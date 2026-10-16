/** @typedef {import('./personal-workflows.mjs').Options} Options */
/** Normalize only documented compatibility aliases; recovery target mode stays explicit. @param {string} mode @param {Options} options */
export function normalizeOptions(mode, options) {
  alias(options, 'owner', 'operator');
  for (const key of ['asset', 'operator', 'endpoint'])
    if (typeof options[key] !== 'string' || !options[key]) throw new Error('--' + key + ' is required');
  if (!['en', 'pl'].includes(String(options['locale'] ?? 'en'))) throw new Error('--locale must be en or pl');
  if (mode === 'create') alias(options, 'master-dir', 'backup-dir');
  else alias(options, 'master-dir', 'master');
  alias(options, 'files-root', 'source-root');
  if (options['finalize'] && options['no-finalize']) throw new Error('Choose one finalization setting');
  if (mode === 'create') return creation(options);
  recovery(options);
}
/** @param {Options} options */
function recovery(options) {
  const target = options['mode'];
  if (target !== 'same-device' && target !== 'replacement')
    throw new Error('--mode must be same-device or replacement');
  options['same-device'] = target === 'same-device';
  options['finalize'] = !options['no-finalize'];
  if (options['backup-only']) throw new Error('--backup-only belongs to master creation');
}
/** @param {Options} options */
function creation(options) {
  if (options['mode']) throw new Error('--mode belongs to recovery');
  if (options['backup-only'] && options['finalize'])
    throw new Error('--backup-only never provisions or finalizes');
}
/** @param {Options} options @param {string} name @param {string} old */
function alias(options, name, old) {
  if (options[name] && options[old]) throw new Error('Use either --' + name + ' or --' + old);
  if (options[name]) options[old] = options[name];
}
