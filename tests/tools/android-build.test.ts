import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from '../test-api.js';
import { createCandidate } from '../../packages/release/src/candidate.js';
import { buildFormats } from '../../packages/release/src/formats.js';
import { supervisorPath } from '../../packages/runtime/src/index.js';
import { fixture, removeReleaseTree } from '../release/fixtures.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await removeReleaseTree(root);
});
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'pxv-build environment-'));
  temporary.push(root);
  return root;
}
async function fakeTools(root: string) {
  const sdk = join(root, 'selected SDK '),
    java = join(root, 'selected JDK ');
  const log = join(root, 'launches.jsonl');
  const source = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), tool = path.basename(process.argv[1]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool,env:process.env,args})+'\\n');
function output(flag, bytes) { const i=args.indexOf(flag); if(i>=0) fs.writeFileSync(args[i+1],bytes); }
if(tool==='keytool') output('-keystore','key');
if(tool==='aapt' && args[0]==='package') output('-F','unsigned');
if(tool==='d8') fs.writeFileSync(path.join(args[args.indexOf('--output')+1],'classes.dex'),'dex');
if(tool==='apksigner' && args[0]==='sign') output('--out','signed');
if(tool==='apksigner' && args[0]==='verify') console.log('Signer #1 certificate SHA-256 digest: '+ 'a'.repeat(64));
`;
  for (const [home, relative] of [
    ...['keytool', 'javac', 'jar'].map((name) => [java, 'bin/' + name]),
    ...['aapt', 'd8', 'apksigner'].map((name) => [sdk, 'build-tools/35.0.0/' + name]),
  ] as [string, string][]) {
    const path = join(home, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, { mode: 0o700 });
  }
  await mkdir(join(sdk, 'platforms/android-35'), { recursive: true });
  await writeFile(join(sdk, 'platforms/android-35/android.jar'), 'fixture');
  return { sdk, java, log };
}
function build(resources: string, project: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [join(resources, 'tools/build-android.mjs'), '--component', 'probe', '--project-root', project],
    { env, encoding: 'utf8' },
  );
}
async function launches(log: string) {
  return (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { tool: string; env: Record<string, string>; args: string[] });
}
it('builds with canonical SDK/JDK absent PATH, isolates signing, and rejects invalid selected homes', async () => {
  const root = await scratch();
  const { sdk, java, log } = await fakeTools(root);
  const env = {
    PATH: '/absent',
    PXV_ANDROID_HOME: sdk,
    ANDROID_HOME: '/invalid native SDK',
    PXV_JAVA_HOME: java,
    JAVA_HOME: '/invalid native JDK',
    NPM_TOKEN: 'private-sentinel',
  };
  const result = build(process.cwd(), join(root, 'project'), env);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ component: 'probe', signerSha256: 'a'.repeat(64) });
  const calls = await launches(log);
  expect(calls.map((call) => call.tool)).toEqual([
    'keytool',
    'aapt',
    'javac',
    'jar',
    'd8',
    'aapt',
    'apksigner',
    'apksigner',
  ]);
  for (const call of calls) {
    expect(call.env['JAVA_HOME']).toBe(java);
    expect(call.env['PATH']).toBe(join(java, 'bin') + ':/absent');
    expect(call.env).not.toHaveProperty('NPM_TOKEN');
    expect(call.env).not.toHaveProperty('PXV_JAVA_HOME');
    expect(call.args.join(' ')).not.toContain(call.env['PXV_SIGNING_PASSWORD']);
  }
  const empty = build(process.cwd(), join(root, 'fallback'), {
    ...env,
    PXV_ANDROID_HOME: '',
    ANDROID_HOME: sdk,
    PXV_JAVA_HOME: '',
    JAVA_HOME: java,
  });
  expect(empty.status).toBe(0);
  const badJava = build(process.cwd(), join(root, 'bad-java'), {
    ...env,
    PXV_JAVA_HOME: join(root, 'absent'),
    JAVA_HOME: java,
  });
  expect(badJava.status).not.toBe(0);
  expect(badJava.stderr).toContain('ENOENT');
  const badSdk = build(process.cwd(), join(root, 'bad-sdk'), {
    ...env,
    PXV_ANDROID_HOME: '/absent',
    ANDROID_HOME: sdk,
  });
  expect(badSdk.status).not.toBe(0);
  const missingSdk = build(process.cwd(), join(root, 'missing-sdk'), {
    PATH: '/absent',
    ANDROID_SDK_ROOT: sdk,
  });
  expect(missingSdk.stderr).toContain('Set PXV_ANDROID_HOME or ANDROID_HOME');
  await rm(log);
  const pathJava = build(process.cwd(), join(root, 'path-java'), {
    PATH: join(java, 'bin'),
    ANDROID_HOME: sdk,
  });
  expect(pathJava.status).toBe(0);
  expect((await launches(log))[0]?.env).not.toHaveProperty('JAVA_HOME');
});
it('packages and installs the Android build helpers with canonical home selection intact', async () => {
  const root = await fixture();
  temporary.push(root);
  const output = await scratch();
  for (const relative of [
    'tools/build-android.mjs',
    'tools/lib/build-command.mjs',
    'tools/lib/android-build.mjs',
    'android/probe',
  ]) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await cp(join(process.cwd(), relative), join(root, relative), { recursive: true });
  }
  const candidate = await createCandidate({
    sourceRoot: root,
    outputRoot: output,
    supervisorEntry: await supervisorPath(),
  });
  const [artifact] = await buildFormats(candidate, { formats: ['npm'] });
  const installed = join(output, 'installed');
  const npm = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const install = spawnSync(
    process.execPath,
    [
      npm,
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      installed,
      artifact!.path,
    ],
    { encoding: 'utf8' },
  );
  expect(install.status).toBe(0);
  const { sdk, java } = await fakeTools(output);
  const result = build(join(installed, 'node_modules/@example/alpha'), join(output, 'operator project'), {
    PATH: '/absent',
    PXV_ANDROID_HOME: sdk,
    PXV_JAVA_HOME: java,
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ signerSha256: 'a'.repeat(64) });
}, 60_000);
