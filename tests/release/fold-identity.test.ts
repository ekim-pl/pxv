import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it, expect } from '../test-api.js';
import { validatePolicy, validatePolicyDocument, type ExecutionPolicy } from '@pxv/contracts';
import { buildDocumentation } from '../../packages/release/src/docs.js';
import type { FoldManifest } from '../../packages/guides/src/fold-packet.js';

const normalized = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const pt = (mm: number): string => String(Math.round((mm * 72) / 25.4));

function panelText(pdf: string, placement: FoldManifest['placements'][number]): string {
  return execFileSync(
    'pdftotext',
    [
      '-f',
      String(placement.sheet),
      '-l',
      String(placement.sheet),
      '-x',
      pt(placement.xMm),
      '-y',
      pt(210 - placement.yMm - 100),
      '-W',
      pt(68),
      '-H',
      pt(100),
      pdf,
      '-',
    ],
    { encoding: 'utf8' },
  );
}

async function assertPanelIdentities(output: string, policy?: ExecutionPolicy): Promise<void> {
  for (const locale of ['en', 'pl']) {
    const name = `credentials-${locale}`;
    const pdf = join(output, `${name}-a4-fold.pdf`);
    const layout = JSON.parse(
      await readFile(join(output, 'qa', `${name}-fold.json`), 'utf8'),
    ) as FoldManifest;
    const assetLabel = normalized(locale === 'en' ? 'Device asset label' : 'Etykieta zasobu');
    for (const placement of layout.placements) {
      const raw = panelText(pdf, placement);
      const text = normalized(raw);
      expect(text).toContain(assetLabel);
      expect(raw).toContain('______________________________');
      const section =
        /(\d+)(?:ordinaryprofilecredentials|accountandrecoveryplan|zwykłedaneprofilu|kontoiodzyskiwanie)/u.exec(
          text,
        );
      if (section && policy) {
        const profile = policy.profiles[Math.floor((Number(section[1]) - 2) / 2)]!;
        expect(text).toContain(normalized(`ID: ${profile.id}`));
        expect(text).toContain(normalized(profile.name));
      }
      if (
        !policy &&
        text.includes(normalized(locale === 'en' ? 'Section / continued' : 'Sekcja / ciąg dalszy'))
      )
        expect(text).toContain(normalized(locale === 'en' ? 'Profile / scope' : 'Profil / zakres'));
    }
    const xml = execFileSync('pdftohtml', ['-xml', '-zoom', '1', '-hidden', '-stdout', pdf], {
      encoding: 'utf8',
    });
    for (const font of xml.matchAll(/<fontspec[^>]* size="([\d.]+)"/gu))
      expect(Number(font[1])).toBeGreaterThanOrEqual(8);
  }
}

it('keeps asset writing fields and full profile identity on every real blank panel (PXV_CHROMIUM)', async (context) => {
  const chromium = process.env['PXV_CHROMIUM'];
  if (!chromium) {
    context.skip('Set PXV_CHROMIUM for real PDF/Poppler identity checks');
    return;
  }
  const root = await mkdtemp('/tmp/pxv-fold-identity-');
  try {
    const source = join(root, 'source');
    const markdown = join(source, 'guides/source/markdown');
    await mkdir(markdown, { recursive: true });
    await writeFile(join(source, 'product.json'), await readFile('product.json'));
    for (const locale of ['en', 'pl'])
      await writeFile(
        join(markdown, `credentials-${locale}.md`),
        await readFile(`guides/source/markdown/credentials-${locale}.md`),
      );
    const owner = validatePolicyDocument(
      JSON.parse(await readFile('policy-packs/single-simple/policy.json', 'utf8')),
    );
    owner.profiles[0]!.name = 'Właściciel bardzo długiego profilu '.repeat(7).trim();
    const five = validatePolicyDocument(
      JSON.parse(await readFile('policy-packs/fleet-nerd/policy.json', 'utf8')),
    );
    for (const [index, policy] of [undefined, owner, five].entries()) {
      const output = join(root, `output-${index}`);
      await buildDocumentation(source, output, {
        pdf: true,
        chromiumExecutable: chromium,
        ...(policy ? { policy } : {}),
      });
      await assertPanelIdentities(output, policy ? validatePolicy(policy) : undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
