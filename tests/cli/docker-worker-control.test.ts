import { expect, it, vi } from '../test-api.js';
import type { CommandRunner, CommandOptions } from '@pxv/adapters';
import {
  dockerWorkerIdentity,
  dockerWorkerFlags,
  DockerWorkerControl,
} from '../../packages/cli/src/docker-worker-control.js';
import { runDockerWorker } from '../../packages/cli/src/docker-worker.js';

function fixture() {
  const identity = dockerWorkerIdentity('/private/control');
  const value = {
    Id: 'a'.repeat(64),
    Name: `/${identity.name}`,
    Config: {
      User: identity.user,
      Labels: { 'org.pxv.worker': identity.token, 'org.pxv.worker-control': identity.controlKey },
    },
    State: { Running: true },
  };
  const calls: { args: string[]; options?: CommandOptions }[] = [];
  let output: string | undefined;
  let error = '';
  let killed = false;
  const runner: CommandRunner = {
    run: (args, options) => {
      calls.push({ args, ...(options ? { options } : {}) });
      if (args[1] === 'kill') {
        killed = true;
        value.State.Running = false;
      }
      return Promise.resolve({ code: error ? 1 : 0, stdout: output ?? JSON.stringify(value), stderr: error });
    },
  };
  return {
    identity,
    value,
    calls,
    runner,
    control: new DockerWorkerControl(identity, runner, 20),
    output: (text: string) => {
      output = text;
    },
    error: (text: string) => {
      error = text;
    },
    killed: () => killed,
  };
}
it('assigns unique worker names and ownership labels, and kills only the inspected immutable ID', async () => {
  const f = fixture();
  expect(dockerWorkerIdentity('/private/control').name).not.toBe(f.identity.name);
  expect(dockerWorkerFlags(f.identity)).toContain(`org.pxv.worker=${f.identity.token}`);
  expect(await f.control.forceStop()).toMatchObject({ kind: 'stopped' });
  expect(f.calls.find((call) => call.args[1] === 'kill')?.args).toEqual([
    'docker',
    'kill',
    '--signal',
    'KILL',
    f.value.Id,
  ]);
  expect(f.calls.every((call) => call.options?.timeoutMs === 20)).toBe(true);
  expect(await f.control.forceStop()).toMatchObject({ kind: 'stopped' });
  f.error('No such container');
  expect(await f.control.forceStop()).toEqual({ kind: 'missing' });
  f.error('Cannot connect to daemon');
  await expect(f.control.forceStop()).rejects.toThrow('could not be inspected');
});
it('refuses sidecars, unrelated users, malformed inspection and changed worker ownership before killing', async () => {
  const f = fixture();
  for (const patch of [
    null,
    {},
    { ...f.value, Id: 'bad' },
    { ...f.value, Name: '/other' },
    { ...f.value, Config: {} },
    { ...f.value, Config: { ...f.value.Config, User: 'other' } },
    { ...f.value, Config: { ...f.value.Config, Labels: { 'org.pxv.adb-control': f.identity.controlKey } } },
    {
      ...f.value,
      Config: { ...f.value.Config, Labels: { ...f.value.Config.Labels, 'org.pxv.worker-control': 'other' } },
    },
    { ...f.value, State: {} },
  ]) {
    f.output(JSON.stringify(patch));
    await expect(f.control.forceStop()).rejects.toThrow('ownership differs');
  }
  f.output('invalid JSON');
  await expect(f.control.state()).rejects.toThrow();
  expect(f.killed()).toBe(false);
});
it('reports a worker that remains running after Docker kill', async () => {
  const f = fixture();
  f.output(JSON.stringify(f.value));
  await expect(f.control.forceStop()).rejects.toThrow('still running');
});
it('bounds a signal-ignoring client and cleans up its owned container on timeout', async () => {
  const f = fixture();
  const before = process.listenerCount('SIGTERM');
  const began = Date.now();
  const code = await runDockerWorker(
    [process.execPath, '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    {
      container: f.identity,
      control: f.runner,
      timeoutMs: 200,
      graceMs: 20,
      controlTimeoutMs: 20,
      reapMs: 100,
    },
  );
  expect(code).toBe(124);
  expect(Date.now() - began).toBeLessThan(2000);
  expect(f.killed()).toBe(true);
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
it('reports unavailable Docker and uncertain startup without hanging or clearing recovery state', async () => {
  for (const message of ['Cannot connect to daemon', 'No such container']) {
    const f = fixture();
    f.error(message);
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(
        await runDockerWorker(
          [process.execPath, '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
          {
            container: f.identity,
            control: f.runner,
            timeoutMs: 200,
            graceMs: 10,
            controlTimeoutMs: 20,
            reapMs: 100,
          },
        ),
      ).toBe(124);
      const output = diagnostic.mock.calls.flat().join('');
      expect(output).toContain('cleanup unresolved');
      expect(output).toContain(f.identity.name);
      expect(output).toContain('preserve recovery records');
      expect(f.killed()).toBe(false);
    } finally {
      diagnostic.mockRestore();
    }
  }
});
it('checks the container after an attached client exits before the grace deadline', async () => {
  const f = fixture();
  expect(
    await runDockerWorker([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      container: f.identity,
      control: f.runner,
      timeoutMs: 100,
      graceMs: 30,
      reapMs: 100,
    }),
  ).toBe(124);
  expect(f.killed()).toBe(true);
});
it('accepts confirmed shutdown and rejects invalid worker timing options', async () => {
  const f = fixture();
  f.value.State.Running = false;
  expect(
    await runDockerWorker([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      container: f.identity,
      control: f.runner,
      timeoutMs: 100,
      graceMs: 20,
    }),
  ).toBe(124);
  expect(f.killed()).toBe(false);
  for (const value of [0, -1, NaN, 0.5, 86_400_001])
    await expect(runDockerWorker([process.execPath], { graceMs: value })).rejects.toThrow(
      'Invalid Docker worker timeout',
    );
});

it.each(['ignored', 'EPERM', 'ESRCH'])(
  'returns a bounded failure when client reaping is unavailable: %s',
  async (mode) => {
    const realKill = process.kill.bind(process);
    let group: number | undefined;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      group = pid;
      if (mode !== 'ignored') throw Object.assign(new Error('Signal delivery unavailable'), { code: mode });
      return true;
    });
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(
        await runDockerWorker(
          [process.execPath, '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
          {
            timeoutMs: 200,
            graceMs: 10,
            reapMs: 10,
          },
        ),
      ).toBe(124);
      expect(diagnostic.mock.calls.flat().join('')).toContain('did not exit within the shutdown deadline');
      expect(group).toBeDefined();
    } finally {
      kill.mockRestore();
      diagnostic.mockRestore();
      if (group !== undefined) realKill(group, 'SIGKILL');
    }
  },
);
it('still performs bounded shutdown when an exited client cannot be inspected', async () => {
  const f = fixture();
  f.error('Daemon unavailable');
  const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(
      await runDockerWorker([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
        container: f.identity,
        control: f.runner,
        timeoutMs: 200,
        graceMs: 100,
        reapMs: 100,
      }),
    ).toBe(124);
    expect(diagnostic.mock.calls.flat().join('')).toContain('could not be inspected');
  } finally {
    diagnostic.mockRestore();
  }
});

it('reports uncertain startup even when the attached client exits before ownership can be observed', async () => {
  const f = fixture();
  f.error('No such container');
  const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(
      await runDockerWorker([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
        container: f.identity,
        control: f.runner,
        timeoutMs: 200,
        graceMs: 100,
      }),
    ).toBe(124);
    expect(diagnostic.mock.calls.flat().join('')).toContain('startup cancellation could not be confirmed');
    expect(f.killed()).toBe(false);
  } finally {
    diagnostic.mockRestore();
  }
});
