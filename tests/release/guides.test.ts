import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import type { HandoffRecord, PolicyPack, ProductDescriptor } from '@pxv/contracts';
import { resolvePolicy } from '@pxv/contracts';
import { project } from '../contracts/fixtures.js';
import { renderHandoff, writeHandoff, type HandoffSnapshot } from '../../packages/guides/src/index.js';

async function snapshot(): Promise<HandoffSnapshot> {
  const product = JSON.parse(await readFile('product.json', 'utf8')) as ProductDescriptor;
  const policy = JSON.parse(await readFile('policy-packs/simple/policy.json', 'utf8')) as PolicyPack;
  const resolvedPolicy = resolvePolicy(policy, { ...project, id: 'project' }, product);
  const record: HandoffRecord = {
    schemaVersion: 1,
    id: 'handoff-test',
    projectId: 'project',
    deviceSerial: 'private-device-serial',
    policyDigest: resolvedPolicy.digest,
    observationDigest: 'b'.repeat(64),
    locale: 'en',
    outcome: 'completed-custody',
    operator: 'Operator',
    createdAt: '2026-10-16T12:00:00.000Z',
    acceptedBy: 'Recipient',
    acceptedAt: '2026-10-16T12:05:00.000Z',
  };
  return { product, policy, record, assetId: 'phone-01', resolvedPolicy };
}

describe('recipient handoff artifacts', () => {
  test('EN/PL documents derive from accepted policy and exclude private inputs', async () => {
    const data = await snapshot();
    const source = { ...data, password: 'secret-sentinel', state: { account: 'secret-sentinel' } };
    expect(renderHandoff(source).markdown).toContain('Device handoff');
    expect(renderHandoff(source, 'pl').markdown).toContain('Przekazanie urządzenia');
    for (const locale of ['en', 'pl'] as const) {
      const result = renderHandoff(source, locale);
      expect(result.html).toContain(`lang="${locale}"`);
      expect(result.html).toContain('default-src');
      expect(result.markdown).toContain('phone\\-01');
      expect(result.html).toContain('phone-01');
      expect(JSON.stringify(result)).not.toContain('secret-sentinel');
      expect(JSON.stringify(result)).not.toContain('private-device-serial');
    }
    const directory = await mkdtemp('/tmp/pxv-guide-');
    const paths = await writeHandoff(data, directory);
    expect(await readFile(paths.markdown, 'utf8')).toContain('Recipient');
    expect((await stat(paths.html)).mode & 0o777).toBe(0o600);
    await expect(writeHandoff(data, directory, { pdf: true })).rejects.toThrow('explicit local Chromium');
  });
  test('escapes fork metadata and rejects unaccepted outcomes', async () => {
    const data = await snapshot();
    data.product.name = '<script>alert(1)</script>';
    data.resolvedPolicy = resolvePolicy(
      data.policy,
      data.resolvedPolicy.project,
      data.product,
      data.resolvedPolicy.engineDigest,
    );
    data.record.policyDigest = data.resolvedPolicy.digest;
    const result = renderHandoff(data);
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
    data.record.outcome = 'emulator';
    expect(() => renderHandoff(data)).toThrow('accepted handoff outcomes');
    data.record.outcome = 'ready-for-handoff';
    delete data.record.acceptedBy;
    delete data.record.acceptedAt;
    expect(renderHandoff(data).html).not.toContain('<dt>Accepted by</dt>');
    data.assetId = 'bad\nasset';
    expect(() => renderHandoff(data)).toThrow('public asset');
  });
  test('PDF rendering uses only an explicit browser with a private temporary profile', async () => {
    const data = await snapshot();
    const directory = await mkdtemp('/tmp/pxv-guide-');
    let observed: string[] = [];
    const paths = await writeHandoff(data, directory, {
      pdf: true,
      chromiumExecutable: '/approved/chromium',
      runtime: {
        async run(args, options) {
          observed = args;
          expect(options?.env?.['HOME']).toContain('.pdf-');
          const path = args.find((arg) => arg.startsWith('--print-to-pdf='))!.slice('--print-to-pdf='.length);
          await writeFile(path, '%PDF-1.4\nsynthetic unit fixture');
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    });
    expect(observed).toContain('--disable-background-networking');
    expect(observed).toContain('--disable-javascript');
    expect(observed.at(-1)).toMatch(/^file:\/\//u);
    expect(paths.pdf).toBeDefined();
    expect((await stat(paths.pdf!)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).some((path) => path.startsWith('.pdf-'))).toBe(false);
  });
  test('PDF failures preserve source documents and clean temporary browser data', async () => {
    const data = await snapshot();
    const directory = await mkdtemp('/tmp/pxv-guide-');
    await expect(
      writeHandoff(data, directory, {
        pdf: true,
        chromiumExecutable: '/approved/chromium',
        runtime: {
          async run(args) {
            const path = args
              .find((arg) => arg.startsWith('--print-to-pdf='))!
              .slice('--print-to-pdf='.length);
            await writeFile(path, 'invalid');
            return { code: 0, stdout: '', stderr: '' };
          },
        },
      }),
    ).rejects.toThrow('valid PDF');
    expect((await readdir(directory)).some((path) => path.endsWith('.html'))).toBe(true);
    expect((await readdir(directory)).some((path) => path.startsWith('.pdf-'))).toBe(false);
  });
  test('refuses documents using current edited policy instead of the accepted snapshot', async () => {
    const data = await snapshot();
    data.policy.name = 'Unaccepted replacement policy';
    expect(() => renderHandoff(data)).toThrow('exact accepted policy');
    data.resolvedPolicy.policy.name = 'Forged accepted policy';
    expect(() => renderHandoff(data)).toThrow('snapshot digest mismatch');
  });
});
