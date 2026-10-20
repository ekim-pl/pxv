import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  toPolicyDocument,
  digest,
  type ExecutionPolicy,
  type SeedvaultAdapterDefinition,
} from '@pxv/contracts';
import type { SeedvaultReport } from '../../packages/engine/src/seedvault-types.js';
import { device, policy, product, project } from '../contracts/fixtures.js';

export async function personalFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pxv-personal-'));
  await writeFile(join(root, 'product.json'), JSON.stringify(product));
  const projectRoot = join(root, 'project'),
    usb = join(root, 'usb'),
    masters = join(root, 'masters');
  for (const path of [
    projectRoot,
    usb,
    masters,
    join(projectRoot, 'artifacts'),
    join(projectRoot, 'state'),
    join(projectRoot, 'secrets'),
    join(usb, '.SeedVaultAndroidBackup/.hidden'),
  ])
    await mkdir(path, { recursive: true });
  const apk = Buffer.from('reviewed APK fixture'),
    probe = Buffer.from('reviewed probe fixture');
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const selected: ExecutionPolicy = {
    ...structuredClone(policy),
    osByCodename: {
      akita: {
        codename: 'akita',
        release: '2026100600',
        url: 'https://releases.grapheneos.org/akita-install-2026100600.zip',
        signatureUrl: 'https://releases.grapheneos.org/akita-install-2026100600.zip.sig',
        signerPrincipal: 'contact@grapheneos.org',
        namespace: 'factory images',
        publicKey: 'ssh-ed25519 AAAA',
      },
    },
    profiles: policy.profiles.map((profile) => ({
      ...profile,
      packages: profile.packages.map((item) => ({ ...item, path: 'artifacts/app.apk', sha256: hash(apk) })),
      networkProbe: {
        artifact: {
          ...profile.packages[0]!,
          packageId: 'org.pxv.probe',
          path: 'artifacts/probe.apk',
          sha256: hash(probe),
        },
        endpoint: 'https://example.org/check',
        expectedEgressCidrs: ['192.0.2.0/24'],
        requireVpn: false,
        failurePackages: [],
      },
    })),
  };
  const identity = { product, engineVersion: '0.1.0', engineDigest: 'a'.repeat(64) };
  await writeFile(join(projectRoot, 'pxv.project.json'), JSON.stringify(project));
  await writeFile(join(projectRoot, 'policy.json'), JSON.stringify(toPolicyDocument(selected)));
  await writeFile(
    join(projectRoot, 'policy.lock.json'),
    JSON.stringify({ ...identity, project, policy: selected }),
  );
  await writeFile(
    join(projectRoot, 'inventory.json'),
    JSON.stringify({ schemaVersion: 1, devices: [device] }),
  );
  await writeFile(join(projectRoot, 'artifacts/app.apk'), apk);
  await writeFile(join(projectRoot, 'artifacts/probe.apk'), probe);
  await writeFile(join(projectRoot, 'state/pxv.sqlite3'), 'DO_NOT_COPY_HISTORY');
  await writeFile(join(projectRoot, 'secrets/signing.key'), 'DO_NOT_COPY_SECRET');
  await writeFile(join(usb, '.SeedVaultAndroidBackup/.hidden/chunk'), Buffer.from([0, 255, 128, 23]));
  await writeFile(join(usb, '.SeedVaultAndroidBackup/metadata'), 'encrypted metadata');
  const user = { userId: 0, serialNo: 0, name: 'Administrator' };
  const report: SeedvaultReport = {
    schemaVersion: 1,
    runId: 'backup-run',
    planId: 'backup-plan',
    operation: 'backup',
    deviceSerial: device.canonicalSerial,
    status: 'completed',
    cursor: 1,
    profiles: [
      {
        profileId: 'admin',
        user,
        status: 'completed',
        evidence: {
          profileId: 'admin',
          user,
          operation: 'backup',
          token: 'abc123',
          observedAt: new Date().toISOString(),
          adapterDigest: 'b'.repeat(64),
          apps: true,
          files: true,
          finalized: true,
          coverage: {
            scope: 'representative-ui-only',
            exclusions: 'not-enumerated',
            contentVerification: 'owner-required',
          },
          source: {
            profileId: 'admin',
            token: 'abc123',
            selector: { resourceId: 'seedvault:id/generation', text: 'Private generation label' },
            filesSelector: {
              resourceId: 'seedvault:id/files-generation',
              text: 'Private files generation label',
            },
          },
        },
      },
    ],
  };
  const adapter = await personalAdapter(root);
  const definition = JSON.parse(await readFile(adapter, 'utf8')) as SeedvaultAdapterDefinition;
  definition.acceptance.path = join(root, definition.acceptance.path);
  for (const profile of report.profiles) profile.evidence!.adapterDigest = digest(definition);
  const coverage = {
    schemaVersion: 1,
    profiles: [
      {
        profileId: 'admin',
        apps: [{ packageId: 'org.example.vpn', status: 'unknown' }],
        files: 'Review personal Documents and Downloads separately',
        exclusions: ['Hardware-backed private keys require service recovery'],
      },
    ],
    allAppsRecoverable: false,
  };
  const coverageFile = join(root, 'coverage.json');
  await writeFile(coverageFile, JSON.stringify(coverage));
  return {
    root,
    projectRoot,
    usb,
    masters,
    identity,
    selected,
    report,
    adapter,
    definition,
    coverage,
    coverageFile,
    destination: join(masters, 'generation-1'),
  };
}
async function personalAdapter(root: string) {
  const selector = { resourceId: 'com.stevesoltys.seedvault:id/test', text: 'Synthetic test only' };
  const completion = {
    apps: selector,
    files: selector,
    finalized: selector,
    idle: selector,
    generation: selector,
    fileGeneration: selector,
  };
  const recipe = {
    schemaVersion: 1 as const,
    id: 'synthetic-test-only',
    buildFingerprint: 'synthetic/test/build',
    package: {
      packageId: 'com.stevesoltys.seedvault' as const,
      versionCode: 1,
      signerSha256: 'b'.repeat(64),
    },
    activities: ['com.stevesoltys.seedvault/.TestActivity'],
    restoreSourceResourceId: selector.resourceId,
    restoreFileSourceResourceId: selector.resourceId,
    backup: {
      steps: [
        { action: 'start-backup' as const, selector },
        { action: 'observe-files-running' as const, selector },
      ],
      completion,
    },
    restore: {
      steps: [
        { action: 'select-source' as const },
        { action: 'start-restore' as const, selector },
        { action: 'select-file-source' as const },
        { action: 'start-files-restore' as const, selector },
        { action: 'observe-files-running' as const, selector },
      ],
      completion,
    },
  };
  const acceptance = {
    schemaVersion: 1,
    adapterId: recipe.id,
    buildFingerprint: recipe.buildFingerprint,
    package: recipe.package,
    recipeDigest: digest(recipe),
    testedAt: new Date().toISOString(),
    result: 'pass',
    profiles: ['synthetic-owner', 'synthetic-secondary'].map((profileId, index) => ({
      profileId,
      userSerialNo: index,
      evidenceSha256: 'c'.repeat(64),
      appsBackup: true,
      apksBackup: true,
      filesBackup: true,
      appsRestore: true,
      apksRestore: true,
      filesRestore: true,
      finalized: true,
      durableGeneration: true,
    })),
  };
  const bytes = JSON.stringify(acceptance);
  await writeFile(join(root, 'acceptance.json'), bytes);
  const definition: SeedvaultAdapterDefinition = {
    ...recipe,
    acceptance: { path: 'acceptance.json', sha256: createHash('sha256').update(bytes).digest('hex') },
  };
  const path = join(root, 'adapter.json');
  await writeFile(path, JSON.stringify(definition));
  return path;
}
export type PersonalFixture = Awaited<ReturnType<typeof personalFixture>>;

export async function fakeResources(fixture: PersonalFixture) {
  const root = join(fixture.root, 'resources');
  await mkdir(join(root, 'packages/engine/dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'product.json'), JSON.stringify(fixture.identity.product));
  await writeFile(
    join(root, 'packages/engine/dist/integrity.js'),
    'export async function engineIntegrity(){return ' + JSON.stringify(fixture.identity.engineDigest) + ';}',
  );
  return root;
}

export async function fakePxv(root: string, body: string) {
  const path = join(root, 'fake-pxv');
  await writeFile(path, `#!/usr/bin/env -S -u NODE_V8_COVERAGE ${process.execPath}\n${body}\n`, {
    mode: 0o700,
  });
  return path;
}
