import { describe, expect, it } from './../test-api.js';
import type { ProjectCliContext } from '../../packages/cli/src/arguments.js';
import { registryOutputPath } from '../../packages/cli/src/registry-output.js';

const context = (output: string) =>
  ({
    project: { root: '/private/project' },
    resources: '/opt/pxv',
    value: () => output,
  }) as unknown as ProjectCliContext;

describe('private registry export location', () => {
  it('allows explicit project secrets and independent private destinations', () => {
    expect(registryOutputPath(context('/private/project/secrets/export.json'))).toBe(
      '/private/project/secrets/export.json',
    );
    expect(registryOutputPath(context('/private/export.json'))).toBe('/private/export.json');
    expect(registryOutputPath(context('/opt/pxv-other/export.json'))).toBe('/opt/pxv-other/export.json');
  });
  it('rejects project public files and distributable resource paths', () => {
    for (const path of [
      '/private/project/inventory.json',
      '/private/project',
      '/opt/pxv/docs/export.md',
      '/opt/pxv',
    ])
      expect(() => registryOutputPath(context(path))).toThrow('under project secrets');
  });
  it('resolves traversal before checking the protected boundary', () => {
    expect(() => registryOutputPath(context('/private/project/secrets/../public.json'))).toThrow(
      'under project secrets',
    );
  });
});
