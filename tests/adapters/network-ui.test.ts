import { obligationWriter } from './obligations.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AndroidUserIdentity, RecoveryObligation, SelectedTarget } from '@pxv/contracts';
import {
  AndroidAdapter,
  NetworkProbeService,
  UiAutomation,
  ipInCidrs,
  observeEmulatorProvenance,
  type CleanupOptions,
  type CommandOptions,
  type NetworkObservation,
  type OperationOptions,
  type VerifiedArtifact,
} from '../../packages/adapters/src/index.js';
const user: AndroidUserIdentity = { userId: 10, serialNo: 42, name: 'work' };
const target: SelectedTarget = {
  device: {
    assetId: 'phone',
    kind: 'pixel',
    canonicalSerial: 'PIXEL',
    model: 'Pixel 8a',
    codename: 'akita',
    transports: [{ kind: 'usb', serial: 'PIXEL' }],
    groups: [],
  },
  transport: { kind: 'usb', serial: 'PIXEL' },
};
const helper: VerifiedArtifact = {
  packageId: 'org.pxv.probe',
  path: '/reviewed/immutable.apk',
  versionCode: 1,
  sha256: 'a'.repeat(64),
  signerSha256: 'b'.repeat(64),
};
const request = {
  endpoint: 'https://probe.example/ip',
  expectedEgressCidrs: ['203.0.113.0/24'],
  requireVpn: true,
};
const normal: NetworkObservation = {
  uid: 1010001,
  requestSucceeded: true,
  connectionObserved: true,
  vpnActive: true,
  egressIp: '203.0.113.5',
  errorType: null,
};
function probeOutput(observation: NetworkObservation) {
  return `INSTRUMENTATION_RESULT: pxv_json=${JSON.stringify({ schema_version: 1, uid: observation.uid, request_succeeded: observation.requestSucceeded, connection_observed: observation.connectionObserved, vpn_active: observation.vpnActive, egress_ip: observation.egressIp, error_type: observation.errorType })}\n`;
}
class ProbeAndroid extends AndroidAdapter {
  installed = false;
  cleanupOwners: string[] = [];
  outputs = [probeOutput(normal)];
  guarded = 0;
  fingerprint = 'accepted/build';
  mutations: string[][] = [];
  constructor() {
    super({ runner: { run: () => Promise.reject(new Error('No actual Android commands in this fixture')) } });
  }
  override guardTarget(): Promise<void> {
    return Promise.resolve();
  }
  override guardUser(): Promise<void> {
    this.guarded++;
    return Promise.resolve();
  }
  override listPackages(): Promise<Set<string>> {
    return Promise.resolve(new Set(this.installed ? ['org.pxv.probe'] : []));
  }
  override install(): Promise<void> {
    this.installed = true;
    return Promise.resolve();
  }
  override cleanup(
    _target: SelectedTarget,
    obligation: RecoveryObligation,
    options: CleanupOptions,
  ): Promise<void> {
    if (options.operationId !== obligation.ownerOperationId)
      return Promise.reject(new Error('Wrong child scope'));
    this.cleanupOwners.push(options.operationId);
    this.installed = false;
    return Promise.resolve();
  }
  override shell(_target: SelectedTarget, args: string[], options?: CommandOptions): Promise<string> {
    if (options?.mutation) this.mutations.push(args);
    if (args[0] === 'getprop') return Promise.resolve(args[1] === 'ro.kernel.qemu' ? '1' : this.fingerprint);
    return Promise.resolve(args[1] === 'instrument' ? (this.outputs.shift() ?? 'no observation') : '');
  }
  override vpn() {
    return Promise.resolve({ packageId: 'org.example.vpn', alwaysOn: true, lockdown: true });
  }
  override installedIdentity(_target: SelectedTarget, _user: AndroidUserIdentity, packageId: string) {
    return Promise.resolve({ packageId, versionCode: 1, signerSha256: 'b'.repeat(64) });
  }
  override launch(): Promise<void> {
    return Promise.resolve();
  }
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-network-ui-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe('app-UID network observations and cleanup ownership', () => {
  it('explicitly recovers pending services only after stable identity and fresh route measurements', async () => {
    const android = new ProbeAndroid();
    const service = new NetworkProbeService(android);
    const resolved: string[] = [];
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: 'old-service',
      operationId: 'parent',
      ownerOperationId: 'parent/probe',
      deviceSerial: target.device.canonicalSerial,
      user,
      kind: 'restart-service',
      resource: 'service',
      payload: {
        packageId: 'org.example.vpn',
        versionCode: 1,
        signerSha256: 'b'.repeat(64),
        request,
        vpn: { packageId: 'org.example.vpn', alwaysOn: true, lockdown: true },
      },
      status: 'pending',
    };
    const options = {
      lease: {},

      obligations: obligationWriter(
        obligation.operationId,
        () => Promise.resolve(),
        (id: string) => {
          resolved.push(id);
          return Promise.resolve();
        },
        obligation.ownerOperationId,
        new Map([[obligation.id, obligation.ownerOperationId]]),
      ),
    };
    await expect(
      service.recoverService(target, { ...obligation, deviceSerial: 'OTHER' }, helper, options),
    ).rejects.toThrow(/scope/);
    await expect(
      service.recoverService(
        target,
        { ...obligation, payload: { ...obligation.payload, versionCode: 2 } },
        helper,
        options,
      ),
    ).rejects.toThrow(/APK changed/);
    await expect(
      service.recoverService(target, { ...obligation, status: 'resolved' }, helper, options),
    ).rejects.toThrow(/scope/);
    await expect(
      service.recoverService(target, { ...obligation, ownerOperationId: 'another-owner' }, helper, options),
    ).rejects.toThrow(/scope/);
    await expect(
      service.recoverService(target, { ...obligation, operationId: 'another-root' }, helper, options),
    ).rejects.toThrow(/scope/);
    const evidence = await service.recoverService(
      target,
      { ...obligation, status: 'blocked' },
      helper,
      options,
    );
    expect(evidence.scope).toBe('probe-app-uid-https-only');
    expect(resolved.at(-1)).toBe(obligation.id);
  });
  it('handles canonical IPv4/IPv6 route ranges and rejects invalid ranges', () => {
    expect(ipInCidrs('203.0.113.5', ['203.0.113.0/24'])).toBe(true);
    expect(ipInCidrs('203.0.114.5', ['203.0.113.0/24'])).toBe(false);
    expect(ipInCidrs('2001:db8::5', ['2001:db8::/32'])).toBe(true);
    expect(ipInCidrs('::ffff:192.0.2.5', ['::ffff:c000:200/120'])).toBe(true);
    expect(() => ipInCidrs('203.0.113.5', ['203.0.113.1/24'])).toThrow(/host bits/);
    expect(() => ipInCidrs('invalid', ['203.0.113.0/24'])).toThrow(/valid IP/);
  });
  it('records intent before installation and cleans only the probe child obligations', async () => {
    const android = new ProbeAndroid();
    const service = new NetworkProbeService(android);
    const records: RecoveryObligation[] = [];
    const resolved: string[] = [];
    const result = await service.run(target, user, helper, request, {
      lease: {},

      obligations: obligationWriter(
        'root',
        (obligation) => {
          expect(android.installed).toBe(false);
          records.push(obligation);
          return Promise.resolve();
        },
        (id) => {
          resolved.push(id);
          return Promise.resolve();
        },
      ),
    });
    expect(result.scope).toBe('probe-app-uid-https-only');
    expect(records).toHaveLength(1);
    expect(records[0]?.ownerOperationId).toMatch(/^root:network-probe-/);
    expect(android.cleanupOwners).toEqual([records[0]?.ownerOperationId]);
    expect(resolved).toEqual([records[0]?.id]);
    expect(android.installed).toBe(false);
  });
  it('validates the endpoint and expected egress before installing and preserves existing helpers', async () => {
    const android = new ProbeAndroid();
    const service = new NetworkProbeService(android);
    const options = {
      lease: {},

      obligations: obligationWriter(
        'root',
        () => Promise.resolve(),
        () => Promise.resolve(),
      ),
    };
    await expect(
      service.run(target, user, helper, { ...request, endpoint: 'http://probe.example/ip' }, options),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      service.run(target, user, helper, { ...request, expectedEgressCidrs: [] }, options),
    ).rejects.toThrow(/CIDRs/);
    expect(android.installed).toBe(false);
    android.installed = true;
    await expect(service.run(target, user, helper, request, options)).rejects.toThrow(/another operation/);
    expect(android.cleanupOwners).toHaveLength(0);
  });
  it('rejects wrong-user, contradictory, malformed and out-of-route observations', async () => {
    const android = new ProbeAndroid();
    const service = new NetworkProbeService(android);
    for (const observation of [
      { ...normal, uid: 10001 },
      { ...normal, connectionObserved: false },
      { ...normal, egressIp: 'invalid' },
      { ...normal, errorType: 'raw diagnostic with secrets' },
    ]) {
      android.outputs = [probeOutput(observation)];
      await expect(service.observe(target, user, request, { lease: {} })).rejects.toThrow();
    }
    android.outputs = ['INSTRUMENTATION_RESULT: pxv_json={}\nINSTRUMENTATION_RESULT: pxv_json={}'];
    await expect(service.observe(target, user, request, { lease: {} })).rejects.toThrow(/exactly one/);
    expect(() => service.requireRoute({ ...normal, egressIp: '198.51.100.1' }, request)).toThrow(/approved/);
    expect(() => service.requireRoute({ ...normal, vpnActive: false }, request)).toThrow(/approved/);
  });
  it('recovers a stopped service with measured routes before resolving its obligation', async () => {
    const android = new ProbeAndroid();
    android.outputs = [
      probeOutput(normal),
      probeOutput({
        ...normal,
        requestSucceeded: false,
        connectionObserved: false,
        egressIp: null,
        errorType: 'ConnectException',
      }),
      probeOutput(normal),
    ];
    const records: RecoveryObligation[] = [];
    const resolved: string[] = [];
    const result = await new NetworkProbeService(android).run(
      target,
      user,
      helper,
      request,
      {
        lease: {},

        obligations: obligationWriter(
          'root',
          (record) => {
            records.push(record);
            return Promise.resolve();
          },
          (id) => {
            resolved.push(id);
            return Promise.resolve();
          },
        ),
      },
      ['org.example.vpn'],
    );
    expect(records.map((record) => record.kind)).toEqual(['remove-helper', 'restart-service']);
    expect(resolved).toEqual([records[1]?.id, records[0]?.id]);
    expect(result.failures).toHaveLength(1);
  });
});
describe('capability-based UI and emulator provenance', () => {
  it('requires exact accepted Android build and language with intact recorded evidence', async () => {
    const acceptance = join(directory, 'acceptance.json');
    const bytes = JSON.stringify({ recorded: 'fixture evidence only' });
    await writeFile(acceptance, bytes);
    const android = new ProbeAndroid();
    const options: OperationOptions = { lease: {} };
    const accepted = {
      id: 'language-pl',
      version: '1.0.0',
      buildFingerprint: 'accepted/build',
      languages: ['pl-PL' as const],
      capabilities: ['language' as const],
      acceptance: { path: acceptance, sha256: createHash('sha256').update(bytes).digest('hex') },
      execute: () => Promise.resolve({ observed: 'pl-PL' }),
    };
    const automation = new UiAutomation([accepted]);
    const measured = await automation.execute(
      android,
      target,
      user,
      { capability: 'language', language: 'pl-PL' },
      options,
    );
    expect(measured.status).toBe('measured');
    expect(
      (
        await automation.execute(
          android,
          target,
          user,
          { capability: 'language', language: 'en-US' },
          options,
        )
      ).status,
    ).toBe('manual-pending');
    android.fingerprint = 'new/unaccepted/build';
    expect(
      (
        await automation.execute(
          android,
          target,
          user,
          { capability: 'language', language: 'pl-PL' },
          options,
        )
      ).status,
    ).toBe('manual-pending');
    android.fingerprint = 'accepted/build';
    await writeFile(acceptance, 'changed');
    await expect(
      automation.execute(android, target, user, { capability: 'language', language: 'pl-PL' }, options),
    ).rejects.toThrow(/evidence changed/);
    expect(() => new UiAutomation([accepted, accepted])).toThrow(/Duplicate/);
  });
  it('records arbitrary final-setup capabilities without numeric scope rejection and cannot certify a phone', async () => {
    const image = join(directory, 'emulator.img');
    const bytes = 'accepted emulator fixture';
    await writeFile(image, bytes);
    const pin = {
      path: image,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fingerprint: 'accepted/build',
      source: 'local recorded test build',
    };
    const android = new ProbeAndroid();
    const emulator: SelectedTarget = {
      device: {
        ...target.device,
        kind: 'emulator',
        canonicalSerial: 'emulator-5554',
        transports: [{ kind: 'emulator', serial: 'emulator-5554' }],
      },
      transport: { kind: 'emulator', serial: 'emulator-5554' },
    };
    const evidence = await observeEmulatorProvenance(android, emulator, pin, [
      'language',
      'duress',
      'profile-setup',
    ]);
    expect(evidence.acceptance).toBe('emulator-only');
    expect(evidence.capabilities).toContain('duress');
    await expect(observeEmulatorProvenance(android, target, pin, [])).rejects.toThrow(/physical device/);
    android.fingerprint = 'changed/build';
    await expect(
      observeEmulatorProvenance(android, emulator, pin, [], new AbortController().signal),
    ).rejects.toThrow(/Running emulator/);
    android.fingerprint = 'accepted/build';
    await expect(
      observeEmulatorProvenance(android, emulator, { ...pin, sha256: '0'.repeat(64) }, []),
    ).rejects.toThrow(/provenance pin/);
  });
});

it('uses a supplied child capability without recording through or resolving its parent', async () => {
  const android = new ProbeAndroid();
  const records: RecoveryObligation[] = [];
  const root = obligationWriter(
    'root',
    (value) => {
      records.push(value);
      return Promise.resolve();
    },
    () => Promise.resolve(),
  );
  const child = root.child('caller');
  await new NetworkProbeService(android).run(target, user, helper, request, {
    lease: {},

    obligations: child,
  });
  const record = records[0];
  if (!record) throw new Error('No helper record');
  expect(record.operationId).toBe('root');
  expect(record.ownerOperationId).toMatch(/^root:caller:network-probe-/);
  await expect(root.resolve(record.id)).rejects.toThrow(/another owner/);
});
