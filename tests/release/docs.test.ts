import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
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
async function editionSources(): Promise<void> {
  await sources();
  for (const [name, source] of [
    ['product-en.md', '# Product edition'],
    ['operator-en.md', '# Operator edition'],
    ['user-en.md', '# User edition'],
    ['b2b-pl.md', '<!-- print:opener -->\n## Flota firmowa'],
  ] as const)
    await writeFile(join(directory, 'guides/source/markdown', name), source);
}
function browserFixture(destination: string, pdfFailure = false, wrongPrintSize = false) {
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  const anchors = [
    { value: 'file:///private/secret', removeAttribute: vi.fn() },
    { value: 'https://example.org/', removeAttribute: vi.fn() },
    { value: null, removeAttribute: vi.fn() },
  ];
  vi.stubGlobal('document', {
    documentElement: { dataset: {} },
    fonts: { ready: Promise.resolve() },
    querySelectorAll: () =>
      anchors.map((anchor) => ({
        getAttribute: () => anchor.value,
        removeAttribute: anchor.removeAttribute,
      })),
  });
  const page = {
    goto: vi.fn(() => Promise.resolve()),
    addStyleTag: vi.fn(() => Promise.resolve()),
    evaluate: vi.fn((callback: () => void) => {
      callback();
      return Promise.resolve();
    }),
    pdf: vi.fn(
      async (options: {
        path: string;
        width?: string;
        preferCSSPageSize?: boolean;
        margin?: number | { top?: string; right?: string; bottom?: string; left?: string };
      }) => {
        if (pdfFailure) throw new Error('Browser PDF failure');
        const document = await PDFDocument.create();
        const points = (millimeters: number) => (millimeters * 72) / 25.4;
        document.addPage(
          options.width && !wrongPrintSize ? [points(216), points(303)] : [points(210), points(297)],
        );
        await writeFile(options.path, await document.save());
      },
    ),
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
    expect(html).toContain('@page pxvoffice{size:A4;margin:15mm 18mm 25mm}');
    expect(html).toContain('@page pxvprint');
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
    expect(fixture.page.pdf).toHaveBeenCalledTimes(4);
    const officeOptions = vi.mocked(fixture.page.pdf).mock.calls.filter(([options]) => !options.width);
    expect(officeOptions).toHaveLength(2);
    expect(officeOptions.every(([options]) => options.preferCSSPageSize)).toBe(true);
    const printOptions = vi.mocked(fixture.page.pdf).mock.calls.filter(([options]) => options.width);
    expect(printOptions).toHaveLength(2);
    expect(
      printOptions.every(
        ([options]) =>
          typeof options.margin === 'object' &&
          options.margin !== null &&
          options.margin.top === '0' &&
          options.margin.right === '0' &&
          options.margin.bottom === '0' &&
          options.margin.left === '0',
      ),
    ).toBe(true);
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

  it('validates all brand fields and refuses missing public font or logo assets', async () => {
    await sources();
    const destination = join(directory, 'output');
    const base = {
      schemaVersion: 1,
      brandName: 'pxv Community',
      colors: { primary: '#17324D', secondary: '#2F6873', accent: '#D9952B' },
      fontFamily: 'DejaVu Sans',
    };
    const cases: { value: Record<string, unknown>; message: RegExp }[] = [
      { value: { ...base, schemaVersion: 2 }, message: /schemaVersion/u },
      { value: { ...base, colors: [] }, message: /three colors/u },
      { value: { ...base, brandName: 'Another brand' }, message: /brandName must match/u },
      { value: { ...base, fontFamily: 'Bad; font-family' }, message: /fontFamily/u },
      {
        value: { ...base, colors: { ...base.colors, primary: 'blue' } },
        message: /color: primary/u,
      },
      { value: { ...base, logo: '../logo.svg' }, message: /Invalid guide brand logo/u },
      { value: { ...base, fontAsset: 'assets/missing.ttf' }, message: /ENOENT/u },
    ];
    for (const testCase of cases) {
      await writeFile(join(directory, 'guides/assets/brand.json'), JSON.stringify(testCase.value));
      await expect(buildDocumentation(directory, destination)).rejects.toThrow(testCase.message);
    }
  });

  it('renders every named guide kind with a custom local font, logo and an untitled Polish B2B source', async () => {
    await editionSources();
    await writeFile(join(directory, 'guides/assets/font.ttf'), 'fixture font asset');
    await writeFile(
      join(directory, 'guides/assets/brand.json'),
      JSON.stringify({
        schemaVersion: 1,
        brandName: 'pxv Community',
        colors: { primary: '#17324D', secondary: '#2F6873', accent: '#D9952B' },
        fontFamily: 'Pxv Display',
        fontAsset: 'assets/font.ttf',
        logo: 'assets/logo.svg',
      }),
    );
    const outputs = await buildDocumentation(directory, join(directory, 'output'));
    expect(outputs).toHaveLength(6);
    for (const kind of ['product', 'operator', 'user', 'b2b'])
      expect(
        await readFile(join(directory, `output/${kind}-${kind === 'b2b' ? 'pl' : 'en'}.html`), 'utf8'),
      ).toContain(`cover-${kind}.png`);
    const polish = await readFile(join(directory, 'output/b2b-pl.html'), 'utf8');
    expect(polish).toContain('<html lang="pl">');
    expect(polish).toContain('<title>pxv Community - pxv Community</title>');
    expect(polish).toContain('class="cover-logo" src="assets/logo.svg"');
    expect(polish).toContain("@font-face{font-family:'Pxv Display'");
    expect(polish).toContain('<h2 class="print-opener">Flota firmowa</h2>');
  });

  it('removes a print PDF whose renderer page size falls outside the required bleed format', async () => {
    await sources();
    const destination = join(directory, 'output');
    const fixture = browserFixture(destination, false, true);
    await expect(
      buildDocumentation(directory, destination, { pdf: true, browser: { launch: fixture.launch } }),
    ).rejects.toThrow('Print renderer did not produce a 216 x 303 mm page');
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    await expect(readFile(join(destination, 'guide.en-print.pdf'))).rejects.toThrow();
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
