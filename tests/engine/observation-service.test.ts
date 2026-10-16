import { describe, expect, it, vi } from 'vitest';
import {
  resolvePolicy,
  type ArtifactPolicy,
  type SelectedTarget,
  type SharedApkEffect,
} from '@pxv/contracts';
import { ObservationService } from '../../packages/engine/src/observation-service.js';
import type { ProjectContext } from '../../packages/engine/src/project.js';
import type { WorkflowPort } from '../../packages/engine/src/workflow-types.js';
import { device, hashA, hashB, observation, policy, product, project } from '../contracts/fixtures.js';
import { MemoryPort } from './fixtures.js';
const context: ProjectContext = {
  root: '/read-only-fixture',
  config: project,
  policy,
  product,
  inventory: { schemaVersion: 1, devices: [device] },
  resolved: resolvePolicy(policy, project, product),
  revisions: { config: hashA, policy: hashA, inventory: hashA },
};
const target: SelectedTarget = { device, transport: { kind: 'usb', serial: device.canonicalSerial } };
const owner = { userId: 0, serialNo: 0, name: 'Administrator' };
const secondary = { userId: 10, serialNo: 42, name: 'Private' };
const artifact: ArtifactPolicy = {
  packageId: 'org.example.vpn',
  versionCode: 20,
  sha256: hashA,
  signerSha256: hashB,
};
function effect(packageId = artifact.packageId): SharedApkEffect {
  return { packageId, users: [{ user: owner, versionCode: 12, signerSha256: hashB }] };
}

describe('enrolled read-only observations', () => {
  it('accepts exact enrolled USB and Wi-Fi targets and passes policy plus cancellation through the observation port', async () => {
    const port = new MemoryPort();
    const inspect = vi.spyOn(port, 'inspect');
    const service = new ObservationService(context, port);
    const signal = new AbortController().signal;
    for (const selected of [
      target,
      { device, transport: { kind: 'wifi' as const, serial: '192.0.2.10:5555' } },
    ]) {
      expect(() => service.assertTarget(selected)).not.toThrow();
      expect(await service.observe(selected, signal)).toEqual(observation);
      expect(inspect).toHaveBeenLastCalledWith(selected, policy, signal);
    }
    expect(port.calls).toEqual([]);
  });
  it('rejects unenrolled or edited device identities and transports before inspection', async () => {
    const port = new MemoryPort();
    const inspect = vi.spyOn(port, 'inspect');
    const service = new ObservationService(context, port);
    for (const selected of [
      { ...target, device: { ...device, assetId: 'unknown' } },
      { ...target, device: { ...device, canonicalSerial: 'REPLACED' } },
      { ...target, transport: { kind: 'wifi' as const, serial: '192.0.2.11:5555' } },
    ])
      await expect(service.observe(selected)).rejects.toThrow(
        'Target differs from the enrolled device or approved transport',
      );
    expect(inspect).not.toHaveBeenCalled();
  });
  it('requires validated measured identity and never converts failed or cancelled inspection to absence', async () => {
    const port = new MemoryPort();
    const service = new ObservationService(context, port);
    port.observation = { ...structuredClone(observation), device: { ...device, canonicalSerial: 'WRONG' } };
    await expect(service.observe(target)).rejects.toThrow('Observed identity differs from enrollment');
    port.observation = { ...structuredClone(observation), schemaVersion: 2 as 1 };
    await expect(service.observe(target)).rejects.toThrow();
    port.observation = structuredClone(observation);
    const controller = new AbortController();
    controller.abort(new Error('Operator cancelled inspection'));
    await expect(service.observe(target, controller.signal)).rejects.toThrow('Operator cancelled inspection');
    vi.spyOn(port, 'inspect').mockRejectedValueOnce(new Error('Transport unavailable'));
    await expect(service.observe(target)).rejects.toThrow('Transport unavailable');
  });
});
describe('device-wide shared APK observations', () => {
  it('skips inspection for an empty request but rejects installs when the shared-effect port is unavailable', async () => {
    const port = new MemoryPort();
    const inspect = vi.spyOn(port, 'sharedEffects');
    const service = new ObservationService(context, port);
    expect(await service.sharedEffects(target, [])).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
    const missing = new Proxy<WorkflowPort>(port, {
      get(value, name, receiver): unknown {
        return name === 'sharedEffects' ? undefined : (Reflect.get(value, name, receiver) as unknown);
      },
    });
    await expect(
      new ObservationService(context, missing).sharedEffects(target, [artifact.packageId]),
    ).rejects.toThrow('Device-wide APK review service is required');
  });
  it('returns canonical effects for every requested package and preserves exact stable user identities', async () => {
    const port = new MemoryPort();
    const signal = new AbortController().signal;
    const first = effect();
    first.users.unshift({ user: secondary, versionCode: 12, signerSha256: hashB });
    const other = effect('org.example.other');
    const inspect = vi.spyOn(port, 'sharedEffects').mockResolvedValue([first, other]);
    const service = new ObservationService(context, port);
    const measured = await service.sharedEffects(target, [artifact.packageId, 'org.example.other'], signal);
    expect(measured.map((row) => row.packageId)).toEqual(['org.example.other', artifact.packageId]);
    expect(measured[1]?.users.map((row) => row.user.serialNo)).toEqual([0, 42]);
    expect(inspect).toHaveBeenCalledWith(target, [artifact.packageId, 'org.example.other'], signal);
    expect(first.users[0]?.user).toEqual(secondary);
  });
  it('rejects incomplete, duplicate or malformed effects instead of authorizing an uncertain install', async () => {
    const port = new MemoryPort();
    const inspect = vi.spyOn(port, 'sharedEffects');
    const service = new ObservationService(context, port);
    inspect.mockResolvedValueOnce([]);
    await expect(service.sharedEffects(target, [artifact.packageId])).rejects.toThrow('incomplete');
    inspect.mockResolvedValueOnce([effect(), effect()]);
    await expect(service.sharedEffects(target, [artifact.packageId])).rejects.toThrow(
      'Duplicate shared APK effects',
    );
    inspect.mockResolvedValueOnce([
      { ...effect(), users: [{ user: owner, versionCode: -1, signerSha256: hashB }] },
    ]);
    await expect(service.sharedEffects(target, [artifact.packageId])).rejects.toThrow();
  });
  it('predicts device-wide upgrades without mutating baseline effects and enrolls only a missing stable user', () => {
    const service = new ObservationService(context, new MemoryPort());
    const baseline = [effect(), effect('org.example.other')];
    const saved = structuredClone(baseline);
    const next = service.nextEffects(baseline, artifact, secondary);
    expect(baseline).toEqual(saved);
    expect(next.find((row) => row.packageId === artifact.packageId)?.users).toEqual([
      { user: owner, versionCode: 20, signerSha256: hashB },
      { user: secondary, versionCode: 20, signerSha256: hashB },
    ]);
    expect(next.find((row) => row.packageId === 'org.example.other')).toEqual(effect('org.example.other'));
    expect(service.nextEffects(next, artifact, secondary)).toEqual(next);
    const replacement = { ...secondary, serialNo: 43 };
    expect(() => service.nextEffects(next, artifact, replacement)).toThrow();
  });
});
