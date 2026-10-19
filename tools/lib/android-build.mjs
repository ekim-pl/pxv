import { randomBytes, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile, chmod, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildJavaEnvironment, buildJavaExecutable, runBuildCommand } from './build-command.mjs';
/** @typedef {{component:string,root:string,resources:string,sdk:string,build:string,alias:string}} BuildInput */
/** @typedef {(args:string[],cwd?:string)=>Promise<string>} BuildCommand */
/** @param {string} path */
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
/** @param {string[]} argv @param {string} resources @returns {BuildInput | undefined} */
function input(argv, resources) {
  const parsed = parseArgs({
    args: argv,
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
    return undefined;
  }
  const component = parsed.values.component;
  if (!component || !['probe', 'setup', 'e2e'].includes(component))
    throw new Error('Choose probe, setup or e2e');
  const sdk = process.env['PXV_ANDROID_HOME'] || process.env['ANDROID_HOME'];
  if (!sdk)
    throw new Error(
      'Set PXV_ANDROID_HOME or ANDROID_HOME to a reviewed SDK with platform 35 and Build Tools 35.0.0',
    );
  const root = resolve(parsed.values['project-root'] ?? process.env['PXV_ROOT'] ?? process.cwd());
  return {
    component,
    root,
    resources: resolve(parsed.values['resource-root'] ?? resources),
    sdk,
    build: join(root, 'android', component, 'build'),
    alias: component === 'e2e' ? 'fixture' : component,
  };
}
/** @param {string} path */
async function rejectSymlink(path) {
  const metadata = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (metadata?.isSymbolicLink()) throw new Error('Build and signing inputs cannot be symlinks');
}
/** @param {BuildInput} value */
async function privateBuildDirectory(value) {
  const paths = [join(value.root, 'android'), join(value.root, 'android', value.component), value.build];
  for (const path of paths) await rejectSymlink(path);
  await mkdir(value.build, { recursive: true, mode: 0o700 });
  for (const path of paths) await rejectSymlink(path);
  await chmod(value.build, 0o700);
}
/** @param {BuildInput} value */
async function signing(value) {
  const key = join(value.build, `${value.alias}.keystore`),
    passwordFile = join(value.build, 'signing-password');
  for (const path of [key, passwordFile]) await rejectSymlink(path);
  if ((await exists(key)) && !(await exists(passwordFile)))
    throw new Error('Restore the existing signing password; key rotation is never automatic');
  if (!(await exists(passwordFile)))
    await writeFile(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  await chmod(passwordFile, 0o600);
  const password = await readFile(passwordFile, 'utf8');
  if (!/^[a-f0-9]{64}$/u.test(password))
    throw new Error('Signing password must be 64 hexadecimal characters');
  const env = {
    ...buildJavaEnvironment(),
    PXV_SIGNING_PASSWORD: password,
  };
  /** @type {BuildCommand} */
  const run = (args, cwd) => runBuildCommand(args, { env, ...(cwd ? { cwd } : {}), secrets: [password] });
  return { key, run };
}
/** @param {BuildInput} value @param {{key:string,run:BuildCommand}} material */
async function ensureKey(value, material) {
  if (!(await exists(material.key)))
    await material.run([
      buildJavaExecutable('keytool'),
      '-genkeypair',
      '-keystore',
      material.key,
      '-storepass:env',
      'PXV_SIGNING_PASSWORD',
      '-keypass:env',
      'PXV_SIGNING_PASSWORD',
      '-alias',
      value.alias,
      '-keyalg',
      'RSA',
      '-keysize',
      '3072',
      '-validity',
      '3650',
      '-dname',
      `CN=pxv local ${value.component}`,
    ]);
  await chmod(material.key, 0o600);
}
/** @param {BuildInput} value */
async function prepareOutputs(value) {
  for (const name of ['classes', 'dex', 'generated']) {
    const path = join(value.build, name);
    await rejectSymlink(path);
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { mode: 0o700 });
  }
}
/** @param {string} directory @returns {Promise<string[]>} */
async function javaSources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Source symlinks are forbidden');
    if (entry.isDirectory()) result.push(...(await javaSources(path)));
    else if (entry.isFile() && entry.name.endsWith('.java')) result.push(path);
  }
  return result.sort();
}
/** @param {BuildInput} value @param {BuildCommand} run */
async function packageApk(value, run) {
  const { sdk, resources, component, build } = value,
    tools = join(sdk, 'build-tools/35.0.0');
  const androidJar = join(sdk, 'platforms/android-35/android.jar'),
    classes = join(build, 'classes'),
    generated = join(build, 'generated');
  const unsigned = join(build, `${component}-unsigned.apk`),
    aapt = join(tools, 'aapt');
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
  const sources = await javaSources(join(resources, 'android', component, 'src'));
  if (component === 'e2e') sources.push(...(await javaSources(generated)));
  await run([
    buildJavaExecutable('javac'),
    '--release',
    '8',
    '-Xlint:all',
    '-Werror',
    '-classpath',
    androidJar,
    '-d',
    classes,
    ...sources,
  ]);
  const jar = join(build, `${component}.jar`);
  await run([buildJavaExecutable('jar'), 'cf', jar, '-C', classes, '.']);
  await run([join(tools, 'd8'), '--min-api', '28', '--lib', androidJar, '--output', join(build, 'dex'), jar]);
  await run([aapt, 'add', unsigned, 'classes.dex'], join(build, 'dex'));
  return unsigned;
}
/** @param {BuildInput} value @param {{key:string,run:BuildCommand}} material @param {string} unsigned */
async function signApk(value, material, unsigned) {
  const output = join(value.build, `${value.alias}.apk`),
    apksigner = join(value.sdk, 'build-tools/35.0.0/apksigner');
  await material.run([
    apksigner,
    'sign',
    '--ks',
    material.key,
    '--ks-key-alias',
    value.alias,
    '--ks-pass',
    'env:PXV_SIGNING_PASSWORD',
    '--key-pass',
    'env:PXV_SIGNING_PASSWORD',
    '--out',
    output,
    unsigned,
  ]);
  const verified = await material.run([apksigner, 'verify', '--verbose', '--print-certs', output]);
  const signerSha256 = /^Signer #1 certificate SHA-256 digest:\s*([a-f0-9]{64})$/mu.exec(verified)?.[1];
  if (!signerSha256) throw new Error('Built APK signature identity missing');
  return {
    component: value.component,
    path: output,
    sha256: createHash('sha256')
      .update(await readFile(output))
      .digest('hex'),
    signerSha256,
  };
}
/** @param {string[]} argv @param {string} resources */
export async function buildAndroid(argv, resources) {
  const value = input(argv, resources);
  if (!value) return undefined;
  await access(join(value.sdk, 'platforms/android-35/android.jar'));
  await privateBuildDirectory(value);
  const material = await signing(value);
  await ensureKey(value, material);
  await prepareOutputs(value);
  const unsigned = await packageApk(value, material.run);
  return signApk(value, material, unsigned);
}
