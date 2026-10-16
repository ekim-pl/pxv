import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CommandRunner, supervisorPath } from '../../packages/runtime/src/index.js';
import {
  buildFormats,
  copyCandidate,
  createCandidate,
  dockerfile,
  promoteNpm,
  shellLauncher,
  verifyArtifacts,
  verifyCandidate,
  walkPublic,
} from '../../packages/release/src/index.js';

const source = process.cwd();
const runner = new CommandRunner();
async function fixture(brand = 'alpha'): Promise<string> {
  const root = await mkdtemp('/tmp/pxv-release-source-');
  const product = JSON.parse(await readFile(join(source, 'product.json'), 'utf8')) as Record<string, unknown>;
  Object.assign(product, {
    id: brand,
    name: `${brand} Fleet`,
    command: brand,
    packageName: `@example/${brand}`,
    debName: brand,
    image: `example/${brand}`,
    assets: { logo: 'assets/logo.svg' },
    defaultPolicy: 'policy-packs/simple/policy.json',
  });
  await writeFile(join(root, 'product.json'), JSON.stringify(product));
  await copyFile(join(source, 'package.json'), join(root, 'package.json'));
  await copyFile(join(source, 'LICENSE'), join(root, 'LICENSE'));
  await copyFile(join(source, 'rust-toolchain.toml'), join(root, 'rust-toolchain.toml'));
  await cp(join(source, 'native', 'supervisor'), join(root, 'native', 'supervisor'), {
    recursive: true,
    filter: (path) => !path.includes('/target'),
  });
  await cp(join(source, 'resources', 'third-party'), join(root, 'resources', 'third-party'), {
    recursive: true,
  });
  await mkdir(join(root, 'guides', 'assets', 'fonts'), { recursive: true });
  await writeFile(
    join(root, 'guides', 'assets', 'fonts', 'LICENSE-Liberation'),
    'Fixture font license notice',
  );
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'README.md'), 'Packaged operator documentation.');
  await mkdir(join(root, 'assets'));
  await writeFile(
    join(root, 'assets', 'logo.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg"><title>${brand}</title></svg>`,
  );
  await mkdir(join(root, 'policy-packs', 'simple'), { recursive: true });
  await copyFile(
    join(source, 'policy-packs', 'simple', 'policy.json'),
    join(root, 'policy-packs', 'simple', 'policy.json'),
  );
  await cp(join(source, 'packages', 'runtime', 'src'), join(root, 'packages', 'runtime', 'src'), {
    recursive: true,
  });
  await mkdir(join(root, 'packages', 'extensions', 'src'), { recursive: true });
  await writeFile(join(root, 'packages', 'extensions', 'src', 'index.ts'), 'export const apiVersion=1;');
  await writeFile(
    join(root, 'packages', 'extensions', 'src', 'worker.ts'),
    'import{parentPort}from"node:worker_threads";parentPort?.postMessage([]);',
  );
  await mkdir(join(root, 'packages', 'cli', 'src'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'cli', 'src', 'main.ts'),
    `import{SqliteStore}from'@pxv/runtime';if(process.argv[2]==='--sqlite'){const store=await SqliteStore.open(process.argv[3]!);await store.set('test','value',42);console.log(await store.get('test','value'));await store.close();}else console.log(${JSON.stringify(brand)},process.env.PXV_RESOURCE_ROOT,process.env.PXV_ROOT);`,
  );
  return root;
}

test('candidate rejects a dynamically linked supervisor even when runnable on the build host', async () => {
  const root = await fixture();
  const output = await mkdtemp('/tmp/pxv-release-output-');
  await expect(
    createCandidate({ sourceRoot: root, outputRoot: output, nativeBinary: '/bin/true' }),
  ).rejects.toThrow('static Linux x86_64');
});

describe('frozen distribution candidate', () => {
  test('bundled launchers resolve absolute and relative command symlinks before locating resources', async () => {
    const root = await mkdtemp('/tmp/pxv-launcher-');
    const installation = join(root, 'opt', 'fleet with spaces');
    const command = join(installation, 'bin', 'fleet');
    const aliases = join(root, 'usr', 'bin');
    await mkdir(join(installation, 'bin'), { recursive: true });
    await mkdir(join(installation, 'lib'));
    await mkdir(aliases, { recursive: true });
    await symlink(process.execPath, join(installation, 'bin', 'node'));
    await writeFile(
      join(installation, 'lib', 'main.js'),
      'console.log(JSON.stringify({root:process.env.PXV_RESOURCE_ROOT,supervisor:process.env.PXV_SUPERVISOR,project:process.env.PXV_ROOT,args:process.argv.slice(2)}));',
    );
    await symlink(command, join(aliases, 'fleet'));
    await symlink('fleet', join(aliases, 'relative-fleet'));
    for (const preview of [undefined, 'preview-example']) {
      await writeFile(command, shellLauncher(preview), { mode: 0o755 });
      for (const name of ['fleet', 'relative-fleet']) {
        const result = await runner.run([join(aliases, name), 'argument with spaces'], {
          cwd: '/',
          env: {
            PATH: '/usr/bin:/bin',
            HOME: root,
            XDG_STATE_HOME: join(root, 'state'),
            ...(preview ? {} : { PXV_ROOT: join(root, 'existing-project') }),
          },
        });
        expect(JSON.parse(result.stdout)).toEqual({
          root: installation,
          supervisor: join(installation, 'native', 'pxv-supervisor'),
          project: preview ? join(root, 'state', 'pxv', 'previews', preview) : join(root, 'existing-project'),
          args: ['argument with spaces'],
        });
      }
    }
  });
  test('fork builds isolate identities, package resources and exclude local/private state', async () => {
    const root = await fixture();
    const output = await mkdtemp('/tmp/pxv-release-output-');
    for (const path of [
      'secrets/operator-key',
      'state/private.json',
      'config/inventory.json',
      '.env',
      '.npmrc',
      'android/probe/build/probe.keystore',
    ]) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), 'NEVER-PACKAGE-THIS-SENTINEL');
    }
    const candidate = await createCandidate({
      sourceRoot: root,
      outputRoot: output,
      nativeBinary: await supervisorPath(),
    });
    expect(candidate.manifest.version).toMatch(/^0\.1\.0-preview\./u);
    expect(candidate.manifest.toolchain.rust).toBe('1.99.1');
    expect(candidate.manifest.toolchain.nativeTarget).toBe('x86_64-unknown-linux-musl');
    expect(candidate.manifest.toolchain.nativeLinkage).toBe('static');
    expect(await readFile(join(candidate.directory, 'MUSL-COPYRIGHT.txt'), 'utf8')).toContain(
      'musl as a whole',
    );
    expect(await readFile(join(candidate.directory, 'RUST-RUNTIME-COPYRIGHT.html'), 'utf8')).toContain(
      'musl',
    );
    expect(candidate.manifest.source.files.some((file) => file.path === 'rust-toolchain.toml')).toBe(true);
    expect(candidate.manifest.command).toMatch(/^alpha-preview-/u);
    expect((await stat(candidate.directory)).mode & 0o777).toBe(0o555);
    expect(
      await readFile(join(candidate.directory, 'guides/assets/fonts/LICENSE-Liberation'), 'utf8'),
    ).toContain('font license');
    expect(await readFile(join(candidate.directory, 'docs/README.md'), 'utf8')).toContain(
      'operator documentation',
    );
    const sbom = JSON.parse(await readFile(join(candidate.directory, 'sbom.spdx.json'), 'utf8')) as {
      packages: { name: string; checksums?: { checksumValue: string }[] }[];
    };
    expect(sbom.packages.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'Node.js',
        'pxv-supervisor',
        'musl',
        'rust-std',
        'base64',
        'libc',
        'serde',
        'serde_json',
        'unicode-ident',
      ]),
    );
    expect(sbom.packages.find((entry) => entry.name === 'Node.js')?.checksums?.[0]?.checksumValue).toBe(
      candidate.manifest.toolchain.nodeSha256,
    );
    const notices = await readFile(join(candidate.directory, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    expect(notices).toContain('cargo:base64@0.22.1');
    expect(notices).toContain('Unicode-3.0');
    expect(notices).toContain('UNICODE LICENSE V3');
    expect(
      candidate.manifest.files.some((file) => file.path.startsWith('node_modules/@pxv/runtime/worker')),
    ).toBe(true);
    for (const file of candidate.manifest.files.filter((file) => file.size < 1024 * 1024))
      expect(await readFile(join(candidate.directory, file.path), 'utf8')).not.toContain(
        'NEVER-PACKAGE-THIS-SENTINEL',
      );
    expect(await verifyCandidate(candidate.directory)).toEqual(candidate.manifest);
    const db = join(output, 'external-project', 'state.sqlite');
    expect(
      (
        await runner.run([join(candidate.directory, 'bin', candidate.manifest.command), '--sqlite', db], {
          cwd: '/tmp',
        })
      ).stdout,
    ).toBe('42\n');
    const preview = (
      await runner.run([join(candidate.directory, 'bin', candidate.manifest.command)], {
        cwd: '/tmp',
        env: { HOME: output, PATH: '/usr/bin:/bin' },
      })
    ).stdout;
    expect(preview).toContain('/pxv/previews/');
    const secondRoot = await fixture('bravo');
    const second = await createCandidate({
      sourceRoot: secondRoot,
      outputRoot: output,
      nativeBinary: await supervisorPath(),
    });
    expect(second.manifest.product.id).toBe('bravo');
    expect(second.manifest.sourceDigest).not.toBe(candidate.manifest.sourceDigest);
    expect(await readFile(join(second.directory, 'assets', 'logo.svg'), 'utf8')).toContain('bravo');
  });
  test('rejects public symlinks and missing declared fork assets', async () => {
    const root = await fixture();
    const output = await mkdtemp('/tmp/pxv-release-output-');
    await symlink('/etc/passwd', join(root, 'assets', 'bad.txt'));
    await expect(
      createCandidate({ sourceRoot: root, outputRoot: output, nativeBinary: await supervisorPath() }),
    ).rejects.toThrow('symlinks');
    await expect(walkPublic(root, '../secrets')).rejects.toThrow('Forbidden');
    expect(await walkPublic(root, 'absent')).toEqual([]);
    await writeFile(join(root, 'assets', 'credentials.json'), '{}');
    await expect(walkPublic(root, 'assets/credentials.json')).rejects.toThrow('Forbidden');
    const noAsset = await fixture('charlie');
    const product = JSON.parse(await readFile(join(noAsset, 'product.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    product['assets'] = { logo: 'assets/missing.svg' };
    await writeFile(join(noAsset, 'product.json'), JSON.stringify(product));
    await expect(
      createCandidate({ sourceRoot: noAsset, outputRoot: output, nativeBinary: await supervisorPath() }),
    ).rejects.toThrow('absent');
  });
  test('portable, npm and Debian packages use the same reviewed engine and install without publication', async () => {
    const root = await fixture();
    const output = await mkdtemp('/tmp/pxv-release-output-');
    const candidate = await createCandidate({
      sourceRoot: root,
      outputRoot: output,
      nativeBinary: await supervisorPath(),
    });
    const artifacts = await buildFormats(candidate, { formats: ['portable', 'npm', 'deb'] });
    const directory = join(candidate.directory, '..', 'artifacts');
    await verifyArtifacts(directory);
    expect(artifacts).toHaveLength(3);
    const portable = artifacts.find((item) => item.format === 'portable')!;
    const npm = artifacts.find((item) => item.format === 'npm')!;
    const deb = artifacts.find((item) => item.format === 'deb')!;
    const portableContents = (await runner.run(['tar', '-tzf', portable.path])).stdout;
    expect(portableContents).toContain('candidate/bin/node');
    expect(portableContents).not.toContain('keystore');
    const npmContents = (await runner.run(['tar', '-tzf', npm.path])).stdout;
    expect(npmContents).not.toContain('package/bin/node');
    expect(npmContents).toContain('package/node_modules/@pxv/runtime/worker.js');
    const extracted = join(output, 'npm-extracted');
    await mkdir(extracted);
    await runner.run(['tar', '-xzf', npm.path, '-C', extracted]);
    expect(
      (await runner.run([process.execPath, join(extracted, 'package', 'npm-bin.mjs')])).stdout,
    ).toContain('alpha');
    const installed = join(output, 'npm-install');
    const npmCli = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await runner.run(
      [
        process.execPath,
        npmCli,
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefix',
        installed,
        npm.path,
      ],
      { timeoutMs: 30_000 },
    );
    expect(
      (
        await runner.run([
          process.execPath,
          join(installed, 'node_modules', '@example', 'alpha', 'npm-bin.mjs'),
        ])
      ).stdout,
    ).toContain('alpha');
    const info = (await runner.run(['dpkg-deb', '--field', deb.path])).stdout;
    expect(info).toContain(`Package: ${candidate.manifest.debName}`);
    expect(info).toContain('~preview.');
    const control = (await runner.run(['dpkg-deb', '--ctrl-tarfile', deb.path])).stdout;
    expect(control).not.toContain('postinst');
    expect(dockerfile(candidate.manifest)).toContain('@sha256:');
    expect(dockerfile(candidate.manifest)).toContain('USER 65532:65532');
    await expect(buildFormats(candidate, { formats: ['portable'] })).rejects.toThrow('output must be empty');
  });
  test('tampered frozen bytes fail verification before packaging', async () => {
    const root = await fixture();
    const output = await mkdtemp('/tmp/pxv-release-output-');
    const candidate = await createCandidate({
      sourceRoot: root,
      outputRoot: output,
      nativeBinary: await supervisorPath(),
    });
    const modified = join(output, 'modified');
    await copyCandidate(candidate.directory, modified);
    await writeFile(join(modified, 'assets', 'logo.svg'), 'tampered');
    await expect(verifyCandidate(modified)).rejects.toThrow('changed');
    await expect(buildFormats(candidate, { formats: [] })).rejects.toThrow('unique');
    const checksumDirectory = join(output, 'checksums');
    await mkdir(checksumDirectory);
    await writeFile(join(checksumDirectory, 'SHA256SUMS'), 'bad\n');
    await expect(verifyArtifacts(checksumDirectory)).rejects.toThrow('Invalid release checksum');
  });
  test('Rust dependency changes and missing or changed reviewed notices block release creation offline', async () => {
    const root = await fixture();
    const output = await mkdtemp('/tmp/pxv-release-output-');
    const catalogFile = join(root, 'resources/third-party/rust-crates.json');
    const original = await readFile(catalogFile, 'utf8');
    const catalog = JSON.parse(original) as {
      packages: { checksum: string; licenses: { path: string }[] }[];
    };
    catalog.packages[0]!.checksum = '0'.repeat(64);
    await writeFile(catalogFile, JSON.stringify(catalog));
    await expect(
      createCandidate({ sourceRoot: root, outputRoot: output, nativeBinary: await supervisorPath() }),
    ).rejects.toThrow('catalog differs from Cargo.lock');
    await writeFile(catalogFile, original);
    const notice = join(root, 'resources/third-party', catalog.packages[0]!.licenses[0]!.path);
    await writeFile(notice, 'changed license');
    await expect(
      createCandidate({ sourceRoot: root, outputRoot: output, nativeBinary: await supervisorPath() }),
    ).rejects.toThrow('notice integrity mismatch');
  });
  test('explicit signing and promotion verify real OpenSSH signatures before publication', async () => {
    const root = await fixture();
    const output = await mkdtemp('/tmp/pxv-release-output-');
    const key = join(output, 'signing');
    await runner.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
    const candidate = await createCandidate({
      sourceRoot: root,
      outputRoot: output,
      nativeBinary: await supervisorPath(),
      preview: false,
    });
    await expect(buildFormats(candidate, { formats: ['npm'] })).rejects.toThrow('signing key');
    const artifacts = await buildFormats(candidate, { formats: ['npm'], signingKey: key });
    const packageFile = artifacts[0]!.path;
    const directory = join(candidate.directory, '..', 'artifacts');
    const allowed = join(output, 'allowed_signers');
    await writeFile(allowed, `release ${await readFile(`${key}.pub`, 'utf8')}`);
    await promoteNpm({
      artifactDirectory: directory,
      packageFile,
      registry: 'https://registry.example.org/',
      allowedSigners: allowed,
      signer: 'release',
      dryRun: true,
    });
    const provenanceFile = join(directory, 'provenance.json');
    const checksumFile = join(directory, 'SHA256SUMS');
    const originalProvenance = await readFile(provenanceFile, 'utf8');
    const originalChecksums = await readFile(checksumFile, 'utf8');
    expect(originalChecksums).toContain('  provenance.json\n');
    await writeFile(
      provenanceFile,
      originalProvenance.replace(candidate.manifest.sourceDigest, '0'.repeat(64)),
    );
    await expect(verifyArtifacts(directory)).rejects.toThrow('checksum mismatch');
    const amendedProvenance = JSON.parse(originalProvenance) as {
      sourceDigest: string;
      artifacts: { size: number }[];
    };
    const rewriteMetadata = async (): Promise<void> => {
      const content = JSON.stringify(amendedProvenance);
      await writeFile(provenanceFile, content);
      await writeFile(
        checksumFile,
        originalChecksums.replace(
          /^[a-f0-9]{64}  provenance\.json$/mu,
          `${createHash('sha256').update(content).digest('hex')}  provenance.json`,
        ),
      );
    };
    amendedProvenance.artifacts[0]!.size += 1;
    await rewriteMetadata();
    await expect(verifyArtifacts(directory)).rejects.toThrow('does not match reviewed bytes');
    amendedProvenance.artifacts[0]!.size -= 1;
    amendedProvenance.sourceDigest = '0'.repeat(64);
    await rewriteMetadata();
    await verifyArtifacts(directory);
    await expect(
      promoteNpm({
        artifactDirectory: directory,
        packageFile,
        registry: 'https://registry.example.org/',
        allowedSigners: allowed,
        signer: 'release',
        dryRun: true,
      }),
    ).rejects.toThrow();
    await writeFile(provenanceFile, originalProvenance);
    await writeFile(checksumFile, originalChecksums.replace(/^[a-f0-9]{64}  provenance\.json\n/mu, ''));
    await expect(verifyArtifacts(directory)).rejects.toThrow('provenance is absent');
    await writeFile(checksumFile, originalChecksums + originalChecksums.split('\n')[0] + '\n');
    await expect(verifyArtifacts(directory)).rejects.toThrow('Invalid release checksum');
    await writeFile(checksumFile, originalChecksums);
    await expect(
      promoteNpm({
        artifactDirectory: directory,
        packageFile,
        registry: 'https://token@registry.example.org/',
        allowedSigners: allowed,
        signer: 'release',
        dryRun: true,
      }),
    ).rejects.toThrow('credential-free');
    await chmod(packageFile, 0o600);
    await writeFile(packageFile, 'tampered');
    await expect(verifyArtifacts(directory)).rejects.toThrow('checksum mismatch');
    await expect(
      promoteNpm({
        artifactDirectory: directory,
        packageFile,
        registry: 'https://registry.example.org/',
        allowedSigners: allowed,
        signer: 'release',
        dryRun: true,
      }),
    ).rejects.toThrow('checksum mismatch');
    expect((await readdir(directory)).some((path) => path === 'SHA256SUMS.sig')).toBe(true);
  });
});
