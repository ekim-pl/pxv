import type { OsPolicy, SelectedTarget } from '@pxv/contracts';
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterError, checked, shellQuote, type CommandRunner, type OperationOptions } from './command.js';
import { copySnapshot, download, fileDigest, regularFile, seal } from './files.js';
import { extractZip } from './zip.js';

export const MAX_IMAGE_BYTES = 4 * 1024 ** 3 - 1;
export interface VerifiedImage {
  path: string;
  signaturePath: string;
  sha256: string;
  signatureSha256: string;
  policy: OsPolicy;
}
export interface ImageOptions {
  runner: CommandRunner;
  sshKeygen?: string;
}
function validatePolicy(policy: OsPolicy): void {
  for (const url of [policy.url, policy.signatureUrl]) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'releases.grapheneos.org' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    )
      throw new AdapterError('OS image source must be the official GrapheneOS HTTPS release host');
  }
  if (policy.signerPrincipal !== 'contact@grapheneos.org' || policy.namespace !== 'factory images')
    throw new AdapterError('OS image requires the exact official signer principal and signature namespace');
  const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})$/.exec(
    policy.publicKey,
  );
  if (!match?.[1] || !match[2])
    throw new AdapterError('OS release public key must be one pinned plain SSH key');
  const blob = Buffer.from(match[2], 'base64');
  if (
    blob.length < 8 ||
    blob.readUInt32BE(0) !== Buffer.byteLength(match[1]) ||
    blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('ascii') !== match[1]
  )
    throw new AdapterError('OS public key is malformed');
  if (!/^[a-z0-9_]+$/.test(policy.codename) || !/^\d{10}$/.test(policy.release))
    throw new AdapterError('OS release identity is invalid');
  if (
    new URL(policy.url).pathname.split('/').at(-1) !== `${policy.codename}-install-${policy.release}.zip` ||
    new URL(policy.signatureUrl).pathname.split('/').at(-1) !==
      `${policy.codename}-install-${policy.release}.zip.sig`
  )
    throw new AdapterError('OS URLs do not match the reviewed codename and release');
}
export class ImageService {
  readonly runner: CommandRunner;
  readonly sshKeygen: string;
  constructor(options: ImageOptions) {
    this.runner = options.runner;
    this.sshKeygen = options.sshKeygen ?? 'ssh-keygen';
  }
  async verify(
    path: string,
    signaturePath: string,
    policy: OsPolicy,
    signal?: AbortSignal,
  ): Promise<VerifiedImage> {
    validatePolicy(policy);
    await regularFile(path, MAX_IMAGE_BYTES);
    await regularFile(signaturePath, 64 * 1024);
    const before = await fileDigest(path, MAX_IMAGE_BYTES, signal);
    const signatureSha256 = await fileDigest(signaturePath, 64 * 1024, signal);
    const directory = await mkdtemp(join(tmpdir(), 'pxv-image-signers-'));
    try {
      const signers = join(directory, 'allowed_signers');
      await writeFile(signers, `${policy.signerPrincipal} ${policy.publicKey}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      checked(
        await this.runner.run(
          [
            this.sshKeygen,
            '-Y',
            'verify',
            '-f',
            signers,
            '-I',
            policy.signerPrincipal,
            '-n',
            policy.namespace,
            '-s',
            signaturePath,
          ],
          { inputFile: path, timeoutMs: 300_000, ...(signal ? { signal } : {}) },
        ),
        'OS SSH signature verification',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    if (
      (await fileDigest(path, MAX_IMAGE_BYTES, signal)) !== before ||
      (await fileDigest(signaturePath, 64 * 1024, signal)) !== signatureSha256
    )
      throw new AdapterError('OS image or signature changed while verifying');
    return { path, signaturePath, sha256: before, signatureSha256, policy: structuredClone(policy) };
  }
  async snapshot(policy: OsPolicy, directory: string, signal?: AbortSignal): Promise<VerifiedImage> {
    validatePolicy(policy);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, 'factory.zip');
    const signaturePath = join(directory, 'factory.zip.sig');
    try {
      await download(path, policy.url, {
        limit: MAX_IMAGE_BYTES,
        timeoutMs: 1_800_000,
        ...(signal ? { signal } : {}),
      });
      await download(signaturePath, policy.signatureUrl, { limit: 64 * 1024, ...(signal ? { signal } : {}) });
      const verified = await this.verify(path, signaturePath, policy, signal);
      await seal(path);
      await seal(signaturePath);
      return verified;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
async function executablePath(name: string): Promise<string> {
  const candidates = isAbsolute(name)
    ? [name]
    : (process.env['PATH'] ?? '/usr/bin:/bin')
        .split(delimiter)
        .filter(Boolean)
        .map((part) => join(part, name));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {
      /* Continue explicit path lookup. */
    }
  }
  throw new AdapterError(`Required executable is unavailable: ${name}`);
}
export async function flashImage(
  runner: CommandRunner,
  fastboot: string,
  target: SelectedTarget,
  image: VerifiedImage,
  options: OperationOptions,
): Promise<void> {
  if (
    target.device.kind !== 'pixel' ||
    target.transport.kind !== 'usb' ||
    target.transport.serial !== target.device.canonicalSerial ||
    image.policy.codename !== target.device.codename ||
    !target.device.transports.some(
      (transport) => transport.kind === 'usb' && transport.serial === target.transport.serial,
    )
  )
    throw new AdapterError('OS flashing requires the enrolled physical USB identity and matching image');
  const serial = target.device.canonicalSerial;
  if (!/^[A-Za-z0-9._-]+$/.test(serial)) throw new AdapterError('Invalid fastboot serial');
  const tool = await executablePath(fastboot);
  const signal = options.signal ? { signal: options.signal } : {};
  const version = checked(await runner.run([tool, '--version'], signal), 'Fastboot version inspection');
  const parsed = /fastboot version (\d+)\.(\d+)\.(\d+)/.exec(version);
  if (
    !parsed?.[1] ||
    !parsed[2] ||
    !parsed[3] ||
    Number(parsed[1]) < 35 ||
    (Number(parsed[1]) === 35 && Number(parsed[2]) === 0 && Number(parsed[3]) < 2)
  )
    throw new AdapterError('GrapheneOS requires fastboot 35.0.2 or newer');
  const getvar = async (name: string): Promise<string> => {
    const result = await runner.run([tool, '-s', serial, 'getvar', name], { ...signal, check: false });
    if (result.code !== 0) throw new AdapterError(`Fastboot ${name} could not be read`);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rows = [
      ...`${result.stdout}\n${result.stderr}`.matchAll(
        new RegExp(`^(?:\\(bootloader\\) )?${escaped}:\\s*(\\S+)\\s*$`, 'gm'),
      ),
    ];
    if (rows.length !== 1 || !rows[0]?.[1])
      throw new AdapterError(`Fastboot ${name} is missing or ambiguous`);
    return rows[0][1];
  };
  const guard = async (): Promise<void> => {
    const list = checked(await runner.run([tool, 'devices'], signal), 'Fastboot device inspection')
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/));
    const matches = list.filter((row) => row[0] === serial && row[1] === 'fastboot');
    if (matches.length !== 1 || (await getvar('product')) !== target.device.codename)
      throw new AdapterError('Fastboot physical identity or codename changed');
  };
  const directory = await mkdtemp(join(tmpdir(), 'pxv-flash-'));
  try {
    const staged = join(directory, 'factory.zip');
    const signature = join(directory, 'factory.zip.sig');
    await copySnapshot(image.path, staged, MAX_IMAGE_BYTES, options.signal);
    await copySnapshot(image.signaturePath, signature, 64 * 1024, options.signal);
    const verified = await new ImageService({ runner }).verify(
      staged,
      signature,
      image.policy,
      options.signal,
    );
    if (verified.sha256 !== image.sha256 || verified.signatureSha256 !== image.signatureSha256)
      throw new AdapterError('OS snapshot differs from the reviewed image');
    const extracted = join(directory, 'image');
    const entries = await extractZip(staged, extracted, signal);
    const scripts = entries.filter(
      (entry) => entry.name.endsWith('/flash-all.sh') || entry.name === 'flash-all.sh',
    );
    if (scripts.length !== 1 || !scripts[0] || scripts[0].directory)
      throw new AdapterError('OS archive requires exactly one official flash-all.sh');
    const script = join(extracted, scripts[0].name);
    const bin = join(directory, 'bin');
    await mkdir(bin, { mode: 0o700 });
    // Official scripts invoke fastboot by name. Both environment and wrapper bind every child invocation.
    await writeFile(
      join(bin, 'fastboot'),
      `#!/bin/sh\nfor arg do case "$arg" in -s|--serial|--serial=*|-s?*) exit 64 ;; esac; done\nexec ${shellQuote(tool)} -s ${shellQuote(serial)} "$@"\n`,
      { flag: 'wx', mode: 0o700 },
    );
    await guard();
    const unlocked = await getvar('unlocked');
    if (!['yes', 'no'].includes(unlocked)) throw new AdapterError('Bootloader lock state is unknown');
    if (unlocked === 'no') {
      checked(
        await runner.run([tool, '-s', serial, 'flashing', 'unlock'], {
          ...options,
          mutation: true,
          timeoutMs: 120_000,
        }),
        'Bootloader unlock',
      );
      if ((await getvar('unlocked')) !== 'yes')
        throw new AdapterError('Confirm the bootloader unlock on the selected phone');
    }
    await guard();
    const result = await runner.run(['/bin/bash', script], {
      ...options,
      mutation: true,
      timeoutMs: 1_800_000,
      cwd: dirname(script),
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LC_ALL: 'C',
        ANDROID_SERIAL: serial,
        FASTBOOT_DEVICE: serial,
        TMPDIR: directory,
      },
    });
    if (result.code !== 0)
      throw new AdapterError(
        'OS flashing failed or was interrupted. No relock was attempted; preserve recovery evidence and inspect the phone',
        'MUTATION_UNCERTAIN',
      );
    // Never relock after a failed script, missing target, unknown boot state or cancellation.
    await guard();
    options.signal?.throwIfAborted();
    checked(
      await runner.run([tool, '-s', serial, 'flashing', 'lock'], {
        ...options,
        mutation: true,
        timeoutMs: 120_000,
      }),
      'Bootloader relock',
    );
    if ((await getvar('unlocked')) !== 'no')
      throw new AdapterError(
        'Locked bootloader was not observed; do not hand off the phone',
        'MUTATION_UNCERTAIN',
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
