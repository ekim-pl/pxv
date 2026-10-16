import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { AdapterError, cancelled } from './command.js';

export async function regularFile(path: string, limit: number): Promise<number> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit)
    throw new AdapterError('Input must be a nonempty regular file within its size limit');
  return info.size;
}
export async function fileDigest(path: string, limit: number, signal?: AbortSignal): Promise<string> {
  await regularFile(path, limit);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new AdapterError('Invalid artifact file');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      cancelled(signal);
      const data = chunk as Buffer;
      bytes += data.length;
      if (bytes > limit) throw new AdapterError('Artifact exceeds byte limit');
      hash.update(data);
    }
    if (bytes !== stat.size) throw new AdapterError('Artifact changed during inspection');
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}
export async function copySnapshot(
  source: string,
  destination: string,
  limit: number,
  signal?: AbortSignal,
): Promise<void> {
  await regularFile(source, limit);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let created = false;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw new AdapterError('Invalid artifact input');
    const output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      let bytes = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        cancelled(signal);
        const data = chunk as Buffer;
        bytes += data.length;
        if (bytes > limit) throw new AdapterError('Snapshot exceeds byte limit');
        await output.writeFile(data);
      }
      if (bytes !== stat.size) throw new AdapterError('Input changed while snapshotting');
      await output.sync();
    } finally {
      await output.close();
    }
  } catch (error) {
    if (created) await unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await input.close();
  }
}
export function artifactUrl(value: string, hosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdapterError('Invalid artifact URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !hosts.has(url.hostname.toLowerCase()) ||
    (url.port && url.port !== '443')
  )
    throw new AdapterError('Artifact URL is outside the approved HTTPS hosts');
  return url;
}
export interface DownloadOptions {
  hosts?: readonly string[];
  limit: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  allow404?: boolean;
}
/** Redirects are validated before following, with one total wall-clock deadline. */
export async function download(
  destination: string,
  urlValue: string,
  options: DownloadOptions,
): Promise<boolean> {
  const base = new URL(urlValue);
  const hosts = new Set([
    base.hostname.toLowerCase(),
    ...(options.hosts ?? []).map((host) => host.toLowerCase()),
  ]);
  let url = artifactUrl(urlValue, hosts);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 120_000);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    cancelled(signal);
    response = await fetch(url, { redirect: 'manual', signal, headers: { 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects === 5) throw new AdapterError('Artifact exceeded redirect limit');
      const location = response.headers.get('location');
      if (!location) throw new AdapterError('Artifact redirect has no location');
      url = artifactUrl(new URL(location, url).href, hosts);
      continue;
    }
    if (response.status === 404 && options.allow404 && redirects === 0) {
      await response.body?.cancel();
      return false;
    }
    break;
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel();
    throw new AdapterError('Artifact download failed');
  }
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > options.limit)) {
    await response.body.cancel();
    throw new AdapterError('Artifact Content-Length exceeds byte limit');
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const file = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let bytes = 0;
    for await (const data of response.body) {
      cancelled(signal);
      bytes += data.length;
      if (bytes > options.limit) throw new AdapterError('Artifact exceeds byte limit');
      await file.writeFile(data);
    }
    if (bytes < 1 || (declared !== null && Number(declared) !== bytes))
      throw new AdapterError('Artifact download is empty or incomplete');
    await file.sync();
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
  return true;
}
export async function seal(path: string): Promise<void> {
  await chmod(path, 0o400);
}
