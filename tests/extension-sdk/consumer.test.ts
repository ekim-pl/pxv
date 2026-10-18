import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, it, expect } from './../test-api.js';
import { ExtensionManager } from '@pxv/extensions';
import { packageManagerCommand } from '../../tools/lib/package-manager.mjs';
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function packageInto(root: string, name: 'contracts' | 'extension-sdk'): Promise<void> {
  const directory = join(root, 'node_modules', '@pxv', name);
  await mkdir(directory, { recursive: true });
  const archive = join(root, `${name}.tgz`);
  // pnpm rewrites workspace references to exact published dependencies; no registry access occurs.
  const command = packageManagerCommand(['--filter', `@pxv/${name}`, 'pack', '--out', archive]);
  await execute(command.file, command.args, {
    cwd: resolve('.'),
    env: { ...process.env, COREPACK_ENABLE_NETWORK: '0' },
    timeout: 30_000,
  });
  await execute('tar', ['-xzf', archive, '--strip-components=1', '-C', directory]);
}
describe('external offline bundled SDK consumer', () => {
  it('packs public declarations and bundles a dependency-free extension consumed by the host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pxv-sdk-consumer-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    );
    await packageInto(root, 'contracts');
    await packageInto(root, 'extension-sdk');
    const sdkManifest = JSON.parse(
      await readFile(join(root, 'node_modules/@pxv/extension-sdk/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(sdkManifest.dependencies['@pxv/contracts']).toBe('0.1.0');
    const source = join(root, 'extension.ts');
    await writeFile(
      source,
      `import {defineExtension,defineIntegrationAdapter,type Action} from '@pxv/extension-sdk';\nconst planned:Action[]=[{kind:'manual',capability:'operator_signoff',instructions:'Externally bundled SDK review'}];\nexport const adapter=defineIntegrationAdapter(()=>planned);\nexport default defineExtension({apiVersion:1,commands:{'prepare.v1':()=>planned}});\n`,
    );
    // Type declarations are exercised from outside this workspace, using packaged public exports.
    await execute(
      process.execPath,
      [
        resolve('node_modules/@typescript/native/bin/tsc'),
        '--strict',
        '--skipLibCheck',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2023',
        '--noEmit',
        source,
      ],
      { cwd: root, timeout: 30_000 },
    );
    const bundle = join(root, 'package');
    await mkdir(bundle);
    const result = await build({
      entryPoints: [source],
      outfile: join(bundle, 'index.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      metafile: true,
      packages: 'bundle',
    });
    expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([]);
    await writeFile(
      join(bundle, 'package.json'),
      JSON.stringify({ name: '@consumer/fleet', version: '0.1.0', type: 'module', main: 'index.js' }),
    );
    await writeFile(
      join(bundle, 'pxv-extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@consumer/fleet',
        version: '0.1.0',
        apiVersion: 1,
        entry: 'index.js',
        contributions: { commands: ['prepare.v1'], policyPacks: [], guides: [], adapters: [] },
      }),
    );
    const archive = join(root, 'extension.tgz');
    await execute('tar', ['-czf', archive, '-C', root, 'package']);
    const manager = new ExtensionManager({
      installRoot: join(root, 'installed'),
      fetch: () => Promise.reject(new Error('Offline execution attempted a registry request')),
    });
    const lock = await manager.install({ tarball: archive });
    // Remove author dependencies and source before invocation to prove the installed bundle stands alone.
    await rm(join(root, 'node_modules'), { recursive: true, force: true });
    await rm(source);
    expect(await readdir(join(root, 'installed', lock.installPath))).not.toContain('node_modules');
    expect(await manager.invoke(lock, 'prepare.v1', {})).toEqual([
      { kind: 'manual', capability: 'operator_signoff', instructions: 'Externally bundled SDK review' },
    ]);
  });
});
