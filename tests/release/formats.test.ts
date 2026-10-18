import { qualityExecutable } from '../../tools/lib/quality-tools.mjs';
import { afterAll, beforeAll, describe, expect, it } from './../test-api.js';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Runtime } from '@pxv/runtime';
import { CommandRunner, supervisorPath } from '@pxv/runtime';
import {
  buildFormats,
  createCandidate,
  verifyArtifacts,
  type Candidate,
} from '../../packages/release/src/index.js';
import { fixture, removeReleaseTree } from './fixtures.js';
let candidate: Candidate;
let root: string;
let output: string;
beforeAll(async () => {
  root = await fixture('format-test');
  output = await mkdtemp('/tmp/pxv-format-test-');
  candidate = await createCandidate({
    sourceRoot: root,
    outputRoot: output,
    supervisorEntry: await supervisorPath(),
  });
}, 30_000);

afterAll(async () => {
  if (output) await removeReleaseTree(output);
  if (root) await removeReleaseTree(root);
});
function dockerRuntime(calls: string[][], failBuild = false): Runtime {
  return {
    run: async (args) => {
      calls.push(args);
      if (args.includes('--output')) {
        if (failBuild) throw new Error('Fixture OCI build failed');
        const location = args[args.indexOf('--output') + 1];
        if (!location) throw new Error('No OCI output');
        await writeFile(location.slice('type=oci,dest='.length), 'fixture OCI archive');
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}
describe('explicit OCI/SEA build boundaries', () => {
  it('retains failure evidence and removes its private BuildKit builder after a failed OCI build', async () => {
    const calls: string[][] = [];
    const destination = join(output, 'oci-failure');
    await expect(
      buildFormats(candidate, {
        formats: ['oci'],
        outputDirectory: destination,
        runtime: dockerRuntime(calls, true),
      }),
    ).rejects.toThrow(/OCI build failed/);
    expect(calls.map((args) => args.slice(1, 3))).toEqual([
      ['buildx', 'create'],
      ['buildx', 'build'],
      ['buildx', 'rm'],
    ]);
    expect(calls[0]).toContain('docker-container');
    expect(calls[0]?.find((arg) => arg.startsWith('image='))).toMatch(/@sha256:/);
    expect(calls.at(-1)?.at(-1)).toBe(calls[0]?.[4]);
    expect(await readFile(join(destination, 'oci-context', 'Dockerfile'), 'utf8')).toContain(
      'USER 65532:65532',
    );
  });
  it.each([true, false])(
    'builds a unique OCI archive with explicit local-load=%s',
    async (loadDockerImage) => {
      const calls: string[][] = [];
      const destination = join(output, 'oci-' + loadDockerImage);
      const artifacts = await buildFormats(candidate, {
        formats: ['oci'],
        outputDirectory: destination,
        loadDockerImage,
        runtime: dockerRuntime(calls),
        docker: '/approved/docker',
      });
      expect(calls.every((args) => args[0] === '/approved/docker')).toBe(true);
      expect(calls.filter((args) => args.includes('--load'))).toHaveLength(loadDockerImage ? 1 : 0);
      expect(artifacts[0]?.image).toBe(
        loadDockerImage ? candidate.manifest.product.image + ':' + candidate.manifest.version : undefined,
      );
      await verifyArtifacts(destination);
      if (loadDockerImage) {
        const shellcheck = await qualityExecutable('shellcheck');
        await new CommandRunner().run([
          shellcheck,
          join(candidate.directory, 'bin', candidate.manifest.command),
          join(destination, 'oci-context', 'entrypoint.sh'),
        ]);
      }
    },
  );
  it('requires explicit SEA injection tooling and passes the real generated blob to that tool', async () => {
    await expect(
      buildFormats(candidate, { formats: ['sea'], outputDirectory: join(output, 'sea-missing') }),
    ).rejects.toThrow(/postject executable/);
    const calls: string[][] = [];
    const runner = new CommandRunner();
    const destination = join(output, 'sea-tool');
    const runtime: Runtime = {
      run: async (args, options) => {
        calls.push(args);
        if (args[0] === '/approved/postject') {
          const blob = args[3];
          if (!blob) throw new Error('Missing blob');
          expect((await lstat(blob)).size).toBeGreaterThan(0);
          expect(args).toContain('NODE_SEA_BLOB');
          expect(args).toContain('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
          return { code: 0, stdout: '', stderr: '' };
        }
        return runner.run(args, options);
      },
    };
    const artifacts = await buildFormats(candidate, {
      formats: ['sea'],
      outputDirectory: destination,
      postject: '/approved/postject',
      runtime,
    });
    expect(calls).toHaveLength(2);
    expect(artifacts[0]?.format).toBe('sea');
    await verifyArtifacts(destination);
    expect(await readFile(join(destination, 'sea-experiment', 'bootstrap.cjs'), 'utf8')).toContain(
      'PXV_SEA_RESOURCES',
    );
  });
  it('rejects unsupported and duplicate formats before any build command runs', async () => {
    const calls: string[][] = [];
    await expect(
      buildFormats(candidate, {
        formats: ['oci', 'oci'],
        outputDirectory: join(output, 'duplicate'),
        runtime: dockerRuntime(calls),
      }),
    ).rejects.toThrow(/unique/);
    await expect(
      buildFormats(candidate, {
        formats: ['unknown' as 'oci'],
        outputDirectory: join(output, 'unknown'),
        runtime: dockerRuntime(calls),
      }),
    ).rejects.toThrow(/Unsupported/);
    expect(calls).toHaveLength(0);
  });
});

it('rejects altered release identities even when the frozen candidate files still verify', async () => {
  const changed = { ...candidate, manifest: { ...candidate.manifest, version: '0.1.0-unreviewed' } };
  const calls: string[][] = [];
  await expect(
    buildFormats(changed, {
      formats: ['oci'],
      outputDirectory: join(output, 'metadata-mismatch'),
      runtime: dockerRuntime(calls),
    }),
  ).rejects.toThrow('Candidate metadata differs from the frozen manifest');
  expect(calls).toHaveLength(0);
});
