import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import type { PhoneRegistryRecord } from '@pxv/contracts';
import type { Runtime } from '@pxv/runtime';
import {
  assetLabelMonth,
  renderAssetLabel,
  renderDeviceBoxCard,
  writeAssetLabel,
  writeDeviceBoxCard,
} from '@pxv/guides';
import { afterEach, expect, it } from '../test-api.js';

const at = '2026-10-20T12:00:00Z';
const value = (value: string, state: 'current' | 'stale' | 'unknown' | 'initial' = 'current') => ({
  value,
  state,
  updatedAt: at,
  ...(state === 'current' ? { confirmedAt: at } : {}),
});
function record(): PhoneRegistryRecord {
  return {
    assetId: 'phone-01',
    canonicalSerial: 'SYNTHETIC-SERIAL',
    codename: 'shiba',
    revision: 1,
    generation: { deviceEpoch: '', profileEpochs: {} },
    fields: {
      duressPin: value('DURESS-PIN'),
      duressPassword: value('ERASE-PASSWORD', 'stale'),
      phoneNumber: value('+48123456789', 'unknown'),
    },
    profiles: [
      {
        profileId: 'owner',
        user: { userId: 0, serialNo: 0, name: 'Właściciel' },
        fields: {
          pin: value('ORDINARY-PIN'),
          password: value('ORDINARY-PASSWORD'),
          protonVpnUsername: value('VPN-USER'),
          protonVpnPassword: value('VPN-PASSWORD'),
          oblivionNotificationWipeKey: value('WIPE-KEY', 'initial'),
          phoneNumber: value('+48987654321'),
          sessionMessengerId: value('05' + '1a'.repeat(32)),
        },
      },
    ],
  };
}
const label = { assetId: 'phone-01', canonicalSerial: 'ABC12345678', month: '202610' };
const roots: string[] = [];
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'pxv-box-test-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('renders only the requested credential fields and effective metadata in EN/PL', () => {
  for (const locale of ['en', 'pl'] as const) {
    const html = renderDeviceBoxCard(record(), { locale });
    expect(html).toContain(`lang="${locale}"`);
    for (const text of [
      'SYNTHETIC-SERIAL',
      'DURESS-PIN',
      'ERASE-PASSWORD',
      'WIPE-KEY',
      '+48123456789',
      '+48987654321',
      '051a1a',
      at,
      'Właściciel',
      'owner; 0/0',
    ])
      expect(html).toContain(text);
    for (const text of ['ORDINARY-PIN', 'ORDINARY-PASSWORD', 'VPN-USER', 'VPN-PASSWORD'])
      expect(html).not.toContain(text);
    expect(html).toContain(locale === 'en' ? 'STALE - verify privately' : 'NIEAKTUALNE - sprawdź prywatnie');
    expect(html).toContain(locale === 'en' ? 'UNKNOWN - verify privately' : 'NIEZNANE - sprawdź prywatnie');
    expect(html).toContain(locale === 'en' ? 'INITIAL' : 'POCZĄTKOWE');
    expect(html).toContain(
      locale === 'en'
        ? 'Never use these for ordinary unlock or tests.'
        : 'Nigdy nie używaj do zwykłego odblokowania ani testów.',
    );
  }
});

it('keeps supplied data inert and preserves whitespace-sensitive values', () => {
  const data = record();
  const secret = '  <script>\t\r\n</script>&"\'  ';
  data.fields.duressPassword = value(secret);
  data.profiles[0]!.user.name = '</style><script>untrusted()</script>';
  const html = renderDeviceBoxCard(data);
  expect(html).toContain('  &lt;script&gt;\t\r\n&lt;/script&gt;&amp;&quot;&#39;  ');
  expect(html).toContain('&lt;/style&gt;&lt;script&gt;untrusted()&lt;/script&gt;');
  expect(html.match(/<script>/gu)).toHaveLength(1);
  const script = /<script>([\s\S]*)<\/script>/u.exec(html)![1]!;
  expect(html).toContain(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`);
  expect(script).not.toContain('untrusted()');
  data.fields = {};
  data.profiles[0]!.fields = {};
  expect(renderDeviceBoxCard(data)).toContain('No values recorded.');
  expect(() => renderDeviceBoxCard(data, { locale: 'de' as 'en' })).toThrow('locale');
});

it('renders three sticker identity lines, escapes text and validates YYYYMM and identities', () => {
  for (const locale of ['en', 'pl'] as const) {
    const html = renderAssetLabel({ ...label, canonicalSerial: '<A&B>' }, { locale });
    expect(html.match(/class="line"/gu)).toHaveLength(3);
    expect(html).toContain('&lt;A&amp;B&gt;');
    expect(html).toContain(locale === 'en' ? 'Date: 202610' : 'Data: 202610');
    expect(html).not.toContain('DURESS');
  }
  for (const month of ['202600', '202613', '20261', '2026-10', '202610x', ''])
    expect(() => renderAssetLabel({ ...label, month })).toThrow('YYYYMM');
  for (const canonicalSerial of ['', 'SERIAL\nINJECT', '\0', 'x'.repeat(257)])
    expect(() => renderAssetLabel({ ...label, canonicalSerial })).toThrow('identity');
  expect(() => renderAssetLabel(label, { locale: 'de' as 'en' })).toThrow('locale');
});

it('uses local calendar months at year boundaries, with deterministic override reprints', () => {
  expect(assetLabelMonth(undefined, new Date(2026, 11, 31, 23, 59))).toBe('202612');
  expect(assetLabelMonth(undefined, new Date(2027, 0, 1, 0, 0))).toBe('202701');
  expect(assetLabelMonth('202610', new Date(2027, 0, 1))).toBe('202610');
  expect(() => assetLabelMonth(undefined, new Date(NaN))).toThrow('YYYYMM');
});

async function pdf(size: [number, number], title = 'PXV_LAYOUT_OK') {
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.addPage(size.map((mm) => (mm * 72) / 25.4) as [number, number]);
  return document.save();
}
function png() {
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(473);
  header.writeUInt32BE(178, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((473 * 3 + 1) * 178))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function renderer(size: [number, number], directories: string[], title?: string): Runtime {
  return {
    async run(args, settings) {
      const directory = settings!.env!['HOME']!;
      directories.push(directory);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      if (args[0] === 'pdftoppm') {
        expect(args).toContain('300');
        await writeFile(args.at(-1)! + '.png', png());
      } else {
        const source = fileURLToPath(args.at(-1)!);
        expect((await stat(source)).mode & 0o777).toBe(0o600);
        expect(await readFile(source, 'utf8')).toContain("default-src 'none'");
        expect(args).toContain('--disable-background-networking');
        expect(args).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
        await writeFile(
          args.find((arg) => arg.startsWith('--print-to-pdf='))!.slice(15),
          await pdf(size, title),
        );
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

it('writes a native-size private card and cleans isolated browser files', async () => {
  const directory = await root(),
    destination = join(directory, 'card.pdf'),
    temporary: string[] = [];
  await writeDeviceBoxCard(record(), destination, {
    chromiumExecutable: '/local/chromium',
    runtime: renderer([68, 100], temporary),
  });
  const document = await PDFDocument.load(await readFile(destination));
  expect(document.getPage(0).getWidth()).toBeCloseTo((68 * 72) / 25.4, 5);
  expect((await stat(destination)).mode & 0o777).toBe(0o600);
  expect(await readdir(directory)).toEqual(['card.pdf']);
  await expect(stat(temporary[0]!)).rejects.toThrow();
  await expect(
    writeDeviceBoxCard(record(), destination, {
      chromiumExecutable: '/local/chromium',
      runtime: renderer([68, 100], temporary),
    }),
  ).rejects.toThrow('card export failed');
});

it('writes matching private sticker formats and refuses existing files/symlinks without leaving half a pair', async () => {
  const directory = await root(),
    destination = join(directory, 'label'),
    temporary: string[] = [];
  const options = { chromiumExecutable: '/local/chromium', runtime: renderer([40, 15], temporary) };
  await writeAssetLabel(label, destination, options);
  expect(await readdir(directory)).toEqual(['label.pdf', 'label.png']);
  const document = await PDFDocument.load(await readFile(destination + '.pdf'));
  expect(document.getPageCount()).toBe(1);
  expect(document.getPage(0).getHeight()).toBeCloseTo((15 * 72) / 25.4, 5);
  expect((await stat(destination + '.png')).mode & 0o777).toBe(0o600);
  for (const path of temporary) await expect(stat(path)).rejects.toThrow();
  const before = await readFile(destination + '.pdf');
  await expect(writeAssetLabel(label, destination, options)).rejects.toThrow('label export failed');
  expect(await readFile(destination + '.pdf')).toEqual(before);
  await symlink(destination + '.png', join(directory, 'collision.png'));
  await expect(writeAssetLabel(label, join(directory, 'collision'), options)).rejects.toThrow(
    'label export failed',
  );
  await expect(stat(join(directory, 'collision.pdf'))).rejects.toThrow();
  expect(await readFile(destination + '.pdf')).toEqual(before);
  expect(await readdir(directory)).toEqual(['collision.png', 'label.pdf', 'label.png']);
});

it('sanitizes renderer failures, detects incomplete layouts and invalid dimensions, and cleans intermediates', async () => {
  const directory = await root();
  for (const [size, title] of [
    [[40, 15], 'PXV_LAYOUT_OK'],
    [[68, 100], 'PXV_LAYOUT_PENDING'],
    [[68, 100], 'PXV_LAYOUT_ERROR'],
  ] as const) {
    const temporary: string[] = [];
    await expect(
      writeDeviceBoxCard(record(), join(directory, 'bad.pdf'), {
        chromiumExecutable: '/local/chromium',
        runtime: renderer([...size], temporary, title),
      }),
    ).rejects.toThrow('card export failed');
    await expect(stat(temporary[0]!)).rejects.toThrow();
  }
  const runtime: Runtime = { run: () => Promise.reject(new Error('SECRET-SENTINEL')) };
  await expect(
    writeAssetLabel(label, join(directory, 'bad'), { chromiumExecutable: '/local/chromium', runtime }),
  ).rejects.toThrow(/^Private asset label export failed;/u);
  await expect(
    writeDeviceBoxCard(record(), join(directory, 'bad.pdf'), { chromiumExecutable: '', runtime }),
  ).rejects.toThrow(/^Private device box card export failed;/u);
  await expect(
    writeAssetLabel(label, join(directory, 'bad.pdf'), { chromiumExecutable: '/local/chromium', runtime }),
  ).rejects.toThrow('label export failed');
  expect(await readdir(directory)).toEqual([]);
});

it('publishes neither sticker format if rasterization fails or produces invalid image bytes', async () => {
  const directory = await root();
  for (const failure of ['exit', 'invalid-png']) {
    const temporary: string[] = [];
    const chrome = renderer([40, 15], temporary);
    const runtime: Runtime = {
      async run(args, options) {
        if (args[0] !== 'pdftoppm') return chrome.run(args, options);
        if (failure === 'invalid-png') await writeFile(args.at(-1)! + '.png', 'INVALID-IMAGE');
        return { code: failure === 'exit' ? 1 : 0, stdout: 'PRIVATE-DIAGNOSTIC', stderr: '' };
      },
    };
    await expect(
      writeAssetLabel(label, join(directory, failure), { chromiumExecutable: '/local/chromium', runtime }),
    ).rejects.toThrow(/^Private asset label export failed;/u);
    expect(await readdir(directory)).toEqual([]);
    await expect(stat(temporary[0]!)).rejects.toThrow();
  }
});

function assertPrintBounds(destination: string, widthMm: number, heightMm: number): void {
  const boxes = execFileSync('pdftotext', ['-bbox', destination, '-'], { encoding: 'utf8' });
  const words = [
    ...boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/gu),
  ];
  expect(words.length).toBeGreaterThan(0);
  for (const [, left, top, right, bottom] of words) {
    expect(Number(left)).toBeGreaterThanOrEqual(4);
    expect(Number(top)).toBeGreaterThanOrEqual(4);
    expect(Number(right)).toBeLessThan((widthMm * 72) / 25.4 - 4);
    expect(Number(bottom)).toBeLessThan((heightMm * 72) / 25.4 - 4);
  }
  if (widthMm !== 68) return;
  for (const page of boxes.matchAll(/<page[^>]*>([\s\S]*?)<\/page>/gu)) {
    const entries = [
      ...page[1]!.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/gu),
    ];
    const footerTop = Number(entries.at(-3)![2]);
    for (const entry of entries.slice(0, -3)) expect(Number(entry[4])).toBeLessThan(footerTop - 2);
  }
}

it('fits empty records on one card and retains all identities across five profiles (PXV_CHROMIUM)', async (context) => {
  const chromiumExecutable = process.env['PXV_CHROMIUM'];
  if (!chromiumExecutable) {
    context.skip('Set PXV_CHROMIUM for real card layout checks');
    return;
  }
  const directory = await root();
  const data = record();
  data.fields = {};
  data.profiles = [];
  for (const locale of ['en', 'pl'] as const) {
    const destination = join(directory, `empty-${locale}.pdf`);
    await writeDeviceBoxCard(data, destination, { chromiumExecutable, locale });
    expect((await PDFDocument.load(await readFile(destination))).getPageCount()).toBe(1);
    assertPrintBounds(destination, 68, 100);
  }
  const populated = record();
  populated.profiles = Array.from({ length: 5 }, (_, index) => ({
    profileId: `profile-${index}`,
    user: { userId: index, serialNo: index, name: `Profil ${index} Żółć` },
    fields: {
      sessionMessengerId: value('05' + String(index).repeat(64)),
      oblivionNotificationWipeKey: value(`WIPE-KEY-${index}`),
    },
  }));
  const destination = join(directory, 'five.pdf');
  await writeDeviceBoxCard(populated, destination, { chromiumExecutable });
  const text = execFileSync('pdftotext', ['-raw', destination, '-'], { encoding: 'utf8' });
  for (let index = 0; index < 5; index++) {
    expect(text).toContain(`Profil ${index} Żółć`);
    expect(text).toContain(`WIPE-KEY-${index}`);
    expect(text.replaceAll(/\s/gu, '')).toContain('05' + String(index).repeat(64));
  }
  assertPrintBounds(destination, 68, 100);
});

it('renders real EN/PL cards, overflow and stickers with readable bounds (PXV_CHROMIUM)', async (context) => {
  const chromiumExecutable = process.env['PXV_CHROMIUM'];
  if (!chromiumExecutable) {
    context.skip('Set PXV_CHROMIUM for real PDF/PNG layout checks');
    return;
  }
  const directory = await root();
  for (const locale of ['en', 'pl'] as const) {
    const destination = join(directory, `card-${locale}.pdf`);
    await writeDeviceBoxCard(record(), destination, { chromiumExecutable, locale });
    const document = await PDFDocument.load(await readFile(destination));
    const text = execFileSync('pdftotext', ['-raw', destination, '-'], { encoding: 'utf8' });
    expect(text).toContain('DURESS-PIN');
    expect(text).toContain('WIPE-KEY');
    expect(text).not.toContain('ORDINARY-PASSWORD');
    expect(text).not.toContain('VPN-PASSWORD');
    for (const [index, page] of text
      .split('\f')
      .filter((page) => page.trim())
      .entries()) {
      expect(page.replaceAll(/\s/gu, '')).toContain('SYNTHETIC-SERIAL');
      expect(page).toContain(`${index + 1} / ${document.getPageCount()}`);
    }
    for (const page of document.getPages()) {
      expect(page.getWidth()).toBeCloseTo((68 * 72) / 25.4, 5);
      expect(page.getHeight()).toBeCloseTo((100 * 72) / 25.4, 5);
    }
    assertPrintBounds(destination, 68, 100);
    const base = join(directory, `label-${locale}`);
    await writeAssetLabel(label, base, { chromiumExecutable, locale });
    const image = await (await PDFDocument.create()).embedPng(await readFile(base + '.png'));
    expect([image.width, image.height]).toEqual([473, 178]);
    const labelText = execFileSync('pdftotext', [base + '.pdf', '-'], { encoding: 'utf8' });
    assertPrintBounds(base + '.pdf', 40, 15);
    for (const text of Object.values(label)) expect(labelText).toContain(text);
    expect(labelText).not.toContain('WIPE-KEY');
    const pngBytes = await readFile(base + '.png');
    const density = pngBytes.indexOf(Buffer.from('pHYs')) + 4;
    expect(density).toBeGreaterThan(4);
    expect(pngBytes.readUInt32BE(density)).toBe(11811);
    expect(pngBytes.readUInt32BE(density + 4)).toBe(11811);
    expect(pngBytes[density + 8]).toBe(1);
  }
  const data = record();
  data.profiles[0]!.fields.sessionMessengerId = value('  BEGIN\t\n' + 'x'.repeat(16_368) + '\nTAIL  ');
  const destination = join(directory, 'overflow.pdf');
  await writeDeviceBoxCard(data, destination, { chromiumExecutable });
  const pages = execFileSync('pdftotext', ['-raw', destination, '-'], { encoding: 'utf8' })
    .split('\f')
    .filter((page) => page.trim());
  expect(pages.length).toBeGreaterThan(2);
  expect((pages.join('').match(/x{2,}/gu) ?? []).join('')).toHaveLength(16_368);
  expect(pages.at(-1)).toContain('TAIL');
  assertPrintBounds(destination, 68, 100);
  for (const page of pages.filter((page) => page.includes('xxx'))) {
    expect(page).toContain('Właściciel');
    expect(page).toContain('SYNTHETIC-SERIAL');
  }
  await expect(
    writeAssetLabel({ ...label, assetId: 'a'.repeat(128) }, join(directory, 'too-long'), {
      chromiumExecutable,
    }),
  ).rejects.toThrow('content fits');
  await expect(stat(join(directory, 'too-long.pdf'))).rejects.toThrow();
});
