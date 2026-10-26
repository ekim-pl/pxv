import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from './../test-api.js';
import type { PhoneRegistryRecord } from '@pxv/contracts';
import type { Runtime } from '@pxv/runtime';
import { resolveInsertMetadata, writeCredentialInsert } from '../../packages/guides/src/index.js';
import { product } from '../contracts/fixtures.js';
import { renderCredentialInsert } from '../../packages/guides/src/credential-insert.js';

const at = '2026-10-17T12:00:00.000Z';
const value = (value: string, state: 'initial' | 'current' | 'unknown' | 'stale' = 'current') => ({
  value,
  state,
  updatedAt: at,
  ...(state === 'current' ? { confirmedAt: at } : {}),
});
function record(): PhoneRegistryRecord {
  return {
    assetId: 'phone-01',
    canonicalSerial: 'PRIVATE-SERIAL',
    codename: 'shiba',
    revision: 2,
    generation: { deviceEpoch: '', profileEpochs: {} },
    fields: {
      duressPin: value('DURESS-PIN'),
      duressPassword: value('DURESS-PASSWORD', 'stale'),
      phoneNumber: value('+48000000000', 'unknown'),
    },
    profiles: [
      {
        profileId: 'owner',
        user: { userId: 0, serialNo: 0, name: 'Właściciel' },
        fields: {
          pin: value('123456', 'initial'),
          password: value('<script>&"\'\nZażółć gęślą jaźń'),
          sessionMessengerId: value('SESSION-ID'),
          protonVpnUsername: value('VPN-USER'),
          protonVpnPassword: value('VPN-PASSWORD'),
          phoneNumber: value('+48111111111'),
          oblivionNotificationWipeKey: value('OBLIVION-KEY'),
        },
      },
      { profileId: 'work', user: { userId: 10, serialNo: 1, name: 'Work' }, fields: {} },
    ],
  };
}
const options = { exportedAt: at, support: 'Private support', model: 'Pixel 8' };
let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});
async function root() {
  const path = await mkdtemp('/tmp/pxv-insert-test-');
  roots.push(path);
  return path;
}

describe('private credential insert', () => {
  it('prints an optional project name literally in either locale without changing legacy output', () => {
    for (const locale of ['en', 'pl'] as const) {
      const html = renderCredentialInsert(record(), {
        ...options,
        locale,
        projectName: '<Fleet> & **Zażółć**',
      });
      expect(html).toContain(locale === 'en' ? '<strong>Project:</strong>' : '<strong>Projekt:</strong>');
      expect(html).toContain('&lt;Fleet&gt; &amp; **Zażółć**');
      expect(renderCredentialInsert(record(), { ...options, locale })).not.toContain(
        '<strong>' + (locale === 'en' ? 'Project' : 'Projekt') + ':</strong>',
      );
    }
  });
  it('renders EN/PL values, dates, missing fields and effective states; separates destructive values', () => {
    for (const locale of ['en', 'pl'] as const) {
      const html = renderCredentialInsert(record(), { ...options, locale });
      expect(html).toContain(`lang="${locale}"`);
      for (const sentinel of [
        'DURESS-PIN',
        'DURESS-PASSWORD',
        'SESSION-ID',
        'VPN-USER',
        'VPN-PASSWORD',
        'OBLIVION-KEY',
        '+48000000000',
        '+48111111111',
        '123456',
      ])
        expect(html).toContain(sentinel);
      expect(html).toContain('Zażółć gęślą jaźń');
      expect(html).toContain('&lt;script&gt;&amp;&quot;&#39;');
      expect(html.match(/PRIVATE-SERIAL/gu)).toHaveLength(2);
      expect(html).toContain(locale === 'en' ? 'Phone serial number' : 'Numer seryjny telefonu');
      expect(html).toContain(
        locale === 'en' ? 'Fill in manually / not configured:' : 'Uzupełnij ręcznie / nie skonfigurowano:',
      );
      expect(html).toContain(
        locale === 'en' ? 'STALE - verify privately' : 'NIEAKTUALNE - sprawdź prywatnie',
      );
      expect(html).toContain(locale === 'en' ? 'UNKNOWN - verify privately' : 'NIEZNANE - sprawdź prywatnie');
      expect(html).toContain('2026-10-17 12:00:00Z');
      expect(html).toContain('Pixel 8 (shiba)');
      const ordinary = html.slice(0, html.indexOf('DURESS-PIN'));
      expect(ordinary).toContain('VPN-PASSWORD');
      expect(ordinary).not.toContain('OBLIVION-KEY');
    }
  });
  it('preserves maximum-length, multiline and whitespace-sensitive values without artificial breaks', () => {
    const data = record();
    const secret = '  start\t\r\n' + 'x'.repeat(16_360) + '\nTAIL  ';
    data.profiles[0]!.fields.password = value(secret);
    const html = renderCredentialInsert(data, options, 'ordinary');
    expect(html).toContain('<pre class="value">' + secret + '</pre>');
    expect(html).not.toContain('DURESS-PIN');
    expect(html).not.toContain('OBLIVION-KEY');
    expect(html.match(/class="write-line"/gu)).toHaveLength(6);
    expect(html).toContain('PRIVATE-SERIAL');
  });
  it('groups ordinary values once per profile and deduplicates metadata with explicit exceptions', () => {
    const data = record();
    const html = renderCredentialInsert(data, options, 'ordinary');
    expect(html.match(/Profile: Właściciel/gu)).toHaveLength(1);
    expect(html.match(/Last operator-confirmed/gu)).toHaveLength(1);
    expect(html).toContain('INITIAL');
    expect(html).toContain('UNKNOWN - verify privately');
    expect(html).not.toContain(data.assetId);
    expect(html).not.toContain('Recovery');
    expect(html).not.toContain('Backup');
    data.profiles[0]!.fields.protonVpnPassword!.updatedAt = '2026-10-18T13:12:11.123+02:00';
    expect(renderCredentialInsert(data, options, 'ordinary')).toContain('2026-10-18 13:12:11.123+02:00');
    const destructive = renderCredentialInsert(data, options, 'erasure');
    expect(destructive).not.toContain('VPN-PASSWORD');
    expect(destructive).not.toContain('SESSION-ID');
    expect(destructive).toContain('DURESS-PIN');
    expect(destructive).toContain('OBLIVION-KEY');
    data.fields = {};
    data.profiles = [];
    expect(renderCredentialInsert(data, options, 'ordinary')).toContain('No values recorded.');
    expect(renderCredentialInsert(data, options, 'erasure')).toContain('No values recorded.');
  });
  it('retains every saved SIM number at device scope and leaves every missing field writable in EN/PL', () => {
    const data = record();
    const numbers = '+48000000001\n+48000000002';
    data.fields = { phoneNumber: value(numbers, 'unknown') };
    data.profiles[0]!.fields = { phoneNumber: value('+48000000003') };
    const before = structuredClone(data);
    for (const locale of ['en', 'pl'] as const) {
      const ordinary = renderCredentialInsert(data, { ...options, locale }, 'ordinary');
      expect(ordinary).toContain(locale === 'en' ? 'SIM phone numbers' : 'Numery telefonów SIM');
      expect(ordinary.match(/\+48000000001/gu)).toHaveLength(1);
      expect(ordinary).toContain('<pre class="value">' + numbers + '</pre>');
      expect(ordinary).toContain('+48000000003');
      expect(ordinary.match(/class="write-line"/gu)).toHaveLength(11);
      const erasure = renderCredentialInsert(data, { ...options, locale }, 'erasure');
      expect(erasure.match(/class="write-line"/gu)).toHaveLength(4);
      expect(erasure).toContain('Work');
      expect(erasure).not.toContain('Last operator-confirmed');
      expect(erasure).not.toContain('Ostatnio potwierdzone przez operatora');
      expect(erasure).not.toContain(numbers);
      delete data.fields.phoneNumber;
      expect(
        renderCredentialInsert(data, { ...options, locale }, 'ordinary').match(/class="write-line"/gu),
      ).toHaveLength(12);
      data.fields.phoneNumber = before.fields.phoneNumber!;
    }
    expect(data).toEqual(before);
  });
  it('writes only a private PDF and cleans the isolated renderer directory', async () => {
    const destination = join(await root(), 'private', 'insert.pdf');
    let temporary = '';
    const runtime: Runtime = {
      async run(args, settings) {
        temporary = settings!.env!['HOME']!;
        expect((await stat(temporary)).mode & 0o777).toBe(0o700);
        const source = fileURLToPath(args.at(-1)!);
        expect((await stat(source)).mode & 0o777).toBe(0o600);
        const html = await readFile(source, 'utf8');
        if (source.endsWith('insert-ordinary.html')) {
          expect(html).toContain('VPN-PASSWORD');
          expect(html).not.toContain('DURESS-PIN');
        } else {
          expect(html).toContain('DURESS-PIN');
          expect(html).not.toContain('VPN-PASSWORD');
        }
        expect(args).toContain('--disable-javascript');
        expect(args).toContain('--disable-background-networking');
        await writeFile(args.find((arg) => arg.startsWith('--print-to-pdf='))!.slice(15), await panelPdf());
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await writeCredentialInsert(record(), destination, {
      ...options,
      chromiumExecutable: '/local/chromium',
      runtime,
    });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await stat(join(destination, '..'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(destination, '..'))).toEqual(['insert.pdf']);
    await expect(stat(temporary)).rejects.toThrow();
    await expect(
      writeCredentialInsert(record(), destination, {
        ...options,
        chromiumExecutable: '/local/chromium',
        runtime,
      }),
    ).rejects.toThrow('Private credential insert export failed');
    const linked = join(destination, '..', 'linked.pdf');
    await symlink(destination, linked);
    await expect(
      writeCredentialInsert(record(), linked, { ...options, chromiumExecutable: '/local/chromium', runtime }),
    ).rejects.toThrow();
    await chmod(join(destination, '..'), 0o755);
    await expect(
      writeCredentialInsert(record(), join(destination, '..', 'unsafe.pdf'), {
        ...options,
        chromiumExecutable: '/local/chromium',
        runtime,
      }),
    ).rejects.toThrow();
  });
  it('sanitizes renderer failures and removes plaintext intermediates', async () => {
    let temporary = '';
    const destination = join(await root(), 'insert.pdf');
    const runtime: Runtime = {
      async run(_args, settings) {
        temporary = settings!.env!['HOME']!;
        await Promise.reject(new Error('VPN-PASSWORD'));
        return { code: 1, stdout: '', stderr: '' };
      },
    };
    await expect(
      writeCredentialInsert(record(), destination, {
        ...options,
        chromiumExecutable: '/local/chromium',
        runtime,
      }),
    ).rejects.toThrow(/^Private credential insert export failed;/u);
    await expect(stat(temporary)).rejects.toThrow();
    await expect(stat(destination)).rejects.toThrow();
  });
});

it('renders blank secret lines and the codename fallback while rejecting an unsupported locale', () => {
  const data = record();
  data.fields.phoneNumber = value('\n');
  const minimal = { exportedAt: at, support: 'Private support' };
  expect(renderCredentialInsert(data, minimal)).toContain('shiba');
  expect(renderCredentialInsert(data, minimal)).toContain('<pre class="value">\n</pre>');
  expect(() => renderCredentialInsert(data, { ...minimal, locale: 'de' as 'en' })).toThrow(
    'Unsupported insert locale',
  );
});
it('uses the default local command runner and rejects missing browser, failed exit and invalid PDF bytes', async () => {
  const directory = await root(),
    browser = join(directory, 'renderer.sh');
  await writeFile(join(directory, 'panel.pdf'), await panelPdf());
  await writeFile(
    browser,
    `#!/bin/sh\nfor arg do case "$arg" in --print-to-pdf=*) cp '${directory}/panel.pdf' "\${arg#*=}";; esac; done\n`,
    { mode: 0o700 },
  );
  await writeCredentialInsert(record(), join(directory, 'default.pdf'), {
    ...options,
    chromiumExecutable: browser,
  });
  expect(await readFile(join(directory, 'default.pdf'), 'utf8')).toContain('%PDF-');
  await expect(
    writeCredentialInsert(record(), join(directory, 'missing.pdf'), { ...options, chromiumExecutable: '' }),
  ).rejects.toThrow('Private credential insert');
  for (const code of [0, 1]) {
    const runtime: Runtime = {
      async run(args) {
        const output = args.find((arg) => arg.startsWith('--print-to-pdf='))!.slice(15);
        await writeFile(output, 'not a PDF');
        return { code, stdout: '', stderr: '' };
      },
    };
    await expect(
      writeCredentialInsert(record(), join(directory, `invalid-${code}.pdf`), {
        ...options,
        chromiumExecutable: browser,
        runtime,
      }),
    ).rejects.toThrow('Private credential insert');
  }
});

async function panelPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([(68 * 72) / 25.4, (100 * 72) / 25.4]);
  return pdf.save();
}

function populatedRecord(count: number): PhoneRegistryRecord {
  const data = record();
  data.profiles = Array.from({ length: count }, (_, i) => ({
    profileId: 'profile-' + i,
    user: {
      userId: i === 0 ? 0 : i + 9,
      serialNo: i,
      name: ['Owner', 'Work', 'Travel', 'Personal', 'Backup'][i] ?? 'Profile ' + i,
    },
    fields: {
      pin: value('12345' + i),
      phoneNumber: value('+4812345678' + i),
      sessionMessengerId: value('05' + String(i).repeat(64)),
      protonVpnUsername: value('vpn-user-' + i),
      protonVpnPassword: value('VPN-password-' + i + '-123456'),
      oblivionNotificationWipeKey: value('WIPE-key-' + i + '-12345678901234567890'),
    },
  }));
  return data;
}

it('renders one/five-profile EN/PL records with manual fields and readable A4 overflow (PXV_CHROMIUM)', async (context) => {
  const chromium = process.env['PXV_CHROMIUM'];
  if (!chromium) {
    context.skip('Set PXV_CHROMIUM to run real PDF/Poppler checks');
    return;
  }
  for (const count of [1, 5])
    for (const locale of ['en', 'pl'] as const) {
      const data = populatedRecord(count);
      const destination = join(await root(), `compact-${count}-${locale}.pdf`);
      const metadata = resolveInsertMetadata(product, {
        projectName: 'Zażółć <Flota> **nazwa**',
        support: { name: 'Wsparcie', phone: '+48 (123) 456 789' },
      });
      await writeCredentialInsert(data, destination, {
        ...options,
        ...metadata,
        locale,
        chromiumExecutable: chromium,
      });
      const pdf = await PDFDocument.load(await readFile(destination));
      expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
      expect(pdf.getPage(0).getWidth()).toBeCloseTo((297 * 72) / 25.4, 4);
      expect(pdf.getPage(0).getHeight()).toBeCloseTo((210 * 72) / 25.4, 4);
      const text = execFileSync('pdftotext', ['-raw', destination, '-'], { encoding: 'utf8' });
      expect(text).toContain(metadata.projectName);
      expect(text).toContain(metadata.support);
      expect(text).not.toContain(product.support.email);
      const sheets = text.split('\f').filter((page) => page.trim());
      for (const sheet of sheets) expect(sheet.match(/phone-01/gu)).toHaveLength(1);
      const erasureStart = sheets.findIndex((sheet) => sheet.includes('DURESS-PIN'));
      expect(erasureStart).toBeGreaterThan(0);
      const ordinary = sheets.slice(0, erasureStart).join('\n');
      const erasure = sheets.slice(erasureStart).join('\n');
      expect(ordinary).toContain('VPN-password-0');
      expect(ordinary).toContain(data.canonicalSerial);
      expect(erasure).toContain(data.canonicalSerial);
      expect(sheets[0]).toContain(locale === 'en' ? 'Phone serial number' : 'Numer seryjny telefonu');
      expect(ordinary).not.toContain('WIPE-key-');
      expect(ordinary).not.toContain('DURESS-PIN');
      expect(erasure).toContain('Oblivion');
      expect(erasure).toContain('WIPE-key-0');
      expect(erasure).not.toContain('VPN-password-');
      expect(ordinary).toContain(locale === 'en' ? 'Fill in manually' : 'Uzupełnij ręcznie');
      for (let i = 0; i < count; i++) {
        expect(ordinary).toContain('vpn-user-' + i);
        expect(ordinary.replaceAll(/\s/gu, '')).toContain('05' + String(i).repeat(64));
        expect(erasure).toContain('WIPE-key-' + i);
      }
      const xml = execFileSync('pdftohtml', ['-xml', '-zoom', '1', '-hidden', '-stdout', destination], {
        encoding: 'utf8',
      });
      const fonts = new Map(
        [...xml.matchAll(/<fontspec id="(\d+)" size="([\d.]+)"/gu)].map((font) => [font[1], Number(font[2])]),
      );
      for (const size of fonts.values()) expect(size).toBeGreaterThanOrEqual(8);
      for (const run of xml.matchAll(/<text[^>]*font="(\d+)"[^>]*>(?:VPN-password[^<]+|12345\d)<\/text>/gu))
        expect(fonts.get(run[1])).toBeGreaterThanOrEqual(10);
    }
});

it('preserves oversized secrets and long Unicode profile identities across extra sheets (PXV_CHROMIUM)', async (context) => {
  const chromium = process.env['PXV_CHROMIUM'];
  if (!chromium) {
    context.skip('Set PXV_CHROMIUM to run real PDF/Poppler checks');
    return;
  }
  const data = populatedRecord(1);
  data.assetId = 'm'.repeat(128);
  data.canonicalSerial = 'S'.repeat(256);
  const name = 'Właściciel bardzo długiego profilu '.repeat(4).trim();
  data.profiles[0]!.user.name = name;
  data.profiles[0]!.fields.password = value('x'.repeat(16_380) + 'TAIL');
  const destination = join(await root(), 'overflow.pdf');
  await writeCredentialInsert(data, destination, { ...options, chromiumExecutable: chromium });
  const pdf = await PDFDocument.load(await readFile(destination));
  expect(pdf.getPageCount()).toBeGreaterThan(2);
  const text = execFileSync('pdftotext', ['-raw', destination, '-'], { encoding: 'utf8' });
  expect((text.match(/x{3,}/gu) ?? []).join('')).toHaveLength(16_380);
  expect(text).toContain('TAIL');
  expect((text.match(/S{3,}/gu) ?? []).join('')).toHaveLength(512);
  const boxes = execFileSync('pdftotext', ['-bbox', destination, '-'], { encoding: 'utf8' });
  const assetBoxes = [...boxes.matchAll(/<word[^>]*xMax="([\d.]+)"[^>]*>m{128}<\/word>/gu)];
  expect(assetBoxes).toHaveLength(pdf.getPageCount());
  for (const box of assetBoxes) expect(Number(box[1])).toBeLessThan((284.5 * 72) / 25.4);

  for (const sheet of text.split('\f').filter((page) => page.trim())) {
    expect(sheet.split(data.assetId)).toHaveLength(2);
    if (sheet.includes('ordinary |')) {
      expect(sheet).not.toContain('DURESS-PIN');
      expect(sheet).not.toContain('WIPE-key-');
      expect(sheet).toContain('Właściciel');
    } else {
      expect(sheet).toContain('erasure |');
      expect(sheet).not.toContain('VPN-password-');
    }
  }
});

it('escapes untrusted profile names as HTML without injecting CSS or script', () => {
  const data = record();
  data.profiles[0]!.user.name = '</style><script>sentinel</script>';
  data.canonicalSerial = 'SERIAL-<script>&-ŻÓŁĆ';
  const html = renderCredentialInsert(data, options);
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  expect(css).not.toContain('<script>');
  expect(html).toContain('&lt;/style&gt;&lt;script&gt;sentinel&lt;/script&gt;');
  expect(html).toContain('SERIAL-&lt;script&gt;&amp;-ŻÓŁĆ');
});
