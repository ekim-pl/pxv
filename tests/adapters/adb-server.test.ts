import { afterEach, describe, expect, it } from './../test-api.js';
import { createServer, type Server } from 'node:net';
import {
  adbClientEnvironment,
  configuredAdbServer,
  probeAdbServer,
  startLocalAdbServer,
  validateAdbServer,
  type AdbServerEndpoint,
  type CommandRunner,
} from '../../packages/adapters/src/index.js';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});
async function server(response: string): Promise<AdbServerEndpoint> {
  const instance = createServer((socket) => socket.once('data', () => socket.end(response)));
  servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  return { host: '127.0.0.1', port: address.port };
}
describe('independent shared ADB server lifecycle', () => {
  it('resolves explicit TCP, host and Unix endpoints without starting a daemon', () => {
    expect(configuredAdbServer({})).toEqual({ host: '127.0.0.1', port: 5037 });
    expect(
      configuredAdbServer({ ANDROID_ADB_SERVER_ADDRESS: '192.0.2.1', ANDROID_ADB_SERVER_PORT: '6000' }),
    ).toEqual({ host: '192.0.2.1', port: 6000 });
    expect(configuredAdbServer({ ADB_SERVER_SOCKET: 'tcp:[::1]:5038' })).toEqual({ host: '::1', port: 5038 });
    expect(configuredAdbServer({ ADB_SERVER_SOCKET: 'tcp:5039' }).port).toBe(5039);
    expect(configuredAdbServer({ ADB_SERVER_SOCKET: 'localfilesystem:/tmp/adb.sock' }).socketPath).toBe(
      '/tmp/adb.sock',
    );
    expect(configuredAdbServer({ ADB_SERVER_SOCKET: 'localabstract:adb-name' }).socketPath).toBe(
      '\0adb-name',
    );
    expect(() => configuredAdbServer({ ADB_SERVER_SOCKET: 'unsupported:thing' })).toThrow(/Unsupported/);
    expect(() => configuredAdbServer({ ADB_SERVER_SOCKET: 'tcp:malformed' })).toThrow(/Invalid/);
    expect(() => validateAdbServer({ host: 'invalid host', port: 5037 })).toThrow(/Invalid/);
    expect(() => configuredAdbServer({ ANDROID_ADB_SERVER_PORT: '70000' })).toThrow(/Invalid/);
  });
  it('probes complete ADB version replies and rejects fake, partial and oversized responses', async () => {
    await expect(probeAdbServer(await server('OKAY00040029'))).resolves.toBeUndefined();
    for (const reply of ['FAIL0000', 'OKAYffff', 'OKAY0004oops', 'OKAY00', 'OKAY00040029' + 'x'.repeat(40)])
      await expect(probeAdbServer(await server(reply))).rejects.toMatchObject({
        code: 'ADB_SERVER_UNAVAILABLE',
      });
  });
  it('keeps explicit client hosts and socket selection while excluding inherited secrets', () => {
    const tcp = adbClientEnvironment({ host: '192.0.2.2', port: 5037 });
    expect(tcp['ANDROID_ADB_SERVER_ADDRESS']).toBe('192.0.2.2');
    expect(tcp).not.toHaveProperty('NPM_TOKEN');
    expect(
      adbClientEnvironment({ host: '127.0.0.1', port: 5037, socketPath: '/tmp/adb.sock' })[
        'ADB_SERVER_SOCKET'
      ],
    ).toBe('localfilesystem:/tmp/adb.sock');
    expect(
      adbClientEnvironment({ host: '127.0.0.1', port: 5037, socketPath: '\0adb-name' })['ADB_SERVER_SOCKET'],
    ).toBe('localabstract:adb-name');
  });
  it('starts only explicitly selected local services outside a device lease and never kills them', async () => {
    const endpoint = await server('OKAY00040029');
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: (args, options) => {
        calls.push(args);
        expect(options?.mutation).not.toBe(true);
        expect(options?.env).not.toHaveProperty('ANDROID_ADB_SERVER_ADDRESS');
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    };
    await startLocalAdbServer(runner, '/approved/adb', endpoint);
    expect(calls).toEqual([['/approved/adb', '-L', `tcp:${endpoint.port}`, 'start-server']]);
    await expect(
      startLocalAdbServer(runner, '/approved/adb', { host: '192.0.2.1', port: 5037 }),
    ).rejects.toThrow(/started by their owner/);
    expect(calls).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(probeAdbServer(endpoint, controller.signal)).rejects.toThrow();
  });
});
