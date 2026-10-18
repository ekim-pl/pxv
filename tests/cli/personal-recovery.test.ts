import { afterEach, beforeEach, expect, it } from './../test-api.js';
import { appendFile, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { distinctRoots, fileHash, treeFiles } from '../../tools/lib/personal-files.mjs';
import {
  completedEvidence,
  compatibleIdentity,
  createMaster,
  localArtifacts,
  verifyMaster,
  workingUsb,
} from '../../tools/lib/personal-master.mjs';
import { createPersonalMaster, restoreSources } from '../../tools/lib/personal-workflows.mjs';
import { reviewedOperation, terminalRun } from '../../tools/lib/personal-cli.mjs';
import { normalizeOptions } from '../../tools/lib/personal-options.mjs';
import { fakePxv, personalFixture, type PersonalFixture } from './personal-recovery-fixtures.js';

let fixture: PersonalFixture;
beforeEach(async () => {
  fixture = await personalFixture();
});
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});
const repo = fileURLToPath(new URL('../../', import.meta.url));
function masterOptions() {
  return {
    project: fixture.projectRoot,
    usb: fixture.usb,
    destination: fixture.destination,
    report: fixture.report,
    expected: ['admin'],
    identity: fixture.identity,
    coverage: fixture.coverage,
    adapter: fixture.definition,
  };
}
it('streams a complete private generation including hidden/binary files and local APK/probe dependencies', async () => {
  await mkdir(join(fixture.usb, '.SeedVaultAndroidBackup/.hidden/empty-directory'));
  await writeFile(
    join(fixture.usb, '.SeedVaultAndroidBackup/.hidden/large'),
    Buffer.alloc(9 * 1024 * 1024, 255),
  );
  await createMaster(masterOptions());
  await verifyMaster(fixture.destination);
  const files = await treeFiles(fixture.destination);
  expect(files).toContain('seedvault/.SeedVaultAndroidBackup/.hidden/large');
  expect(files).toContain('project/artifacts/probe.apk');
  expect(files).toContain('project/artifacts/app.apk');
  expect(files).toContain('qualification/adapter.json');
  expect(files).toContain('qualification/acceptance.json');
  expect(
    (
      await lstat(join(fixture.destination, 'seedvault/.SeedVaultAndroidBackup/.hidden/empty-directory'))
    ).isDirectory(),
  ).toBe(true);
  const portable = JSON.parse(
    await readFile(join(fixture.destination, 'qualification/adapter.json'), 'utf8'),
  ) as { acceptance: { path: string } };
  expect(portable.acceptance.path).toBe('acceptance.json');
  expect(files.some((name) => /sqlite|inventory|signing|state\/|secrets\//u.test(name))).toBe(false);
  expect(await fileHash(join(fixture.destination, 'seedvault/.SeedVaultAndroidBackup/.hidden/large'))).toBe(
    await fileHash(join(fixture.usb, '.SeedVaultAndroidBackup/.hidden/large')),
  );
  expect((await lstat(fixture.destination)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(fixture.destination, 'master.json'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(fixture.projectRoot, 'state/pxv.sqlite3'), 'utf8')).toBe('DO_NOT_COPY_HISTORY');
  await expect(createMaster(masterOptions())).rejects.toThrow('overwrite');
});
it('never publishes incomplete profile evidence and retains failed filesystem generations visibly incomplete', async () => {
  const pending = structuredClone(fixture.report);
  pending.profiles[0]!.status = 'pending';
  await expect(createMaster({ ...masterOptions(), report: pending })).rejects.toThrow('Incomplete');
  await expect(lstat(fixture.destination)).rejects.toThrow();
  await expect(createMaster({ ...masterOptions(), expected: ['admin', 'daily'] })).rejects.toThrow(
    'every requested profile',
  );
  await symlink(
    join(fixture.projectRoot, 'secrets/signing.key'),
    join(fixture.usb, '.SeedVaultAndroidBackup/link'),
  );
  await expect(createMaster(masterOptions())).rejects.toThrow('INCOMPLETE');
  const retained = (await readdir(fixture.masters)).find((name) => name.startsWith('.incomplete-'));
  expect(retained).toBeDefined();
  expect(await readFile(join(fixture.masters, retained!, 'INCOMPLETE.json'), 'utf8')).toContain('false');
  await expect(lstat(fixture.destination)).rejects.toThrow();
});
it('verifies digests, rejects unmanifested files and preserves the source while making a working USB copy', async () => {
  await createMaster(masterOptions());
  const working = join(fixture.root, 'working');
  await mkdir(working);
  const before = await fileHash(join(fixture.destination, 'master.json'));
  await workingUsb(fixture.destination, working);
  expect(await fileHash(join(fixture.destination, 'master.json'))).toBe(before);
  expect(await readFile(join(working, '.SeedVaultAndroidBackup/metadata'), 'utf8')).toBe(
    'encrypted metadata',
  );
  await expect(workingUsb(fixture.destination, working)).rejects.toThrow('overwrite');
  await appendFile(join(fixture.destination, 'project/artifacts/app.apk'), 'corrupt');
  await expect(verifyMaster(fixture.destination)).rejects.toThrow('digest mismatch');
});
it('rejects unsafe dependencies, shared roots, unreviewed extensions and mismatched product/build identity', async () => {
  await expect(distinctRoots([fixture.projectRoot, join(fixture.projectRoot, 'backup')])).rejects.toThrow(
    'overlap',
  );
  for (const path of ['../escape.apk', '/tmp/escape.apk', 'state/private.apk', 'policy.json']) {
    const selected = structuredClone(fixture.selected);
    selected.profiles[0]!.packages[0]!.path = path;
    expect(() => localArtifacts(selected)).toThrow();
  }
  expect(() =>
    compatibleIdentity(fixture.identity, { ...fixture.identity, engineDigest: 'b'.repeat(64) }),
  ).toThrow('same reviewed');
  const configPath = join(fixture.projectRoot, 'pxv.project.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { extensions: unknown[] };
  config.extensions = [{ id: 'unreviewed-extension' }];
  await writeFile(configPath, JSON.stringify(config));
  await expect(createMaster(masterOptions())).rejects.toThrow('extension-free');
});
it('rejects forged manifest paths and requires exact per-profile restore selectors', async () => {
  const evidence = completedEvidence(fixture.report, ['admin']) as { profileId: string; source: unknown }[];
  expect(restoreSources({ seedvault: { profiles: evidence } }, ['admin'])).toEqual([evidence[0]!.source]);
  expect(() => {
    restoreSources({ seedvault: { profiles: evidence } }, ['admin', 'daily']);
  }).toThrow('every current target profile');
  await createMaster(masterOptions());
  const manifestPath = join(fixture.destination, 'master.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: { path: string }[] };
  manifest.files[0]!.path = '../outside';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(verifyMaster(fixture.destination)).rejects.toThrow('Unsafe relative');
});
it('classifies OS reenrollment and provisioning readiness separately and never accepts failed status from exit zero', () => {
  const run = { id: 'run', status: 'pending' };
  expect(terminalRun({ run, events: [{ event: { type: 'awaiting-os-reenrollment' } }] }, 'os')).toBe(true);
  expect(() => terminalRun({ run, events: [] }, 'os')).toThrow('no supported continuation');
  expect(terminalRun({ run }, 'provision')).toBe(true);
  expect(terminalRun({ run: { ...run, manualGate: 'normal_credentials' } }, 'provision')).toBe(false);
  expect(() => terminalRun({ run: { ...run, status: 'needs-inspection' } }, 'provision')).toThrow(
    'Preserve evidence',
  );
});
it('requires an explicit recovery mode and defaults recovery finalization while forbidding backup-only provisioning', () => {
  const base = { asset: 'personal', operator: 'Self', endpoint: '192.0.2.10:37123' };
  const options: Record<string, string | boolean | undefined> = {
    ...base,
    mode: 'replacement',
    'master-dir': '/private/master',
    locale: 'pl',
  };
  normalizeOptions('recover', options);
  expect(options).toMatchObject({ finalize: true, 'same-device': false, master: '/private/master' });
  const ownerAlias: Record<string, string | boolean | undefined> = {
    asset: base.asset,
    endpoint: base.endpoint,
    owner: 'Self',
    'master-dir': '/private/new-copy',
  };
  normalizeOptions('create', ownerAlias);
  expect(ownerAlias).toMatchObject({ operator: 'Self', 'backup-dir': '/private/new-copy' });
  const optOut: Record<string, string | boolean | undefined> = {
    ...base,
    mode: 'same-device',
    'no-finalize': true,
  };
  normalizeOptions('recover', optOut);
  expect(optOut).toMatchObject({ finalize: false, 'same-device': true });
  expect(() => normalizeOptions('recover', base)).toThrow('--mode');
  expect(() => normalizeOptions('create', { ...base, 'backup-only': true, finalize: true })).toThrow(
    'never provisions',
  );
});
it('canonical recovery commands offer help; dry-run reads inputs without a CLI call or filesystem changes', async () => {
  for (const mode of ['create', 'recover']) {
    const help = spawnSync(process.execPath, [join(repo, 'tools/personal-recovery.mjs'), mode, '--help'], {
      encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--dry-run');
  }
  const before = await treeFiles(fixture.root);
  const result = spawnSync(
    process.execPath,
    [
      join(repo, 'tools/personal-recovery.mjs'),
      'create',
      '--dry-run',
      '--project-root',
      join(fixture.root, 'new-project'),
      '--policy',
      join(fixture.projectRoot, 'policy.json'),
      '--asset',
      'personal',
      '--serial',
      'NEW_SERIAL',
      '--model',
      'Pixel 8a',
      '--operator',
      'Owner',
      '--usb-root',
      fixture.usb,
      '--backup-dir',
      fixture.destination,
      '--endpoint',
      '192.0.2.10:37123',
    ],
    { encoding: 'utf8', env: { ...process.env, PXV_BIN: '/not/a/real/cli' } },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout) as unknown).toMatchObject({ dryRun: true, mutationsPerformed: false });
  expect(await treeFiles(fixture.root)).toEqual(before);
  await expect(lstat(join(fixture.root, 'new-project'))).rejects.toThrow();
});
it('backup-only execution never flashes, enrolls or provisions and requires a durable all-profile report', async () => {
  const resources = join(fixture.root, 'resources');
  await mkdir(join(resources, 'packages/engine/dist'), { recursive: true });
  await writeFile(join(resources, 'package.json'), '{"type":"module"}');
  await writeFile(join(resources, 'product.json'), JSON.stringify(fixture.identity.product));
  await writeFile(
    join(resources, 'packages/engine/dist/integrity.js'),
    'export async function engineIntegrity(){return ' + JSON.stringify(fixture.identity.engineDigest) + ';}',
  );
  const questions: string[] = [];
  const log = join(fixture.root, 'calls.jsonl'),
    adapter = fixture.adapter;
  const bin = await fakePxv(
    fixture.root,
    String.raw`import{appendFileSync,readFileSync}from'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\n');const out=x=>console.log(JSON.stringify(x));const cmd=args.slice(0,2).join(' ');const get=k=>args[args.indexOf(k)+1];if(cmd==='policy lock'||cmd==='device inspect')out({ok:true});else if(cmd==='seedvault connect'||cmd==='seedvault disconnect')out({connected:true});else if(cmd==='seedvault inspect')out({deviceSerial:'PIXEL1',unsupportedUsers:[],profiles:[{profileId:'admin'}]});else if(cmd==='seedvault backup')out({planId:'plan',reviewSummary:'EXACT_REVIEW',expiresAt:'2099-01-01T00:00:00Z'});else if(cmd==='agent execute'){if(readFileSync(get('--review-file'),'utf8')!=='EXACT_REVIEW')throw Error('changed review');out({id:'backup-run',status:'queued'});}else if(cmd==='agent status')out({run:{id:'backup-run',status:'completed'}});else if(cmd==='seedvault report')out(${JSON.stringify(fixture.report)});else throw Error('Unexpected operation '+cmd);`,
  );
  const session = {
    root: resources,
    bin,
    project: fixture.projectRoot,
    asset: 'all',
    operator: 'Self',
    signal: new AbortController().signal,
    prompt: (question: string) => {
      questions.push(question);
      return Promise.resolve(question.includes('Type EXECUTE') ? 'EXECUTE' : 'done');
    },
  };
  await createPersonalMaster(session, {
    'backup-only': true,
    'usb-root': fixture.usb,
    'backup-dir': fixture.destination,
    'seedvault-adapter': adapter,
    'coverage-file': fixture.coverageFile,
    endpoint: '192.0.2.10:37123',
    'pair-endpoint': '192.0.2.10:41234',
  });
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  expect(calls.some((args) => ['install-os', 'provision', 'enroll'].includes(args[1]!))).toBe(false);
  const requestCall = calls.find((args) => args[0] === 'seedvault' && args[1] === 'backup')!;
  const request = JSON.parse(await readFile(requestCall[requestCall.indexOf('--file') + 1]!, 'utf8')) as {
    adapter: { acceptance: { path: string } };
  };
  expect(request.adapter.acceptance.path).toBe(join(fixture.root, 'acceptance.json'));
  expect(
    questions.some((question) => question.includes('ONLY the paired host created for this session')),
  ).toBe(true);
  await verifyMaster(fixture.destination);
});
it('preserves exact refreshed review bytes and resumes language checkpoints without attesting them', async () => {
  const log = join(fixture.root, 'reviews.jsonl'),
    state = join(fixture.root, 'state.json');
  await writeFile(state, '{}');
  const bin = await fakePxv(
    fixture.root,
    String.raw`import{appendFileSync,readFileSync,writeFileSync}from'node:fs';const args=process.argv.slice(2),file=${JSON.stringify(state)},state=JSON.parse(readFileSync(file,'utf8'));const out=x=>console.log(JSON.stringify(x)),get=k=>args[args.indexOf(k)+1],cmd=args.slice(0,2).join(' ');appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\n');const prepared=n=>({planId:'plan'+n,reviewSummary:'review'+n+'\\nEXACT',expiresAt:'2099-01-01T00:00:00Z'});if(cmd==='device provision')out(prepared(1));else if(cmd==='agent execute'){const n=get('--plan').slice(-1);if(readFileSync(get('--review-file'),'utf8')!==prepared(n).reviewSummary)throw Error('review changed');out({id:'run'+n,status:'queued'});}else if(cmd==='agent status'){const id=get('--run');out({run:{id,status:'pending',...(id==='run1'?{manualGate:'normal_credentials'}:state.languageDone?{}:{manualGate:'language:admin'})}});}else if(cmd==='device attest')out({check:get('--check')});else if(cmd==='agent resume'){if(get('--run')==='run1'){console.error('Reviewed plan expired; prepare again');process.exitCode=2;}else{state.languageDone=true;writeFileSync(file,JSON.stringify(state));out({id:'run2',status:'pending'});process.exitCode=4;}}else if(cmd==='agent refresh')out(prepared(2));else throw Error('unexpected '+cmd);`,
  );
  const session = {
    root: repo,
    bin,
    project: fixture.projectRoot,
    asset: 'all',
    operator: 'Self',
    signal: new AbortController().signal,
    prompt: (question: string) => Promise.resolve(question.includes('Type EXECUTE') ? 'EXECUTE' : 'done'),
  };
  expect((await reviewedOperation(session, ['device', 'provision'], 'provision')) as unknown).toMatchObject({
    id: 'run2',
    status: 'pending',
  });
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  const attested = calls
    .filter((args) => args[1] === 'attest')
    .map((args) => args[args.indexOf('--check') + 1]);
  expect(attested).toEqual(['normal_credentials']);
  expect(calls.filter((args) => args[1] === 'execute')).toHaveLength(2);
  for (const call of calls) expect(call).toContain('--json');
});
it('shows exact Seedvault profile instructions and cancels its exact retained run when the owner stops', async () => {
  const log = join(fixture.root, 'cancel.jsonl');
  const bin = await fakePxv(
    fixture.root,
    String.raw`import{appendFileSync}from'node:fs';const args=process.argv.slice(2),cmd=args.slice(0,2).join(' '),out=x=>console.log(JSON.stringify(x));appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\n');if(cmd==='seedvault backup')out({planId:'backup',reviewSummary:'review',expiresAt:'2099-01-01T00:00:00Z'});else if(cmd==='agent execute')out({id:'exact-run',status:'queued'});else if(cmd==='agent status')out({run:{id:'exact-run',status:'pending',manualGate:'seedvault:admin'}});else if(cmd==='seedvault report')out({cursor:0,profiles:[{instructions:'Unlock Administrator and privately choose the USB destination'}]});else if(cmd==='agent cancel')out({cancellationRequested:true});else throw Error('Unexpected '+cmd);`,
  );
  const questions: string[] = [];
  const session = {
    root: repo,
    bin,
    project: fixture.projectRoot,
    asset: 'all',
    operator: 'Self',
    signal: new AbortController().signal,
    prompt: (question: string) => {
      questions.push(question);
      return Promise.resolve(question.includes('Type EXECUTE') ? 'EXECUTE' : 'stop');
    },
  };
  await expect(reviewedOperation(session, ['seedvault', 'backup'], 'seedvault')).rejects.toThrow(
    'Stopped at the physical checkpoint',
  );
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  expect(calls.some((args) => args[0] === 'seedvault' && args[1] === 'report')).toBe(true);
  expect(calls.some((args) => args[1] === 'attest')).toBe(false);
  const cancelled = calls.find((args) => args[1] === 'cancel')!;
  expect(cancelled[cancelled.indexOf('--run') + 1]).toBe('exact-run');
  expect(questions.some((question) => question.includes('seedvault:admin'))).toBe(true);
});
