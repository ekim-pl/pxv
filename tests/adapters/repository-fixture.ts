import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RepositoryPolicy } from '@pxv/contracts';
import { vi } from '../test-api.js';
import { RepositoryService, type RepositoryFloor } from '../../packages/adapters/src/index.js';

export const now = 1_800_000_000_000;
export const repository: RepositoryPolicy = {
  id: 'test',
  url: 'https://repo.example/repo',
  signerSha256: 'a'.repeat(64),
  redirectHosts: ['cdn.example'],
  maxAgeDays: 30,
};
export const row = {
  versionCode: 7,
  apkName: 'org.example.app_7.apk',
  hash: 'b'.repeat(64),
  signer: 'c'.repeat(64),
  minSdkVersion: 28,
  nativecode: ['arm64-v8a'],
};
export const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Synthetic verifier boundary; real signed JAR verification lives in crypto.test.ts. */
export function repositoryFixture(cacheRoot?: string) {
  let floor: RepositoryFloor | undefined;
  const advance = vi.fn((_key: string, old: RepositoryFloor | undefined, next: RepositoryFloor) => {
    if (floor !== old) throw new Error('floor changed');
    floor = next;
    return Promise.resolve();
  });
  const verify = vi.fn(async (args: string[]) => {
    const entry = args.at(-1);
    const file = args.at(-3);
    if (!file) throw new Error('Missing JAR fixture');
    const stdout = await readFile(file, 'utf8');
    return {
      code: 0,
      stdout: entry === 'entry.json' || entry === 'index-v1.json' ? stdout : '',
      stderr: '',
    };
  });
  const repo = new RepositoryService({
    runner: { run: verify },
    verifierPath: '/retained-verifier.java',
    freshness: { read: () => Promise.resolve(floor), advance },
    now: () => now,
    ...(cacheRoot ? { cacheRoot } : {}),
  });
  return {
    repo,
    advance,
    verify,
    setFloor: (value: RepositoryFloor) => {
      floor = value;
    },
  };
}

export function repositoryDocuments(format: 'v1' | 'v2') {
  const index = JSON.stringify({
    repo: { timestamp: now },
    packages:
      format === 'v1'
        ? { 'org.example.app': [row] }
        : {
            'org.example.app': {
              versions: {
                v7: {
                  file: { name: '/' + row.apkName, sha256: row.hash, size: 500 },
                  manifest: {
                    versionCode: row.versionCode,
                    signer: { sha256: [row.signer] },
                    usesSdk: { minSdkVersion: 28 },
                    nativecode: row.nativecode,
                  },
                },
              },
            },
          },
  });
  const entry = {
    version: 20002,
    timestamp: now,
    index: {
      name: '/index-v2.json',
      size: Buffer.byteLength(index),
      sha256: digest(index),
    },
  };
  const jar = format === 'v1' ? index : JSON.stringify(entry);
  const materialId = digest(
    format === 'v1'
      ? `index-v1.jar\0${digest(jar)}`
      : `entry.jar\0${digest(jar)}\0index.json\0${digest(index)}`,
  );
  const fetch = vi.fn((url: URL) =>
    Promise.resolve(
      format === 'v1' && url.pathname.endsWith('/entry.jar')
        ? new Response(null, { status: 404 })
        : new Response(url.pathname.endsWith('.jar') ? jar : index),
    ),
  );
  return { indexBytes: index, entry, jar, materialId, fetch };
}
