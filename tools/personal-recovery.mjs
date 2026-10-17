#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { terminal } from './lib/personal-cli.mjs';
import { normalizeOptions } from './lib/personal-options.mjs';
import { createPersonalMaster, option, preflight, recoverPersonalDevice } from './lib/personal-workflows.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const strings = [
  'project-root',
  'policy',
  'source-root',
  'files-root',
  'asset',
  'serial',
  'model',
  'operator',
  'owner',
  'usb-root',
  'backup-dir',
  'master',
  'master-dir',
  'mode',
  'locale',
  'codename',
  'endpoint',
  'pair-endpoint',
  'seedvault-adapter',
  'coverage-file',
];
const booleans = ['help', 'dry-run', 'backup-only', 'finalize', 'no-finalize'];
/** @param {string} mode */
function help(mode) {
  const create = mode === 'create';
  process.stdout.write(
    `Personal GrapheneOS ${create ? 'master backup' : 'recovery'}\n\n` +
      `Required: --project-root DIR --asset ID --operator NAME (or --owner NAME) --usb-root MOUNT --endpoint HOST:PORT\n` +
      `          --seedvault-adapter REVIEWED.json\n` +
      (create
        ? `New setup: --policy REVIEWED.json --serial SERIAL --model 'Pixel ...' --backup-dir NEW_DIR (or --master-dir NEW_DIR)\n` +
          `Existing phone: --backup-only --backup-dir NEW_DIR (retains enrollment; never flashes or provisions)\n` +
          `Both creation modes require --coverage-file PRIVATE.json (per-profile app/file inventory and exclusions).\n`
        : `Recovery: --master-dir DIR --mode same-device|replacement --serial SERIAL --model 'Pixel ...'\n` +
          `same-device retains the original project's identity/history/enrollment. Recovery finalizes by default; --no-finalize opts out.\n`) +
      `Optional: --pair-endpoint HOST:PORT --locale en|pl --codename CODE --dry-run --help\n` +
      (create
        ? `          --files-root DIR (local APK paths default to the policy's directory); --finalize (fresh setup only)\n`
        : '') +
      `\n--dry-run only reads/validates inputs and prints steps; it creates no files or PXV plans.\n` +
      `PXV_BIN selects one executable path. Run this command with the pinned Node executable.\n` +
      `Use a new master destination and a separate USB drive. Never enter recovery words or PINs in shell flags.\n`,
  );
}
/** @param {string[]} argv */
async function main(argv) {
  const mode = argv[0];
  if (mode !== 'create' && mode !== 'recover') throw new Error('Choose create or recover');
  const definitions = Object.fromEntries([
    ...strings.map((key) => [key, { type: 'string' }]),
    ...booleans.map((key) => [key, { type: 'boolean' }]),
  ]);
  const { values } = parseArgs({ args: argv.slice(1), options: definitions, strict: true });
  const options = /** @type {import('./lib/personal-workflows.mjs').Options} */ (values);
  if (options['help']) {
    help(mode);
    return;
  }
  normalizeOptions(mode, options);
  await preflight(options, root);
  await runSession(mode, options);
}
/** @param {string} mode @param {import('./lib/personal-workflows.mjs').Options} options */
async function runSession(mode, options) {
  const controller = new AbortController();
  const interrupted = () =>
    controller.abort(new Error('Operator interrupted; inspect retained PXV run state'));
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const input = options['dry-run'] ? undefined : terminal();
  const session = {
    root,
    bin: resolve(process.env['PXV_BIN'] ?? root + '/bin/pxv'),
    project: resolve(option(options, 'project-root')),
    asset: option(options, 'asset'),
    operator: option(options, 'operator'),
    locale: option(options, 'locale', 'en'),
    signal: controller.signal,
    prompt: input?.ask ?? (() => Promise.reject(new Error('Unexpected prompt in dry run'))),
  };
  try {
    await (mode === 'create' ? createPersonalMaster : recoverPersonalDevice)(session, options);
  } finally {
    input?.close();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}
try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Personal recovery failed') + '\n');
  process.exitCode = 2;
}
