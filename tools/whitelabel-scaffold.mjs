#!/usr/bin/env node
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  canonicalLocale,
  parseDocument,
  profileLocale,
  validatePolicy,
  validateProduct,
  validateProject,
} from '../packages/contracts/dist/index.js';

/** @typedef {{schemaVersion:1,product:{id:string,name:string,command:string,packageName:string,debName:string,image:string,support:{name:string,email:string,url:string}},brand:{primary:string,secondary:string,accent:string,fontFamily:string,logoPath?:string,fontFile?:string},starter:{policyTemplate?:'simple'|'reference-five',defaultLocale?:string,language?:string,ownerProfileName?:string}}} ScaffoldConfig */
/** @typedef {ScaffoldConfig & {configPath:string}} ConfigWithPath */
/** @typedef {ReturnType<typeof validateProduct>} Product */
/** @typedef {ReturnType<typeof validatePolicy>} Policy */
/** @typedef {ReturnType<typeof validateProject>} Project */
/** @typedef {{product:Product,policy:Policy,project:Project,brand:Record<string,unknown>,policyPath:string,template:string,logoPath?:string|undefined,logoExtension?:string|undefined,fontPath?:string|undefined,fontExtension?:string|undefined,inventory:{schemaVersion:1,devices:never[]}}} Prepared */
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedColor = /^#[\da-f]{6}$/iu;
const allowedFont = /^[\p{L}\p{N} _.-]{1,64}$/u;
const allowedId = /^[a-z][a-z0-9-]{0,62}$/u;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requireRecord(value, name) {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

/** @param {Record<string, unknown>} value @param {string[]} required @param {string} name @param {string[]} optional */
function validateKeys(value, required, name, optional = []) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error(`${name} has missing or unsupported fields`);
}

/** @param {Record<string, unknown>} value @returns {ScaffoldConfig['product']} */
function parseProduct(value) {
  validateKeys(value, ['command', 'debName', 'id', 'image', 'name', 'packageName', 'support'], 'product');
  const id = value['id'];
  if (typeof id !== 'string' || !allowedId.test(id))
    throw new Error('product.id must be a lowercase identifier');
  return /** @type {ScaffoldConfig['product']} */ (value);
}

/** @param {Record<string, unknown>} value @returns {ScaffoldConfig['brand']} */
function parseBrand(value) {
  validateKeys(value, ['accent', 'fontFamily', 'primary', 'secondary'], 'brand', ['fontFile', 'logoPath']);
  for (const key of ['primary', 'secondary', 'accent']) {
    if (typeof value[key] !== 'string' || !allowedColor.test(value[key]))
      throw new Error(`brand.${key} must be a six-digit hex color`);
  }
  const fontFamily = value['fontFamily'];
  if (typeof fontFamily !== 'string' || !allowedFont.test(fontFamily.trim()))
    throw new Error('brand.fontFamily contains unsupported CSS characters');
  for (const key of ['logoPath', 'fontFile']) {
    if (value[key] !== undefined && typeof value[key] !== 'string')
      throw new Error(`brand.${key} must be a file path`);
  }
  return /** @type {ScaffoldConfig['brand']} */ (value);
}

/** @param {Record<string, unknown>} value @returns {ScaffoldConfig['starter']} */
function parseStarter(value) {
  validateKeys(value, [], 'starter', ['defaultLocale', 'language', 'ownerProfileName', 'policyTemplate']);
  if (
    value['policyTemplate'] !== undefined &&
    !['simple', 'reference-five'].includes(String(value['policyTemplate']))
  )
    throw new Error('starter.policyTemplate must be simple or reference-five');
  const locale = starterLocale(value);
  if (
    value['ownerProfileName'] !== undefined &&
    (typeof value['ownerProfileName'] !== 'string' || !value['ownerProfileName'].trim())
  )
    throw new Error('starter.ownerProfileName must be nonempty');
  return /** @type {ScaffoldConfig['starter']} */ ({
    ...value,
    ...(locale ? { defaultLocale: locale } : {}),
  });
}

/** @param {Record<string, unknown>} value */
function starterLocale(value) {
  const preferred =
    value['defaultLocale'] === undefined ? undefined : canonicalLocale(value['defaultLocale']);
  const legacy = value['language'] === undefined ? undefined : canonicalLocale(value['language']);
  if (preferred && legacy && preferred !== legacy)
    throw new Error('starter.defaultLocale conflicts with legacy language');
  return preferred ?? legacy;
}

/** @param {unknown} value @returns {ScaffoldConfig} */
function parseConfig(value) {
  const config = requireRecord(value, 'White-label config');
  validateKeys(config, ['brand', 'product', 'schemaVersion'], 'White-label config', ['starter']);
  if (config['schemaVersion'] !== 1) throw new Error('White-label config schemaVersion must be 1');
  return {
    schemaVersion: 1,
    product: parseProduct(requireRecord(config['product'], 'product')),
    brand: parseBrand(requireRecord(config['brand'], 'brand')),
    starter: parseStarter(config['starter'] === undefined ? {} : requireRecord(config['starter'], 'starter')),
  };
}

/** @param {string[]} argv */
function argumentsFor(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: 'string' }, 'output-dir': { type: 'string' } },
    strict: true,
  });
  if (!values.config) throw new Error('Use --config FILE with a versioned white-label JSON file');
  return { configPath: resolve(values.config), outputRoot: resolve(values['output-dir'] ?? process.cwd()) };
}

/** @param {string | undefined} relativePath @param {string} base @param {string} label @param {readonly string[]} extensions */
async function inputAsset(relativePath, base, label, extensions) {
  if (!relativePath) return undefined;
  if (isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split(/[\\/]/u).includes('..'))
    throw new Error(`${label} must stay within the config directory`);
  const path = resolve(base, relativePath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (!extensions.includes(extname(path).toLowerCase()))
    throw new Error(`${label} extension must be one of ${extensions.join(', ')}`);
  return path;
}

/** @param {string} path @param {unknown} value */
async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

/** @param {Policy} basePolicy @param {ScaffoldConfig['starter']} starter */
function generatedProfiles(basePolicy, starter) {
  return basePolicy.profiles.map((profile) => {
    const locale = starter.defaultLocale ?? profileLocale(profile);
    const generated = {
      ...profile,
      ...(profile.id === 'owner' && starter.ownerProfileName
        ? { name: starter.ownerProfileName.trim() }
        : {}),
      ...(locale ? { defaultLocale: locale } : {}),
    };
    delete generated.language;
    return generated;
  });
}

/** @param {ConfigWithPath} config @returns {Promise<Prepared>} */
async function prepare(config) {
  const template = config.starter.policyTemplate ?? 'simple';
  const source = await readFile(join(sourceRoot, 'policy-packs', template, 'policy.json'), 'utf8');
  const basePolicy = validatePolicy(parseDocument(source));
  const policyPath = `policy-packs/${config.product.id}/policy.json`;
  const logoPath = await inputAsset(config.brand.logoPath, dirname(config.configPath), 'brand.logoPath', [
    '.svg',
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
  ]);
  const fontPath = await inputAsset(config.brand.fontFile, dirname(config.configPath), 'brand.fontFile', [
    '.ttf',
    '.otf',
  ]);
  const logoExtension = logoPath ? extname(logoPath).toLowerCase() : undefined;
  const fontExtension = fontPath ? extname(fontPath).toLowerCase() : undefined;
  const logoAsset = logoExtension ? `guides/assets/brand-logo${logoExtension}` : undefined;
  const fontAsset = fontExtension ? `assets/fonts/brand-font${fontExtension}` : 'assets/fonts/DejaVuSans.ttf';
  const product = validateProduct({
    schemaVersion: 1,
    ...config.product,
    upstreamVersion: '0.1.0',
    engineApi: 1,
    assets: logoAsset ? { logo: logoAsset } : {},
    defaultPolicy: policyPath,
  });
  const policy = validatePolicy({
    ...basePolicy,
    id: config.product.id,
    version: '0.1.0',
    name: `${product.name} starter policy`,
    profiles: generatedProfiles(basePolicy, config.starter),
  });
  const project = validateProject({
    format: 'pxv-ts',
    schemaVersion: 1,
    id: `${config.product.id.slice(0, 55)}-starter`,
    productId: config.product.id,
    policyFile: 'policy.json',
    inventoryFile: 'inventory.json',
    extensions: [],
  });
  const brand = {
    schemaVersion: 1,
    brandName: product.name,
    colors: {
      primary: config.brand.primary.toUpperCase(),
      secondary: config.brand.secondary.toUpperCase(),
      accent: config.brand.accent.toUpperCase(),
    },
    fontFamily: config.brand.fontFamily.trim(),
    fontAsset,
    ...(logoExtension ? { logo: `assets/brand-logo${logoExtension}` } : {}),
  };
  return {
    product,
    policy,
    project,
    brand,
    policyPath,
    template,
    logoPath,
    logoExtension,
    fontPath,
    fontExtension,
    inventory: { schemaVersion: 1, devices: [] },
  };
}

/** @param {string} outputRoot @param {Prepared} prepared */
async function writeTemplates(outputRoot, prepared) {
  await saveJson(join(outputRoot, 'config/templates/project.json'), prepared.project);
  await saveJson(join(outputRoot, 'config/templates/pxv.project.json'), prepared.project);
  await saveJson(join(outputRoot, 'config/templates/inventory.json'), prepared.inventory);
  await saveJson(join(outputRoot, 'starter/pxv.project.json'), prepared.project);
  await saveJson(join(outputRoot, 'starter/policy.json'), prepared.policy);
  await saveJson(join(outputRoot, 'starter/inventory.json'), prepared.inventory);
  const starterReadme = `# ${prepared.product.name} project starter\n\nThis template has an empty device inventory and a reviewed-structure policy based on the ${prepared.template} template. It contains no phone identity, credentials, device data or prior approvals. Use pxv project init --path NEW_DIRECTORY --policy ${prepared.policyPath} to create each real project with a fresh project identity, then enroll its observed device.\n`;
  await mkdir(join(outputRoot, 'starter'), { recursive: true });
  await writeFile(join(outputRoot, 'starter/README.md'), starterReadme);
}

/** @param {string} outputRoot @param {Prepared} prepared */
async function copyBrandAssets(outputRoot, prepared) {
  if (prepared.logoPath && prepared.logoExtension) {
    const target = join(outputRoot, 'guides/assets/brand-logo' + prepared.logoExtension);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(prepared.logoPath, target);
  }
  if (prepared.fontPath && prepared.fontExtension) {
    const target = join(outputRoot, 'guides/assets/fonts/brand-font' + prepared.fontExtension);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(prepared.fontPath, target);
  } else {
    const source = join(sourceRoot, 'guides/assets/fonts/DejaVuSans.ttf');
    const target = join(outputRoot, 'guides/assets/fonts/DejaVuSans.ttf');
    if (resolve(source) !== resolve(target)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
}

/** @param {string} outputRoot @param {Prepared} prepared */
async function writeBrandArtifacts(outputRoot, prepared) {
  await saveJson(join(outputRoot, 'product.json'), prepared.product);
  await saveJson(join(outputRoot, 'guides/assets/brand.json'), prepared.brand);
  await saveJson(join(outputRoot, prepared.policyPath), prepared.policy);
  await writeTemplates(outputRoot, prepared);
  await copyBrandAssets(outputRoot, prepared);
}

/** @param {string[]} argv */
async function scaffold(argv) {
  const options = argumentsFor(argv);
  const config = parseConfig(JSON.parse(await readFile(options.configPath, 'utf8')));
  const prepared = await prepare({ ...config, configPath: options.configPath });
  await writeBrandArtifacts(options.outputRoot, prepared);
  process.stdout.write(
    `White-label starter generated for ${prepared.product.name} in ${options.outputRoot}\n`,
  );
  process.stdout.write(`Policy: ${join(options.outputRoot, prepared.policyPath)}\n`);
  process.stdout.write(`Project template: ${join(options.outputRoot, 'starter/pxv.project.json')}\n`);
}

const commandArguments = process.argv.slice(2);
scaffold(commandArguments[0] === '--' ? commandArguments.slice(1) : commandArguments).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'White-label scaffolding failed'}\n`);
  process.exitCode = 1;
});
