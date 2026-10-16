import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProject, loadProject, saveInventory, WorkflowEngine } from '@pxv/engine';
import { SqliteStore } from '@pxv/runtime';
import { device, product } from '../contracts/fixtures.js';
import { basePolicy, MemoryPort } from './fixtures.js';

describe('workflow service composition', () => {
  it('uses the default clock across planning, journals and execution while borrowing store ownership', async () => {
    const root = await mkdtemp('/tmp/pxv-composition-');
    const codeRoot = join(root, 'code');
    await mkdir(join(codeRoot, 'packages/core'), { recursive: true });
    await writeFile(join(codeRoot, 'packages/core/index.js'), 'export const build=1;');
    const created = await createProject(join(root, 'project'), product, basePolicy(), codeRoot);
    await saveInventory(created, { schemaVersion: 1, devices: [device] });
    const project = await loadProject(created.root, product, codeRoot);
    const store = await SqliteStore.open(join(root, 'state.sqlite'));
    const close = vi.spyOn(store, 'close');
    try {
      const engine = new WorkflowEngine({
        project,
        store,
        port: new MemoryPort(),
        artifacts: {
          snapshot: (artifact, path) => Promise.resolve({ ...artifact, path }),
        },
        controlRoot: join(root, 'control'),
      });
      const target = { device, transport: device.transports[0]! };
      const prepared = await engine.prepare(target);
      expect(Date.parse(prepared.plan.createdAt)).toBeLessThanOrEqual(engine.clock().getTime());
      const run = await engine.submit(prepared.plan.id, prepared.reviewSummary, 'Alice');
      expect((await engine.execute(run.id)).status).toBe('pending');
      await engine.event(run.id, 'composition-note', { decision: 'reviewed' });
      expect((await store.events<{ type: string }>(run.id)).at(-1)?.event.type).toBe('composition-note');
      expect(close).not.toHaveBeenCalled();
      expect((await engine.state('all')).planDigest).toBe(prepared.plan.digest);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
