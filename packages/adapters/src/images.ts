import type { OsPolicy, SelectedTarget } from '@pxv/contracts';
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterError, checked, shellQuote, type CommandRunner, type OperationOptions } from './command.js';
import { copySnapshot, download, fileDigest, regularFile, seal } from './files.js';
import { extractZip } from './zip.js';

const MAX_IMAGE_BYTES = 4 * 1024 ** 3 - 1;
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
  [policy.url, policy.signatureUrl].forEach(validateImageUrl);
  if (policy.signerPrincipal !== 'contact@grapheneos.org' || policy.namespace !== 'factory images')
    throw new AdapterError('OS image requires the exact official signer principal and signature namespace');
  validatePublicKey(policy.publicKey);
  if (!/^[a-z0-9_]+$/.test(policy.codename) || !/^\d{10}$/.test(policy.release))
    throw new AdapterError('OS release identity is invalid');
  const name = policy.codename + '-install-' + policy.release + '.zip';
  if (
    new URL(policy.url).pathname.split('/').at(-1) !== name ||
    new URL(policy.signatureUrl).pathname.split('/').at(-1) !== name + '.sig'
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
  validateFlashTarget(target, image);
  const tool = await executablePath(fastboot);
  const session = new FastbootSession(runner, tool, target, options);
  await session.version();
  const directory = await mkdtemp(join(tmpdir(), 'pxv-flash-'));
  try {
    const script = await stageImage(runner, image, directory, options.signal);
    const bin = await fastbootWrapper(directory, tool, target.device.canonicalSerial);
    await session.unlock();
    await session.install(script, bin, directory);
    await session.lock();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validateImageUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'releases.grapheneos.org' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new AdapterError('OS image source must be the official GrapheneOS HTTPS release host');
}
function validatePublicKey(key: string): void {
  const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})$/.exec(key);
  if (!match?.[1] || !match[2])
    throw new AdapterError('OS release public key must be one pinned plain SSH key');
  const blob = Buffer.from(match[2], 'base64');
  if (
    blob.length < 8 ||
    blob.readUInt32BE(0) !== Buffer.byteLength(match[1]) ||
    blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('ascii') !== match[1]
  )
    throw new AdapterError('OS public key is malformed');
}
function validateFlashTarget(target: SelectedTarget, image: VerifiedImage): void {
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
  if (!/^[A-Za-z0-9._-]+$/.test(target.device.canonicalSerial))
    throw new AdapterError('Invalid fastboot serial');
}
function requireFastbootVersion(output: string): void {
  const parsed = /fastboot version (\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!parsed?.[1] || !parsed[2] || !parsed[3])
    throw new AdapterError('GrapheneOS requires fastboot 35.0.2 or newer');
  const [major, minor, patch] = parsed.slice(1).map(Number);
  if (major === undefined || major < 35 || isOldFastbootPatch(major, minor, patch))
    throw new AdapterError('GrapheneOS requires fastboot 35.0.2 or newer');
}
async function stageImage(
  runner: CommandRunner,
  image: VerifiedImage,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const staged = join(directory, 'factory.zip'),
    signature = join(directory, 'factory.zip.sig');
  await copySnapshot(image.path, staged, MAX_IMAGE_BYTES, signal);
  await copySnapshot(image.signaturePath, signature, 64 * 1024, signal);
  const verified = await new ImageService({ runner }).verify(staged, signature, image.policy, signal);
  if (verified.sha256 !== image.sha256 || verified.signatureSha256 !== image.signatureSha256)
    throw new AdapterError('OS snapshot differs from the reviewed image');
  const extracted = join(directory, 'image');
  const entries = await extractZip(staged, extracted, signal ? { signal } : {});
  const scripts = entries.filter(
    (entry) => entry.name.endsWith('/flash-all.sh') || entry.name === 'flash-all.sh',
  );
  if (scripts.length !== 1 || !scripts[0] || scripts[0].directory)
    throw new AdapterError('OS archive requires exactly one official flash-all.sh');
  return join(extracted, scripts[0].name);
}
async function fastbootWrapper(directory: string, tool: string, serial: string): Promise<string> {
  const bin = join(directory, 'bin');
  await mkdir(bin, { mode: 0o700 });
  await writeFile(
    join(bin, 'fastboot'),
    '#!/bin/sh\nfor arg do case "$arg" in -s|--serial|--serial=*|-s?*) exit 64 ;; esac; done\nexec ' +
      shellQuote(tool) +
      ' -s ' +
      shellQuote(serial) +
      ' "$@"\n',
    { flag: 'wx', mode: 0o700 },
  );
  return bin;
}
class FastbootSession {
  private readonly signal: { signal?: AbortSignal };
  private readonly serial: string;
  constructor(
    private readonly runner: CommandRunner,
    private readonly tool: string,
    private readonly target: SelectedTarget,
    private readonly options: OperationOptions,
  ) {
    this.signal = options.signal ? { signal: options.signal } : {};
    this.serial = target.device.canonicalSerial;
  }
  async version(): Promise<void> {
    requireFastbootVersion(
      checked(await this.runner.run([this.tool, '--version'], this.signal), 'Fastboot version inspection'),
    );
  }
  private async getvar(name: string): Promise<string> {
    const result = await this.runner.run([this.tool, '-s', this.serial, 'getvar', name], {
      ...this.signal,
      check: false,
    });
    if (result.code !== 0) throw new AdapterError('Fastboot ' + name + ' could not be read');
    const escaped = name;
    const rows = [
      ...(result.stdout + '\n' + result.stderr).matchAll(
        new RegExp('^(?:\\(bootloader\\) )?' + escaped + ':\\s*(\\S+)\\s*$', 'gm'),
      ),
    ];
    if (rows.length !== 1 || !rows[0]?.[1])
      throw new AdapterError('Fastboot ' + name + ' is missing or ambiguous');
    return rows[0][1];
  }
  private async guard(): Promise<void> {
    const list = checked(
      await this.runner.run([this.tool, 'devices'], this.signal),
      'Fastboot device inspection',
    )
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/));
    const matches = list.filter((row) => row[0] === this.serial && row[1] === 'fastboot');
    if (matches.length !== 1 || (await this.getvar('product')) !== this.target.device.codename)
      throw new AdapterError('Fastboot physical identity or codename changed');
  }
  async unlock(): Promise<void> {
    await this.guard();
    const unlocked = await this.getvar('unlocked');
    if (!['yes', 'no'].includes(unlocked)) throw new AdapterError('Bootloader lock state is unknown');
    if (unlocked === 'yes') return;
    checked(
      await this.runner.run([this.tool, '-s', this.serial, 'flashing', 'unlock'], {
        ...this.options,
        mutation: true,
        timeoutMs: 120_000,
      }),
      'Bootloader unlock',
    );
    if ((await this.getvar('unlocked')) !== 'yes')
      throw new AdapterError('Confirm the bootloader unlock on the selected phone');
  }
  async install(script: string, bin: string, directory: string): Promise<void> {
    await this.guard();
    const result = await this.runner.run(['/bin/bash', script], {
      ...this.options,
      mutation: true,
      timeoutMs: 1_800_000,
      cwd: dirname(script),
      env: {
        PATH: bin + ':/usr/bin:/bin',
        LC_ALL: 'C',
        ANDROID_SERIAL: this.serial,
        FASTBOOT_DEVICE: this.serial,
        TMPDIR: directory,
      },
    });
    if (result.code !== 0)
      throw new AdapterError(
        'OS flashing failed or was interrupted. No relock was attempted; preserve recovery evidence and inspect the phone',
        'MUTATION_UNCERTAIN',
      );
  }
  async lock(): Promise<void> {
    await this.guard();
    this.options.signal?.throwIfAborted();
    checked(
      await this.runner.run([this.tool, '-s', this.serial, 'flashing', 'lock'], {
        ...this.options,
        mutation: true,
        timeoutMs: 120_000,
      }),
      'Bootloader relock',
    );
    if ((await this.getvar('unlocked')) !== 'no')
      throw new AdapterError(
        'Locked bootloader was not observed; do not hand off the phone',
        'MUTATION_UNCERTAIN',
      );
  }
}

function isOldFastbootPatch(major: number, minor: number | undefined, patch: number | undefined): boolean {
  return major === 35 && minor === 0 && (patch ?? 0) < 2;
}
