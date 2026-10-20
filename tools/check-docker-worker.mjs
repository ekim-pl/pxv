import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommandRunner } from '../packages/runtime/dist/index.js';
import { prepareDockerEnvironment, runInDocker } from '../packages/cli/dist/docker.js';
import { dockerWorkerIdentity, DockerWorkerControl } from '../packages/cli/dist/docker-worker-control.js';
import { runDockerWorker } from '../packages/cli/dist/docker-worker.js';

const buildFile = process.argv[2] === '--build-result' ? process.argv[3] : undefined;
const build = buildFile ? JSON.parse(await readFile(buildFile, 'utf8')) : undefined;
const image = build
  ? build.artifacts.find(/** @param {{format:string}} artifact */ (artifact) => artifact.format === 'oci')
      ?.image
  : process.argv[2];
if (!image) throw new Error('Usage: check-docker-worker.mjs IMAGE [NODE_PATH] or --build-result BUILD.json');
const node = build ? '/opt/pxv/bin/node' : (process.argv[3] ?? '/usr/local/bin/node');
const group = (process.getgroups?.() ?? []).find((value) => value !== process.getgid?.());
if (group === undefined) throw new Error('Docker group fixture requires a supplementary caller group');
const root = await mkdtemp(join(tmpdir(), 'pxv-docker-integration-'));
const previous = process.env['PXV_CONTROL_ROOT'];
process.env['PXV_CONTROL_ROOT'] = join(root, 'control');
const runner = new CommandRunner();
const repository = process.cwd();
/** @type {string[]} */
const cleanupNames = [];
let lastWorkerName = '';
const helperModule = pathToFileURL(join(repository, 'packages/cli/dist/retained-helper.js')).href;
try {
  const project = join(root, 'project');
  await mkdir(project, { mode: 0o700 });
  const extensions = join(root, 'extensions');
  await prepareDockerEnvironment(extensions);
  const input = join(root, 'review + ż.txt');
  await writeFile(input, 'EXACT_REVIEW', { mode: 0o600 });
  const groupFile = join(project, 'group-only');
  await runner.run([
    'docker',
    'run',
    '--rm',
    '--mount',
    `type=bind,src=${project},dst=/fixture`,
    '--user',
    '0:0',
    '--entrypoint',
    node,
    image,
    '-e',
    `const fs=require('node:fs');fs.writeFileSync('/fixture/group-only','GROUP_OK');fs.chownSync('/fixture/group-only',0,${group});fs.chmodSync('/fixture/group-only',0o640);`,
  ]);
  /** Preserve the wrapper's real mounts/groups/streams, changing only the fixture image entrypoint.
   * @param {string} code @param {import('../packages/cli/dist/docker-worker.js').DockerWorkerOptions} [timing] */
  const worker =
    (code, timing = {}) =>
    /** @param {string[]} args @param {import('../packages/cli/dist/docker-worker.js').DockerWorkerOptions} [options] */ async (
      args,
      options,
    ) => {
      lastWorkerName = options?.container?.name ?? '';
      if (lastWorkerName) cleanupNames.push(lastWorkerName);
      const at = args.findIndex((value) => /^sha256:[a-f0-9]{64}$/u.test(value));
      assert.ok(at > 0);
      const pinned = args[at];
      assert.ok(pinned);
      return runDockerWorker(
        [
          ...args.slice(0, at),
          '--mount',
          `type=bind,src=${repository},dst=${repository},readonly`,
          '--entrypoint',
          node,
          pinned,
          '-e',
          code,
          '--',
          ...args.slice(at + 1),
        ],
        { ...options, ...timing },
      );
    };
  const inspect = `const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(1);assert.equal(fs.readFileSync(args[args.indexOf('--review-file')+1],'utf8'),'EXACT_REVIEW');assert.throws(()=>fs.writeFileSync(args[args.indexOf('--review-file')+1],'BAD'),error=>error.code==='EROFS');assert.equal(fs.readFileSync(${JSON.stringify(groupFile)},'utf8'),'GROUP_OK');assert.equal(fs.readFileSync('/project/group-only','utf8'),'GROUP_OK');process.stderr.write('Streaming Docker fixture passed\\n');console.log(JSON.stringify({input:true,groups:true,alias:true}));`;
  assert.equal(
    await runInDocker(
      ['agent', 'execute', '--review-file', input, '--json'],
      project,
      image,
      'host-adb',
      extensions,
      runner,
      worker(inspect),
    ),
    0,
  );
  const output = join(root, 'private output');
  const write = `const fs=require('node:fs'),args=process.argv.slice(1);fs.writeFileSync(args[args.indexOf('--output')+1]+'/handoff.txt','PERSISTED');`;
  assert.equal(
    await runInDocker(
      ['handoff', 'export', '--output', output],
      project,
      image,
      'host-adb',
      extensions,
      runner,
      worker(write),
    ),
    0,
  );
  assert.equal(await readFile(join(output, 'handoff.txt'), 'utf8'), 'PERSISTED');
  await mkdir(join(project, 'state/plans/review'), { recursive: true });
  const helper = join(project, 'state/plans/review/helper.apk');
  await writeFile(helper, 'EXACT_HELPER');
  await symlink(helper, join(project, 'state/plans/review/symlink.apk'));
  const retained = JSON.stringify({ path: '/project/state/plans/review/helper.apk' });
  await writeFile(join(project, 'retained.json'), retained);
  const aliasCheck = `void(async()=>{const fs=require('node:fs/promises'),assert=require('node:assert/strict'),{retainedHelperPath}=await import(${JSON.stringify(helperModule)});assert.equal(await retainedHelperPath(${JSON.stringify(project)},'/project/state/plans/review/helper.apk'),${JSON.stringify(helper)});assert.equal(await retainedHelperPath(${JSON.stringify(project)},${JSON.stringify(helper)}),${JSON.stringify(helper)});assert.equal(await fs.readFile(${JSON.stringify(helper)},'utf8'),'EXACT_HELPER');await assert.rejects(retainedHelperPath(${JSON.stringify(project)},'/project/state/plans/../outside.apk'));await assert.rejects(retainedHelperPath(${JSON.stringify(project)},'/project/state/plans/review/symlink.apk'),/symlinks/);})().catch(error=>{console.error(error);process.exitCode=1});`;
  assert.equal(
    await runInDocker(
      ['device', 'recover', '--asset', 'fixture'],
      project,
      image,
      'host-adb',
      extensions,
      runner,
      worker(aliasCheck),
    ),
    0,
  );
  assert.equal(await readFile(join(project, 'retained.json'), 'utf8'), retained);
  const other = join(root, 'other-project');
  await mkdir(other);
  const falseAlias = `void(async()=>{const assert=require('node:assert/strict'),{retainedHelperPath}=await import(${JSON.stringify(helperModule)});await assert.rejects(retainedHelperPath(${JSON.stringify(project)},'/project/state/plans/review/helper.apk'),/differs/);})().catch(error=>{console.error(error);process.exitCode=1});`;
  assert.equal(
    await runDockerWorker([
      'docker',
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      `${process.getuid?.()}:${process.getgid?.()}`,
      '--mount',
      `type=bind,src=${repository},dst=${repository},readonly`,
      '--mount',
      `type=bind,src=${project},dst=${project},readonly`,
      '--mount',
      `type=bind,src=${other},dst=/project,readonly`,
      '--env',
      'PXV_DOCKER_MODE=host-adb',
      '--entrypoint',
      node,
      image,
      '-e',
      falseAlias,
    ]),
    0,
  );
  const guard = dockerWorkerIdentity(join(root, 'guard'));
  const protectedNames = [guard.name, `${guard.name}-unrelated`];
  for (const name of protectedNames) {
    cleanupNames.push(name);
    await runner.run([
      'docker',
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--network',
      'none',
      '--label',
      'org.pxv.adb-control=disposable-test-fixture',
      '--entrypoint',
      node,
      image,
      '-e',
      'setInterval(()=>{},1000)',
    ]);
  }
  await assert.rejects(new DockerWorkerControl(guard, runner).forceStop(), /ownership differs/);
  let forcedWorker = false;
  /** @type {import('../packages/adapters/dist/command.js').CommandRunner} */
  const shutdownControl = {
    run: (args, options) => {
      if (args[1] === 'kill') forcedWorker = true;
      return runner.run(args, options);
    },
  };
  const marker = join(project, 'shutdown-ready');
  const began = performance.now();
  assert.equal(
    await runInDocker(
      ['inventory', 'list', '--json'],
      project,
      image,
      'host-adb',
      extensions,
      runner,
      worker(
        `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},'READY');setInterval(()=>{},1000)`,
        { control: shutdownControl, timeoutMs: 5000, graceMs: 100, controlTimeoutMs: 1000, reapMs: 1000 },
      ),
    ),
    124,
  );
  assert.equal(await readFile(marker, 'utf8'), 'READY');
  assert.ok(forcedWorker, 'Signal-ignoring worker must require an owned-container kill');
  assert.ok(performance.now() - began < 15_000, 'Ignored-signal worker shutdown must be bounded');
  const stoppedWorker = await runner.run(
    ['docker', 'container', 'inspect', '--format', '{{.State.Running}}', lastWorkerName],
    { check: false, timeoutMs: 1000 },
  );
  assert.ok(stoppedWorker.code !== 0 || stoppedWorker.stdout.trim() === 'false');
  for (const name of protectedNames) {
    const retained = await runner.run([
      'docker',
      'container',
      'inspect',
      '--format',
      '{{.State.Running}}',
      name,
    ]);
    assert.equal(
      retained.stdout.trim(),
      'true',
      'Worker cleanup must preserve unrelated and sidecar-labeled containers',
    );
  }
  await mkdir('.quality', { recursive: true });
  await writeFile(
    '.quality/docker-worker.json',
    JSON.stringify(
      {
        status: 'passed',
        image,
        inputReadOnly: true,
        outputPersistent: true,
        groupFixture: true,
        projectAlias: true,
        retainedAliasRecovery: true,
        falseAliasRejected: true,
        symlinkRejected: true,
        boundedWorkerShutdown: true,
        unrelatedContainersPreserved: true,
        sidecarOwnershipRejected: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Disposable Docker worker path/group integration passed.');
} finally {
  for (const name of cleanupNames)
    await runner.run(['docker', 'rm', '--force', name], { check: false, timeoutMs: 10_000 }).catch(() => {});
  if (previous === undefined) delete process.env['PXV_CONTROL_ROOT'];
  else process.env['PXV_CONTROL_ROOT'] = previous;
  await rm(root, { recursive: true, force: true });
}
