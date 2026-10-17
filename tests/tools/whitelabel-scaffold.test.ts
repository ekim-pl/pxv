import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pxv-whitelabel-'));
  temporary.push(root);
  return root;
}

async function configFile(root: string, value: unknown): Promise<string> {
  const path = join(root, 'brand.json');
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function scaffold(config: string, output: string) {
  return spawnSync(
    process.execPath,
    [join(repo, 'tools/optional/branding/scaffold.mjs'), '--config', config, '--output-dir', output],
    { cwd: repo, encoding: 'utf8' },
  );
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

it('generates a simple default brand and fresh project/device starter without changing Community', async () => {
  const root = await scratch();
  const communityBefore = await readFile(join(repo, 'product.json'), 'utf8');
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  delete config['starter'];
  delete (config['product'] as Record<string, unknown>)['features'];
  const configPath = await configFile(root, config);
  const output = join(root, 'out');

  const result = scaffold(configPath, output);
  expect(result.status, result.stderr).toBe(0);
  const product = await json<{ name: string; defaultPolicy: string }>(join(output, 'product.json'));
  const theme = await json<{ brandName: string; fontAsset: string; colors: Record<string, string> }>(
    join(output, 'guides/assets/brand.json'),
  );
  const policy = await json<{ profiles: Record<string, unknown>[] }>(join(output, 'starter/policy.json'));
  const project = await json<{ id: string; productId: string }>(join(output, 'starter/pxv.project.json'));
  const inventory = await json<{ devices: unknown[] }>(join(output, 'starter/inventory.json'));

  expect(product).toMatchObject({
    name: 'Acme Fleet',
    defaultPolicy: 'policy-packs/acme/policy.json',
    features: { extensions: false, seedvault: false },
  });
  expect(theme).toMatchObject({ brandName: 'Acme Fleet', fontAsset: 'assets/fonts/DejaVuSans.ttf' });
  expect(theme.colors).toEqual({ primary: '#17324D', secondary: '#2F6873', accent: '#D9952B' });
  expect(policy.profiles).toHaveLength(1);
  expect(policy.profiles[0]).toMatchObject({ id: 'owner', defaultLocale: 'en-US' });
  expect(policy.profiles[0]).not.toHaveProperty('language');
  expect(project).toEqual({
    format: 'pxv-ts',
    schemaVersion: 1,
    id: 'acme-starter',
    productId: 'acme',
    policyFile: 'policy.json',
    inventoryFile: 'inventory.json',
    extensions: [],
  });
  expect(inventory.devices).toEqual([]);
  expect(await readFile(join(repo, 'product.json'), 'utf8')).toBe(communityBefore);
});

it.each([
  [{ extensions: true }, { extensions: true, seedvault: false }],
  [{ seedvault: true }, { extensions: false, seedvault: true }],
  [
    { extensions: true, seedvault: true },
    { extensions: true, seedvault: true },
  ],
])('enables only explicitly selected scaffold features %j', async (features, expected) => {
  const root = await scratch();
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  (config['product'] as Record<string, unknown>)['features'] = features;
  const output = join(root, 'out');
  const result = scaffold(await configFile(root, config), output);
  expect(result.status, result.stderr).toBe(0);
  expect(await json(join(output, 'product.json'))).toMatchObject({ features: expected });
});

it.each([
  [null, 'product.features must be an object'],
  [{ extensions: 'yes' }, 'product.features.extensions must be a boolean'],
  [{ unknown: true }, 'product.features has missing or unsupported fields'],
])('rejects invalid scaffold features %j before writing', async (features, expected) => {
  const root = await scratch();
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  (config['product'] as Record<string, unknown>)['features'] = features;
  const output = join(root, 'out');
  const result = scaffold(await configFile(root, config), output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(expected);
  await expect(readFile(join(output, 'product.json'))).rejects.toThrow();
});

it('accepts a Polish language override and optional brand assets', async () => {
  const root = await scratch();
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  const product = config['product'] as Record<string, unknown>;
  const brand = config['brand'] as Record<string, unknown>;
  const starter = config['starter'] as Record<string, unknown>;
  product['id'] = 'acme-reference';
  product['name'] = 'Acme Reference';
  starter['policyTemplate'] = 'reference-five';
  delete starter['defaultLocale'];
  starter['language'] = 'pl-PL';
  starter['ownerProfileName'] = 'Koordynator';
  brand['logoPath'] = 'logo.svg';
  brand['fontFile'] = 'font.ttf';
  await copyFile(join(repo, 'assets/logo.svg'), join(root, 'logo.svg'));
  await copyFile(join(repo, 'guides/assets/fonts/DejaVuSans.ttf'), join(root, 'font.ttf'));
  const output = join(root, 'out');
  const result = scaffold(await configFile(root, config), output);
  expect(result.status, result.stderr).toBe(0);

  const policy = await json<{
    profiles: { id: string; name: string; defaultLocale: string; language?: string }[];
  }>(join(output, 'starter/policy.json'));
  const theme = await json<{ logo?: string; fontAsset: string }>(join(output, 'guides/assets/brand.json'));
  expect(policy.profiles).toHaveLength(5);
  expect(policy.profiles.every((profile) => profile.defaultLocale === 'pl-PL')).toBe(true);
  expect(policy.profiles.every((profile) => !('language' in profile))).toBe(true);
  expect(policy.profiles.find((profile) => profile.id === 'owner')?.name).toBe('Koordynator');
  expect(theme).toMatchObject({ logo: 'assets/brand-logo.svg', fontAsset: 'assets/fonts/brand-font.ttf' });
  expect(await readFile(join(output, 'guides/assets/brand-logo.svg'), 'utf8')).toContain('<svg');
});

it('canonicalizes a language-script-region default for every generated profile, including owner', async () => {
  const root = await scratch();
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  const starter = config['starter'] as Record<string, unknown>;
  starter['policyTemplate'] = 'reference-five';
  starter['defaultLocale'] = 'SR-latn-rs';
  const output = join(root, 'out');

  const result = scaffold(await configFile(root, config), output);
  expect(result.status, result.stderr).toBe(0);
  const policy = await json<{ profiles: Record<string, unknown>[] }>(join(output, 'starter/policy.json'));
  expect(policy.profiles).toHaveLength(5);
  expect(policy.profiles.every((profile) => profile['defaultLocale'] === 'sr-Latn-RS')).toBe(true);
  expect(policy.profiles.every((profile) => !('language' in profile))).toBe(true);
});

it('accepts equivalent canonical and alternate locale fields', async () => {
  const root = await scratch();
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  const starter = config['starter'] as Record<string, unknown>;
  starter['defaultLocale'] = 'iw-il';
  starter['language'] = 'he-IL';
  const output = join(root, 'out');

  const result = scaffold(await configFile(root, config), output);
  expect(result.status, result.stderr).toBe(0);
  const policy = await json<{ profiles: Record<string, unknown>[] }>(join(output, 'starter/policy.json'));
  expect(policy.profiles[0]).toMatchObject({ id: 'owner', defaultLocale: 'he-IL' });
  expect(policy.profiles[0]).not.toHaveProperty('language');
});

it.each([
  [{ defaultLocale: 'de-DE', language: 'pl-PL' }, 'conflicts with alternate language'],
  [{ defaultLocale: 'en-US,pl-PL' }, 'Expected one explicit BCP 47 locale tag'],
  [{ defaultLocale: 'pl_PL' }, 'Expected one explicit BCP 47 locale tag'],
  [{ defaultLocale: 'und' }, 'Expected one explicit BCP 47 locale tag'],
  [{ defaultLocale: null }, 'Expected one explicit BCP 47 locale tag'],
  [{ language: 'Europe/Warsaw' }, 'Expected one explicit BCP 47 locale tag'],
])('rejects conflicting or invalid locale input %j before writing', async (starter, expected) => {
  const root = await scratch();
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  config['starter'] = starter;
  const output = join(root, 'out');

  const result = scaffold(await configFile(root, config), output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(expected);
  await expect(readFile(join(output, 'product.json'), 'utf8')).rejects.toThrow();
});

it('rejects invalid brand colors without writing a partial product', async () => {
  const root = await scratch();
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  (config['brand'] as Record<string, unknown>)['accent'] = 'gold';
  const output = join(root, 'out');
  const result = scaffold(await configFile(root, config), output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('brand.accent must be a six-digit hex color');
  await expect(readFile(join(output, 'product.json'), 'utf8')).rejects.toThrow();
});
