#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile, chmod, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const parsed = parseArgs({
  options: {
    component: { type: 'string' },
    'project-root': { type: 'string' },
    'resource-root': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (parsed.values.help) {
  console.log(
    'build-android --component probe|setup|e2e --project-root DIRECTORY [--resource-root DIRECTORY]',
  );
} else {
  const component = parsed.values.component;
  if (!['probe', 'setup', 'e2e'].includes(component)) throw new Error('Choose probe, setup or e2e');
  const root = resolve(parsed.values['project-root'] ?? process.env.PXV_ROOT ?? process.cwd());
  const resources = resolve(
    parsed.values['resource-root'] ?? dirname(dirname(fileURLToPath(import.meta.url))),
  );
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('Set ANDROID_HOME to a reviewed SDK with platform 35 and Build Tools 35.0.0');
  const androidJar = join(sdk, 'platforms/android-35/android.jar');
  const tools = join(sdk, 'build-tools/35.0.0');
  await access(androidJar);
  const build = join(root, 'android', component, 'build');
  await mkdir(build, { recursive: true, mode: 0o700 });
  // No ancestor, output, key or password can redirect private signing material.
  for (const path of [join(root, 'android'), join(root, 'android', component), build])
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Build directories cannot be symlinks');
  await chmod(build, 0o700);
  const alias = component === 'e2e' ? 'fixture' : component;
  const key = join(build, `${alias}.keystore`);
  const passwordFile = join(build, 'signing-password');
  const exists = async (path) =>
    access(path).then(
      () => true,
      () => false,
    );
  for (const path of [key, passwordFile])
    if ((await exists(path)) && (await lstat(path)).isSymbolicLink())
      throw new Error('Signing inputs cannot be symlinks');
  if ((await exists(key)) && !(await exists(passwordFile)))
    throw new Error('Restore the existing signing password; key rotation is never automatic');
  if (!(await exists(passwordFile)))
    await writeFile(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  await chmod(passwordFile, 0o600);
  const password = await readFile(passwordFile, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Signing password must be 64 hexadecimal characters');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    JAVA_HOME: process.env.JAVA_HOME ?? '',
    PXV_SIGNING_PASSWORD: password,
  };
  const run = async (args, cwd) =>
    new Promise((resolveRun, reject) => {
      const child = spawn(args[0], args.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let diagnostics = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        diagnostics += data;
      });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolveRun(output)
          : reject(
              new Error(
                `Android build command failed (${code}): ${diagnostics.replaceAll(password, '<secret>')}`,
              ),
            ),
      );
    });
  if (!(await exists(key)))
    await run([
      'keytool',
      '-genkeypair',
      '-keystore',
      key,
      '-storepass:env',
      'PXV_SIGNING_PASSWORD',
      '-keypass:env',
      'PXV_SIGNING_PASSWORD',
      '-alias',
      alias,
      '-keyalg',
      'RSA',
      '-keysize',
      '3072',
      '-validity',
      '3650',
      '-dname',
      `CN=pxv local ${component}`,
    ]);
  await chmod(key, 0o600);
  for (const name of ['classes', 'dex', 'generated']) {
    const path = join(build, name);
    if ((await exists(path)) && (await lstat(path)).isSymbolicLink())
      throw new Error('Build output cannot be a symlink');
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { mode: 0o700 });
  }
  const classes = join(build, 'classes');
  const generated = join(build, 'generated');
  const unsigned = join(build, `${component}-unsigned.apk`);
  const output = join(build, `${alias}.apk`);
  const sources = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source symlinks are forbidden');
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.java')) sources.push(path);
    }
  };
  await walk(join(resources, 'android', component, 'src'));
  const aapt = join(tools, 'aapt');
  const packaging = [
    aapt,
    'package',
    '-f',
    '-M',
    join(resources, 'android', component, 'AndroidManifest.xml'),
    '-I',
    androidJar,
    '-F',
    unsigned,
  ];
  if (component === 'e2e') packaging.push('-m', '-J', generated, '-S', join(resources, 'android/e2e/res'));
  await run(packaging);
  if (component === 'e2e') await walk(generated);
  await run(['javac', '--release', '8', '-classpath', androidJar, '-d', classes, ...sources]);
  const jar = join(build, `${component}.jar`);
  await run(['jar', 'cf', jar, '-C', classes, '.']);
  await run([join(tools, 'd8'), '--min-api', '28', '--lib', androidJar, '--output', join(build, 'dex'), jar]);
  await run([aapt, 'add', unsigned, 'classes.dex'], join(build, 'dex'));
  const apksigner = join(tools, 'apksigner');
  await run([
    apksigner,
    'sign',
    '--ks',
    key,
    '--ks-key-alias',
    alias,
    '--ks-pass',
    'env:PXV_SIGNING_PASSWORD',
    '--key-pass',
    'env:PXV_SIGNING_PASSWORD',
    '--out',
    output,
    unsigned,
  ]);
  const verification = await run([apksigner, 'verify', '--verbose', '--print-certs', output]);
  const signerSha256 = /^Signer #1 certificate SHA-256 digest:\s*([a-f0-9]{64})$/m.exec(verification)?.[1];
  if (!signerSha256) throw new Error('Built APK signature identity missing');
  console.log(
    JSON.stringify(
      {
        component,
        path: output,
        sha256: createHash('sha256')
          .update(await readFile(output))
          .digest('hex'),
        signerSha256,
      },
      null,
      2,
    ),
  );
}
