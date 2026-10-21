import { afterEach, beforeEach, expect, it } from './../test-api.js';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMaster, verifyMaster } from '../../tools/lib/personal-master.mjs';
import { fileHash, treeFiles } from '../../tools/lib/personal-files.mjs';
import { createPersonalMaster, recoverPersonalDevice } from '../../tools/lib/personal-workflows.mjs';
import { qualifiedAdapter } from '../../tools/lib/personal-validation.mjs';
import { invoke } from '../../tools/lib/personal-cli.mjs';
import { resolvePolicy, toPolicyDocument, type ProjectConfig } from '@pxv/contracts';
import {
  fakePxv,
  fakeResources,
  personalFixture,
  type PersonalFixture,
} from './personal-recovery-fixtures.js';

let fixture: PersonalFixture;
beforeEach(async () => {
  fixture = await personalFixture();
});
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});
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
function answer(question: string) {
  if (question.includes('Type EXECUTE')) return Promise.resolve('EXECUTE');
  if (question.includes('Type READY')) return Promise.resolve('READY');
  if (question.includes('Type PIXEL1')) return Promise.resolve('PIXEL1');
  if (question.includes('Type REPLACEMENT')) return Promise.resolve('REPLACEMENT');
  return Promise.resolve('done');
}
it('preserves UTF-8 JSON and diagnostics across every byte boundary', async () => {
  const expected = JSON.stringify({ name: 'Właściciel', text: 'Zażółć 🧪' });
  const bin = await fakePxv(
    fixture.root,
    `const b=Buffer.from(${JSON.stringify(expected)}),i=Number(process.argv[process.argv.indexOf('--split')+1]);for(const s of [process.stdout,process.stderr])s.write(b.subarray(0,i));setTimeout(()=>{for(const s of [process.stdout,process.stderr])s.write(b.subarray(i));},30);`,
  );
  const session = {
    root: fixture.root,
    bin,
    project: fixture.projectRoot,
    asset: 'all',
    operator: 'Self',
    signal: new AbortController().signal,
    prompt: answer,
  };
  for (let split = 1; split < Buffer.byteLength(expected); split++) {
    const result = await invoke(session, ['--split', String(split)]);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe(expected);
  }
});
for (const fault of ['deleted', 'corrupt', 'changed-and-renewed'])
  it(`rechecks backup approval after the physical checkpoint: ${fault}`, async () => {
    const resources = await fakeResources(fixture),
      log = join(fixture.root, 'calls.jsonl');
    const bin = await fakePxv(
      fixture.root,
      `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(log)},'UNEXPECTED CONNECTION');`,
    );
    const lockPath = join(fixture.projectRoot, 'policy.lock.json');
    const session = {
      root: resources,
      bin,
      project: fixture.projectRoot,
      asset: 'all',
      operator: 'Self',
      signal: new AbortController().signal,
      prompt: async () => {
        if (fault === 'deleted') await rm(lockPath);
        else if (fault === 'corrupt') await writeFile(lockPath, '{invalid');
        else {
          const policy = { ...fixture.selected, name: 'Reviewed replacement policy' };
          await writeFile(join(fixture.projectRoot, 'policy.json'), JSON.stringify(toPolicyDocument(policy)));
          const config = JSON.parse(
            await readFile(join(fixture.projectRoot, 'pxv.project.json'), 'utf8'),
          ) as ProjectConfig;
          await writeFile(
            lockPath,
            JSON.stringify(
              resolvePolicy(policy, config, fixture.identity.product, fixture.identity.engineDigest),
            ),
          );
        }
        return 'done';
      },
    };
    await expect(
      createPersonalMaster(session, {
        'backup-only': true,
        'usb-root': fixture.usb,
        'backup-dir': fixture.destination,
        'seedvault-adapter': fixture.adapter,
        'coverage-file': fixture.coverageFile,
        endpoint: '192.0.2.10:37123',
        'pair-endpoint': '192.0.2.10:41234',
      }),
    ).rejects.toThrow(
      fault === 'changed-and-renewed' ? 'restart the workflow' : 'explicitly renew policy lock',
    );
    await expect(lstat(log)).rejects.toThrow();
    await expect(lstat(fixture.destination)).rejects.toThrow();
  });
for (const fault of ['missing', 'corrupt', 'policy', 'configuration', 'executable'])
  for (const dryRun of [false, true])
    it(`rejects ${fault} backup approval before prompts or commands (dry run: ${dryRun})`, async () => {
      const resources = await fakeResources(fixture);
      const lockPath = join(fixture.projectRoot, 'policy.lock.json');
      if (fault === 'missing') await rm(lockPath);
      if (fault === 'corrupt') await writeFile(lockPath, '{invalid');
      if (fault === 'policy') {
        const path = join(fixture.projectRoot, 'policy.json');
        const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        await writeFile(path, JSON.stringify({ ...value, name: 'Changed policy' }));
      }
      if (fault === 'configuration') {
        const path = join(fixture.projectRoot, 'pxv.project.json');
        const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        await writeFile(
          path,
          JSON.stringify({ ...value, insertMetadata: { projectName: 'Changed project' } }),
        );
      }
      if (fault === 'executable')
        await writeFile(
          join(resources, 'packages/engine/dist/integrity.js'),
          `export async function engineIntegrity(){return '${'c'.repeat(64)}';}`,
        );
      const before = fault === 'missing' ? undefined : await readFile(lockPath, 'utf8');
      const questions: string[] = [];
      await expect(
        createPersonalMaster(
          {
            root: resources,
            bin: '/no/device/commands',
            project: fixture.projectRoot,
            asset: 'all',
            operator: 'Self',
            signal: new AbortController().signal,
            prompt: (question: string) => {
              questions.push(question);
              return answer(question);
            },
          },
          {
            'backup-only': true,
            'dry-run': dryRun,
            'usb-root': fixture.usb,
            'backup-dir': fixture.destination,
            'seedvault-adapter': fixture.adapter,
            'coverage-file': fixture.coverageFile,
            endpoint: '192.0.2.10:37123',
          },
        ),
      ).rejects.toThrow('explicitly renew policy lock');
      expect(questions).toEqual([]);
      if (before === undefined) await expect(lstat(lockPath)).rejects.toThrow();
      else expect(await readFile(lockPath, 'utf8')).toBe(before);
      await expect(lstat(fixture.destination)).rejects.toThrow();
    });
it('retains old or unrelated encrypted trees with an explicitly unverified incomplete status', async () => {
  await writeFile(
    join(fixture.usb, '.SeedVaultAndroidBackup/metadata'),
    'unrelated old encrypted repository',
  );
  const manifest = (await createMaster(masterOptions())) as {
    complete: boolean;
    copyIntegrityVerified: boolean;
    generationCorrespondence: string;
    restoration: string;
    coverage: { allAppsRecoverable: boolean };
  };
  expect(manifest).toMatchObject({
    complete: false,
    copyIntegrityVerified: true,
    generationCorrespondence: 'unverified',
    restoration: 'untested',
    coverage: { allAppsRecoverable: false },
  });
  await verifyMaster(fixture.destination);
});
it('qualifies exact adapter acceptance locally and rejects tampering before any device command or copy', async () => {
  await expect(qualifiedAdapter(fixture.adapter)).resolves.toBeDefined();
  await writeFile(join(fixture.root, 'acceptance.json'), '{"result":"pass"}');
  await expect(qualifiedAdapter(fixture.adapter)).rejects.toThrow('acceptance evidence changed');
  const session = {
    root: await fakeResources(fixture),
    bin: '/no/device/commands',
    project: fixture.projectRoot,
    asset: 'all',
    operator: 'Self',
    signal: new AbortController().signal,
    prompt: answer,
  };
  await expect(
    createPersonalMaster(session, {
      'backup-only': true,
      'usb-root': fixture.usb,
      'backup-dir': fixture.destination,
      'seedvault-adapter': fixture.adapter,
      'coverage-file': fixture.coverageFile,
      endpoint: '192.0.2.10:37123',
    }),
  ).rejects.toThrow('acceptance evidence changed');
  await expect(lstat(fixture.destination)).rejects.toThrow();
});
it('rejects missing or malformed source-profile evidence before working USB writes or erasure', async () => {
  await createMaster(masterOptions());
  const manifestPath = join(fixture.destination, 'master.json');
  const original = await readFile(manifestPath, 'utf8');
  const working = join(fixture.root, 'working');
  await mkdir(working);
  const session = {
    root: await fakeResources(fixture),
    bin: '/no/device/commands',
    project: fixture.projectRoot,
    asset: 'all',
    operator: 'Self',
    signal: new AbortController().signal,
    prompt: answer,
  };
  for (const profiles of [
    [],
    [
      {
        ...fixture.report.profiles[0]!.evidence,
        source: { profileId: 'admin', token: 'abc123', selector: { resourceId: 'only-id-with-no-label' } },
      },
    ],
  ]) {
    const manifest = JSON.parse(original) as { seedvault: { profiles: unknown[] } };
    manifest.seedvault.profiles = profiles;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(
      recoverPersonalDevice(session, {
        master: fixture.destination,
        'same-device': true,
        serial: 'PIXEL1',
        model: 'Pixel 8a',
        'usb-root': working,
        'seedvault-adapter': fixture.adapter,
        endpoint: '192.0.2.10:37123',
      }),
    ).rejects.toThrow();
    expect(await readdir(working)).toEqual([]);
  }
});
it('same-device recovery rejects outstanding approved work before copying the drive or recording maintenance', async () => {
  await createMaster(masterOptions());
  const working = join(fixture.root, 'working');
  await mkdir(working);
  const log = join(fixture.root, 'active.jsonl');
  const bin = await fakePxv(
    fixture.root,
    String.raw`import{appendFileSync}from'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\n');if(args[0]==='agent'&&args[1]==='runs'){if(args.includes('--cursor'))console.log(JSON.stringify({items:[{key:'old-approved',value:{id:'old-approved',status:'queued'}}],nextCursor:null}));else console.log(JSON.stringify({items:Array.from({length:1000},(_,i)=>({key:'completed-'+i,value:{id:'completed-'+i,status:'completed'}})),nextCursor:'next-page'}));}else throw Error('No later command is allowed');`,
  );
  const session = {
    root: await fakeResources(fixture),
    bin,
    project: fixture.projectRoot,
    asset: 'all',
    operator: 'Self',
    signal: new AbortController().signal,
    prompt: answer,
  };
  await expect(
    recoverPersonalDevice(session, {
      master: fixture.destination,
      'same-device': true,
      serial: 'PIXEL1',
      model: 'Pixel 8a',
      'usb-root': working,
      'seedvault-adapter': fixture.adapter,
      endpoint: '192.0.2.10:37123',
    }),
  ).rejects.toThrow('explicitly cancel');
  expect(await readdir(working)).toEqual([]);
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(expect.arrayContaining(['--cursor', 'next-page']));
  for (const call of calls) expect(call).toContain('--json');
});
it.each([true, false])(
  'recovery preserves same-phone history=%s and creates isolated replacement state otherwise',
  async (sameDevice) => {
    await createMaster(masterOptions());
    const before = await fileHash(join(fixture.destination, 'master.json'));
    const working = join(fixture.root, 'working'),
      target = sameDevice ? fixture.projectRoot : join(fixture.root, 'replacement');
    await mkdir(working);
    const serial = sameDevice ? 'PIXEL1' : 'REPLACEMENT';
    const restored = structuredClone(fixture.report);
    restored.operation = 'restore';
    restored.runId = 'run-restore';
    restored.deviceSerial = serial;
    for (const profile of restored.profiles) profile.evidence!.operation = 'restore';
    const log = join(fixture.root, 'calls.jsonl');
    const bin = await fakePxv(
      fixture.root,
      String.raw`import{appendFileSync,readFileSync,writeFileSync,mkdirSync,existsSync}from'node:fs';import{join}from'node:path';const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1],cmd=args.slice(0,2).join(' '),out=x=>console.log(JSON.stringify(x)),project=get('--project-root');appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\n');if(cmd!=='agent runs'&&!existsSync(${JSON.stringify(join(working, '.SeedVaultAndroidBackup/metadata'))}))throw Error('Working copy must precede phone commands');if(cmd==='agent runs')out({items:[],nextCursor:null});else if(cmd==='project init'){mkdirSync(join(project,'state'),{recursive:true});writeFileSync(join(project,'pxv.project.json'),JSON.stringify({format:'pxv-ts',schemaVersion:1,id:'fresh-project',productId:'pxv',policyFile:'policy.json',inventoryFile:'inventory.json',extensions:[]}));writeFileSync(join(project,'policy.json'),readFileSync(get('--policy')));writeFileSync(join(project,'inventory.json'),JSON.stringify({schemaVersion:1,devices:[]}));writeFileSync(join(project,'state/pxv.sqlite3'),'NEW_HISTORY');out({root:project});}else if(cmd==='inventory enroll'){const file=join(project,'inventory.json'),inv=JSON.parse(readFileSync(file,'utf8'));inv.devices.push({assetId:get('--asset'),canonicalSerial:get('--serial')});writeFileSync(file,JSON.stringify(inv));out({enrolled:true});}else if(cmd==='policy validate'||cmd==='policy lock'||cmd==='device inspect'||cmd==='lifecycle maintenance')out({ok:true});else if(cmd==='device install-os'||cmd==='device create-users'||cmd==='device provision'||cmd==='seedvault restore'){const plan=cmd==='device install-os'?'os':cmd==='device create-users'?'users':cmd==='device provision'?'provision':'restore';out({planId:plan,reviewSummary:'REVIEW_'+plan,expiresAt:'2099-01-01T00:00:00Z'});}else if(cmd==='agent execute'){if(readFileSync(get('--review-file'),'utf8')!=='REVIEW_'+get('--plan'))throw Error('Changed review');out({id:'run-'+get('--plan'),status:'queued'});}else if(cmd==='agent status'){const id=get('--run');out({run:{id,status:id==='run-os'||id==='run-provision'?'pending':'completed'},events:id==='run-os'?[{event:{type:'awaiting-os-reenrollment'}}]:[]});}else if(cmd==='seedvault connect'||cmd==='seedvault disconnect')out({connected:true});else if(cmd==='seedvault inspect')out({deviceSerial:${JSON.stringify(serial)},unsupportedUsers:[],profiles:[{profileId:'admin'}]});else if(cmd==='seedvault report')out(${JSON.stringify(restored)});else throw Error('unexpected '+cmd);`,
    );
    const session = {
      root: await fakeResources(fixture),
      bin,
      project: target,
      asset: 'all',
      operator: 'Self',
      signal: new AbortController().signal,
      prompt: answer,
    };
    await recoverPersonalDevice(session, {
      master: fixture.destination,
      'same-device': sameDevice,
      serial,
      model: 'Pixel 8a',
      'usb-root': working,
      'seedvault-adapter': fixture.adapter,
      endpoint: '192.0.2.10:37123',
    });
    expect(await fileHash(join(fixture.destination, 'master.json'))).toBe(before);
    const marker = JSON.parse(await readFile(join(target, 'pxv.project.json'), 'utf8')) as { id: string };
    expect(marker.id).toBe(sameDevice ? 'pilot' : 'fresh-project');
    expect(await readFile(join(target, 'state/pxv.sqlite3'), 'utf8')).toBe(
      sameDevice ? 'DO_NOT_COPY_HISTORY' : 'NEW_HISTORY',
    );
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args[0] === 'lifecycle' && args[1] === 'maintenance')).toBe(sameDevice);
    expect(calls.some((args) => args[0] === 'inventory' && args[1] === 'enroll')).toBe(!sameDevice);
    const inventory = JSON.parse(await readFile(join(target, 'inventory.json'), 'utf8')) as {
      devices: { canonicalSerial: string }[];
    };
    expect(inventory.devices).toHaveLength(1);
    expect(inventory.devices[0]!.canonicalSerial).toBe(serial);
    expect(
      (await treeFiles(join(target, 'state/personal-recovery'))).some((name) =>
        name.endsWith('-restore-check.json'),
      ),
    ).toBe(true);
  },
);
