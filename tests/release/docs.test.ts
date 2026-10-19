import type * as TestModule0 from 'node:fs/promises';
import type * as TestModule1 from 'node:path';
import type * as TestModule2 from 'node:url';
import type * as TestModule3 from 'pdf-lib';
import type * as TestModule4 from '../../packages/release/src/docs.js';
import type * as TestModule5 from '@pxv/contracts';
import type * as TestModule6 from '../../tools/optional/publishing/links.mjs';
import { importModule } from './../test-api.js';
globalThis.__pxvTestFile = import.meta.url;
import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
// Module exports are called without a receiver.

const { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } = await importModule<
  typeof TestModule0
>('node:fs/promises', import.meta.url);
// Module exports are called without a receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { join, resolve } = await importModule<typeof TestModule1>('node:path', import.meta.url);
// Module exports are called without a receiver.

const { pathToFileURL } = await importModule<typeof TestModule2>('node:url', import.meta.url);
// Module exports are called without a receiver.

const { PDFDocument } = await importModule<typeof TestModule3>('pdf-lib', import.meta.url);
// Module exports are called without a receiver.

const { buildDocumentation } = await importModule<typeof TestModule4>(
  '../../packages/release/src/docs.js',
  import.meta.url,
);
// Module exports are called without a receiver.

const { parseDocument, validatePolicy } = await importModule<typeof TestModule5>(
  '@pxv/contracts',
  import.meta.url,
);
// Module exports are called without a receiver.

const { verifyGuideLinks } = await importModule<typeof TestModule6>(
  '../../tools/optional/publishing/links.mjs',
  import.meta.url,
);

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
    ['operator-en.md', '# Operator edition'],
    ['user-en.md', '# User edition'],
    ['user-pl.md', '## Codzienne użytkowanie'],
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
        height?: string;
        preferCSSPageSize?: boolean;
        displayHeaderFooter?: boolean;
        headerTemplate?: string;
        footerTemplate?: string;
        margin?: number | { top?: string; right?: string; bottom?: string; left?: string };
      }) => {
        if (pdfFailure) throw new Error('Browser PDF failure');
        const document = await PDFDocument.create();
        const points = (millimeters: number) => (millimeters * 72) / 25.4;
        const a5 = /\/(?:quickstart|credentials)-(?:en|pl)-/u.test(options.path);
        const trim = a5 ? [148, 210] : [210, 297];
        const media =
          options.width && !wrongPrintSize
            ? [Number.parseFloat(options.width), Number.parseFloat(options.height ?? '')]
            : trim;
        document.addPage([points(media[0] ?? 0), points(media[1] ?? 0)]);
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
    expect(html).toContain('General instructions.');
    expect(html).toContain('@page pxvoffice{size:A4;margin:15mm 18mm 20mm}');
    expect(html).toContain('@page pxvprint');
    expect(await readFile(outputs[1] ?? '', 'utf8')).toContain('Instrukcja ogólna.');
    expect(await readFile(join(directory, 'output/assets/logo.svg'), 'utf8')).toBe('<svg/>');
  });
  it('rewrites emitted guide links and retains only public files and existing fragments', async () => {
    await sources();
    await writeFile(
      join(directory, 'guides/source/markdown/guide.en.md'),
      [
        '# Operator',
        '## Daily use',
        '## Daily use',
        '<h2 id="custom">Custom</h2>',
        '[edition](guide.pl.md#codzienne-użytkowanie)',
        '[output edition](guide.pl.html)',
        '[source path](source/markdown/guide.pl.md)',
        '[asset](../../assets/logo.svg)',
        '[output asset](assets/logo.svg)',
        '[index](index.html)',
        '[fragment](#daily-use-1)',
        '[cover](#operator)',
        '[custom](#custom)',
        '[top](#)',
        '[missing fragment](guide.pl.md#missing)',
        '[missing asset fragment](../../assets/logo.svg#missing)',
        '[outside](../../../docs/POLICY_FORMAT.md)',
        '[missing](missing.html)',
        '[stale](stale.html)',
        '[absolute](/etc/passwd)',
        '[file](file:///private/secret)',
        '[query](guide.pl.md?private)',
        '[invalid escape](%invalid)',
        '[invalid fragment](#%invalid)',
        '[encoded escape](%2fetc/passwd)',
        '[backslash](guide%5c.pl.md)',
        '[public](https://example.org/)',
        '[mail](mailto:help@example.org)',
        '<a href=" javascript:alert(1)">spaced</a>',
        '<a href="">empty</a>',
        "<a href='guide.pl.md'>single quoted</a>",
        '<a href="guide.pl.md" title="translated">attribute</a>',
      ].join('\n\n'),
    );
    await writeFile(
      join(directory, 'guides/source/markdown/guide.pl.md'),
      '# Odbiorca\n\n## Codzienne użytkowanie',
    );
    const destination = join(directory, 'output');
    await mkdir(destination);
    await writeFile(join(destination, 'stale.html'), 'not from this build');
    const outputs = await buildDocumentation(directory, destination);
    const html = await readFile(join(destination, 'guide.en.html'), 'utf8');
    for (const href of [
      'guide.pl.html#codzienne-u%C5%BCytkowanie',
      'guide.pl.html',
      'assets/logo.svg',
      'index.html',
      '#daily-use-1',
      '#operator',
      '#custom',
      '#',
      'https://example.org/',
      'mailto:help@example.org',
    ])
      expect(html).toContain(`href="${href}"`);
    for (const text of [
      'missing fragment',
      'missing asset fragment',
      'outside',
      'missing',
      'stale',
      'absolute',
      'file',
      'query',
      'invalid escape',
      'invalid fragment',
      'encoded escape',
      'backslash',
      'spaced',
      'empty',
    ])
      expect(html).toMatch(new RegExp(`<a>${text}</a>`, 'u'));
    expect(html).toContain('<h2 id="daily-use">');
    await verifyGuideLinks(destination, [join(destination, 'index.html'), ...outputs]);
  });
  it('checks unsafe, missing and escaped local navigation throughout generated editions', async () => {
    await sources();
    const destination = join(directory, 'output');
    const outputs = await buildDocumentation(directory, destination);
    const edition = outputs[0] ?? '';
    for (const [href, error] of [
      ['missing.html', /ENOENT/u],
      ['#missing', /Missing guide link fragment/u],
      ['../product.json', /outside the public output/u],
      ['assets', /not a file/u],
      ['javascript:alert(1)', /Unsafe guide link/u],
      ['', /Unsafe guide link/u],
    ] as const) {
      await writeFile(edition, `<a href="${href}">invalid</a>`);
      await expect(verifyGuideLinks(destination, [edition])).rejects.toThrow(error);
    }
  });
  it('renders owner-only recipient guidance in both languages', async () => {
    await sources();
    for (const locale of ['en', 'pl'])
      await writeFile(
        join(directory, `guides/source/markdown/user-${locale}.md`),
        await readFile(`guides/source/markdown/user-${locale}.md`, 'utf8'),
      );
    const destination = join(directory, 'output');
    await buildDocumentation(directory, destination);
    expect(await readFile(join(destination, 'user-en.html'), 'utf8')).toContain(
      'only the Owner profile, use that profile; no user switching is needed',
    );
    expect(await readFile(join(destination, 'user-pl.html'), 'utf8')).toContain(
      'tylko profil właściciela (Owner), korzystaj z niego; przełączanie użytkowników nie jest potrzebne',
    );
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
    for (const [options] of vi.mocked(fixture.page.pdf).mock.calls) {
      expect(options.displayHeaderFooter).toBe(true);
      expect(options.headerTemplate).toBe('<span></span>');
      expect(options.footerTemplate).toContain('pxv Community');
      expect(options.footerTemplate).toContain('class="pageNumber"');
      expect(options.footerTemplate).toContain('class="totalPages"');
    }
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

  it('renders operator and user editions with a custom local font, logo and an untitled Polish source', async () => {
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
    expect(outputs).toHaveLength(5);
    for (const kind of ['operator', 'user'])
      expect(await readFile(join(directory, `output/${kind}-en.html`), 'utf8')).toContain(
        `cover-${kind}.png`,
      );
    const polish = await readFile(join(directory, 'output/user-pl.html'), 'utf8');
    expect(polish).toContain('<html lang="pl">');
    expect(polish).toContain('<body data-guide-kind="user">');
    expect(polish).toContain('body[data-guide-kind="user"] .guide-cover{min-height:50mm}');
    expect(polish).toContain('<title>pxv Community - pxv Community</title>');
    expect(polish).toContain('class="cover-logo" src="assets/logo.svg"');
    expect(polish).toContain("@font-face{font-family:'Pxv Display'");
    expect(polish).toContain("src:url('assets/font.ttf');font-style:normal;font-weight:400}");
    expect(polish).not.toContain('font-weight:100 900');
    expect(polish).toContain('<h2 id="codzienne-użytkowanie">Codzienne użytkowanie</h2>');
    expect(polish).not.toContain('print-opener');
    const index = await readFile(join(directory, 'output/index.html'), 'utf8');
    expect(index).toContain('Operator (EN)');
    expect(index).toContain('User (PL)');
    expect(index).not.toContain('Business fleet');
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

  it('renders A5 recipient and credential editions with compact covers and real A5 PDF page boxes while retaining A4', async () => {
    await editionSources();
    const a5Editions = ['quickstart-en', 'quickstart-pl', 'credentials-en', 'credentials-pl'];
    for (const name of a5Editions)
      await writeFile(
        join(directory, 'guides/source/markdown', `${name}.md`),
        '# Compact guide\n\n## 1. Begin\n\nReadable first page.\n\n<div class="page-break"></div>\n\n## 2. Keep safe\n\n<div class="write-line">Device identifier</div>\n\n<div class="credential-warning">Keep private</div>',
      );
    const destination = join(directory, 'output');
    const fixture = browserFixture(destination);
    await buildDocumentation(directory, destination, { pdf: true, browser: { launch: fixture.launch } });
    const points = (millimeters: number) => (millimeters * 72) / 25.4;
    for (const name of [...a5Editions, 'operator-en', 'user-en']) {
      const a5 = a5Editions.includes(name);
      const [width, height] = a5 ? [148, 210] : [210, 297];
      const html = await readFile(join(destination, `${name}.html`), 'utf8');
      if (a5) {
        expect(html).toContain('class="guide-a5"');
        expect(html).toContain('<section class="guide-cover compact-cover">');
        expect(html).not.toContain('<img class="cover-photo"');
        expect(html).toContain('@page pxva5office{size:148mm 210mm;');
        expect(html).toContain('@page pxva5print{size:154mm 216mm;');
        expect(html).toContain('font-size:10pt;line-height:1.34;color:#111');
        expect(html).toContain('.guide-a5 .page-break{break-before:page}');
        expect(html).toContain('.guide-a5 ol{list-style:none;counter-reset:a5-step}');
        expect(html).toContain('.guide-a5 ol>li{position:relative;counter-increment:a5-step}');
        expect(html).toContain('content:counter(a5-step) ".";position:absolute;left:-5mm;');
        expect(html).toContain('border-bottom:0.3mm dotted #555');
        expect(html).toContain('<div class="credential-warning">Keep private</div>');
      } else
        expect(html).toContain(
          `<img class="cover-photo" src="assets/photos/cover-${name.split('-')[0]}.png"`,
        );
      const office = await PDFDocument.load(await readFile(join(destination, `${name}-office.pdf`)));
      expect(office.getPage(0).getSize().width).toBeCloseTo(points(width ?? 0), 4);
      expect(office.getPage(0).getSize().height).toBeCloseTo(points(height ?? 0), 4);
      const print = await PDFDocument.load(await readFile(join(destination, `${name}-print.pdf`)));
      const page = print.getPage(0);
      expect(page.getMediaBox().width).toBeCloseTo(points((width ?? 0) + 6), 4);
      expect(page.getMediaBox().height).toBeCloseTo(points((height ?? 0) + 6), 4);
      for (const box of [page.getTrimBox(), page.getArtBox()]) {
        expect(box.x).toBeCloseTo(points(3), 4);
        expect(box.y).toBeCloseTo(points(3), 4);
        expect(box.width).toBeCloseTo(points(width ?? 0), 4);
        expect(box.height).toBeCloseTo(points(height ?? 0), 4);
      }
      expect(page.getBleedBox()).toEqual(page.getMediaBox());
      expect(page.getCropBox()).toEqual(page.getMediaBox());
    }
    const index = await readFile(join(destination, 'index.html'), 'utf8');
    expect(index).toContain('A5 recipient quick start (EN)');
    expect(index).toContain('A5 private credential insert (PL)');
    expect(index).toContain('A5 office PDF');
    expect(index).toContain('A4 print PDF + 3 mm bleed');
    const a5Print = fixture.page.pdf.mock.calls.filter(([options]) => options.width === '154mm');
    expect(a5Print).toHaveLength(4);
    expect(a5Print.every(([options]) => options.height === '216mm')).toBe(true);
  });

  it('removes an A5 print PDF with the wrong media dimensions', async () => {
    await mkdir(join(directory, 'guides/source/markdown'), { recursive: true });
    await writeFile(join(directory, 'guides/source/markdown/quickstart-en.md'), '# Quick start');
    const destination = join(directory, 'output');
    const fixture = browserFixture(destination, false, true);
    await expect(
      buildDocumentation(directory, destination, { pdf: true, browser: { launch: fixture.launch } }),
    ).rejects.toThrow('Print renderer did not produce a 154 x 216 mm page');
    await expect(readFile(join(destination, 'quickstart-en-print.pdf'))).rejects.toThrow();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it('normalizes authored policy inputs into generated A5 Markdown while preserving A4 and canonical templates', async () => {
    await editionSources();
    const names = ['quickstart-en', 'quickstart-pl', 'credentials-en', 'credentials-pl'];
    const templates = new Map<string, string>();
    for (const name of names) {
      const template = await readFile(`guides/source/markdown/${name}.md`, 'utf8');
      templates.set(name, template);
      await writeFile(join(directory, 'guides/source/markdown', `${name}.md`), template);
    }
    const operator = await readFile(join(directory, 'guides/source/markdown/operator-en.md'), 'utf8');
    for (const file of ['policy.json']) {
      const policy = parseDocument(await readFile(`policy-packs/single-simple/${file}`, 'utf8'));
      const normalized = validatePolicy(policy);
      const destination = join(directory, file);
      await buildDocumentation(directory, destination, { policy });
      for (const name of names) {
        const markdown = await readFile(join(destination, 'source/markdown', `${name}.md`), 'utf8');
        const html = await readFile(join(destination, `${name}.html`), 'utf8');
        expect(markdown).not.toBe(templates.get(name));
        expect(markdown).toContain(normalized.profiles[0]?.name);
        expect(html).toContain(normalized.profiles[0]?.name);
        expect(await readFile(join(directory, 'guides/source/markdown', `${name}.md`), 'utf8')).toBe(
          templates.get(name),
        );
      }
      expect(await readFile(join(destination, 'source/markdown/operator-en.md'), 'utf8')).toBe(operator);
      expect(await readFile(join(destination, 'index.html'), 'utf8')).toContain(
        'document configuration, not device acceptance',
      );
      await expect(access(join(destination, file))).rejects.toThrow();
    }
  });

  it('validates policy before creating or changing output files', async () => {
    await sources();
    const destination = join(directory, 'invalid-policy');
    await expect(buildDocumentation(directory, destination, { policy: {} })).rejects.toThrow();
    await expect(access(destination)).rejects.toThrow();
    const invalidPolicy = {
      ...(parseDocument(await readFile('policy-packs/single-simple/policy.json', 'utf8')) as object),
      unexpected: true,
    };
    await expect(buildDocumentation(directory, destination, { policy: invalidPolicy })).rejects.toThrow(
      'unexpected',
    );
    await expect(access(destination)).rejects.toThrow();
    await mkdir(destination);
    await writeFile(join(destination, 'index.html'), 'Existing guide');
    await expect(buildDocumentation(directory, destination, { policy: null })).rejects.toThrow();
    expect(await readFile(join(destination, 'index.html'), 'utf8')).toBe('Existing guide');
  });

  it('rejects policy output within authoritative guides and through symlink aliases before writes', async () => {
    await sources();
    const policy = parseDocument(await readFile('policy-packs/single-simple/policy.json', 'utf8'));
    const canonical = await readFile(join(directory, 'guides/source/markdown/guide.en.md'), 'utf8');
    const alias = join(directory, 'guide-alias');
    await symlink(join(directory, 'guides'), alias);
    for (const destination of [
      join(directory, 'guides'),
      join(directory, 'guides/private'),
      alias,
      join(alias, 'private'),
    ])
      await expect(buildDocumentation(directory, destination, { policy })).rejects.toThrow(
        'outside the authoritative guides directory',
      );
    expect(await readFile(join(directory, 'guides/source/markdown/guide.en.md'), 'utf8')).toBe(canonical);
    await expect(access(join(directory, 'guides/private'))).rejects.toThrow();
    await expect(access(join(directory, 'guides/index.html'))).rejects.toThrow();
  });

  it('rejects existing nested output symlinks before they can overwrite canonical source files', async () => {
    await sources();
    const policy = parseDocument(await readFile('policy-packs/single-simple/policy.json', 'utf8'));
    const canonicalPath = join(directory, 'guides/source/markdown/guide.en.md');
    const canonical = await readFile(canonicalPath, 'utf8');
    const fileOutput = join(directory, 'file-link-output');
    await mkdir(join(fileOutput, 'source/markdown'), { recursive: true });
    await symlink(canonicalPath, join(fileOutput, 'source/markdown/guide.pl.md'));
    const directoryOutput = join(directory, 'directory-link-output');
    await mkdir(directoryOutput);
    await symlink(join(directory, 'guides/source'), join(directoryOutput, 'source'));
    for (const destination of [fileOutput, directoryOutput])
      await expect(buildDocumentation(directory, destination, { policy })).rejects.toThrow(
        'must not contain symbolic links',
      );
    expect(await readFile(canonicalPath, 'utf8')).toBe(canonical);
    await expect(access(join(directoryOutput, 'assets'))).rejects.toThrow();
    await expect(access(join(fileOutput, 'assets'))).rejects.toThrow();
  });

  it('rejects output hardlinks before cross-file copies can overwrite canonical source files', async () => {
    await sources();
    const policy = parseDocument(await readFile('policy-packs/single-simple/policy.json', 'utf8'));
    const canonicalPath = join(directory, 'guides/source/markdown/guide.en.md');
    const canonical = await readFile(canonicalPath, 'utf8');
    const destination = join(directory, 'hardlink-output');
    await mkdir(join(destination, 'source/markdown'), { recursive: true });
    await link(canonicalPath, join(destination, 'source/markdown/guide.pl.md'));
    await expect(buildDocumentation(directory, destination, { policy })).rejects.toThrow(
      'must not contain hardlinked files',
    );
    expect(await readFile(canonicalPath, 'utf8')).toBe(canonical);
    await expect(access(join(destination, 'assets'))).rejects.toThrow();
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
    const module = await importModule<typeof TestModule4>(
      '../../packages/release/src/docs.js',
      import.meta.url,
    );
    await module.buildDocumentation(directory, destination, { pdf: true });
    expect(fixture.launch).toHaveBeenCalledOnce();
  } finally {
    vi.doUnmock(playwright);
    vi.resetModules();
  }
});

type PDFDocument = typeof PDFDocument.prototype;
