import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from './../test-api.js';
import { PIN_SCRAMBLING_KEY, toPolicyDocument } from '@pxv/contracts';
import { createProject, loadProject, saveInventory, WorkflowEngine, type WorkflowPort } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { device, product } from '../contracts/fixtures.js';
import { approveProject, basePolicy, executeWithWitnesses, MemoryPort } from './fixtures.js';

const setting = (value: string) => ({ namespace: 'secure' as const, key: PIN_SCRAMBLING_KEY, value });

class PinPort extends MemoryPort {
  credentialDefaultsPreflight = vi.fn<NonNullable<WorkflowPort['credentialDefaultsPreflight']>>(() =>
    Promise.resolve(),
  );
  setCredentialDefault = vi.fn<NonNullable<WorkflowPort['setCredentialDefault']>>((_target, user) => {
    this.calls.push(`credential:${user.userId}`);
    return Promise.resolve();
  });
}

describe('profile PIN scrambling in provisioning', () => {
  let root: string;
  let store: SqliteStore;
  let port: PinPort;
  let engine: WorkflowEngine;
  const target = { device, transport: device.transports[0]! };
  beforeEach(async () => {
    root = await mkdtemp('/tmp/pxv-pin-scrambling-');
    store = await SqliteStore.open(join(root, 'state.sqlite'));
    port = new PinPort();
    const policy = basePolicy();
    const owner = policy.profiles[0]!;
    owner.scramblePinLayout = true;
    owner.defaultCredential = { type: 'pin', secretRef: 'owner-pin' };
    policy.profiles.push({
      ...structuredClone(owner),
      id: 'work',
      name: 'Work',
      kind: 'secondary',
      scramblePinLayout: false,
      vpn: { packageId: null, alwaysOn: false, lockdown: false },
    });
    delete policy.profiles[1]!.defaultCredential;
    const code = join(root, 'code');
    await mkdir(join(code, 'packages/fixture'), { recursive: true });
    await writeFile(join(code, 'packages/fixture/index.js'), 'export const version=1;');
    const created = await createProject(join(root, 'project'), product, toPolicyDocument(policy), code);
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    engine = new WorkflowEngine({
      project: await approveProject(await loadProject(created.root, product, code)),
      store,
      port,
      artifacts: { snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }) },
      controlRoot: join(root, 'control'),
    });
  });
  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  async function executeProvision() {
    const prepared = await engine.prepare(target);
    const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Operator');
    return { prepared, result: await executeWithWitnesses(engine, run.id) };
  }

  it('applies independent layouts before PIN initialization and private confirmation', async () => {
    const apply = vi.spyOn(port, 'applySetting');
    const { prepared, result } = await executeProvision();
    expect(result).toMatchObject({ status: 'pending', manualGate: 'normal_credentials' });
    const actions = prepared.plan.actions;
    const pinIndex = actions.findIndex((action) => action.kind === 'default-credential');
    expect(
      actions.filter((action) => action.kind === 'setting' && action.setting.key === PIN_SCRAMBLING_KEY),
    ).toEqual([
      { kind: 'setting', profileId: 'admin', setting: setting('1') },
      { kind: 'setting', profileId: 'work', setting: setting('0') },
    ]);
    expect(actions.slice(pinIndex).some((action) => action.kind === 'setting')).toBe(false);
    const calls = apply.mock.calls.filter((call) => call[2].key === PIN_SCRAMBLING_KEY);
    expect(calls.map((call) => [call[1].userId, call[2].value])).toEqual([
      [0, '1'],
      [11, '0'],
    ]);
    expect(port.calls.lastIndexOf('setting')).toBeLessThan(port.calls.indexOf('credential:0'));
    expect(port.setCredentialDefault).toHaveBeenCalledOnce();
  });

  it('repairs setting drift after initial credentials were accepted without setting the PIN again', async () => {
    await executeProvision();
    port.observation.profiles[0]!.settings.find((item) => item.key === PIN_SCRAMBLING_KEY)!.value = '0';
    const { prepared, result } = await executeProvision();
    expect(prepared.plan.actions).toContainEqual({
      kind: 'setting',
      profileId: 'admin',
      setting: setting('1'),
    });
    expect(prepared.plan.actions.some((action) => action.kind === 'default-credential')).toBe(false);
    expect(result).toMatchObject({ status: 'pending', manualGate: 'normal_credentials' });
    expect(port.setCredentialDefault).toHaveBeenCalledOnce();
    expect(port.observation.profiles[0]?.settings).toContainEqual(setting('1'));
  });

  it('accepts matching contributed settings and rejects a contradictory layout', async () => {
    await expect(
      engine.prepareExtension(target, [{ kind: 'setting', profileId: 'admin', setting: setting('1') }]),
    ).resolves.toMatchObject({ operation: 'extension' });
    await expect(
      engine.prepareExtension(target, [{ kind: 'setting', profileId: 'admin', setting: setting('0') }]),
    ).rejects.toThrow('contradicts selected policy');
    expect(port.calls).toEqual([]);
  });

  it('stops before credential initialization when the layout setting fails', async () => {
    port.failAt = 'setting';
    const { result } = await executeProvision();
    expect(result.status).toBe('needs-inspection');
    expect(port.setCredentialDefault).not.toHaveBeenCalled();
  });
});
