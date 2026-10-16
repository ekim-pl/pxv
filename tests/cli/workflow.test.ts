import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli, type CliIo } from '@pxv/cli';
import { recoveryReservations, supervisorPath } from '@pxv/runtime';
import { product } from '../contracts/fixtures.js';

let root: string;
let resources: string;
let project: string;
let statePath: string;
let server: Server;
let saved: NodeJS.ProcessEnv;
let output: string[];
let io: CliIo;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pxv-cli-live-fixture-'));
  resources = join(root, 'resources');
  project = join(root, 'project');
  statePath = join(root, 'phone.json');
  await mkdir(join(resources, 'policy-packs/reference-five'), { recursive: true });
  await writeFile(join(resources, 'product.json'), JSON.stringify(product));
  await writeFile(
    join(resources, product.defaultPolicy),
    JSON.stringify({
      schemaVersion: 1,
      id: 'fixture',
      version: '0.1.0',
      name: 'Disposable acceptance',
      capabilities: [],
      requiredAttestations: [],
      repositories: [],
      profiles: [
        {
          id: 'owner',
          name: 'Owner',
          kind: 'owner',
          packages: [],
          settings: [{ namespace: 'system', key: 'screen_off_timeout', value: '60000' }],
          permissions: [],
          vpn: { packageId: null, alwaysOn: false, lockdown: false },
        },
      ],
    }),
  );
  await writeFile(
    statePath,
    JSON.stringify({
      debug: true,
      settings: { screen_off_timeout: '30000' },
      users: [{ userId: 0, serialNo: 0, name: 'Owner' }],
    }),
  );
  const adb = join(root, 'adb');
  await writeFile(
    adb,
    `#!${process.execPath}\nimport{readFileSync,writeFileSync}from'node:fs';\nconst file=${JSON.stringify(statePath)};const state=JSON.parse(readFileSync(file,'utf8'));const args=process.argv.slice(2).map(x=>x.startsWith("'")&&x.endsWith("'")?x.slice(1,-1).replaceAll("'\\\\''", "'"):x);const at=args.indexOf('shell');const cmd=args.slice(at+1);const out=x=>process.stdout.write(String(x)+'\\n');const save=()=>writeFileSync(file,JSON.stringify(state));\nif(args.includes('version'))out('Android Debug Bridge version 1.0.41\\nVersion 37.0.1');\nelse if(args.includes('devices'))out('List of devices attached\\n'+(state.debug?'SERIAL device product:akita model:Pixel_8a device:akita':'')+'\\n');\nelse if(at>=0){if(cmd[0]==='getprop'){out(({'ro.serialno':'SERIAL','ro.product.model':'Pixel 8a','ro.product.device':'akita','ro.build.version.incremental':'2026100600','ro.build.display.id':'2026100600','ro.boot.verifiedbootstate':'green','ro.boot.flash.locked':'1','ro.boot.vbmeta.device_state':'locked','ro.build.version.release':'17','ro.build.fingerprint':'fixture/build'})[cmd[1]]??'');}\nelse if(cmd[0]==='cmd'&&cmd[1]==='user')out(state.users.map(u=>'UserInfo{'+u.userId+':'+u.name+':4c13} serialNo='+u.serialNo).join('\\n'));\nelse if(cmd[0]==='pm'&&cmd[1]==='list')out('');\nelse if(cmd[0]==='settings'){const action=cmd.includes('get')?'get':'put';const i=cmd.indexOf(action);const key=cmd[i+2];if(action==='get')out(key==='adb_enabled'?(state.debug?'1':'0'):key==='always_on_vpn_lockdown'?'0':key==='always_on_vpn_app'?'null':key==='adb_wifi_enabled'?'0':state.settings[key]??'null');else{state.settings[key]=cmd[i+3];if(key==='adb_enabled'){state.debug=false;save();process.exitCode=255;}else save();}}\nelse{process.stderr.write('Unexpected fixture command '+JSON.stringify(cmd));process.exitCode=2;}}else process.exitCode=2;\n`,
    { mode: 0o700 },
  );
  server = createServer((socket) => {
    socket.once('data', () => socket.end('OKAY00040029'));
  });
  await new Promise<void>((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  saved = { ...process.env };
  Object.assign(process.env, {
    PXV_TOOL_ADB: adb,
    PXV_HOST_ADB_HOST: '127.0.0.1',
    PXV_HOST_ADB_PORT: String(address.port),
    PXV_CONTROL_ROOT: join(root, 'control'),
    PXV_SUPERVISOR: await supervisorPath(),
  });
  output = [];
  io = { out: (text) => output.push(text), error: (text) => output.push(text) };
  await runCli(args(['project', 'init', '--path', project]), io);
  await runCli(
    args([
      'inventory',
      'enroll',
      '--asset',
      'phone-001',
      '--serial',
      'SERIAL',
      '--model',
      'Pixel 8a',
      '--codename',
      'akita',
      '--yes',
    ]),
    io,
  );
});
afterEach(async () => {
  process.env = saved;
  if (server)
    await new Promise<void>((resolveServer, reject) =>
      server.close((error) => (error ? reject(error) : resolveServer())),
    );
  if (root) await rm(root, { recursive: true, force: true });
});
function args(values: string[]): string[] {
  return [...values, '--resource-root', resources, '--project-root', project];
}
function device(values: string[]): string[] {
  return args(['device', ...values, '--asset', 'phone-001']);
}

it('executes real supervised CLI provisioning, rechecks evidence, shuts down debugging and records custody', async () => {
  expect(await runCli(device(['inspect']), io)).toBe(0);
  expect(await runCli(device(['plan']), io)).toBe(0);
  expect(await runCli(device(['guided', '--locale', 'pl', '--yes', '--operator', 'operator']), io)).toBe(4);
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
    settings: { screen_off_timeout: '60000' },
  });
  for (const check of ['verified_boot', 'recipient_acceptance', 'operator_signoff'])
    expect(await runCli(device(['attest', '--check', check, '--operator', 'operator', '--yes']), io)).toBe(0);
  expect(await runCli(device(['report']), io)).toBe(0);
  expect(output.at(-1)).toContain('"ready": true');
  expect(await runCli(device(['finalize', '--operator', 'operator', '--yes']), io)).toBe(0);
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ debug: false });
  expect(await recoveryReservations(join(root, 'control'))).toEqual([]);
  const receiptDirectory = join(root, 'control', 'receipts');
  const receipts = await Promise.all(
    (await readdir(receiptDirectory)).map(
      async (file) =>
        JSON.parse(await readFile(join(receiptDirectory, file), 'utf8')) as Record<string, unknown>,
    ),
  );
  const disconnects = receipts.filter((receipt) => receipt['code'] === 255);
  expect(disconnects).toHaveLength(1);
  expect(disconnects[0]).toMatchObject({
    status: 'completed',
    code: 255,
    cleanup_proven: true,
    interrupted: false,
    expected_exit_codes: [0, 255],
  });
  expect(
    await runCli(
      args([
        'handoff',
        'accept',
        '--asset',
        'phone-001',
        '--recipient',
        'recipient',
        '--debugging-off',
        '--yes',
      ]),
      io,
    ),
  ).toBe(0);
  expect(output.at(-1)).toContain('completed-custody');
  expect(
    await runCli(
      args([
        'handoff',
        'export',
        '--asset',
        'phone-001',
        '--output',
        join(root, 'handoff'),
        '--locale',
        'pl',
      ]),
      io,
    ),
  ).toBe(0);
  const paths = JSON.parse(output.at(-1) ?? '{}') as { markdown: string; html: string };
  expect(await readFile(paths.markdown, 'utf8')).toContain('recipient');
  expect(await readFile(paths.html, 'utf8')).not.toContain('SERIAL');
});

it('retains old evidence but requires a new workflow after a maintenance visit or loss', async () => {
  await runCli(device(['provision', '--yes']), io);
  expect(await runCli(args(['agent', 'runs']), io)).toBe(0);
  const runs = JSON.parse(output.at(-1) ?? '[]') as { key: string }[];
  const runId = runs[0]?.key;
  expect(runId).toBeTruthy();
  expect(await runCli(args(['agent', 'status', '--run', runId ?? '', '--after', '0']), io)).toBe(0);
  expect(
    await runCli(
      args([
        'lifecycle',
        'maintenance',
        '--asset',
        'phone-001',
        '--operator',
        'operator',
        '--note',
        'Authorized service visit',
        '--yes',
      ]),
      io,
    ),
  ).toBe(0);
  await expect(runCli(device(['report']), io)).rejects.toThrow('Fresh provisioning');
  await expect(
    runCli(
      args([
        'lifecycle',
        'retirement',
        '--asset',
        'phone-001',
        '--operator',
        'operator',
        '--note',
        'Retire asset',
        '--yes',
      ]),
      io,
    ),
  ).rejects.toThrow('erasure');
  expect(
    await runCli(
      args([
        'lifecycle',
        'loss',
        '--asset',
        'phone-001',
        '--operator',
        'operator',
        '--note',
        'Reported by recipient',
        '--yes',
      ]),
      io,
    ),
  ).toBe(0);
  expect(
    await runCli(
      args([
        'lifecycle',
        'retirement',
        '--asset',
        'phone-001',
        '--operator',
        'operator',
        '--note',
        'Erasure and custody confirmed',
        '--erased',
        '--yes',
      ]),
      io,
    ),
  ).toBe(0);
});

it('requires explicit approval and refuses unsafe selectors before any mutation', async () => {
  await expect(
    runCli(device(['provision']), { ...io, confirm: () => Promise.resolve(false) }),
  ).rejects.toThrow('Cancelled');
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
    settings: { screen_off_timeout: '30000' },
  });
  expect(await runCli(device(['recover']), io)).toBe(4);
  await expect(runCli(device(['finalize', '--operator', 'operator', '--yes']), io)).rejects.toThrow();
});

it('starts a durable acknowledged worker, closes the client store and deduplicates exact submissions', async () => {
  await runCli(device(['plan']), io);
  const prepared = JSON.parse(output.at(-1) ?? '{}') as { planId: string; reviewSummary: string };
  const reviewFile = join(root, 'approved-review.json');
  await writeFile(reviewFile, prepared.reviewSummary);
  await runCli(
    args([
      'agent',
      'execute',
      '--plan',
      prepared.planId,
      '--review-file',
      reviewFile,
      '--operator',
      'operator',
    ]),
    io,
  );
  const submitted = JSON.parse(output.at(-1) ?? '{}') as { id: string };
  const started = Date.now();
  let status = '';
  while (Date.now() - started < 10_000) {
    await runCli(args(['agent', 'status', '--run', submitted.id]), io);
    const response = JSON.parse(output.at(-1) ?? '{}') as { run: { status: string } };
    status = response.run.status;
    if (status !== 'queued' && status !== 'running') break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  expect(status).toBe('pending');
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
    settings: { screen_off_timeout: '60000' },
  });
  await runCli(
    args([
      'agent',
      'execute',
      '--plan',
      prepared.planId,
      '--review-file',
      reviewFile,
      '--operator',
      'operator',
    ]),
    io,
  );
  expect((JSON.parse(output.at(-1) ?? '{}') as { id: string }).id).toBe(submitted.id);
  await runCli(args(['agent', 'cancel', '--run', submitted.id]), io);
  expect(output.at(-1)).toContain('cancellationRequested');
});
