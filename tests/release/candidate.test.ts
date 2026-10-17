import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CommandRunner, supervisorPath, type Runtime } from '@pxv/runtime';
import { createCandidate, verifyCandidate, walkPublic } from '../../packages/release/src/index.js';
import { fixture, removeReleaseTree } from './fixtures.js';
const temporary: string[] = [];
async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(prefix);
  temporary.push(path);
  return path;
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await removeReleaseTree(path);
});
function nativeOverrides(reply: (args: string[]) => string | undefined): Runtime {
  const runner = new CommandRunner();
  return {
    run: (args, options) => {
      const stdout = reply(args);
      return stdout === undefined
        ? runner.run(args, options)
        : Promise.resolve({ code: 0, stdout, stderr: '' });
    },
  };
}
describe('candidate input and runtime provenance', () => {
  it('ships public guide navigation and build records without local QA or source-only tooling', async () => {
    const root = await fixture('guide-documentation');
    temporary.push(root);
    const output = await temp('/tmp/pxv-candidate-output-');
    const documents = {
      'SECURITY.md': '# Security\n\nKeep private inputs and recovery evidence protected.',
      'CONTRIBUTING.md': '# Contributing\n\nRun source-bound quality before publication.',
      'docs/README.md': '[Security boundaries](../SECURITY.md)',
      'guides/README.md': '[Build instructions](source/BUILD.txt) [Contributing](../CONTRIBUTING.md)',
      'guides/index.html': '<a href="source/markdown/operator-en.md">Operator source</a>',
      'guides/source/BUILD.txt': 'Regenerate branded PDFs from the matching source checkout.',
      'guides/source/build-manifest.json': '{"schemaVersion":1}',
    };
    for (const [path, text] of Object.entries({
      ...documents,
      'guides/qa/local-only.txt': 'Local review evidence',
      'guides/source/release-gates.json': '{"obsolete":true}',
      'tools/optional/publishing/rebuild.mjs': 'throw new Error("Source-only guide tooling");',
    })) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const candidate = await createCandidate({ sourceRoot: root, outputRoot: output });
    for (const [path, text] of Object.entries(documents)) {
      expect(await readFile(join(candidate.directory, path), 'utf8')).toBe(text);
      expect(candidate.manifest.source.files.find((file) => file.path === path)).toMatchObject({
        sha256: createHash('sha256').update(text).digest('hex'),
      });
    }
    expect(candidate.manifest.files.some((file) => file.path.startsWith('guides/qa/'))).toBe(false);
    expect(candidate.manifest.files.some((file) => file.path.endsWith('release-gates.json'))).toBe(false);
    await expect(
      readFile(join(candidate.directory, 'tools/optional/publishing/rebuild.mjs')),
    ).rejects.toThrow(/ENOENT/);
    await verifyCandidate(candidate.directory);
  });
  it('records real bundled npm dependencies and their available notices along with clean source revision evidence', async () => {
    const root = await fixture('dependency-test');
    temporary.push(root);
    const output = await temp('/tmp/pxv-candidate-output-');
    const dependency = join(root, 'node_modules', 'fixture-dependency');
    await mkdir(join(dependency, 'nested'), { recursive: true });
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture-dependency', version: '1.2.3', main: 'index.js' }),
    );
    await writeFile(join(dependency, 'index.js'), 'export {value} from "./nested/value.js";');
    await writeFile(join(dependency, 'nested/package.json'), '{}');
    await writeFile(join(dependency, 'nested/value.js'), 'export const value=42;');
    await writeFile(join(dependency, 'LICENSE'), 'Fixture dependency notice');
    await mkdir(join(dependency, 'LICENSE-directory'));
    await writeFile(
      join(root, 'packages/cli/src/main.ts'),
      'import{value}from"fixture-dependency";console.log(value);',
    );
    const runtime = nativeOverrides((args) =>
      args[0] === 'git' ? (args.includes('rev-parse') ? 'fixture-revision\n' : '') : undefined,
    );
    const candidate = await createCandidate({
      sourceRoot: root,
      outputRoot: output,
      nativeBinary: await supervisorPath(),
      runtime,
    });
    expect(candidate.manifest.source).toMatchObject({ revision: 'fixture-revision', dirty: false });
    expect(await readFile(join(candidate.directory, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toContain(
      'npm:fixture-dependency@1.2.3 (NOASSERTION)',
    );
    expect(await readFile(join(candidate.directory, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toContain(
      'Fixture dependency notice',
    );
    const sbom = JSON.parse(await readFile(join(candidate.directory, 'sbom.spdx.json'), 'utf8')) as {
      packages: { name: string; licenseDeclared: string }[];
    };
    expect(sbom.packages.find((value) => value.name === 'fixture-dependency')?.licenseDeclared).toBe(
      'NOASSERTION',
    );
    expect(await verifyCandidate(candidate.directory)).toEqual(candidate.manifest);
  });
  it('rejects unsupported reported runtime versions and native build identities before resource copying', async () => {
    const root = await fixture();
    temporary.push(root);
    const output = await temp('/tmp/pxv-candidate-output-');
    const nativeBinary = await supervisorPath();
    const replies = [
      { flag: '--version', tool: process.execPath, value: 'v23.0.0' },
      { flag: '--version', tool: nativeBinary, value: 'pxv-supervisor 9.9.9' },
      {
        flag: '--build-info',
        tool: nativeBinary,
        value: JSON.stringify({ target: 'x86_64-unknown-linux-gnu', static: true, protocol: 1 }),
      },
      {
        flag: '--build-info',
        tool: nativeBinary,
        value: JSON.stringify({ target: 'x86_64-unknown-linux-musl', static: false, protocol: 1 }),
      },
      {
        flag: '--build-info',
        tool: nativeBinary,
        value: JSON.stringify({ target: 'x86_64-unknown-linux-musl', static: true, protocol: 2 }),
      },
    ];
    for (const reply of replies) {
      const runtime = nativeOverrides((args) =>
        args[0] === reply.tool && args[1] === reply.flag ? reply.value : undefined,
      );
      await expect(
        createCandidate({ sourceRoot: root, outputRoot: output, nativeBinary, runtime }),
      ).rejects.toThrow(/Release requires|Native supervisor/);
    }
  });
  it('rejects symlinked source metadata and unsafe source package names without following their targets', async () => {
    const root = await fixture();
    temporary.push(root);
    const output = await temp('/tmp/pxv-candidate-output-');
    await symlink('/etc/passwd', join(root, 'pnpm-lock.yaml'));
    await expect(createCandidate({ sourceRoot: root, outputRoot: output })).rejects.toThrow(/symlinks/);
    await rm(join(root, 'pnpm-lock.yaml'));
    await mkdir(join(root, 'packages', 'unsafe_name'));
    await expect(createCandidate({ sourceRoot: root, outputRoot: output })).rejects.toThrow(/source package/);
    await expect(walkPublic(root, 'product.json/child')).rejects.toThrow();
  });
});

it.each(['assets/logo.svg', 'SECURITY.md', 'CONTRIBUTING.md'])(
  'refuses to freeze a candidate when public source bytes change during its build: %s',
  async (changedPath) => {
    const root = await fixture('source-drift');
    temporary.push(root);
    await writeFile(join(root, changedPath), 'Original public source');
    const output = await temp('/tmp/pxv-candidate-output-');
    const runner = new CommandRunner();
    const runtime: Runtime = {
      run: async (args, options) => {
        if (args[0] === 'git' && args.includes('status')) {
          await writeFile(join(root, changedPath), 'Changed public source during build');
          return { code: 0, stdout: '', stderr: '' };
        }
        return runner.run(args, options);
      },
    };
    await expect(
      createCandidate({ sourceRoot: root, outputRoot: output, nodePath: process.execPath, runtime }),
    ).rejects.toThrow('Source inputs changed during build');
  },
);
