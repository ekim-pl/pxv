#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStaticLinuxX64Elf } from '../packages/release/src/native.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = 'x86_64-unknown-linux-musl';
if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Native build requires Linux x86_64');
if (process.argv.slice(2).some((arg) => arg !== '--test')) throw Error('Unknown native build argument');
if (!/^rustc 1\.99\.1 /u.test(execFileSync('rustc', ['--version'], { encoding: 'utf8' })))
  throw Error('Native build requires Rust1.99.1');
const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
const catalog = JSON.parse(await readFile(join(root, 'resources/third-party/native-runtime.json'), 'utf8'));
const libc = await readFile(join(sysroot, 'lib/rustlib', target, 'lib/self-contained/libc.a'));
if (createHash('sha256').update(libc).digest('hex') !== catalog.musl.sysrootLibcSha256)
  throw Error('Rust musl runtime differs from the reviewed pin');
/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: join(
    sysroot,
    'lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld',
  ),
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS: '-C target-feature=+crt-static',
};
delete env.RUSTFLAGS;
delete env.CARGO_ENCODED_RUSTFLAGS;
const test = process.argv.includes('--test');
execFileSync(
  'cargo',
  [
    test ? 'test' : 'build',
    '--locked',
    ...(test ? [] : ['--release']),
    '--target',
    target,
    '--manifest-path',
    join(root, 'native/supervisor/Cargo.toml'),
  ],
  { cwd: root, env, stdio: 'inherit' },
);
if (!test) {
  const binary = join(root, 'native/supervisor/target', target, 'release/pxv-supervisor');
  assertStaticLinuxX64Elf(await readFile(binary));
  if (execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== 'pxv-supervisor 0.1.0')
    throw Error('Native version mismatch');
}
