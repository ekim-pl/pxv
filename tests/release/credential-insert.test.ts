import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PhoneRegistryRecord } from '@pxv/contracts';
import type { Runtime } from '@pxv/runtime';
import { writeCredentialInsert } from '../../packages/guides/src/index.js';
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
      expect(html).not.toContain('PRIVATE-SERIAL');
      expect(html).toContain(locale === 'en' ? 'Not recorded' : 'Nie zapisano');
      expect(html).toContain(
        locale === 'en' ? 'STALE - verify privately' : 'NIEAKTUALNE - sprawdź prywatnie',
      );
      expect(html).toContain(locale === 'en' ? 'UNKNOWN - verify privately' : 'NIEZNANE - sprawdź prywatnie');
      expect(html).toContain(at);
      expect(html).toContain('Pixel 8 (shiba)');
      const ordinary = html.slice(0, html.indexOf('DURESS-PIN'));
      expect(ordinary).toContain('VPN-PASSWORD');
      expect(ordinary).not.toContain('OBLIVION-KEY');
    }
  });
  it('preserves a maximum-length secret across labeled continuation pages', () => {
    const data = record();
    data.profiles[0]!.fields.password = value('x'.repeat(16_380) + 'TAIL');
    const html = renderCredentialInsert(data, options);
    const values = [...html.matchAll(/<pre>(.*?)<\/pre>/gsu)].map((match) => match[1]!.replaceAll('\n', ''));
    expect(values.join('')).toContain('x'.repeat(16_380) + 'TAIL');
    expect(html).toContain('(continued)');
    expect(html.match(/<header>Asset: phone-01/gu)?.length).toBeGreaterThan(30);
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
        expect(await readFile(source, 'utf8')).toContain('VPN-PASSWORD');
        expect(args).toContain('--disable-javascript');
        expect(args).toContain('--disable-background-networking');
        await writeFile(
          args.find((arg) => arg.startsWith('--print-to-pdf='))!.slice(15),
          '%PDF-1.4\nsynthetic',
        );
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
