import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

const REGISTRY_PLAINTEXT_LIMIT = 16 * 1024 * 1024;
export const REGISTRY_ENVELOPE_LIMIT = Math.ceil(REGISTRY_PLAINTEXT_LIMIT / 3) * 4 + 4096;
const FORMAT = 'pxv-encrypted-registry';
const SCRYPT = { algorithm: 'scrypt', N: 131072, r: 8, p: 1 } as const;
const CIPHER = 'aes-256-gcm';
export const encryptedRegistryFailure = (): Error =>
  new Error('Encrypted registry could not be opened or updated');

interface Header {
  format: typeof FORMAT;
  version: 1;
  projectId: string;
  kdf: typeof SCRYPT & { salt: string };
  cipher: { algorithm: typeof CIPHER; nonce: string };
}
interface Envelope extends Header {
  ciphertext: string;
  tag: string;
}

export function validateRegistryInput(projectId: string, passphrase: Buffer): void {
  if (!Buffer.isBuffer(passphrase) || passphrase.length < 12 || passphrase.length > 1024)
    throw encryptedRegistryFailure();
  if (
    typeof projectId !== 'string' ||
    !projectId.length ||
    Buffer.byteLength(projectId) > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(projectId)
  )
    throw encryptedRegistryFailure();
}

function exactFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function base64(value: unknown, minBytes: number, maxBytes = minBytes): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4)
    throw encryptedRegistryFailure();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString('base64') !== value)
    throw encryptedRegistryFailure();
  return bytes;
}

function validateHeader(value: Record<string, unknown>, projectId: string): Header {
  if (value['format'] !== FORMAT || value['version'] !== 1 || value['projectId'] !== projectId)
    throw encryptedRegistryFailure();
  const kdf = value['kdf'];
  const cipher = value['cipher'];
  if (!exactFields(kdf, ['algorithm', 'N', 'r', 'p', 'salt']) || !exactFields(cipher, ['algorithm', 'nonce']))
    throw encryptedRegistryFailure();
  if (
    Object.entries(SCRYPT).some(([key, expected]) => kdf[key] !== expected) ||
    cipher['algorithm'] !== CIPHER
  )
    throw encryptedRegistryFailure();
  base64(kdf['salt'], 32);
  base64(cipher['nonce'], 12);
  return {
    format: FORMAT,
    version: 1,
    projectId,
    kdf: { ...SCRYPT, salt: kdf['salt'] as string },
    cipher: { algorithm: CIPHER, nonce: cipher['nonce'] as string },
  };
}

function decodeEnvelope(bytes: Buffer, projectId: string): Envelope {
  if (!bytes.length || bytes.length > REGISTRY_ENVELOPE_LIMIT) throw encryptedRegistryFailure();
  const source = bytes.toString('utf8');
  const value: unknown = JSON.parse(source);
  if (!exactFields(value, ['format', 'version', 'projectId', 'kdf', 'cipher', 'ciphertext', 'tag']))
    throw encryptedRegistryFailure();
  const header = validateHeader(value, projectId);
  base64(value['ciphertext'], 1, REGISTRY_PLAINTEXT_LIMIT);
  base64(value['tag'], 16);
  const envelope = { ...header, ciphertext: value['ciphertext'] as string, tag: value['tag'] as string };
  // One canonical wire encoding rejects duplicate fields and ambiguous JSON representations.
  if (JSON.stringify(envelope) !== source) throw encryptedRegistryFailure();
  return envelope;
}

async function derive(passphrase: Buffer, salt: Buffer): Promise<Buffer> {
  const input = Buffer.from(passphrase);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        input,
        salt,
        32,
        { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 192 * 1024 * 1024 },
        (error, key) => {
          if (error) reject(encryptedRegistryFailure());
          else resolve(key);
        },
      );
    });
  } finally {
    input.fill(0);
  }
}

export function registryJson(value: unknown): Buffer {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > REGISTRY_PLAINTEXT_LIMIT)
    throw encryptedRegistryFailure();
  return Buffer.from(encoded, 'utf8');
}

export async function encryptRegistry(
  plaintext: Buffer,
  projectId: string,
  passphrase: Buffer,
): Promise<Buffer> {
  const salt = randomBytes(32),
    nonce = randomBytes(12);
  const header: Header = {
    format: FORMAT,
    version: 1,
    projectId,
    kdf: { ...SCRYPT, salt: salt.toString('base64') },
    cipher: { algorithm: CIPHER, nonce: nonce.toString('base64') },
  };
  const key = await derive(passphrase, salt);
  let encrypted: Buffer | undefined;
  try {
    const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: Envelope = {
      ...header,
      ciphertext: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8');
  } finally {
    key.fill(0);
    encrypted?.fill(0);
  }
}

export async function decryptRegistry(bytes: Buffer, projectId: string, passphrase: Buffer): Promise<Buffer> {
  const { ciphertext, tag, ...header } = decodeEnvelope(bytes, projectId);
  const key = await derive(passphrase, base64(header.kdf.salt, 32));
  let partial: Buffer | undefined;
  try {
    const cipher = createDecipheriv(CIPHER, key, base64(header.cipher.nonce, 12), { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    cipher.setAuthTag(base64(tag, 16));
    partial = cipher.update(base64(ciphertext, 1, REGISTRY_PLAINTEXT_LIMIT));
    return Buffer.concat([partial, cipher.final()]);
  } finally {
    key.fill(0);
    partial?.fill(0);
  }
}
