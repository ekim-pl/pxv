import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactUrl, download } from '../../packages/adapters/src/index.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-download-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
describe('bounded authenticated transport', () => {
  it('requires exact HTTPS origins without credentials, alternate ports or fragments', () => {
    const hosts = new Set(['example.com']);
    expect(artifactUrl('https://example.com/a.apk', hosts).hostname).toBe('example.com');
    for (const url of [
      'http://example.com/a',
      'https://evil.example.com/a',
      'https://user:secret@example.com/a',
      'https://example.com:8443/a',
      'https://example.com/a#fragment',
      'invalid',
    ])
      expect(() => artifactUrl(url, hosts)).toThrow();
  });
  it('writes a new private file after checking a bounded Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('verified', { headers: { 'Content-Length': '8' } })),
    );
    const destination = join(directory, 'file');
    expect(await download(destination, 'https://example.com/a', { limit: 8 })).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('verified');
    await expect(download(destination, 'https://example.com/a', { limit: 8 })).rejects.toThrow();
    expect(await readFile(destination, 'utf8')).toBe('verified');
  });
  it('checks every redirect before sending a request to its host', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://cdn.example.com/b' } }),
      )
      .mockResolvedValueOnce(new Response('bytes'));
    vi.stubGlobal('fetch', fetcher);
    await download(join(directory, 'allowed'), 'https://example.com/a', {
      limit: 32,
      hosts: ['cdn.example.com'],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher
      .mockReset()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://unapproved.example/b' } }),
      );
    await expect(
      download(join(directory, 'blocked'), 'https://example.com/a', { limit: 32 }),
    ).rejects.toThrow(/approved HTTPS hosts/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds redirect loops and disallows missing redirect locations', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(null, { status: 302, headers: { Location: '/again' } })),
        ),
    );
    await expect(download(join(directory, 'loop'), 'https://example.com/a', { limit: 32 })).rejects.toThrow(
      /redirect limit/,
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302 })));
    await expect(
      download(join(directory, 'missing'), 'https://example.com/a', { limit: 32 }),
    ).rejects.toThrow(/no location/);
  });
  it('permits a legacy fallback only on an initial exact 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    expect(
      await download(join(directory, 'missing'), 'https://example.com/entry.jar', {
        limit: 32,
        allow404: true,
      }),
    ).toBe(false);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/other' } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      download(join(directory, 'redirect404'), 'https://example.com/entry.jar', {
        limit: 32,
        allow404: true,
      }),
    ).rejects.toThrow(/failed/);
  });
  it('rejects unknown and declared oversized bodies and removes partial downloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('huge', { headers: { 'Content-Length': '1000' } })),
    );
    await expect(
      download(join(directory, 'declared'), 'https://example.com/a', { limit: 3 }),
    ).rejects.toThrow(/Content-Length/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('huge')));
    const path = join(directory, 'streamed');
    await expect(download(path, 'https://example.com/a', { limit: 3 })).rejects.toThrow(/byte limit/);
    await expect(readFile(path)).rejects.toThrow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x', { headers: { 'Content-Length': '2' } })),
    );
    await expect(
      download(join(directory, 'truncated'), 'https://example.com/a', { limit: 3 }),
    ).rejects.toThrow(/incomplete/);
  });
  it('honors caller cancellation before network work and preserves existing files', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(
      download(join(directory, 'cancelled'), 'https://example.com/a', {
        limit: 32,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const existing = join(directory, 'existing');
    await writeFile(existing, 'retain');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('new')));
    await expect(download(existing, 'https://example.com/a', { limit: 32 })).rejects.toThrow();
    expect(await readFile(existing, 'utf8')).toBe('retain');
  });
});
