import { createHash, randomUUID } from 'node:crypto';
import { CommandRunner } from '@pxv/runtime';
import type { CommandRunner as Runner } from '@pxv/adapters';

export interface DockerWorkerIdentity {
  name: string;
  token: string;
  user: string;
  controlKey: string;
}
export function dockerWorkerIdentity(controlRoot: string): DockerWorkerIdentity {
  const token = randomUUID();
  return {
    name: `pxv-worker-${process.getuid?.() ?? 1000}-${token}`,
    token,
    user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    controlKey: createHash('sha256').update(controlRoot).digest('hex'),
  };
}
export function dockerWorkerFlags(identity: DockerWorkerIdentity): string[] {
  return [
    '--name',
    identity.name,
    '--label',
    `org.pxv.worker=${identity.token}`,
    '--label',
    `org.pxv.worker-control=${identity.controlKey}`,
  ];
}
type WorkerInspection = {
  Id: string;
  Name: string;
  Config: { User: string; Labels: Record<string, string> };
  State: { Running: boolean };
};
function validWorker(value: unknown): value is WorkerInspection {
  const candidate = value as Partial<WorkerInspection> | null;
  return (
    !!candidate &&
    /^[a-f0-9]{64}$/u.test(candidate.Id ?? '') &&
    typeof candidate.Name === 'string' &&
    typeof candidate.Config?.User === 'string' &&
    !!candidate.Config.Labels &&
    typeof candidate.State?.Running === 'boolean'
  );
}
type WorkerState = { kind: 'missing' } | { kind: 'running' | 'stopped'; id: string };
/** Worker ownership is distinct from ADB sidecar ownership. Kill only the inspected immutable ID. */
export class DockerWorkerControl {
  private observedContainer = false;
  get observed(): boolean {
    return this.observedContainer;
  }
  constructor(
    readonly identity: DockerWorkerIdentity,
    readonly runner: Runner = new CommandRunner(),
    readonly timeoutMs = 10_000,
  ) {}
  async state(): Promise<WorkerState> {
    const result = await this.runner.run(
      ['docker', 'container', 'inspect', '--format', '{{json .}}', this.identity.name],
      { timeoutMs: this.timeoutMs, check: false },
    );
    if (result.code !== 0) {
      if (/No such (?:object|container)/iu.test(result.stderr)) return { kind: 'missing' };
      throw new Error('Docker worker ownership could not be inspected');
    }
    const value = JSON.parse(result.stdout) as {
      Id?: string;
      Name?: string;
      Config?: { User?: string; Labels?: Record<string, string> };
      State?: { Running?: boolean };
    };
    if (!validWorker(value) || !this.owned(value))
      throw new Error('Docker worker ownership differs; refusing to stop this container');
    this.observedContainer = true;
    return { kind: value.State.Running ? 'running' : 'stopped', id: value.Id };
  }
  private owned(value: WorkerInspection): boolean {
    return (
      value.Name === `/${this.identity.name}` &&
      value.Config.User === this.identity.user &&
      value.Config.Labels['org.pxv.worker'] === this.identity.token &&
      value.Config.Labels['org.pxv.worker-control'] === this.identity.controlKey
    );
  }

  async forceStop(): Promise<WorkerState> {
    const before = await this.state();
    if (before.kind !== 'running') return before;
    await this.runner.run(['docker', 'kill', '--signal', 'KILL', before.id], {
      timeoutMs: this.timeoutMs,
      check: false,
    });
    const after = await this.state();
    if (after.kind === 'running') throw new Error('Docker worker is still running after forced shutdown');
    return after;
  }
}
