import { readFileSync } from 'node:fs';
import { describe, expect, it } from '../test-api.js';
import { validatePolicy } from '@pxv/contracts';

describe('workflow inventory contracts', () => {
  it('uses the workflow inventory to validate supported independent profile layouts', () => {
    const inventory = JSON.parse(readFileSync('tests/acceptance/workflow-inventory.json', 'utf8')) as {
      profileLayouts: { pack: string; count: number }[];
    };
    for (const layout of inventory.profileLayouts)
      expect(
        validatePolicy(JSON.parse(readFileSync(`policy-packs/${layout.pack}/policy.json`, 'utf8')) as unknown)
          .profiles,
      ).toHaveLength(layout.count);
  });
});
