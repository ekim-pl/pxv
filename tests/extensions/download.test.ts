import { describe, it, expect, vi } from 'vitest';
import { ExtensionDownloader, registryUrl } from '../../packages/extensions/src/download.js';
const url = new URL('https://registry.example/package.tgz');
describe('bounded private registry downloads', () => {
  it('rejects unsafe URLs before contacting a transport', async () => {
    const transport = vi.fn<typeof fetch>();
    const downloader = new ExtensionDownloader(undefined, undefined, transport);
    for (const value of ['http://registry.example/archive', 'https://user:secret@registry.example/archive'])
      await expect(downloader.download(new URL(value), 1024)).rejects.toThrow(
        'Unsafe extension download URL',
      );
    expect(transport).not.toHaveBeenCalled();
    for (const value of [
      'https://registry.example/?token=secret',
      'https://registry.example/#secret',
      'https://user:secret@registry.example',
    ])
      expect(() => registryUrl(value)).toThrow('HTTPS without embedded credentials');
  });
  it('bounds redirects and rejects missing locations, HTTP failures and empty bodies', async () => {
    const redirect = new ExtensionDownloader(undefined, undefined, () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: '/again' } })),
    );
    await expect(redirect.download(url, 1024)).rejects.toThrow('Too many extension registry redirects');
    for (const [response, message] of [
      [new Response(null, { status: 302 }), 'has no location'],
      [new Response('private error body', { status: 403 }), 'HTTP 403'],
      [new Response(null), 'empty response'],
    ] as const) {
      await expect(
        new ExtensionDownloader(undefined, undefined, () => Promise.resolve(response)).download(url, 1024),
      ).rejects.toThrow(message);
    }
  });
  it('redacts a transport exception containing authentication material', async () => {
    const downloader = new ExtensionDownloader(url, 'registry-secret', () =>
      Promise.reject(new Error('registry-secret from transport')),
    );
    await expect(downloader.download(url, 1024)).rejects.toThrow(/^Extension registry request failed$/u);
  });
  it('cancels a body immediately on overflow and never returns partial data', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel: cancelled,
    });
    const downloader = new ExtensionDownloader(undefined, undefined, () =>
      Promise.resolve(new Response(stream)),
    );
    await expect(downloader.download(url, 8)).rejects.toThrow('download exceeds size limit');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
