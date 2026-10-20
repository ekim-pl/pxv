import { FdroidclSession } from '@pxv/adapters';
import { CommandRunner } from '@pxv/runtime';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from '../test-api.js';
import { repository } from './repository-fixture.js';

let root: string;
let session: FdroidclSession | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-fdroidcl-process-'));
});
afterEach(async () => {
  await session?.close();
  session = undefined;
  await rm(root, { recursive: true, force: true });
});

it('executes the resolved fdroidcl process with isolated state and prevents incidental adb subprocesses', async () => {
  const executable = join(root, 'fdroidcl');
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const adb = cp.spawnSync('adb', ['start-server']);
if (!adb.error || adb.error.code !== 'ENOENT') process.exit(10);
const config = path.join(process.env.XDG_CONFIG_HOME, 'fdroidcl');
if (process.argv[2] === 'update') {
  fs.writeFileSync(path.join(config, 'f-droid.jar'), 'synthetic signed index');
} else {
  if (process.argv[3] !== 'org.example.app:7') process.exit(11);
  const apk = path.join(process.env.XDG_CACHE_HOME, 'fdroidcl', 'apks', 'app.apk');
  fs.mkdirSync(path.dirname(apk), { recursive: true });
  fs.writeFileSync(apk, 'synthetic APK');
  console.log('APK available in ' + apk);
}
`,
  );
  await chmod(executable, 0o700);
  session = await FdroidclSession.open(new CommandRunner(), executable, repository);
  await session.update();
  expect(await readFile(session.indexPath, 'utf8')).toBe('synthetic signed index');
  const path = await session.download({ packageId: 'org.example.app', versionCode: 7 });
  expect(await readFile(path, 'utf8')).toBe('synthetic APK');
  expect(await readFile(join(session.root, 'config/fdroidcl/config.toml'), 'utf8')).toContain(repository.url);
  const temporary = session.root;
  await session.close();
  session = undefined;
  await expect(access(temporary)).rejects.toThrow();
});

it('explains the v1 repository prerequisite on a failed index update', async () => {
  session = await FdroidclSession.open(
    { run: () => Promise.resolve({ code: 1, stdout: '', stderr: '404' }) },
    '/tools/fdroidcl',
    repository,
  );
  await expect(session.update()).rejects.toThrow('index-v1.jar');
});

it('refuses relative executables and cancelled sessions before starting a process', async () => {
  await expect(FdroidclSession.open(new CommandRunner(), 'fdroidcl', repository)).rejects.toThrow('absolute');
  const controller = new AbortController();
  controller.abort();
  await expect(
    FdroidclSession.open(new CommandRunner(), '/tools/fdroidcl', repository, controller.signal),
  ).rejects.toThrow();
});
