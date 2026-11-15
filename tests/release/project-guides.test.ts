import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, type PDFPage } from 'pdf-lib';
import { afterEach, beforeEach, expect, it } from '../test-api.js';
import { buildDocumentation } from '../../packages/release/src/docs.js';
import { assertFoldPanelBounds } from '../../tools/optional/publishing/fold-qa.mjs';
import { createGuideFixture, product } from './guide-fixture.js';

let source: string;
beforeEach(async () => {
  source = await createGuideFixture();
});
afterEach(async () => {
  await rm(source, { recursive: true, force: true });
});

const normalized = (value: string): string => value.replace(/\s+/gu, ' ').trim();

function footerText(pdf: string, page: PDFPage, index = 0): string {
  return normalized(
    execFileSync(
      'pdftotext',
      [
        '-f',
        String(index + 1),
        '-l',
        String(index + 1),
        '-W',
        String(Math.ceil(page.getWidth())),
        '-y',
        String(Math.floor(page.getHeight() - 45)),
        '-H',
        '45',
        pdf,
        '-',
      ],
      { encoding: 'utf8' },
    ),
  );
}

async function assertRunningLabels(pdf: string, projectName: string): Promise<void> {
  const document = await PDFDocument.load(await readFile(pdf));
  for (const [index, page] of document.getPages().entries()) {
    expect(footerText(pdf, page, index)).toContain(projectName);
  }
}

it('prints literal project titles, descriptive subtitles, support and running labels in EN/PL (PXV_CHROMIUM)', async (context) => {
  const chromium = process.env['PXV_CHROMIUM'];
  if (!chromium) {
    context.skip('Set PXV_CHROMIUM for real project guide PDF/Poppler checks');
    return;
  }
  const root = await mkdtemp('/tmp/pxv-project-guide-pdf-');
  const projectName = 'Zażółć <Flota> & **nazwa**';
  const support = { name: 'Wsparcie <Telefonów>', phone: '+48 (123) 456 789' };
  try {
    await buildDocumentation(source, root, {
      pdf: true,
      chromiumExecutable: chromium,
      insertMetadata: { projectName, support },
    });
    for (const locale of ['en', 'pl']) {
      for (const kind of ['operator', 'user', 'quickstart', 'credentials']) {
        const edition = `${kind}-${locale}`;
        const template = await readFile(`guides/source/markdown/${edition}.md`, 'utf8');
        const title = template.split('\n')[0]!.slice(2);
        const modes = kind === 'operator' || kind === 'user' ? ['office', 'print'] : ['a4-fold'];
        for (const mode of modes) {
          const pdf = join(root, `${edition}-${mode}.pdf`);
          const text = normalized(execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf8' }));
          expect(text).toContain(projectName);
          expect(text).toContain(title);
          expect(text).toContain(support.name);
          expect(text).toContain(support.phone);
          expect(text).toContain(locale === 'pl' ? 'Wsparcie:' : 'Support:');
          expect(text).not.toContain(product.name);
          if (mode === 'a4-fold') assertFoldPanelBounds(pdf);
          else await assertRunningLabels(pdf, projectName);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('omits automatic product identity from generic and fallback-support PDFs in EN/PL (PXV_CHROMIUM)', async (context) => {
  const chromium = process.env['PXV_CHROMIUM'];
  if (!chromium) {
    context.skip('Set PXV_CHROMIUM for real project guide PDF/Poppler checks');
    return;
  }
  const root = await mkdtemp('/tmp/pxv-unbranded-guide-pdf-');
  try {
    for (const [index, metadata] of [undefined, {}].entries()) {
      const output = join(root, String(index));
      await buildDocumentation(source, output, {
        pdf: true,
        chromiumExecutable: chromium,
        insertMetadata: metadata,
      });
      for (const locale of ['en', 'pl']) {
        for (const kind of ['operator', 'user', 'quickstart', 'credentials']) {
          const modes = kind === 'operator' || kind === 'user' ? ['office', 'print'] : ['a4-fold'];
          for (const mode of modes) {
            const pdf = join(output, `${kind}-${locale}-${mode}.pdf`);
            const text = normalized(execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf8' }));
            expect(text).not.toContain(product.name);
            if (metadata) {
              expect(text).toContain(product.support.email);
              expect(text).toContain(product.support.url);
            }
            if (mode !== 'a4-fold') {
              const document = await PDFDocument.load(await readFile(pdf));
              expect(footerText(pdf, document.getPage(0))).toMatch(/^1\s*\/\s*\d+$/u);
            }
          }
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('ellipsizes long running labels while preserving page numbers and the full title (PXV_CHROMIUM)', async (context) => {
  const chromium = process.env['PXV_CHROMIUM'];
  if (!chromium) {
    context.skip('Set PXV_CHROMIUM for real project guide PDF/Poppler checks');
    return;
  }
  const root = await mkdtemp('/tmp/pxv-long-guide-label-');
  const projectName = 'LongProject'.repeat(30);
  try {
    const markdown = join(root, 'guides/source/markdown');
    await mkdir(markdown, { recursive: true });
    await writeFile(join(root, 'product.json'), await readFile('product.json'));
    await writeFile(join(markdown, 'operator-en.md'), '# Operator guide\n\nShort body.');
    const output = join(root, 'output');
    await buildDocumentation(root, output, {
      pdf: true,
      chromiumExecutable: chromium,
      insertMetadata: { projectName },
    });
    const html = await readFile(join(output, 'operator-en.html'), 'utf8');
    expect(/<h1\b[^>]*>(.*?)<\/h1>/su.exec(html)?.[1]).toBe(projectName);
    for (const mode of ['office', 'print']) {
      const pdf = join(output, `operator-en-${mode}.pdf`);
      const document = await PDFDocument.load(await readFile(pdf));
      const page = document.getPage(0);
      const footer = footerText(pdf, page);
      expect(footer).toContain('LongProject');
      expect(footer).toContain('…');
      expect(footer).toMatch(/1\s*\/\s*1/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
