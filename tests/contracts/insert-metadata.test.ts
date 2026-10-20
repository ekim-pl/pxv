import { describe, expect, it } from '../test-api.js';
import {
  digest,
  resolvePolicy,
  validateProject,
  validateProjectInsertMetadata,
  verifyResolvedPolicy,
} from '@pxv/contracts';
import { policy, product, project } from './fixtures.js';

describe('project insert metadata', () => {
  it('preserves legacy project and snapshot bytes and binds optional metadata to reviews', () => {
    expect(validateProject(project)).toEqual(project);
    const { digest: retainedDigest, ...snapshot } = resolvePolicy(policy, project, product);
    expect(snapshot.project).not.toHaveProperty('insertMetadata');
    expect(retainedDigest).toBe(digest(snapshot));
    expect(verifyResolvedPolicy({ ...snapshot, digest: retainedDigest }).digest).toBe(retainedDigest);
    const changed = { ...project, insertMetadata: { projectName: 'Example Fleet' } };
    expect(resolvePolicy(policy, changed, product).digest).not.toBe(retainedDigest);
  });

  it.each([
    {},
    { projectName: 'Zażółć <Fleet> & **literal**' },
    { support: { name: 'Help', email: 'help@example.org' } },
    { support: { name: 'Help', url: 'https://example.org/support' } },
    { support: { name: 'Help', phone: '+48 (123) 456 789 ext. 2' } },
    {
      projectName: 'Fleet',
      support: { name: 'Help', email: 'help@example.org', url: 'https://example.org', phone: '123' },
    },
  ])('accepts independently optional metadata: %j', (metadata) => {
    expect(validateProjectInsertMetadata(metadata)).toEqual(metadata);
    expect(validateProject({ ...project, insertMetadata: metadata }).insertMetadata).toEqual(metadata);
  });

  it.each([
    null,
    { extra: true },
    { projectName: '' },
    { projectName: '   ' },
    { projectName: 'x'.repeat(4097) },
    { projectName: 'first\nsecond' },
    { projectName: 'a\u2028b' },
    { support: {} },
    { support: { name: 'Help' } },
    { support: { phone: '123' } },
    { support: { name: ' ', phone: '123' } },
    { support: { name: 'Help', phone: '\t123' } },
    { support: { name: 'Help', email: 'bad' } },
    { support: { name: 'Help', url: 'http://example.org' } },
    { support: { name: 'Help', url: 'https://user:pass@example.org' } },
    { support: { name: 'Help', url: 'https://example.org/#fragment' } },
    { support: { name: 'Help', phone: '123', private: 'unexpected' } },
  ])('rejects malformed metadata: %j', (metadata) => {
    expect(() => validateProjectInsertMetadata(metadata)).toThrow();
    expect(() => validateProject({ ...project, insertMetadata: metadata })).toThrow();
  });
});
