import type { ProductDescriptor } from '@pxv/contracts';

export const stringFlags = [
  'project-root',
  'resource-root',
  'policy',
  'path',
  'asset',
  'serial',
  'model',
  'codename',
  'kind',
  'transport',
  'mode',
  'group',
  'plan',
  'run',
  'review-file',
  'operator',
  'check',
  'note',
  'locale',
  'recipient',
  'after',
  'cursor',
  'limit',
  'jobs',
  'file',
  'registry',
  'package',
  'version',
  'extension',
  'contribution',
  'command',
  'input-file',
  'license',
  'execution',
  'image',
  'docker-mode',
  'evidence',
  'output',
  'type',
  'endpoint',
  'pair-endpoint',
  'seedvault-adapter',
  'output-dir',
  'chromium',
  'passphrase-file',
  'new-passphrase-file',
  'record-revision',
] as const;
export const booleanFlags = [
  'help',
  'yes',
  'json',
  'all',
  'dry-run',
  'allow-mutations',
  'debugging-off',
  'erased',
  'inspected',
  'html-only',
  'no-render',
] as const;
type Flag = (typeof stringFlags)[number] | (typeof booleanFlags)[number];
interface CommandDefinition {
  name: string;
  description: string;
  flags: readonly Flag[];
  required: readonly Flag[];
  feature?: 'extensions' | 'seedvault';
  textual?: boolean;
  hidden?: boolean;
}
const common: readonly Flag[] = ['help', 'json', 'resource-root', 'project-root'];
const execution: readonly Flag[] = ['execution', 'image', 'docker-mode'];
const selection: readonly Flag[] = ['asset', 'all', 'group', 'transport'];
function command(
  name: string,
  description: string,
  flags: readonly Flag[] = [],
  required: readonly Flag[] = [],
  options: Partial<Pick<CommandDefinition, 'feature' | 'textual' | 'hidden'>> = {},
): CommandDefinition {
  return { name, description, flags: [...common, ...executionFlags(name), ...flags], required, ...options };
}
function executionFlags(name: string): readonly Flag[] {
  const section = name.split(' ')[0];
  if (['help', 'version', 'guides', 'host', 'internal-worker', 'mcp'].includes(section ?? '')) return [];
  return ['registry', 'seedvault'].includes(section ?? '') ? ['execution'] : execution;
}
const workflows = ['plan', 'guided', 'provision', 'create-users', 'deploy', 'install-os'];
const extensionRead = ['list', 'inspect', 'guide', 'remove'];
const commands: readonly CommandDefinition[] = [
  command('help', 'Show command help.', [], [], { textual: true }),
  command('version', 'Print the installed version.', [], [], { textual: true }),
  command('project init', 'Create a new isolated project.', ['path', 'policy'], ['path']),
  command('policy validate', 'Validate the authored policy and lock.'),
  command('policy lock', 'Record the current policy and extension lock.', ['yes']),
  command('inventory list', 'List enrolled targets.'),
  command('inventory import', 'Import explicitly reviewed enrollment.', ['file', 'yes'], ['file']),
  command(
    'inventory enroll',
    'Verify and enroll one phone.',
    ['asset', 'serial', 'model', 'codename', 'kind', 'transport', 'mode', 'group', 'yes'],
    ['asset', 'serial', 'model', 'codename'],
  ),
  ...['device', 'fleet'].flatMap((section) => [
    ...['inspect', 'report'].map((name) =>
      command(
        `${section} ${name}`,
        name === 'inspect' ? 'Observe live device state.' : 'Read stored readiness evidence.',
        selection,
      ),
    ),
    ...workflows.map((name) =>
      command(
        `${section} ${name}`,
        'Prepare reviewed work; execute only after approval.',
        workflowFlags(name),
      ),
    ),
    command(
      `${section} attest`,
      'Record a check actually performed by the named operator.',
      [...selection, 'check', 'operator', 'note', 'evidence', 'yes'],
      ['asset', 'check', 'operator'],
    ),
    command(
      `${section} finalize`,
      'Verify readiness and disable debugging.',
      [...selection, 'operator', 'locale', 'yes'],
      ['asset', 'operator'],
    ),
    command(
      `${section} recover`,
      'Inspect retained obligations before acknowledging cleanup.',
      [...selection, 'run', 'inspected', 'yes'],
      ['asset'],
    ),
  ]),
  command('agent runs', 'List run history; follow nextCursor for additional pages.', ['cursor', 'limit']),
  command('agent status', 'Read stored run evidence, checkpoints and next steps.', ['run', 'after'], ['run']),
  command('agent cancel', 'Request cancellation of an exact run.', ['run'], ['run']),
  command('agent resume', 'Continue reviewed work after its manual checkpoint.', ['run', 'yes'], ['run']),
  command('agent refresh', 'Prepare a new review of remaining work.', ['run'], ['run']),
  command(
    'agent execute',
    'Submit the exact saved review and launch its worker.',
    ['plan', 'review-file', 'operator'],
    ['plan', 'review-file', 'operator'],
  ),
  command('internal-worker', 'Execute a previously submitted run.', ['run'], ['run'], { hidden: true }),
  command('host doctor', 'Inspect host prerequisites.'),
  ...['adb-start', 'docker-prepare', 'docker-adb-stop'].map((name) =>
    command(`host ${name}`, 'Perform the explicitly requested host preparation.', ['yes']),
  ),
  command('host docker-adb-start', 'Start the reviewed Docker ADB service.', ['image', 'yes'], ['image']),
  command(
    'host bootstrap',
    'Install a checksum-approved tool archive.',
    ['file', 'license', 'path', 'yes'],
    ['file', 'license', 'path'],
  ),
  command('host build-helper', 'Build and sign a local Android helper.', ['type', 'yes'], ['type']),
  command('mcp serve', 'Serve MCP over protocol-only stdout.', ['allow-mutations']),
  ...['operator', 'recipient', 'project'].map((name) =>
    command(
      `guide ${name}`,
      'Print the selected public guide.',
      name === 'project' ? ['locale', 'kind'] : ['locale'],
      [],
      { textual: true },
    ),
  ),
  command('guides rebuild', 'Rebuild guide artifacts from a source checkout.', [
    'policy',
    'output-dir',
    'chromium',
    'html-only',
    'no-render',
  ]),
  ...['maintenance', 'policy-change', 'loss', 'retirement'].map((name) =>
    command(
      `lifecycle ${name}`,
      'Record lifecycle evidence and invalidate prior handoff.',
      ['asset', 'operator', 'note', 'erased', 'yes'],
      ['asset', 'operator', 'note'],
    ),
  ),
  command(
    'handoff accept',
    'Confirm debugging is off and transfer recipient custody.',
    ['asset', 'recipient', 'debugging-off', 'yes'],
    ['asset', 'recipient', 'debugging-off'],
  ),
  command(
    'handoff export',
    'Export an accepted handoff packet.',
    ['asset', 'output', 'locale'],
    ['asset', 'output'],
  ),
  ...['init', 'list', 'show', 'history', 'update', 'reveal', 'rekey', 'reconcile'].map((name) =>
    registryCommand(name),
  ),
  ...['install', 'update', 'list', 'inspect', 'remove', 'invoke', 'policy', 'guide', 'adapter'].map((name) =>
    extensionCommand(name),
  ),
  ...['inspect', 'backup', 'restore', 'report', 'connections', 'connect', 'disconnect'].map((name) =>
    seedvaultCommand(name),
  ),
];
function workflowFlags(name: string): readonly Flag[] {
  if (name === 'plan') return [...selection, 'dry-run'];
  return [
    ...selection,
    'operator',
    'jobs',
    'dry-run',
    'yes',
    ...(name === 'guided' ? ['locale' as const] : []),
  ];
}
function registryCommand(name: string): CommandDefinition {
  const flags: Record<string, readonly Flag[]> = {
    init: [],
    list: [],
    show: ['asset'],
    history: ['asset'],
    update: ['asset', 'file', 'record-revision', 'yes'],
    reveal: ['asset', 'output', 'record-revision'],
    rekey: ['new-passphrase-file'],
    reconcile: ['yes'],
  };
  const required: Record<string, Flag[]> = {
    show: ['asset'],
    history: ['asset'],
    update: ['asset', 'file', 'record-revision'],
    reveal: ['asset', 'output'],
  };
  return command(
    `registry ${name}`,
    'Access the encrypted local phone registry.',
    ['passphrase-file', ...(flags[name] ?? [])],
    required[name],
  );
}
function extensionCommand(name: string): CommandDefinition {
  const flags: Record<string, readonly Flag[]> = {
    install: ['file', 'package', 'version', 'registry', 'yes'],
    update: ['extension', 'file', 'package', 'version', 'registry', 'yes'],
    list: [],
    inspect: ['extension'],
    remove: ['extension', 'yes'],
    invoke: ['asset', 'transport', 'extension', 'command', 'input-file'],
    adapter: ['asset', 'transport', 'extension', 'contribution', 'input-file'],
    guide: ['extension', 'contribution'],
    policy: ['extension', 'contribution', 'yes'],
  };
  const required: Flag[] = ['install', 'list'].includes(name) ? [] : ['extension'];
  if (['policy', 'guide', 'adapter'].includes(name)) required.push('contribution');
  if (name === 'invoke') required.push('command');
  if (['invoke', 'adapter'].includes(name)) required.push('asset');
  return command(`extension ${name}`, 'Manage explicitly trusted extensions.', flags[name], required, {
    ...(!extensionRead.includes(name) ? { feature: 'extensions' } : {}),
    textual: name === 'guide',
  });
}
function seedvaultCommand(name: string): CommandDefinition {
  const target: readonly Flag[] = ['asset', 'transport'];
  const flags: Record<string, readonly Flag[]> = {
    inspect: target,
    connections: target,
    report: ['run'],
    backup: [...target, 'file', 'seedvault-adapter', 'operator', 'dry-run', 'yes'],
    restore: [...target, 'file', 'seedvault-adapter', 'operator', 'dry-run', 'yes'],
    connect: [...target, 'serial', 'endpoint', 'pair-endpoint', 'dry-run', 'yes'],
    disconnect: [...target, 'serial', 'endpoint', 'run', 'inspected', 'dry-run', 'yes'],
  };
  const required: Flag[] =
    name === 'report'
      ? ['run']
      : ['connect', 'disconnect'].includes(name)
        ? ['asset', 'endpoint']
        : ['asset'];
  return command(
    `seedvault ${name}`,
    'Inspect or perform a reviewed personal recovery operation.',
    flags[name],
    required,
    !['report', 'connections', 'disconnect'].includes(name) ? { feature: 'seedvault' } : {},
  );
}
function findCommand(positionals: string[]): CommandDefinition | undefined {
  return commands.find((item) => item.name === positionals.join(' '));
}
export function validateCommand(
  positionals: string[],
  values: Record<string, unknown>,
): CommandDefinition | undefined {
  if (!positionals.length) {
    if (Object.keys(values).some((name) => !common.includes(name as Flag)))
      throw new Error('Choose a command; use --help');
    return undefined;
  }
  const definition = findCommand(positionals);
  if (!definition) throw unknownCommand(positionals);
  const unsupported = Object.keys(values).find((name) => !definition.flags.includes(name as Flag));
  if (unsupported) throw new Error(`--${unsupported} is not supported for ${definition.name}`);
  if (values['help']) return definition;
  validateExecutionFlags(definition, values);
  validateExactSelection(definition, values);
  validateConditionalInput(definition, values);
  for (const name of definition.required)
    if (values[name] === undefined || values[name] === '') throw new Error(`--${name} is required`);
  return definition;
}
function validateExecutionFlags(definition: CommandDefinition, values: Record<string, unknown>): void {
  if (values['execution'] === 'docker') {
    if (!definition.flags.includes('image'))
      throw new Error(`${definition.name} requires local host execution`);
    if (!values['image']) throw new Error('--image is required for Docker execution');
    return;
  }
  if (values['docker-mode'] !== undefined) throw new Error('--docker-mode requires --execution docker');
  if (values['image'] !== undefined && definition.name !== 'host docker-adb-start')
    throw new Error('--image requires --execution docker');
}
function validateConditionalInput(definition: CommandDefinition, values: Record<string, unknown>): void {
  if (values['evidence'] !== undefined && values['check'] !== 'emulator_image_provenance')
    throw new Error('--evidence is supported only for --check emulator_image_provenance');
  if (/^extension (?:install|update)$/u.test(definition.name) && !values['file']) {
    for (const name of ['package', 'version'])
      if (!values[name]) throw new Error(`--${name} is required without --file`);
  }
  if (
    definition.name.endsWith(' attest') &&
    values['check'] === 'emulator_image_provenance' &&
    !values['evidence']
  )
    throw new Error('--evidence is required for emulator_image_provenance');
}
function unknownCommand(positionals: string[]): Error {
  if (positionals.length > 2) return new Error('Unexpected positional arguments; use --help');
  const section = positionals[0];
  if (section === 'device' || section === 'fleet') return new Error('Unknown device workflow; use --help');
  if (section === 'guide') return new Error('Choose guide operator, recipient or project');
  if (section === 'guides') return new Error('Choose guides rebuild');
  if (section && commands.some((item) => item.name.startsWith(`${section} `)))
    return new Error(`Unknown ${section} command; use --help`);
  return new Error('Unknown command; use --help');
}
function validateExactSelection(definition: CommandDefinition, values: Record<string, unknown>): void {
  if (!/^(?:device|fleet) (?:attest|finalize|recover)$/u.test(definition.name)) return;
  if (values['all'] || values['group'] !== undefined)
    throw new Error('Attestation, finalization and recovery require one exact --asset');
  if (definition.name.endsWith(' recover') && values['inspected'] && !values['run'])
    throw new Error('--run is required with --inspected');
}
export function assertCommandFeature(positionals: string[], product: ProductDescriptor): void {
  const feature = findCommand(positionals)?.feature;
  if (!feature || product.features?.[feature] !== false) return;
  const messages = {
    extensions: 'Extensions are outside this core product; use an extension-enabled product',
    seedvault: 'Seedvault is an optional experimental recovery module; use a recovery-enabled product',
  };
  throw new Error(messages[feature]);
}
export function commandHelp(product: ProductDescriptor, version: string, positionals: string[]): string {
  const definition = findCommand(positionals);
  const header = `${product.command} ${version} — ${product.name}`;
  if (definition && definition.name !== 'help')
    return `${header}\n\n${product.command} ${definition.name}\n${definition.description}\n\n${definition.flags.map((name) => `  --${name}${stringFlags.includes(name as (typeof stringFlags)[number]) ? ' VALUE' : ''}${definition.required.includes(name) ? ' (required)' : ''}`).join('\n')}`;
  const listing = commands.filter(
    (item) => !item.hidden && (!item.feature || product.features?.[item.feature] !== false),
  );
  return `${header}\n\n${listing.map((item) => `${item.name} — ${item.description}`).join('\n')}\n\nUse COMMAND --help for supported flags. Human-readable output is the default; use --json for automation.\nDevice mutations require an enrolled target and explicit review. Physical confirmations remain on the phone.`;
}
export function textualCommand(positionals: string[], values: Record<string, unknown>): boolean {
  return !positionals.length || values['help'] === true || findCommand(positionals)?.textual === true;
}
