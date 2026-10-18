import { describe, expect, it } from './../test-api.js';
import {
  defineExtension,
  defineIntegrationAdapter,
  EXTENSION_API_VERSION,
} from '../../packages/extension-sdk/src/index.js';
import type { Action } from '@pxv/contracts';

describe('public extension SDK', () => {
  it('exports a versioned immutable definition that returns planned core actions', async () => {
    const commands = {
      review: (): Action[] => [
        { kind: 'manual', capability: 'operator_signoff', instructions: 'Review the selected device.' },
      ],
    };
    const extension = defineExtension({ apiVersion: 1, commands });
    expect(extension.apiVersion).toBe(EXTENSION_API_VERSION);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(Object.isFrozen(extension.commands)).toBe(true);
    commands.review = () => [];
    expect(await extension.commands['review']?.({})).toEqual([
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Review the selected device.' },
    ]);
  });
  it('rejects unsupported API versions and invalid command contributions', () => {
    expect(() => defineExtension({ apiVersion: 2 as never, commands: {} })).toThrow('Unsupported');
    expect(() => defineExtension({ apiVersion: 1, commands: { 'bad name': () => [] } })).toThrow('Invalid');
    expect(() => defineExtension({ apiVersion: 1, commands: { review: 'bad' as never } })).toThrow('Invalid');
  });
  it('defines immutable integration adapters that only propose core actions', async () => {
    const adapter = defineIntegrationAdapter(() => [
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Review the integration plan.' },
    ]);
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.apiVersion).toBe(1);
    expect(await adapter.plan({})).toEqual([
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Review the integration plan.' },
    ]);
    expect(() => defineIntegrationAdapter(null as never)).toThrow('planning function');
  });
});
