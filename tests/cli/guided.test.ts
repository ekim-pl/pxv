import { expect, it } from 'vitest';
import { renderProjectGuide, guidedNextSteps } from '../../packages/cli/src/guided.js';
import type { RunRecord } from '@pxv/engine';
import { policy, product } from '../contracts/fixtures.js';

it('derives localized guides from arbitrary policy profiles and device capabilities without secret values', () => {
  const selected = {
    ...policy,
    profiles: policy.profiles.map((profile) => ({
      ...profile,
      name: `Custom ${profile.id}`,
      settings: [{ namespace: 'secure' as const, key: 'safe_key', value: 'SECRET_SENTINEL' }],
    })),
  };
  const en = renderProjectGuide(product, selected, 'pixel', 'en');
  expect(en).toContain('Custom');
  expect(en).toContain('Required checks');
  expect(en).not.toContain('SECRET_SENTINEL');
  const pl = renderProjectGuide(product, selected, 'emulator', 'pl');
  expect(pl).toContain('Wymagane kontrole');
  expect(pl).toContain('emulator_image_provenance');
  expect(
    renderProjectGuide(
      product,
      {
        ...selected,
        profiles: selected.profiles.map((profile) => {
          const copy = { ...profile };
          delete copy.language;
          return copy;
        }),
        capabilities: [],
      },
      'pixel',
      'en',
    ),
  ).toContain('No additional private setup');
});
it('guides manual receipts and review refresh while never replaying interrupted mutations', () => {
  const base: RunRecord = {
    id: 'run',
    planId: 'plan',
    status: 'pending',
    operator: 'operator',
    createdAt: new Date().toISOString(),
    manualGate: 'normal_credentials',
  };
  const steps = guidedNextSteps(product, base, 'en', "/tmp/project '$(test)'", 'all');
  expect(steps.join('\n')).toContain('device attest');
  expect(steps.join('\n')).toContain('agent refresh');
  expect(steps.join('\n')).toContain("'\\''");
  expect(
    guidedNextSteps(product, { ...base, manualGate: 'language:owner' }, 'pl', '/tmp/project', 'all').join(
      '\n',
    ),
  ).not.toContain('device attest');
  for (const status of ['needs-inspection', 'failed', 'cancelled'] as const)
    expect(guidedNextSteps(product, { ...base, status }, 'pl', '/tmp/project', 'all').join('\n')).toContain(
      'Nie odtwarzaj',
    );
  expect(
    guidedNextSteps(product, { ...base, status: 'completed' }, 'en', '/tmp/project', 'all').join('\n'),
  ).toContain('before finalization');
});
