import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDocumentation } from '../../packages/release/src/docs.js';
type Launch = NonNullable<NonNullable<Parameters<typeof buildDocumentation>[2]>['browser']>['launch'];
type Browser = Awaited<ReturnType<Launch>>;
type BrowserContext = Awaited<ReturnType<Browser['newContext']>>;
type Page = Awaited<ReturnType<BrowserContext['newPage']>>;
type Route = Parameters<Parameters<BrowserContext['route']>[1]>[0];
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp('/tmp/pxv-documentation-test-');
  await writeFile(join(directory, 'product.json'), await readFile('product.json'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { force: true, recursive: true });
});
async function sources(): Promise<void> {
  await mkdir(join(directory, 'guides/source/markdown'), { recursive: true });
  await mkdir(join(directory, 'guides/assets'), { recursive: true });
  await writeFile(
    join(directory, 'guides/source/markdown/guide.en.md'),
    '# Operator\n\n[local](../../secret) [public](https://example.org/)\n\n![Logo](../../assets/logo.svg)',
  );
  await writeFile(join(directory, 'guides/source/markdown/guide.pl.md'), '# Odbiorca');
  await writeFile(join(directory, 'guides/assets/logo.svg'), '<svg/>');
}
function browserFixture(destination: string, pdfFailure = false) {
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  const anchors = [
    { value: 'file:///private/secret', removeAttribute: vi.fn() },
    { value: 'https://example.org/', removeAttribute: vi.fn() },
    { value: null, removeAttribute: vi.fn() },
  ];
  vi.stubGlobal('document', {
    querySelectorAll: () =>
      anchors.map((anchor) => ({
        getAttribute: () => anchor.value,
        removeAttribute: anchor.removeAttribute,
      })),
  });
  const page = {
    goto: vi.fn(() => Promise.resolve()),
    evaluate: vi.fn((callback: () => void) => {
      callback();
      return Promise.resolve();
    }),
    pdf: vi.fn(async (options: { path: string }) => {
      if (pdfFailure) throw new Error('Browser PDF failure');
      await writeFile(options.path, '%PDF-1.4 fixture');
    }),
  };
  const context = {
    route: vi.fn((_pattern: string, handler: (route: Route) => Promise<void>) => {
      routeHandler = handler;
      return Promise.resolve();
    }),
    newPage: () => Promise.resolve(page as unknown as Page),
    close: vi.fn(() => Promise.resolve()),
  };
  const browser = {
    newContext: vi.fn(() => Promise.resolve(context as unknown as BrowserContext)),
    close: vi.fn(() => Promise.resolve()),
  };
  const launch = vi.fn(() => Promise.resolve(browser as unknown as Browser));
  const checkRoute = async (url: string) => {
    const decision = {
      continue: vi.fn(() => Promise.resolve()),
      abort: vi.fn(() => Promise.resolve()),
      request: () => ({ url: () => url }),
    };
    if (!routeHandler) throw new Error('No route guard');
    await routeHandler(decision as unknown as Route);
    return decision;
  };
  return { launch, browser, context, page, anchors, checkRoute, destination };
}
describe('public documentation generation', () => {
  it('requires public sources and renders branded EN/PL HTML with safe relative links', async () => {
    await expect(buildDocumentation(directory, join(directory, 'output'))).rejects.toThrow(/No public guide/);
    await sources();
    const outputs = await buildDocumentation(directory, join(directory, 'output'));
    expect(outputs).toHaveLength(2);
    const html = await readFile(outputs[0] ?? '', 'utf8');
    expect(html).toContain('src="assets/logo.svg"');
    expect(html).toContain('href="https://example.org/"');
    expect(html).not.toContain('href="../../secret"');
    expect(html).toContain('Qualification draft');
    expect(await readFile(outputs[1] ?? '', 'utf8')).toContain('Wersja do kwalifikacji');
    expect(await readFile(join(directory, 'output/assets/logo.svg'), 'utf8')).toBe('<svg/>');
  });
  it('uses a local browser with JavaScript disabled and blocks network or outside-directory resources', async () => {
    await sources();
    const destination = join(directory, 'output');
    const fixture = browserFixture(destination);
    await buildDocumentation(directory, destination, {
      pdf: true,
      chromiumExecutable: '/approved/chromium',
      browser: { launch: fixture.launch },
    });
    expect(fixture.launch).toHaveBeenCalledWith({ executablePath: '/approved/chromium', headless: true });
    expect(fixture.browser.newContext).toHaveBeenCalledWith({
      javaScriptEnabled: false,
      serviceWorkers: 'block',
    });
    const allowed = await fixture.checkRoute(pathToFileURL(join(destination, 'assets/logo.svg')).href);
    expect(allowed.continue).toHaveBeenCalledOnce();
    for (const url of [
      'https://remote.invalid/private',
      pathToFileURL(join(directory, 'secret')).href,
      pathToFileURL(destination + '-sibling/secret').href,
    ]) {
      const blocked = await fixture.checkRoute(url);
      expect(blocked.abort).toHaveBeenCalledOnce();
    }
    expect(fixture.anchors[0]?.removeAttribute).toHaveBeenCalledWith('href');
    expect(fixture.anchors[1]?.removeAttribute).not.toHaveBeenCalled();
    expect(fixture.anchors[2]?.removeAttribute).toHaveBeenCalledWith('href');
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    expect(fixture.page.pdf).toHaveBeenCalledTimes(2);
  });
  it('always closes the browser after PDF failure and keeps the rendered public HTML', async () => {
    await sources();
    const destination = join(directory, 'output');
    const fixture = browserFixture(destination, true);
    await expect(
      buildDocumentation(directory, destination, { pdf: true, browser: { launch: fixture.launch } }),
    ).rejects.toThrow('Browser PDF failure');
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    expect(fixture.launch).toHaveBeenCalledWith({ headless: true });
    expect(await readFile(join(destination, 'guide.en.html'), 'utf8')).toContain('Operator');
  });
});

it('renders alongside existing public assets without copying an asset onto itself', async () => {
  await sources();
  const outputs = await buildDocumentation(directory, join(directory, 'guides'));
  expect(outputs).toHaveLength(2);
  expect(await readFile(join(directory, 'guides/assets/logo.svg'), 'utf8')).toBe('<svg/>');
});

it('uses the production browser dependency when no browser override is supplied', async () => {
  await sources();
  const destination = join(directory, 'output');
  const fixture = browserFixture(destination);
  const playwright = resolve('packages/release/node_modules/playwright/index.mjs');
  vi.doMock(playwright, () => ({ chromium: { launch: fixture.launch } }));
  vi.resetModules();
  try {
    const module = await import('../../packages/release/src/docs.js');
    await module.buildDocumentation(directory, destination, { pdf: true });
    expect(fixture.launch).toHaveBeenCalledOnce();
  } finally {
    vi.doUnmock(playwright);
    vi.resetModules();
  }
});
