import { afterEach, beforeEach, expect, it, vi } from './../test-api.js';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toPolicyDocument, validatePolicy } from '@pxv/contracts';
import { device } from '../contracts/fixtures.js';
import { createMaster, projectSnapshot, verifyMaster } from '../../tools/lib/personal-master.mjs';
import { createPersonalMaster } from '../../tools/lib/personal-workflows.mjs';
import { treeFiles } from '../../tools/lib/personal-files.mjs';
import { personalFixture, type PersonalFixture } from './personal-recovery-fixtures.js';

let fixture: PersonalFixture;
beforeEach(async () => {
  fixture = await personalFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture.root, { recursive: true, force: true });
});

async function modelPolicy() {
  const document = toPolicyDocument(fixture.selected);
  const akita = document.os!.akita!;
  document.os!.husky = {
    ...akita,
    codename: 'husky',
    url: akita.url.replace('akita-', 'husky-'),
    signatureUrl: akita.signatureUrl.replace('akita-', 'husky-'),
  };
  await writeFile(join(fixture.projectRoot, 'policy.json'), JSON.stringify(document));
  const lock = JSON.parse(await readFile(join(fixture.projectRoot, 'policy.lock.json'), 'utf8')) as object;
  await writeFile(
    join(fixture.projectRoot, 'policy.lock.json'),
    JSON.stringify({ ...lock, policy: validatePolicy(document) }),
  );
  return document;
}

it('creates and verifies a master for the exact enrolled model without changing its authored source or lock', async () => {
  await modelPolicy();
  const husky = {
    ...device,
    assetId: 'second',
    canonicalSerial: 'HUSKY1',
    codename: 'husky',
    model: 'Pixel 8 Pro',
    transports: [{ kind: 'usb', serial: 'HUSKY1' }],
  };
  await writeFile(
    join(fixture.projectRoot, 'inventory.json'),
    JSON.stringify({ schemaVersion: 1, devices: [device, husky] }),
  );
  const paths = ['policy.json', 'policy.lock.json'].map((name) => join(fixture.projectRoot, name));
  const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const snapshot = await projectSnapshot(fixture.projectRoot, husky.canonicalSerial);
  expect(snapshot.os.codename).toBe('husky');
  const manifest = (await createMaster({
    project: fixture.projectRoot,
    usb: fixture.usb,
    destination: fixture.destination,
    report: { ...fixture.report, deviceSerial: husky.canonicalSerial },
    expected: ['admin'],
    identity: fixture.identity,
    coverage: fixture.coverage,
    adapter: fixture.definition,
  })) as { codename: string };
  expect(manifest.codename).toBe('husky');
  const verified = await verifyMaster(fixture.destination);
  expect(verified.policy).not.toHaveProperty('schemaVersion');
  expect(verified.policy.profiles[0]?.packages[0]?.path).toBe('artifacts/app.apk');
  expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(before);
  const manifestPath = join(fixture.destination, 'master.json');
  const retained = JSON.parse(await readFile(manifestPath, 'utf8')) as object;
  await writeFile(manifestPath, JSON.stringify({ ...retained, codename: 'unsupported' }));
  await expect(verifyMaster(fixture.destination)).rejects.toThrow('Master OS identity differs');
});

it('rejects malformed sources and requires a current normalized lock', async () => {
  const invalid = { ...toPolicyDocument(fixture.selected), unexpected: true };
  await writeFile(join(fixture.projectRoot, 'policy.json'), JSON.stringify(invalid));
  await expect(projectSnapshot(fixture.projectRoot, device.canonicalSerial)).rejects.toThrow('unexpected');
  const document = await modelPolicy();
  document.profiles[0]!.name = 'Changed after review';
  await writeFile(join(fixture.projectRoot, 'policy.json'), JSON.stringify(document));
  await expect(projectSnapshot(fixture.projectRoot, device.canonicalSerial)).rejects.toThrow(
    'current policy lock',
  );
});

it('requires explicit model selection for mixed-model new setups and rejects missing pins before commands or writes', async () => {
  await modelPolicy();
  const session = {
    root: fixture.root,
    bin: '/no/device/commands',
    project: join(fixture.root, 'new-project'),
    asset: 'new-device',
    operator: 'Owner',
    signal: new AbortController().signal,
    prompt: () => Promise.reject(new Error('Unexpected prompt')),
  };
  const options = {
    'dry-run': true,
    policy: join(fixture.projectRoot, 'policy.json'),
    'source-root': fixture.projectRoot,
    serial: 'NEW1',
    model: 'Pixel 8 Pro',
    'usb-root': fixture.usb,
    'backup-dir': fixture.destination,
  };
  const before = await treeFiles(fixture.root);
  await expect(createPersonalMaster(session, options)).rejects.toThrow('--codename is required');
  await expect(createPersonalMaster(session, { ...options, codename: 'missing' })).rejects.toThrow(
    '--codename differs',
  );
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await createPersonalMaster(session, { ...options, codename: 'husky' });
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
    dryRun: true,
    device: { codename: 'husky', canonicalSerial: 'NEW1' },
    mutationsPerformed: false,
  });
  expect(await treeFiles(fixture.root)).toEqual(before);
  await expect(projectSnapshot(fixture.projectRoot, 'UNKNOWN_SERIAL')).rejects.toThrow(
    'one enrolled physical Pixel',
  );
});
