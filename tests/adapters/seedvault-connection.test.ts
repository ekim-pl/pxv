import { describe, expect, it, vi } from './../test-api.js';
import type { AndroidAdapter } from '@pxv/adapters';
import { SeedvaultConnectionAdapter, seedvaultEndpoint } from '@pxv/adapters';
import { device } from '../contracts/fixtures.js';

const endpoint = '192.0.2.10:39991';
const selected = {
  device: { ...device, transports: [{ kind: 'wifi' as const, serial: endpoint }] },
  transport: { kind: 'wifi' as const, serial: endpoint },
};
function fixture() {
  const runAdb = vi.fn().mockResolvedValue({
    code: 0,
    stdout: `service _adb-tls-connect._tcp ${endpoint}\npair _adb-tls-pairing._tcp 192.0.2.10:39992\n`,
    stderr: '',
  });
  const guardTarget = vi.fn().mockResolvedValue(undefined);
  return {
    runAdb,
    guardTarget,
    adapter: new SeedvaultConnectionAdapter({ runAdb, guardTarget } as unknown as AndroidAdapter),
  };
}
describe('TLS wireless ADB connection', () => {
  it('accepts bounded host endpoints and rejects malformed addresses before command execution', () => {
    for (const address of [endpoint, 'phone.local:1234', '[2001:db8::1]:3000'])
      expect(seedvaultEndpoint(address)).toBe(address);
    for (const address of ['host:0', 'host:65536', 'host;evil:42', 'a:4\n', '[:::]:22', '127.0.0.1'])
      expect(() => seedvaultEndpoint(address)).toThrow();
  });
  it('requires the TLS discovery service, supervises connection, then measures canonical identity', async () => {
    const f = fixture();
    f.runAdb
      .mockResolvedValueOnce({ code: 0, stdout: `service _adb-tls-connect._tcp ${endpoint}`, stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: `connected to ${endpoint}`, stderr: '' });
    const options = { lease: {}, signal: new AbortController().signal };
    await f.adapter.connect(selected, endpoint, options);
    expect(f.runAdb).toHaveBeenLastCalledWith(['connect', endpoint], { ...options, mutation: true });
    expect(f.guardTarget).toHaveBeenCalledWith(selected, options.signal);
    await expect(f.adapter.connect(selected, '192.0.2.11:5555', options)).rejects.toThrow('advertised TLS');
  });
  it('pairs using private stdin and refuses unconfirmed pairing, connection and command failures', async () => {
    const f = fixture();
    const options = { lease: {} };
    f.runAdb
      .mockResolvedValueOnce({ code: 0, stdout: 'pair _adb-tls-pairing._tcp 192.0.2.10:39992', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'Successfully paired to 192.0.2.10', stderr: '' });
    await f.adapter.pair('192.0.2.10:39992', '123456', options);
    expect(f.runAdb).toHaveBeenLastCalledWith(['pair', '192.0.2.10:39992'], {
      lease: {},
      mutation: true,
      input: '123456\n',
    });
    await expect(f.adapter.pair(endpoint, 'secret', options)).rejects.toThrow('six-digit');
    await expect(f.adapter.pair('192.0.2.10:39992', '123456', options)).rejects.toThrow('not confirmed');
    await expect(f.adapter.connect(selected, endpoint, options)).rejects.toThrow('not confirmed');
    f.runAdb.mockResolvedValueOnce({ code: 7, stdout: '', stderr: 'failure' });
    await expect(f.adapter.disconnect(endpoint, options)).rejects.toThrow('failed');
  });
  it('disconnects only the requested endpoint under supervision and propagates a mismatched phone', async () => {
    const f = fixture();
    await f.adapter.disconnect(endpoint, { lease: {} });
    expect(f.runAdb).toHaveBeenLastCalledWith(['disconnect', endpoint], { lease: {}, mutation: true });
    f.runAdb
      .mockResolvedValueOnce({ code: 0, stdout: `x _adb-tls-connect._tcp ${endpoint}`, stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: `already connected to ${endpoint}`, stderr: '' });
    f.guardTarget.mockRejectedValueOnce(new Error('canonical serial differs'));
    await expect(f.adapter.connect(selected, endpoint, { lease: {} })).rejects.toThrow('canonical serial');
  });
});
