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
    [join(repo, 'tools/whitelabel-scaffold.mjs'), '--config', config, '--output-dir', output],
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
  const configPath = await configFile(root, config);
  const output = join(root, 'out');

  const result = scaffold(configPath, output);
  expect(result.status, result.stderr).toBe(0);
  const product = await json<{ name: string; defaultPolicy: string }>(join(output, 'product.json'));
  const theme = await json<{ brandName: string; fontAsset: string; colors: Record<string, string> }>(
    join(output, 'guides/assets/brand.json'),
  );
  const policy = await json<{ profiles: unknown[] }>(join(output, 'starter/policy.json'));
  const project = await json<{ id: string; productId: string }>(join(output, 'starter/pxv.project.json'));
  const inventory = await json<{ devices: unknown[] }>(join(output, 'starter/inventory.json'));

  expect(product).toMatchObject({ name: 'Acme Fleet', defaultPolicy: 'policy-packs/acme/policy.json' });
  expect(theme).toMatchObject({ brandName: 'Acme Fleet', fontAsset: 'assets/fonts/DejaVuSans.ttf' });
  expect(theme.colors).toEqual({ primary: '#17324D', secondary: '#2F6873', accent: '#D9952B' });
  expect(policy.profiles).toHaveLength(1);
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

it('validates alternate starter policies, Polish language and optional brand assets', async () => {
  const root = await scratch();
  const config = await json<Record<string, unknown>>(join(repo, 'config/templates/white-label.example.json'));
  const product = config['product'] as Record<string, unknown>;
  const brand = config['brand'] as Record<string, unknown>;
  const starter = config['starter'] as Record<string, unknown>;
  product['id'] = 'acme-reference';
  product['name'] = 'Acme Reference';
  starter['policyTemplate'] = 'reference-five';
  starter['language'] = 'pl-PL';
  starter['ownerProfileName'] = 'Koordynator';
  brand['logoPath'] = 'logo.svg';
  brand['fontFile'] = 'font.ttf';
  await copyFile(join(repo, 'assets/logo.svg'), join(root, 'logo.svg'));
  await copyFile(join(repo, 'guides/assets/fonts/DejaVuSans.ttf'), join(root, 'font.ttf'));
  const output = join(root, 'out');
  const result = scaffold(await configFile(root, config), output);
  expect(result.status, result.stderr).toBe(0);

  const policy = await json<{ profiles: { id: string; name: string; language: string }[] }>(
    join(output, 'starter/policy.json'),
  );
  const theme = await json<{ logo?: string; fontAsset: string }>(join(output, 'guides/assets/brand.json'));
  expect(policy.profiles).toHaveLength(5);
  expect(policy.profiles.every((profile) => profile.language === 'pl-PL')).toBe(true);
  expect(policy.profiles.find((profile) => profile.id === 'owner')?.name).toBe('Koordynator');
  expect(theme).toMatchObject({ logo: 'assets/brand-logo.svg', fontAsset: 'assets/fonts/brand-font.ttf' });
  expect(await readFile(join(output, 'guides/assets/brand-logo.svg'), 'utf8')).toContain('<svg');
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
