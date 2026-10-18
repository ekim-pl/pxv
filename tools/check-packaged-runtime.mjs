#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { verifyArtifacts, verifyCandidate } from '../packages/release/dist/index.js';
import { sourceIdentity } from './lib/metrics.mjs';

const execute = promisify(execFile);
const root = process.cwd();
// A failed invocation must not leave a previous passing matrix looking current.
await rm(join(root, '.quality/packaged-runtime.json'), { force: true });
const argument = process.argv[2];
if (!argument) throw new Error('Usage: node tools/check-packaged-runtime.mjs BUILD_RESULT.json');
/** @type {{candidate:string,artifacts:{format:string,path:string,image?:string}[]}} */
const build = JSON.parse(await readFile(resolve(argument), 'utf8'));
const candidate = resolve(build.candidate);
const manifest = await verifyCandidate(candidate);
const artifactDirectory = join(dirname(candidate), 'artifacts');
await verifyArtifacts(artifactDirectory);
const provenanceBytes = await readFile(join(artifactDirectory, 'provenance.json'));
const provenance = JSON.parse(provenanceBytes.toString());
const candidateHash = createHash('sha256')
  .update(await readFile(join(candidate, 'candidate.json')))
  .digest('hex');
if (provenance.candidateManifestSha256 !== candidateHash) throw new Error('Provenance candidate mismatch');
if (new Set(build.artifacts.map((artifact) => artifact.format)).size !== build.artifacts.length)
  throw new Error('Duplicate format selection');
if (build.artifacts.length !== provenance.artifacts.length) throw new Error('Incomplete format selection');
for (const artifact of build.artifacts) {
  const selected = provenance.artifacts.find(
    (/** @type {{format:string,file:string}} */ record) =>
      record.format === artifact.format && resolve(artifactDirectory, record.file) === resolve(artifact.path),
  );
  if (!selected) throw new Error('Build result does not identify verified artifacts');
}
const scratch = await mkdtemp('/tmp/pxv-packaged-runtime-');
/** @type {{format:string,os:string,status:string}[]} */
const checks = [];
const report = {
  candidate: manifest.id,
  sourceDigest: manifest.sourceDigest,
  toolchain: manifest.toolchain,
  provenanceSha256: createHash('sha256').update(provenanceBytes).digest('hex'),
  artifacts: provenance.artifacts,
  qualitySourceSha256: '',
  status: 'failed',
  checks,
};
/** @param {string} command @param {string[]} args */
async function run(command, args) {
  return execute(command, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
}
/** @param {string} format @param {string} directory @param {string} os @param {boolean} npm */
async function baseline(format, directory, os, npm = false) {
  const { stdout } = await run('docker', [
    'run',
    '--rm',
    '--read-only',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--network',
    'none',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,mode=1777',
    '--mount',
    `type=bind,src=${directory},dst=/package,readonly`,
    '--mount',
    `type=bind,src=${candidate},dst=/runtime,readonly`,
    '--mount',
    `type=bind,src=${root}/tools/check-native-baseline.mjs,dst=/baseline.mjs,readonly`,
    '--env',
    'PXV_SUPERVISOR=/package/node_modules/@pxv/runtime/supervisor.js',
    '--entrypoint',
    npm ? '/runtime/bin/node' : '/package/bin/node',
    os,
    '/baseline.mjs',
    '/package/node_modules/@pxv/runtime/index.js',
  ]);
  const result = JSON.parse(stdout);
  if (result.status !== 'passed') throw new Error(`${format} on ${os} failed`);
  checks.push({ format, os, ...result });
  process.stdout.write(`${format} on ${os}: passed\n`);
}
/** @param {string} format @param {string} file */
async function unpack(format, file) {
  const directory = join(scratch, format);
  await mkdir(directory);
  if (format === 'portable') {
    await run('tar', ['-xzf', file, '-C', directory]);
    return join(directory, 'candidate');
  }
  if (format === 'deb') {
    await run('dpkg-deb', ['-x', file, directory]);
    return join(directory, 'opt', manifest.debName);
  }
  // All runtime dependencies are bundled. A normal offline install must succeed
  // without contacting a registry or invoking a native compiler.
  await run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--prefix', directory, file]);
  return join(directory, 'node_modules', manifest.product.packageName);
}
/** @param {string} image */
async function oci(image) {
  const { stdout } = await run('docker', ['create', image]);
  const container = stdout.trim();
  const directory = join(scratch, 'oci');
  try {
    await run('docker', ['cp', `${container}:/opt/pxv`, directory]);
  } finally {
    await run('docker', ['rm', container]);
  }
  // Verify the installed OCI bytes, then load them on both supported baselines.
  const installed = await verifyCandidate(directory);
  if (JSON.stringify(installed) !== JSON.stringify(manifest)) throw new Error('OCI candidate mismatch');
  await baselines('oci', directory);
}
/** @param {string} format @param {string} directory */
async function baselines(format, directory) {
  for (const os of ['debian:12-slim', 'ubuntu:24.04'])
    await baseline(format, directory, os, format === 'npm');
}
/** Frozen candidates and copied OCI files need writable directories for removal.
 * @param {string} directory */
async function cleanup(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await cleanup(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
try {
  await baselines('candidate', candidate);
  for (const artifact of build.artifacts) {
    if (['portable', 'deb', 'npm'].includes(artifact.format))
      await baselines(artifact.format, await unpack(artifact.format, resolve(artifact.path)));
    else if (artifact.format === 'oci') {
      if (!artifact.image) throw new Error('Packaged checks require a locally loaded OCI image');
      await oci(artifact.image);
    }
  }
  const quality = JSON.parse(await readFile(join(root, '.quality/report.json'), 'utf8'));
  const source = await sourceIdentity(root);
  if (quality.status !== 'passed' || !quality.sourceUnchanged || quality.source?.sha256 !== source.sha256)
    throw new Error('Current source-bound quality evidence is required');
  for (const file of manifest.source.files) {
    const hash = createHash('sha256')
      .update(await readFile(join(root, file.path)))
      .digest('hex');
    if (hash !== file.sha256) throw new Error(`Candidate source is stale: ${file.path}`);
  }
  report.qualitySourceSha256 = source.sha256;
  report.status = 'passed';
} finally {
  await mkdir(join(root, '.quality'), { recursive: true });
  await writeFile(join(root, '.quality/packaged-runtime.json'), JSON.stringify(report, null, 2) + '\n');
  await cleanup(scratch);
}
