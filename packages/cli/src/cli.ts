import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDocument,
  resolveSelection,
  validateInventory,
  validatePolicy,
  validateProject,
  type ProductDescriptor,
  type SelectedTarget,
  type TargetSelector,
  type Transport,
} from '@pxv/contracts';
import { configuredAdbServer, startLocalAdbServer, HostTools, type EmulatorImagePin } from '@pxv/adapters';
import {
  atomicWritePrivate,
  hostControlRoot,
  readBounded,
  recoveryReservations,
  SqliteStore,
} from '@pxv/runtime';
import {
  createProject,
  containedPath,
  loadProject,
  recordLifecycle,
  saveInventory,
  writePolicyLock,
  type Operation,
  type RunRecord,
} from '@pxv/engine';
import { ExtensionManager, type ExtensionSource } from '@pxv/extensions';
import { serveStdio } from '@pxv/mcp';
import { application, productAt, resourceRoot } from './context.js';
import { agentBackend, liveAgentBackend } from './backend.js';
import { renderProjectGuide, guidedNextSteps } from './guided.js';
import { bootstrapTool, inspectHost } from './host.js';
import { runInDocker, prepareDockerEnvironment, startDockerAdb, stopDockerAdb } from './docker.js';
import { writeHandoff } from '@pxv/guides';

export interface CliIo {
  out(value: string): void;
  error(value: string): void;
  confirm?(message: string): Promise<boolean>;
}
const defaultIo: CliIo = {
  out: (value) => stdout.write(`${value}\n`),
  error: (value) => process.stderr.write(`${value}\n`),
};
const stringFlags = [
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
] as const;
const booleanFlags = [
  'help',
  'yes',
  'json',
  'all',
  'dry-run',
  'allow-mutations',
  'debugging-off',
  'erased',
  'inspected',
] as const;
const options: Record<string, { type: 'string' | 'boolean' }> = {};
for (const name of stringFlags) options[name] = { type: 'string' };
for (const name of booleanFlags) options[name] = { type: 'boolean' };

function help(product: ProductDescriptor, version: string): string {
  return (
    `${product.command} ${version} — ${product.name}\n\n` +
    `project init --path NEW_DIRECTORY [--policy FILE]\npolicy validate | policy lock\ninventory list | inventory enroll --asset ID --serial SERIAL --model MODEL --codename CODE --yes\n` +
    `host doctor | host adb-start | host bootstrap --file APPROVED_ARCHIVE.json --license ID --path NEW_DIRECTORY\nhost build-helper --type probe|setup|e2e\nhost docker-prepare | docker-adb-start --image IMAGE | docker-adb-stop\n` +
    `device inspect | plan | guided | provision | create-users | deploy | install-os | report | attest | finalize | recover\n` +
    `  --project-root DIRECTORY --asset ID [--transport usb|wifi|emulator] [--dry-run] [--yes]\n` +
    `fleet provision --all|--group GROUP [--jobs 2] [--yes]\nagent runs | status --run ID [--after CURSOR] | cancel --run ID | resume --run ID --yes | refresh --run ID | execute --plan ID --review-file FILE --operator NAME\n` +
    `mcp serve [--allow-mutations]\nextension install|update --package NAME --version EXACT --registry HTTPS\nextension install --file PACKAGE.tgz | list | inspect | remove | invoke\nextension policy|guide|adapter --extension ID --contribution PATH\n` +
    `lifecycle maintenance|policy-change|loss|retirement --asset ID --operator NAME --note TEXT [--erased]\n` +
    `handoff accept --asset ID --recipient NAME --debugging-off --yes\nhandoff export --asset ID --output DIRECTORY [--locale en|pl]\nguide operator|recipient|project [--locale en|pl]\n` +
    `Use --execution docker --image EXPLICIT_IMAGE --docker-mode direct|host-adb for container execution.\n` +
    `All mutations require an enrolled target and explicit review. Physical confirmations remain on the phone.`
  );
}

async function confirmation(io: CliIo, message: string, approved: boolean): Promise<void> {
  if (approved) return;
  if (io.confirm) {
    if (await io.confirm(message)) return;
    throw new Error('Cancelled');
  }
  if (!stdin.isTTY) throw new Error('Review the plan and use --yes in non-interactive execution');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    if ((await prompt.question(`${message} [y/N] `)).trim().toLowerCase() !== 'y')
      throw new Error('Cancelled');
  } finally {
    prompt.close();
  }
}

async function workerLauncher(): Promise<string> {
  const installed = fileURLToPath(new URL('./main.js', import.meta.url));
  return access(installed).then(
    () => installed,
    () => fileURLToPath(new URL('../dist/main.js', import.meta.url)),
  );
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  const values: Record<string, unknown> = parsed.values;
  const positionals = parsed.positionals;
  const value = (name: (typeof stringFlags)[number], fallback?: string): string => {
    const found = values[name];
    if (typeof found === 'string') return found;
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  };
  const flag = (name: (typeof booleanFlags)[number]): boolean => values[name] === true;
  const output = (result: unknown): void => io.out(JSON.stringify(result, null, 2));
  const [section, command] = positionals;
  const resources = await resourceRoot(
    typeof values['resource-root'] === 'string' ? values['resource-root'] : undefined,
  );
  const product = await productAt(resources);
  const buildMetadata: { version?: unknown; command?: unknown } = await readFile(
    join(resources, 'candidate.json'),
    'utf8',
  ).then(
    (text) => JSON.parse(text) as { version?: unknown; command?: unknown },
    () => ({}),
  );
  const version = typeof buildMetadata.version === 'string' ? buildMetadata.version : product.upstreamVersion;
  if (!section || flag('help') || section === 'help') {
    io.out(
      help(
        typeof buildMetadata.command === 'string' ? { ...product, command: buildMetadata.command } : product,
        version,
      ),
    );
    return 0;
  }
  if (section === 'version') {
    io.out(version);
    return 0;
  }
  const projectRoot = resolve(value('project-root', process.env['PXV_ROOT'] ?? process.cwd()));
  const extensionRoot =
    process.env['PXV_EXTENSION_ROOT'] ??
    join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local/share'), 'pxv/extensions');
  const execution = value('execution', 'host');
  const dockerMode = process.env['PXV_DOCKER_MODE'];
  if (dockerMode !== undefined && dockerMode !== 'direct' && dockerMode !== 'host-adb')
    throw new Error('Invalid Docker worker mode');
  if (execution !== 'host' && execution !== 'docker') throw new Error('Execution must be host or docker');
  if (execution === 'docker') {
    const mode = value('docker-mode', 'host-adb');
    if (mode !== 'direct' && mode !== 'host-adb') throw new Error('Invalid Docker transport mode');
    return runInDocker(argv, projectRoot, value('image'), mode, extensionRoot);
  }
  if (dockerMode === 'host-adb' && section === 'device' && command === 'install-os')
    throw new Error('Fastboot requires direct USB mode');
  if (section === 'guide' && command !== 'project') {
    if (command !== 'operator' && command !== 'recipient')
      throw new Error('Choose the operator or recipient guide');
    const locale = value('locale', 'en');
    if (!['en', 'pl'].includes(locale)) throw new Error('Guide locale must be en or pl');
    io.out(
      await readFile(
        join(
          resources,
          'guides/source/markdown',
          `${command === 'recipient' ? 'user' : command}-${locale}.md`,
        ),
        'utf8',
      ),
    );
    return 0;
  }
  if (section === 'host') {
    if (command === 'doctor') {
      const report = await inspectHost();
      output(report);
      return report.supported && report.supervisor && report.tools.every((tool) => tool.compatible) ? 0 : 4;
    }
    if (command === 'docker-prepare') {
      await confirmation(io, 'Prepare private Docker control, key and extension directories?', flag('yes'));
      output(await prepareDockerEnvironment(extensionRoot));
      return 0;
    }
    if (command === 'docker-adb-start') {
      await confirmation(
        io,
        'Start the reviewed image as an independent direct-USB ADB service?',
        flag('yes'),
      );
      output(await startDockerAdb(value('image'), extensionRoot));
      return 0;
    }
    if (command === 'docker-adb-stop') {
      await confirmation(io, 'Stop this operator’s Docker ADB service?', flag('yes'));
      output(await stopDockerAdb(extensionRoot));
      return 0;
    }
    const { CommandRunner } = await import('@pxv/runtime');
    const runner = new CommandRunner();
    if (command === 'adb-start') {
      await confirmation(io, 'Start the configured local ADB server?', flag('yes'));
      if (process.env['HOME'])
        await mkdir(join(process.env['HOME'], '.android'), { recursive: true, mode: 0o700 });
      await startLocalAdbServer(
        runner,
        await new HostTools({ runner }).require('adb'),
        configuredAdbServer(),
      );
      output({ started: true });
      return 0;
    }
    if (command === 'bootstrap') {
      await confirmation(
        io,
        'Install this checksum-approved official tool archive under its reviewed license?',
        flag('yes'),
      );
      output({
        installed: await bootstrapTool(value('file'), value('license'), resolve(value('path')), runner),
      });
      return 0;
    }
    if (command === 'build-helper') {
      const component = value('type');
      if (!['probe', 'setup', 'e2e'].includes(component)) throw new Error('Choose probe, setup or e2e');
      await confirmation(io, 'Build and sign this local Android helper?', flag('yes'));
      const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
      for (const name of ['HOME', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT'])
        if (process.env[name]) env[name] = process.env[name];
      const built = await runner.run(
        [
          process.execPath,
          join(resources, 'tools/build-android.mjs'),
          '--component',
          component,
          '--project-root',
          projectRoot,
          '--resource-root',
          resources,
        ],
        { env, timeoutMs: 120_000 },
      );
      io.out(built.stdout.trim());
      return 0;
    }
    throw new Error('Unknown host command');
  }
  if (section === 'project' && command === 'init') {
    const policyPath =
      typeof values['policy'] === 'string'
        ? resolve(values['policy'])
        : join(resources, product.defaultPolicy);
    const policy = validatePolicy(parseDocument(await readFile(policyPath, 'utf8')));
    const project = await createProject(resolve(value('path')), product, policy, resources);
    const store = await SqliteStore.open(join(project.root, 'state/pxv.sqlite3'));
    await store.close();
    await writePolicyLock(project);
    output({ root: project.root, projectId: project.config.id, policy: project.policy.id });
    return 0;
  }
  const project = await loadProject(projectRoot, product, resources);
  if (section === 'guide' && command === 'project') {
    const locale = value('locale', 'en');
    const kind = value('kind', 'pixel');
    if (locale !== 'en' && locale !== 'pl') throw new Error('Guide locale must be en or pl');
    if (kind !== 'pixel' && kind !== 'emulator') throw new Error('Guide kind must be pixel or emulator');
    io.out(renderProjectGuide(product, project.policy, kind, locale));
    return 0;
  }
  if (section === 'policy') {
    if (command === 'lock') {
      await confirmation(io, 'Record the current policy and extension lock?', flag('yes'));
      await writePolicyLock(project);
    } else if (command !== 'validate') throw new Error('Unknown policy command');
    output({ valid: true, policyDigest: project.resolved.digest });
    return 0;
  }
  if (section === 'inventory') {
    if (command === 'list') {
      output(project.inventory);
      return 0;
    }
    if (command === 'enroll') {
      const kind = value('kind', 'pixel');
      if (kind !== 'pixel' && kind !== 'emulator') throw new Error('Device kind must be pixel or emulator');
      const transport = value('transport', kind === 'emulator' ? 'emulator' : 'usb');
      if (transport !== 'usb' && transport !== 'emulator')
        throw new Error('First enrollment requires USB or a dedicated emulator');
      const inventory = validateInventory({
        schemaVersion: 1,
        devices: [
          ...project.inventory.devices,
          {
            assetId: value('asset'),
            kind,
            canonicalSerial: value('serial'),
            model: value('model'),
            codename: value('codename'),
            groups: values['group'] ? [value('group')] : [],
            transports: [{ kind: transport, serial: value('serial') }],
          },
        ],
      });
      await confirmation(
        io,
        'Confirm the physical asset label and observed serial/model match this enrollment?',
        flag('yes'),
      );
      const selected = resolveSelection(inventory, { kind: 'asset', assetId: value('asset') })[0];
      if (!selected) throw new Error('Enrollment target missing');
      const { CommandRunner } = await import('@pxv/runtime');
      const { AndroidAdapter } = await import('@pxv/adapters');
      const runner = new CommandRunner();
      const tools = new HostTools({ runner });
      const mode = value('mode', 'adb');
      if (mode === 'fastboot') {
        if (kind !== 'pixel' || transport !== 'usb')
          throw new Error('Fastboot enrollment requires a USB Pixel');
        const tool = await tools.require('fastboot');
        const discovered = await runner.run([tool, 'devices']);
        if (
          discovered.stdout
            .split('\n')
            .filter((line) => line.trim().split(/\s+/u)[0] === value('serial') && line.includes('fastboot'))
            .length !== 1
        )
          throw new Error('Exact fastboot serial is unavailable or ambiguous');
        const observed = await runner.run([tool, '-s', value('serial'), 'getvar', 'product']);
        const combined = `${observed.stdout}\n${observed.stderr}`;
        const codename = /(?:^|\n)(?:\(bootloader\)\s*)?product:\s*([a-z0-9_]+)/u.exec(combined)?.[1];
        if (codename !== value('codename')) throw new Error('Fastboot product differs from enrollment');
      } else if (mode === 'adb')
        await new AndroidAdapter({ runner, adb: (await tools.discover('adb')) ?? 'adb' }).guardTarget(
          selected,
        );
      else throw new Error('Enrollment mode must be adb or fastboot');
      await saveInventory(project, inventory);
      output({ enrolled: value('asset') });
      return 0;
    }
    if (command === 'import') {
      await confirmation(io, 'Import reviewed enrollment data?', flag('yes'));
      await saveInventory(project, validateInventory(parseDocument(await readFile(value('file'), 'utf8'))));
      output({ imported: true });
      return 0;
    }
    throw new Error('Unknown inventory command');
  }
  const selector: TargetSelector = flag('all')
    ? { kind: 'fleet' }
    : values['group']
      ? { kind: 'group', group: value('group') }
      : { kind: 'asset', assetId: value('asset', '') };
  if (flag('all') && (values['asset'] || values['group']))
    throw new Error('Choose one exact asset, group or explicit fleet selector');
  const transport = typeof values['transport'] === 'string' ? value('transport') : undefined;
  if (transport && !['usb', 'wifi', 'emulator'].includes(transport)) throw new Error('Invalid transport');
  const targets = (): SelectedTarget[] =>
    resolveSelection(project.inventory, selector, transport as Transport['kind'] | undefined);
  if (section === 'extension') {
    const manager = new ExtensionManager({
      installRoot: extensionRoot,
      ...(values['registry'] ? { registry: value('registry') } : {}),
      ...(process.env['PXV_REGISTRY_TOKEN'] ? { token: process.env['PXV_REGISTRY_TOKEN'] } : {}),
    });
    if (command === 'list') {
      output(await manager.list());
      return 0;
    }
    const lock = project.config.extensions.find((item) => item.id === value('extension', ''));
    if (command === 'install' || command === 'update') {
      const source: ExtensionSource = values['file']
        ? { tarball: resolve(value('file')) }
        : { package: value('package'), version: value('version') };
      await confirmation(
        io,
        'Install this trusted extension and invalidate existing policy approvals?',
        flag('yes'),
      );
      if (command === 'update' && !lock) throw new Error('Select an installed extension to update');
      const installed =
        command === 'update' && lock ? await manager.update(lock, source) : await manager.install(source);
      const config = validateProject({
        ...project.config,
        extensions: [...project.config.extensions.filter((item) => item.id !== installed.id), installed],
      });
      await atomicWritePrivate(join(projectRoot, 'pxv.project.json'), JSON.stringify(config, null, 2));
      output(installed);
      return 0;
    }
    if (!lock) throw new Error('Extension is not pinned in this project');
    if (command === 'guide') {
      io.out(await manager.readContribution(lock, 'guides', value('contribution')));
      return 0;
    }
    if (command === 'policy') {
      const policy = await manager.readContribution(lock, 'policyPacks', value('contribution'));
      await confirmation(
        io,
        'Select this extension policy and invalidate existing policy approvals?',
        flag('yes'),
      );
      await atomicWritePrivate(
        await containedPath(project.root, project.config.policyFile),
        JSON.stringify(policy, null, 2),
      );
      output({ selectedPolicy: policy.id, extension: lock.id, policyLockRequired: true });
      return 0;
    }
    if (command === 'inspect') {
      output(await manager.inspect(lock));
      return 0;
    }
    if (command === 'remove') {
      await confirmation(io, 'Remove this extension from the project lock?', flag('yes'));
      await atomicWritePrivate(
        join(projectRoot, 'pxv.project.json'),
        JSON.stringify(
          { ...project.config, extensions: project.config.extensions.filter((item) => item.id !== lock.id) },
          null,
          2,
        ),
      );
      output({ removedFromProject: lock.id, retainedInSharedStore: true });
      return 0;
    }
    if (command === 'invoke' || command === 'adapter') {
      const input: unknown = values['input-file']
        ? parseDocument(await readFile(value('input-file'), 'utf8'))
        : {};
      const actions =
        command === 'adapter'
          ? await manager.invokeAdapter(lock, value('contribution'), input)
          : await manager.invoke(lock, value('command'), input);
      const app = await application(projectRoot, resources);
      try {
        const target = targets()[0];
        if (!target) throw new Error('Select an asset');
        const prepared = await app.engine.prepareExtension(target, actions);
        output({
          planId: prepared.plan.id,
          reviewSummary: prepared.reviewSummary,
          expiresAt: prepared.expiresAt,
        });
      } finally {
        await app.store.close();
      }
      return 0;
    }
    throw new Error('Unknown extension command');
  }
  if (section === 'mcp' && command === 'serve') {
    const server = await serveStdio(
      liveAgentBackend(projectRoot, resources, await workerLauncher(), flag('allow-mutations')),
      flag('allow-mutations'),
      { identity: { name: product.command, version } },
    );
    await new Promise<void>((resolveClose, rejectClose) => {
      const close = (): void => {
        stdin.removeListener('end', close);
        process.removeListener('SIGINT', close);
        process.removeListener('SIGTERM', close);
        void server.close().then(resolveClose, rejectClose);
      };
      stdin.once('end', close);
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
    });
    return 0;
  }
  const readOnly =
    (section === 'agent' && ['runs', 'status'].includes(command ?? '')) ||
    (section === 'device' && ['report', 'inspect'].includes(command ?? '')) ||
    (section === 'handoff' && command === 'export');
  const app = await application(projectRoot, resources, readOnly);
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error('Operator interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const launcher = await workerLauncher();
    if (section === 'internal-worker') {
      const runId = value('run');
      process.send?.({ type: 'ready', runId });
      if (process.connected) process.disconnect();
      try {
        const run = await app.engine.execute(runId, controller.signal);
        await app.store.delete('worker-launch', runId);
        return run.status === 'completed' ? 0 : run.status === 'pending' ? 4 : 3;
      } catch (error) {
        const prior = await app.store.get<RunRecord>('runs', runId);
        if (prior)
          await app.store.set('runs', runId, {
            ...prior,
            status: 'needs-inspection',
            error: 'Worker stopped; inspect retained evidence before another review',
          });
        throw error;
      }
    }
    if (section === 'agent') {
      if (command === 'refresh') {
        const prepared = await app.engine.refreshReview(value('run'), controller.signal);
        output({
          planId: prepared.plan.id,
          reviewSummary: prepared.reviewSummary,
          expiresAt: prepared.expiresAt,
        });
        return 0;
      }
      if (command === 'runs') {
        output(await app.store.entries<RunRecord>('runs'));
        return 0;
      }
      if (command === 'status') {
        const cursor = Number(value('after', '0'));
        output({
          run: await app.store.get('runs', value('run')),
          events: await app.store.events(value('run'), cursor, 100),
        });
        return 0;
      }
      if (command === 'cancel') {
        await app.engine.cancel(value('run'));
        output({ cancellationRequested: true });
        return 0;
      }
      if (command === 'resume') {
        await confirmation(
          io,
          'Resume the approved run after completing its explicit manual checkpoint?',
          flag('yes'),
        );
        output(await app.engine.execute(value('run'), controller.signal));
        return 0;
      }
      if (command === 'execute') {
        const summary = (await readBounded(value('review-file'), 8 * 1024 * 1024)).toString('utf8');
        if (dockerMode) {
          // An ephemeral Docker worker must own its run until completion or a
          // durable manual pause; detaching would orphan it when PID 1 exits.
          const submitted = await app.engine.submit(value('plan'), summary, value('operator'));
          const run = await app.engine.execute(submitted.id, controller.signal);
          output(run);
          return run.status === 'completed'
            ? 0
            : run.status === 'pending'
              ? 4
              : run.status === 'cancelled'
                ? 130
                : 3;
        }
        const run = await agentBackend(app.engine, resources, launcher, true).executePlan(
          value('plan'),
          summary,
          value('operator'),
        );
        output(run);
        return 0;
      }
      throw new Error('Unknown agent command');
    }
    if (section === 'lifecycle') {
      if (!['maintenance', 'policy-change', 'loss', 'retirement'].includes(command ?? ''))
        throw new Error('Unknown lifecycle operation');
      await confirmation(io, `Record ${command} and invalidate previous handoff evidence?`, flag('yes'));
      output(
        await recordLifecycle(project, app.store, {
          assetId: value('asset'),
          type: command as 'maintenance' | 'policy-change' | 'loss' | 'retirement',
          operator: value('operator'),
          note: value('note'),
          confirmedErasure: flag('erased'),
        }),
      );
      return 0;
    }
    if (section === 'handoff' && command === 'export') {
      const { record, snapshot } = await app.engine.acceptedHandoff(value('asset'));
      const locale = value('locale', record.locale);
      if (locale !== 'en' && locale !== 'pl') throw new Error('Invalid locale');
      output(
        await writeHandoff(
          {
            product: snapshot.resolvedPolicy.product,
            policy: snapshot.resolvedPolicy.policy,
            resolvedPolicy: snapshot.resolvedPolicy,
            record,
            assetId: snapshot.assetId,
          },
          resolve(value('output')),
          { locale },
        ),
      );
      return 0;
    }
    if (section === 'handoff' && command === 'accept') {
      await confirmation(
        io,
        'Confirm both debugging toggles are physically off and transfer recipient custody?',
        flag('yes'),
      );
      output(await app.engine.acceptCustody(value('asset'), value('recipient'), flag('debugging-off')));
      return 0;
    }
    if (section !== 'device' && section !== 'fleet') throw new Error('Unknown command; use --help');
    const selected = targets();
    if (section === 'device' && selected.length !== 1)
      throw new Error('Device commands require exactly one asset');
    const target = selected[0];
    if (!target) throw new Error('No enrolled targets');
    if (command === 'inspect') {
      output(await app.engine.observe(target));
      return 0;
    }
    if (command === 'report') {
      output(
        await Promise.all(
          selected.map(async (item) => ({
            assetId: item.device.assetId,
            ...(await app.engine.readiness(item)),
            currentStateVerified: false,
          })),
        ),
      );
      return 0;
    }
    if (command === 'attest') {
      await confirmation(
        io,
        `Confirm the named check was actually performed: ${value('check')}`,
        flag('yes'),
      );
      const evidence =
        value('check') === 'emulator_image_provenance'
          ? (parseDocument(await readFile(value('evidence'), 'utf8')) as EmulatorImagePin)
          : undefined;
      output(
        await app.engine.attest(
          target,
          value('check'),
          value('operator'),
          typeof values['note'] === 'string' ? value('note') : undefined,
          evidence,
        ),
      );
      return 0;
    }
    if (command === 'finalize') {
      await confirmation(io, 'Disable debugging after fresh full-device signoff?', flag('yes'));
      const locale = value('locale', 'en');
      if (locale !== 'en' && locale !== 'pl') throw new Error('Invalid locale');
      output(await app.engine.finalize(target, value('operator'), locale));
      return 0;
    }
    if (command === 'recover') {
      const reservations = await recoveryReservations(hostControlRoot());
      if (!flag('inspected')) {
        output({
          reservations,
          instructions:
            'Inspect the affected phone and owned cleanup before explicit --inspected --run OPERATION_ID --yes',
        });
        return 4;
      }
      await confirmation(io, 'Confirm physical inspection and all owned cleanup are complete?', flag('yes'));
      await app.engine.recover(target, value('run'), controller.signal);
      output({ recoveryAcknowledged: true });
      return 0;
    }
    const operation: Operation =
      command === 'create-users'
        ? 'create-users'
        : command === 'deploy'
          ? 'deploy-apps'
          : command === 'install-os'
            ? 'install-os'
            : command === 'provision' || command === 'plan' || command === 'guided'
              ? 'provision'
              : (() => {
                  throw new Error('Unknown device workflow');
                })();
    const jobs = Number(value('jobs', '2'));
    if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('jobs must be 1–8');
    const locale = value('locale', 'en');
    if (locale !== 'en' && locale !== 'pl') throw new Error('Guide locale must be en or pl');
    if (command === 'guided') io.out(renderProjectGuide(product, project.policy, target.device.kind, locale));
    const plans = [];
    for (const item of selected) {
      const prepared = await app.engine.prepare(item, operation, controller.signal);
      plans.push(prepared);
      output({
        assetId: item.device.assetId,
        planId: prepared.plan.id,
        reviewSummary: prepared.reviewSummary,
        expiresAt: prepared.expiresAt,
      });
    }
    if (command === 'plan' || flag('dry-run')) return 0;
    await confirmation(
      io,
      operation === 'install-os'
        ? 'DESTRUCTIVE: erase and install the reviewed phones? Attend unlock/relock prompts.'
        : 'Execute the exact reviewed changes?',
      flag('yes'),
    );
    const runs = [];
    for (const plan of plans)
      runs.push(
        await app.engine.submit(
          plan.plan.id,
          plan.reviewSummary,
          value('operator', process.env['USER'] ?? 'operator'),
        ),
      );
    const results = await app.engine.executeFleet(
      runs.map((run) => run.id),
      jobs,
      controller.signal,
    );
    output({
      runs: results,
      ...(command === 'guided'
        ? {
            next: results.map((run, index) => ({
              runId: run.id,
              steps: guidedNextSteps(
                product,
                run,
                locale,
                projectRoot,
                selected[index]?.device.assetId ?? '',
              ),
            })),
          }
        : {}),
    });
    return results.some((run) => ['failed', 'needs-inspection'].includes(run.status))
      ? 3
      : results.some((run) => run.status === 'cancelled')
        ? 130
        : results.some((run) => run.status === 'pending')
          ? 4
          : 0;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await app.store.close();
  }
}
