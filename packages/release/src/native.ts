import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

function runtimeRequire(root: string): NodeJS.Require {
  return createRequire(join(root, 'packages/runtime/package.json'));
}
/** Runtime-only files: source-build machinery and other platform addons are omitted. */
export function koffiFiles(root: string): string[] {
  const require = runtimeRequire(root);
  const koffi = dirname(require.resolve('koffi'));
  const platform = dirname(require.resolve('@koromix/koffi-linux-x64'));
  return [
    ...['package.json', 'index.cjs', 'src/koffi/index.cjs', 'src/koffi/src/static.cjs', 'LICENSE.txt'].map(
      (p) => join(koffi, p),
    ),
    ...['package.json', 'index.js', 'linux_x64/koffi.node'].map((p) => join(platform, p)),
  ];
}
export async function validateAddon(root: string): Promise<void> {
  await validateCatalog(root);
  const addon = koffiFiles(root).at(-1)!;
  const bytes = await readFile(addon);
  assertLinuxX64Addon(bytes);
  validateSymbols(addon);
  runtimeRequire(root)('@koromix/koffi-linux-x64');
}
export async function installKoffi(root: string, destination: string): Promise<void> {
  for (const path of koffiFiles(root)) {
    const marker = path.includes('/@koromix/koffi-linux-x64/') ? '@koromix/koffi-linux-x64' : 'koffi';
    const base = dirname(runtimeRequire(root).resolve(marker));
    const target = join(destination, 'node_modules', marker, relative(base, path));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target);
    await chmod(target, 0o644);
  }
  // Distribution manifests contain no install scripts or unused optional platforms.
  await writeFile(
    join(destination, 'node_modules/koffi/package.json'),
    JSON.stringify({
      name: 'koffi',
      version: '3.3.3',
      type: 'module',
      license: 'MIT',
      main: './index.cjs',
      exports: { '.': { require: './index.cjs' } },
      dependencies: { '@koromix/koffi-linux-x64': '3.3.3' },
    }),
  );
}

function invalid(): never {
  throw new Error(
    'Supervisor must be a Linux x64 addon ELF without a shared interpreter or runtime search path',
  );
}

function elfIdentity(bytes: Buffer): void {
  if (bytes.length < 64) invalid();
  if (
    bytes.toString('hex', 0, 4) !== '7f454c46' ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![0, 3].includes(bytes.readUInt8(7))
  )
    invalid();
  elfMachine(bytes);
}

function elfMachine(bytes: Buffer): void {
  if (
    bytes.readUInt16LE(16) !== 3 ||
    bytes.readUInt16LE(18) !== 62 ||
    bytes.readUInt32LE(20) !== 1 ||
    bytes.readUInt16LE(52) !== 64
  )
    invalid();
}

function boundedOffset(bytes: Buffer, field: number): number {
  const value = bytes.readBigUInt64LE(field);
  if (value > BigInt(bytes.length)) invalid();
  return Number(value);
}

function programTable(bytes: Buffer): { offset: number; count: number } {
  const offset = boundedOffset(bytes, 32);
  const count = bytes.readUInt16LE(56);
  if (
    !count ||
    count > 512 ||
    bytes.readUInt16LE(54) !== 56 ||
    offset < 64 ||
    offset + count * 56 > bytes.length
  )
    invalid();
  return { offset, count };
}

function dynamicTable(bytes: Buffer, start: number, length: number): void {
  if (length < 16 || length % 16 !== 0) invalid();
  for (let entry = start; entry < start + length; entry += 16) {
    const tag = bytes.readBigInt64LE(entry);
    if (tag === 0n) return;
    if (tag === 15n || tag === 29n) invalid();
  }
  invalid();
}

/** Validate the shared Linux x64 addon without an interpreter or runtime search path.
 * Symbol and dependency checks run separately before actual loading. */
export function assertLinuxX64Addon(bytes: Buffer): void {
  elfIdentity(bytes);
  const { offset, count } = programTable(bytes);
  let loads = 0;
  for (let index = 0; index < count; index++) {
    const header = offset + index * 56;
    const type = bytes.readUInt32LE(header);
    const start = boundedOffset(bytes, header + 8);
    const length = boundedOffset(bytes, header + 32);
    if (start + length > bytes.length || type === 3) invalid();
    if (type === 1) loads++;
    if (type === 2) dynamicTable(bytes, start, length);
  }
  if (!loads) invalid();
}

function validateSymbols(addon: string): void {
  const dynamic = execFileSync('readelf', ['-d', addon], { encoding: 'utf8' });
  for (const match of dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/gu))
    if (
      ![
        'libc.so.6',
        'libm.so.6',
        'libpthread.so.0',
        'libdl.so.2',
        'librt.so.1',
        'libstdc++.so.6',
        'libgcc_s.so.1',
        'ld-linux-x86-64.so.2',
      ].includes(match[1]!)
    )
      throw new Error('Unreviewed addon shared dependency: ' + match[1]);
  const symbols = execFileSync('readelf', ['--version-info', addon], { encoding: 'utf8' });
  for (const match of symbols.matchAll(/GLIBC_(\d+)\.(\d+)/gu))
    if (Number(match[1]) > 2 || Number(match[2]) > 36)
      throw new Error('Koffi addon exceeds Debian 12 glibc baseline');
}

async function validateCatalog(root: string): Promise<void> {
  const catalog = JSON.parse(await readFile(join(root, 'resources/third-party/koffi.json'), 'utf8')) as {
    version: string;
    platform: string;
    nodeApi: number;
    files: Record<string, string>;
  };
  if (catalog.version !== '3.3.3' || catalog.platform !== 'linux_x64' || catalog.nodeApi !== 8)
    throw new Error('Reviewed Koffi runtime catalog mismatch');
  for (const path of koffiFiles(root)) {
    const marker = path.includes('/@koromix/koffi-linux-x64/') ? '@koromix/koffi-linux-x64' : 'koffi';
    const base = dirname(runtimeRequire(root).resolve(marker));
    const key = marker + '/' + relative(base, path);
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (catalog.files[key] !== hash) throw new Error('Reviewed Koffi runtime catalog mismatch: ' + key);
  }
  const license = await readFile(join(root, 'resources/third-party/KOFFI-LICENSE.txt'));
  if (createHash('sha256').update(license).digest('hex') !== catalog.files['koffi/LICENSE.txt'])
    throw new Error('Koffi notice integrity mismatch');
}
