import { describe, expect, it, vi } from 'vitest';
import { runRelease } from '../../packages/release/src/release-service.js';
import type { Candidate } from '../../packages/release/src/candidate.js';
const candidate = {
  directory: '/reviewed/candidate',
  manifest: { version: '0.1.0-preview.fixture' },
} as Candidate;
function services() {
  return {
    createCandidate: vi.fn(() => Promise.resolve(candidate)),
    buildFormats: vi.fn(() => Promise.resolve([])),
    promoteNpm: vi.fn(() => Promise.resolve()),
    write: vi.fn<(text: string) => void>(),
  };
}
describe('release command composition', () => {
  it('shows explicit build and promotion help without constructing a candidate', async () => {
    const deps = services();
    await runRelease(['--help'], deps);
    expect(deps.write).toHaveBeenCalledWith(expect.stringContaining('Publish verified npm artifact'));
    expect(deps.createCandidate).not.toHaveBeenCalled();
  });
  it('builds preview defaults and forwards only explicit stable tool and format choices', async () => {
    const deps = services();
    await runRelease([], deps);
    expect(deps.createCandidate).toHaveBeenLastCalledWith({ preview: true });
    expect(deps.buildFormats).toHaveBeenLastCalledWith(candidate, {
      formats: ['portable', 'deb', 'npm', 'oci'],
      loadDockerImage: true,
    });
    await runRelease(
      [
        '--release',
        '--source-root',
        '/source',
        '--output-root',
        '/output',
        '--supervisor',
        '/native',
        '--formats',
        'sea',
        '--postject',
        '/postject',
        '--signing-key',
        '/key',
        '--no-oci-load',
      ],
      deps,
    );
    expect(deps.createCandidate).toHaveBeenLastCalledWith({
      preview: false,
      sourceRoot: '/source',
      outputRoot: '/output',
      nativeBinary: '/native',
    });
    expect(deps.buildFormats).toHaveBeenLastCalledWith(candidate, {
      formats: ['sea'],
      loadDockerImage: false,
      postject: '/postject',
      signingKey: '/key',
    });
    expect(deps.write).toHaveBeenLastCalledWith(
      expect.stringContaining('"candidate": "/reviewed/candidate"'),
    );
  });
  it('requires complete explicit promotion coordinates and preserves dry-run intent', async () => {
    const deps = services();
    const args = [
      'promote',
      '--artifacts',
      '/artifacts',
      '--package',
      '/artifacts/release.tgz',
      '--registry',
      'https://registry.example/',
      '--allowed-signers',
      '/signers',
      '--signer',
      'release',
    ];
    await runRelease(args, deps);
    expect(deps.promoteNpm).toHaveBeenLastCalledWith({
      artifactDirectory: '/artifacts',
      packageFile: '/artifacts/release.tgz',
      registry: 'https://registry.example/',
      allowedSigners: '/signers',
      signer: 'release',
      dryRun: false,
    });
    await runRelease([...args, '--dry-run'], deps);
    expect(deps.promoteNpm).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: true }));
    expect(deps.createCandidate).not.toHaveBeenCalled();
    for (const flag of ['artifacts', 'package', 'registry', 'allowed-signers', 'signer']) {
      const index = args.indexOf('--' + flag);
      const incomplete = [...args.slice(0, index), ...args.slice(index + 2)];
      await expect(runRelease(incomplete, deps)).rejects.toThrow('Required --' + flag);
    }
  });
  it.each(
    [
      ['--formats'],
      ['--formats', '--release'],
      ['--unknown'],
      ['--formats', 'unrecognized'],
      ['promote', '--release'],
    ].map((args) => ({ args })),
  )('rejects malformed flags before work starts: %j', async ({ args }) => {
    const deps = services();
    await expect(runRelease(args, deps)).rejects.toThrow();
    expect(deps.createCandidate).not.toHaveBeenCalled();
    expect(deps.buildFormats).not.toHaveBeenCalled();
    expect(deps.promoteNpm).not.toHaveBeenCalled();
  });
  it('propagates candidate and packaging failures without printing success', async () => {
    const deps = services();
    deps.createCandidate.mockRejectedValueOnce(new Error('Untrusted candidate'));
    await expect(runRelease([], deps)).rejects.toThrow('Untrusted');
    expect(deps.buildFormats).not.toHaveBeenCalled();
    deps.buildFormats.mockRejectedValueOnce(new Error('Build interrupted'));
    await expect(runRelease([], deps)).rejects.toThrow('interrupted');
    expect(deps.write).not.toHaveBeenCalled();
  });
});

it('uses fixed release diagnostics for unexpected non-Error failures', async () => {
  const { releaseFailure } = await import('../../packages/release/src/errors.js');
  expect(releaseFailure(new Error('Known failure'), 'fallback')).toBe('Known failure');
  expect(releaseFailure({ private: 'must not be exposed' }, 'fixed build failure')).toBe(
    'fixed build failure',
  );
});
