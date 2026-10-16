import { serveStdio } from '@pxv/mcp';
import { stdin } from 'node:process';
import type { ProjectCliContext } from './arguments.js';
import { workerLauncher } from './arguments.js';
import { liveAgentBackend } from './backend.js';

export async function mcpCommand(context: ProjectCliContext): Promise<number | undefined> {
  const { flag, section, command, resources, product, version, projectRoot } = context;

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

  return undefined;
}
