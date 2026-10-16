export function registryUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const url = new URL(value.endsWith('/') ? value : value + '/');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Private registry must use HTTPS without embedded credentials');
  return url;
}
async function registryRequest(
  fetcher: typeof fetch,
  url: URL,
  headers: Record<string, string>,
): Promise<Response> {
  try {
    return await fetcher(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error('Extension registry request failed');
  }
}
async function readResponse(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Extension download exceeds size limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
function validateDownloadUrl(url: URL): void {
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Unsafe extension download URL');
}
export class ExtensionDownloader {
  readonly #registry: URL | undefined;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  constructor(registry: URL | undefined, token: string | undefined, fetcher: typeof fetch) {
    this.#registry = registry;
    this.#token = token;
    this.#fetch = fetcher;
  }
  private headers(url: URL): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#token && url.origin === this.#registry?.origin)
      headers['authorization'] = 'Bearer ' + this.#token;
    return headers;
  }
  async download(initial: URL, maxBytes: number): Promise<Buffer> {
    let url = initial;
    for (let redirects = 0; redirects <= 5; redirects++) {
      validateDownloadUrl(url);
      const headers = this.headers(url);
      const response = await registryRequest(this.#fetch, url, headers);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Extension registry redirect has no location');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Extension registry returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('Extension registry returned an empty response');
      return readResponse(response.body, maxBytes);
    }
    throw new Error('Too many extension registry redirects');
  }
}
