import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ImageService,
  flashImage,
  shellQuote,
  type CommandRunner,
} from '../../packages/adapters/src/index.js';
import type { OsPolicy, SelectedTarget } from '@pxv/contracts';
let directory: string;
let key: string;
let fakeFastboot: string;
let policy: OsPolicy;
const runner: CommandRunner = {
  run: (args, options = {}) => {
    const executable = args[0];
    if (!executable) throw new Error('Missing command');
    if (options.mutation && executable !== fakeFastboot && executable !== '/bin/bash')
      throw new Error('Fixture forbids external device mutations');
    if (
      options.mutation &&
      (!options.lease || (executable === '/bin/bash' && !options.cwd?.startsWith('/tmp/pxv-flash-')))
    )
      throw new Error('Fixture mutation lacks supervision context');
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args.slice(1), {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (data: Buffer) => stdout.push(data));
      child.stderr.on('data', (data: Buffer) => stderr.push(data));
      child.once('error', reject);
      child.once('close', (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
      if (options.inputFile) createReadStream(options.inputFile).pipe(child.stdin);
      else child.stdin.end(options.input);
    });
  },
};
async function exec(args: string[]) {
  const result = await runner.run(args);
  if (result.code) throw new Error(result.stderr);
  return result.stdout;
}
const target: SelectedTarget = {
  device: {
    assetId: 'fixture',
    kind: 'pixel',
    canonicalSerial: 'FIXTURE123',
    model: 'Pixel 8a',
    codename: 'akita',
    groups: [],
    transports: [{ kind: 'usb', serial: 'FIXTURE123' }],
  },
  transport: { kind: 'usb', serial: 'FIXTURE123' },
};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pxv-flash-fixture-'));
  key = join(directory, 'key');
  await exec(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  policy = {
    codename: 'akita',
    release: '2026100600',
    url: 'https://releases.grapheneos.org/akita-install-2026100600.zip',
    signatureUrl: 'https://releases.grapheneos.org/akita-install-2026100600.zip.sig',
    signerPrincipal: 'contact@grapheneos.org',
    namespace: 'factory images',
    publicKey: (await readFile(`${key}.pub`, 'utf8')).trim().split(' ').slice(0, 2).join(' '),
  };
  fakeFastboot = join(directory, 'fixture-fastboot');
  const state = shellQuote(join(directory, 'unlocked'));
  const log = shellQuote(join(directory, 'calls'));
  await writeFile(
    fakeFastboot,
    `#!/bin/sh\nif [ "$1" = '--version' ]; then echo 'fastboot version 37.0.1'; exit 0; fi\nif [ "$1" = devices ]; then printf 'FIXTURE123\\tfastboot\\n'; exit 0; fi\n[ "$1" = '-s' ] && [ "$2" = 'FIXTURE123' ] || exit 90\nshift 2\nprintf '%s\\n' "$*" >> ${log}\ncase "$1 $2" in\n'getvar product') echo 'product: akita' >&2 ;;\n'getvar unlocked') printf 'unlocked: ' >&2; cat ${state} >&2 ;;\n'flashing unlock') echo yes > ${state} ;;\n'flashing lock') echo no > ${state} ;;\n'flash boot') [ ! -f ${shellQuote(join(directory, 'fail'))} ] || exit 42 ;;\nesac\n`,
    { mode: 0o700 },
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function fixture(name: string) {
  const input = join(directory, name);
  await mkdir(input);
  await writeFile(
    join(input, 'flash-all.sh'),
    '#!/bin/sh\nset -eu\nfastboot flash boot boot.img\nfastboot reboot-bootloader\n',
  );
  await chmod(join(input, 'flash-all.sh'), 0o700);
  await writeFile(join(input, 'boot.img'), 'signed test partition');
  const archive = join(directory, `${name}.zip`);
  await exec(['zip', '-q', '-j', archive, join(input, 'flash-all.sh'), join(input, 'boot.img')]);
  await exec(['ssh-keygen', '-Y', 'sign', '-f', key, '-n', policy.namespace, archive]);
  return new ImageService({ runner }).verify(archive, `${archive}.sig`, policy);
}
describe('serial-bound authenticated OS flashing', () => {
  it('executes an authenticated script only through the fixed serial wrapper and relocks after validated success', async () => {
    await writeFile(join(directory, 'unlocked'), 'no\n');
    await writeFile(join(directory, 'calls'), '');
    const image = await fixture('success');
    await flashImage(runner, fakeFastboot, target, image, { lease: {} });
    expect((await readFile(join(directory, 'unlocked'), 'utf8')).trim()).toBe('no');
    const calls = await readFile(join(directory, 'calls'), 'utf8');
    expect(calls).toContain('flash boot boot.img');
    expect(calls.indexOf('flashing lock')).toBeGreaterThan(calls.indexOf('flash boot boot.img'));
  });
  it('never relocks after the signed flash script reports failure', async () => {
    await writeFile(join(directory, 'unlocked'), 'yes\n');
    await writeFile(join(directory, 'calls'), '');
    await writeFile(join(directory, 'fail'), 'fail');
    const image = await fixture('failure');
    await expect(flashImage(runner, fakeFastboot, target, image, { lease: {} })).rejects.toMatchObject({
      code: 'MUTATION_UNCERTAIN',
    });
    const calls = await readFile(join(directory, 'calls'), 'utf8');
    expect(calls).not.toContain('flashing lock');
    expect((await readFile(join(directory, 'unlocked'), 'utf8')).trim()).toBe('yes');
  });
  it('refuses wireless or changed targets before flashing', async () => {
    const image = await fixture('wireless');
    await expect(
      flashImage(
        runner,
        fakeFastboot,
        { ...target, transport: { kind: 'wifi', serial: '192.0.2.1:5555' } },
        image,
        { lease: {} },
      ),
    ).rejects.toThrow(/USB identity/);
    await expect(
      flashImage(
        runner,
        fakeFastboot,
        { ...target, device: { ...target.device, codename: 'other' } },
        image,
        { lease: {} },
      ),
    ).rejects.toThrow(/matching image/);
  });
});

describe('OS preflight and uncertain lock failures', () => {
  it('refuses source tampering at the private staging boundary before unlocking or flashing', async () => {
    const image = await fixture('changed-after-review');
    await writeFile(image.path, 'changed after plan approval');
    const mutations: string[][] = [];
    const guarded: CommandRunner = {
      run: (args, options) => {
        if (options?.mutation) mutations.push(args);
        return runner.run(args, options);
      },
    };
    await expect(flashImage(guarded, fakeFastboot, target, image, { lease: {} })).rejects.toThrow(
      /signature verification/,
    );
    expect(mutations).toHaveLength(0);
  });
  it('rejects unsupported fastboot versions and malformed target observations before mutation', async () => {
    const image = await fixture('preflight-errors');
    for (const version of ['unrecognized', 'fastboot version 34.0.9', 'fastboot version 35.0.1']) {
      const guarded: CommandRunner = {
        run: (args, options) =>
          args[1] === '--version'
            ? Promise.resolve({ code: 0, stdout: version, stderr: '' })
            : runner.run(args, options),
      };
      await expect(flashImage(guarded, fakeFastboot, target, image, { lease: {} })).rejects.toThrow(/35.0.2/);
    }
    for (const outcome of [
      { code: 1, stdout: '', stderr: '' },
      { code: 0, stdout: 'product: akita\nproduct: akita\n', stderr: '' },
      { code: 0, stdout: 'product: wrong', stderr: '' },
    ]) {
      const mutations: string[][] = [];
      const guarded: CommandRunner = {
        run: (args, options) => {
          if (options?.mutation) mutations.push(args);
          if (args.at(-1) === 'product') return Promise.resolve(outcome);
          return runner.run(args, options);
        },
      };
      await expect(flashImage(guarded, fakeFastboot, target, image, { lease: {} })).rejects.toThrow(
        /Fastboot/,
      );
      expect(mutations).toHaveLength(0);
    }
    await expect(
      flashImage(runner, join(directory, 'missing-fastboot'), target, image, { lease: {} }),
    ).rejects.toThrow(/unavailable/);
    await expect(
      flashImage(runner, fakeFastboot, target, { ...image, sha256: '0'.repeat(64) }, { lease: {} }),
    ).rejects.toThrow(/reviewed image/);
  });
  it('does not relock when lock state, unlock confirmation or final lock verification is uncertain', async () => {
    await rm(join(directory, 'fail'), { force: true });
    const image = await fixture('lock-errors');
    for (const states of [['unknown'], ['no', 'no'], ['yes', 'yes']]) {
      const pending = [...states];
      const mutations: string[][] = [];
      const guarded: CommandRunner = {
        run: (args, options) => {
          if (options?.mutation) mutations.push(args);
          if (args.at(-1) === 'unlocked')
            return Promise.resolve({ code: 0, stdout: '', stderr: 'unlocked: ' + pending.shift() });
          return runner.run(args, options);
        },
      };
      await expect(flashImage(guarded, fakeFastboot, target, image, { lease: {} })).rejects.toThrow(
        /lock|Locked/,
      );
      const locks = mutations.filter((args) => args.at(-1) === 'lock');
      expect(locks).toHaveLength(states[0] === 'yes' ? 1 : 0);
    }
  });
  it('rejects policy URL, public key and release identity ambiguity before signature execution', async () => {
    const service = new ImageService({ runner });
    for (const change of [
      { url: policy.url + '?different=true' },
      { namespace: 'wrong' },
      { publicKey: 'bad' },
      { publicKey: 'ssh-ed25519 AAAAAA==' },
      { release: 'bad' },
      { signatureUrl: 'https://releases.grapheneos.org/wrong.zip.sig' },
    ]) {
      await expect(service.verify('absent', 'absent.sig', { ...policy, ...change })).rejects.toThrow(/OS/);
    }
  });
});
