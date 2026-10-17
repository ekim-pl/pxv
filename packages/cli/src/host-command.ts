import { configuredAdbServer, HostTools, startLocalAdbServer } from '@pxv/adapters';
import { CommandRunner } from '@pxv/runtime';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CliContext } from './arguments.js';
import { confirmation } from './arguments.js';
import { prepareDockerEnvironment, startDockerAdb, stopDockerAdb } from './docker.js';
import { bootstrapTool, inspectHost } from './host.js';

async function dockerHost(context: CliContext): Promise<number | undefined> {
  const { io, value, flag, output, command, extensionRoot } = context;

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
    await confirmation(io, 'Start the reviewed image as an independent direct-USB ADB service?', flag('yes'));
    output(await startDockerAdb(value('image'), extensionRoot));
    return 0;
  }
  if (command === 'docker-adb-stop') {
    await confirmation(io, 'Stop this operator’s Docker ADB service?', flag('yes'));
    output(await stopDockerAdb(extensionRoot));
    return 0;
  }
  return undefined;
}
async function toolHost(context: CliContext): Promise<number | undefined> {
  const { io, value, flag, output, command } = context;
  const runner = new CommandRunner();
  if (command === 'adb-start') {
    await confirmation(io, 'Start the configured local ADB server?', flag('yes'));
    if (process.env['HOME'])
      await mkdir(join(process.env['HOME'], '.android'), { recursive: true, mode: 0o700 });
    await startLocalAdbServer(runner, await new HostTools({ runner }).require('adb'), configuredAdbServer());
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
  return undefined;
}
async function helperHost(context: CliContext): Promise<number | undefined> {
  const { io, value, flag, command, resources, projectRoot } = context;
  const runner = new CommandRunner();
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
    if (built.stdout.trim()) io.out(built.stdout.trim());
    if (built.stderr.trim()) io.error(built.stderr.trim());
    context.output({ built: true, helper: component });
    return 0;
  }
  return undefined;
}
export async function hostCommand(context: CliContext): Promise<number> {
  const result = (await dockerHost(context)) ?? (await toolHost(context)) ?? (await helperHost(context));
  if (result === undefined) throw new Error('Unknown host command');
  return result;
}
