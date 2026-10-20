import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, it } from '../test-api.js';
import { runDockerWorker } from '../../packages/cli/src/docker-worker.js';

const hooks = fileURLToPath(new URL('../../tools/test-hooks.mjs', import.meta.url));
const moduleUrl = new URL('../../packages/cli/src/docker-worker.ts', import.meta.url).href;
function launch(body: string) {
  return spawn(
    process.execPath,
    [
      '--import',
      hooks,
      '--input-type=module',
      '-e',
      `import {runDockerWorker} from ${JSON.stringify(moduleUrl)};${body}`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform === 'linux' },
  );
}
it('streams prompts and input before child exit and preserves separate JSON/diagnostic streams', async () => {
  const code =
    'process.stderr.write("PROMPT\\n");process.stdin.once("data",value=>{console.log(JSON.stringify({answer:value.toString().trim()}));process.exitCode=4;process.stdin.pause()})';
  const child = launch(
    `process.exitCode=await runDockerWorker([process.execPath,'-e',${JSON.stringify(code)}]);`,
  );
  let stdout = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  const closed = once(child, 'close');
  const prompt: unknown[] = await once(child.stderr, 'data');
  expect(String(prompt[0])).toContain('PROMPT');
  expect(child.exitCode).toBeNull();
  child.stdin.end('confirmed\n');
  expect((await closed)[0]).toBe(4);
  expect(JSON.parse(stdout)).toEqual({ answer: 'confirmed' });
});
it('forwards EOF, handles startup errors and restores parent signal listeners', async () => {
  const before = process.listenerCount('SIGINT');
  await expect(runDockerWorker([])).rejects.toThrow('required');
  await expect(runDockerWorker(['/missing/docker-executable'])).rejects.toThrow();
  expect(process.listenerCount('SIGINT')).toBe(before);
  const code = 'process.stdin.resume();process.stdin.on("end",()=>process.exit(7))';
  const child = launch(
    `process.exitCode=await runDockerWorker([process.execPath,'-e',${JSON.stringify(code)}]);`,
  );
  const closed = once(child, 'close');
  child.stdin.end();
  expect((await closed)[0]).toBe(7);
});
it.each(['SIGINT', 'SIGTERM'] as const)('waits for child cleanup after %s', async (signal) => {
  const code = `process.on('${signal}',()=>setTimeout(()=>{console.log('CLEAN');process.exit(0)},30));console.log('READY');setInterval(()=>{},1000)`;
  const child = launch(
    `process.exitCode=await runDockerWorker([process.execPath,'-e',${JSON.stringify(code)}]);`,
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  await once(child.stdout, 'data');
  const closed = once(child, 'close');
  process.kill(-child.pid!, signal);
  expect((await closed)[0]).toBe(signal === 'SIGINT' ? 130 : 143);
  expect(output).toContain('CLEAN');
});
it('returns signal exits and timeout status after shutdown', async () => {
  const before = process.listenerCount('SIGTERM');
  expect(await runDockerWorker([process.execPath, '-e', 'process.kill(process.pid,"SIGTERM")'])).toBe(143);
  expect(await runDockerWorker([process.execPath, '-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 })).toBe(
    124,
  );
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
it.each(['SIGINT', 'SIGTERM'] as const)(
  'escalates an ignored %s and preserves the interruption status',
  async (signal) => {
    const code = `process.on('${signal}',()=>{});console.log('READY');setInterval(()=>{},1000)`;
    const child = launch(
      `process.exitCode=await runDockerWorker([process.execPath,'-e',${JSON.stringify(code)}],{graceMs:50,reapMs:100});`,
    );
    await once(child.stdout, 'data');
    const closed = once(child, 'close');
    child.kill(signal);
    expect((await closed)[0]).toBe(signal === 'SIGINT' ? 130 : 143);
  },
);
