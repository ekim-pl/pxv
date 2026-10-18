import { runCommand } from './supervisor-command.js';
import { loadKernel, type Kernel } from './supervisor-native.js';
import { terminateDescendants } from './supervisor-process.js';
import { Channel } from './supervisor-protocol.js';
import { Lease } from './supervisor-storage.js';
let exitAfterFlush = false;
function informational(): boolean {
  if (process.argv.length !== 3) return false;
  if (process.argv[2] === '--version') {
    console.log('pxv-supervisor 0.1.0');
    return true;
  }
  if (process.argv[2] !== '--build-info') return false;
  console.log(
    JSON.stringify({
      protocol: 1,
      platform: 'linux_x64',
      addon: '3.3.3',
      nodeApi: 8,
      subreaper: true,
      pidfd: true,
    }),
  );
  return true;
}
async function serve(lease: Lease, channel: Channel, kernel: Kernel, direct: Set<number>): Promise<void> {
  await channel.send({ type: 'ready', supervisor: lease.supervisor });
  for (;;) {
    const message = await channel.receive();
    if (message.type === 'run') await runCommand(lease, channel, message, kernel, direct);
    else if (message.type === 'finish') {
      const clean = await terminateDescendants(kernel, direct);
      exitAfterFlush = !clean;
      const success = lease.finish(message['success'] as boolean, clean);
      await channel.send({ type: 'finished', success, cleanup_proven: clean });
      return;
    } else throw new Error('Unexpected ownership message');
  }
}
async function session(kernel: Kernel): Promise<void> {
  kernel.closeOnExec(3);
  const channel = new Channel(),
    direct = new Set<number>();
  let lease: Lease | undefined;
  try {
    const request = await channel.receive();
    if (!['acquire', 'acquire_recovery'].includes(request.type))
      throw new Error('Lease acquisition required');
    lease = new Lease(
      process.argv[3]!,
      request['device_key'] as string,
      request['transport_key'] as string,
      request['operation_id'] as string,
      kernel,
      request['previous_operation_id'] as string | undefined,
    );
    await serve(lease, channel, kernel, direct);
  } catch (error) {
    const clean = await terminateDescendants(kernel, direct);
    exitAfterFlush = !clean;
    if (lease) {
      lease.uncertain = true;
      try {
        lease.finish(false, clean);
      } catch {
        /* retain original fences */
      }
    }
    await channel
      .send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      .catch(() => undefined);
    throw error;
  } finally {
    if (!channel.socket.destroyed)
      await new Promise<void>((done) => {
        channel.socket.end(() => {
          channel.socket.destroy();
          done();
        });
      });
  }
}
async function main(): Promise<void> {
  const kernel = loadKernel();
  kernel.prepare();
  if (informational()) return;
  if (process.argv.length !== 4 || process.argv[2] !== '--control-root')
    throw new Error('Usage: node supervisor.js --control-root PATH (private IPC on fd 3)');
  await session(kernel);
}
main()
  .then(() => {
    // An unkillable descendant must not hold the owner API open indefinitely.
    // Durable cleanup-unproven reservations remain the recovery barrier.
    if (exitAfterFlush) process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('pxv-supervisor:', error);
    process.exitCode = 125;
    if (exitAfterFlush) process.exit(125);
  });
