import { lstat, chmod, readdir, rm } from 'node:fs/promises';
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const source = process.cwd();
export async function fixture(brand = 'alpha'): Promise<string> {
  const root = await mkdtemp('/tmp/pxv-release-source-');
  const product = JSON.parse(await readFile(join(source, 'product.json'), 'utf8')) as Record<string, unknown>;
  Object.assign(product, {
    id: brand,
    name: `${brand} Fleet`,
    command: brand,
    packageName: `@example/${brand}`,
    debName: brand,
    image: `example/${brand}`,
    assets: { logo: 'assets/logo.svg' },
    defaultPolicy: 'policy-packs/simple/policy.json',
  });
  await writeFile(join(root, 'product.json'), JSON.stringify(product));
  await copyFile(join(source, 'package.json'), join(root, 'package.json'));
  await copyFile(join(source, 'LICENSE'), join(root, 'LICENSE'));
  await copyFile(join(source, 'rust-toolchain.toml'), join(root, 'rust-toolchain.toml'));
  await cp(join(source, 'native', 'supervisor'), join(root, 'native', 'supervisor'), {
    recursive: true,
    filter: (path) => !path.includes('/target'),
  });
  await cp(join(source, 'resources', 'third-party'), join(root, 'resources', 'third-party'), {
    recursive: true,
  });
  await mkdir(join(root, 'guides', 'assets', 'fonts'), { recursive: true });
  await copyFile(
    join(source, 'guides', 'assets', 'fonts', 'LICENSE'),
    join(root, 'guides', 'assets', 'fonts', 'LICENSE'),
  );
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'README.md'), 'Packaged operator documentation.');
  await mkdir(join(root, 'assets'));
  await writeFile(
    join(root, 'assets', 'logo.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg"><title>${brand}</title></svg>`,
  );
  await mkdir(join(root, 'policy-packs', 'simple'), { recursive: true });
  await copyFile(
    join(source, 'policy-packs', 'simple', 'policy.json'),
    join(root, 'policy-packs', 'simple', 'policy.json'),
  );
  await cp(join(source, 'packages', 'runtime', 'src'), join(root, 'packages', 'runtime', 'src'), {
    recursive: true,
  });
  await mkdir(join(root, 'packages', 'extensions', 'src'), { recursive: true });
  await writeFile(join(root, 'packages', 'extensions', 'src', 'index.ts'), 'export const apiVersion=1;');
  await writeFile(
    join(root, 'packages', 'extensions', 'src', 'worker.ts'),
    'import{parentPort}from"node:worker_threads";parentPort?.postMessage([]);',
  );
  await mkdir(join(root, 'packages', 'cli', 'src'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'cli', 'src', 'main.ts'),
    `import{SqliteStore}from'@pxv/runtime';if(process.argv[2]==='--sqlite'){const store=await SqliteStore.open(process.argv[3]!);await store.set('test','value',42);console.log(await store.get('test','value'));await store.close();}else console.log(${JSON.stringify(brand)},process.env.PXV_RESOURCE_ROOT,process.env.PXV_ROOT);`,
  );
  return root;
}

/** Frozen candidates need writable directory permissions before test cleanup. Never follows symlinks. */
export async function removeReleaseTree(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeReleaseTree(join(path, name));
  }
  await rm(path, { force: true, recursive: true });
}
