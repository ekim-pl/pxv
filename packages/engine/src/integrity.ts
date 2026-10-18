import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/** Executable identity includes dirty source/build bytes; private operator data is excluded. */
export async function engineIntegrity(codeRoot: string): Promise<string> {
  const base = resolve(codeRoot);
  const files: string[] = [];
  const walk = async (path: string, includeAll = false): Promise<void> => {
    const info = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error('Executable product resources must not contain symlinks');
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (['target', 'node_modules', 'test', 'tests', 'build'].includes(name)) continue;
        await walk(join(path, name), includeAll);
      }
    } else if (info.isFile() && (includeAll || /\.(?:[cm]?js|ts|rs|java|json|svg|toml|lock)$/u.test(path)))
      files.push(path);
  };
  for (const entry of ['packages', 'lib', 'tools', 'product.json']) await walk(join(base, entry));
  for (const entry of ['resources', 'assets']) await walk(join(base, entry), true);
  for (const entry of ['node_modules/@pxv/runtime', 'node_modules/@pxv/extensions']) {
    const path = join(base, entry);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isDirectory()) await walk(path); // Workspace links are represented by packages above.
  }
  files.push(...(await supervisorFiles(base)));
  if (files.length === 0) throw new Error('Executable build identity is unavailable');
  const hash = createHash('sha256');
  for (const path of [...new Set(files)].sort())
    hash
      .update(relative(base, path))
      .update('\0')
      .update(await readFile(path))
      .update('\0');
  return hash.digest('hex');
}

async function supervisorFiles(base: string): Promise<string[]> {
  const files: string[] = [];
  for (const native of [
    join(base, 'node_modules/@pxv/runtime/supervisor.js'),
    join(base, 'packages/runtime/dist/supervisor.js'),
    ...(process.env['PXV_SUPERVISOR'] ? [resolve(process.env['PXV_SUPERVISOR'])] : []),
  ]) {
    const nativeInfo = await lstat(native).catch(() => undefined);
    if (nativeInfo?.isSymbolicLink()) throw new Error('Supervisor must be an immutable regular file');
    if (nativeInfo?.isFile()) files.push(native);
  }
  files.push(...dependencyFiles(base));
  return files;
}

function dependencyFiles(base: string): string[] {
  const files: string[] = [];
  for (const location of [
    join(base, 'packages/runtime/package.json'),
    join(base, 'package.json'),
    ...(process.env['PXV_SUPERVISOR'] ? [resolve(process.env['PXV_SUPERVISOR'])] : []),
  ]) {
    const require = createRequire(location);
    try {
      const loader = require.resolve('koffi');
      const platform = require.resolve('@koromix/koffi-linux-x64');
      files.push(
        loader,
        join(dirname(loader), 'src/koffi/index.cjs'),
        join(dirname(loader), 'src/koffi/src/static.cjs'),
        platform,
        join(dirname(platform), 'linux_x64/koffi.node'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  return files;
}
