import type { Store } from '@pxv/runtime';
/** Cancellation polling is scoped to one owned execution, including error exits. */
export class ExecutionControl {
  readonly controller = new AbortController();
  private polling = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly abort = (): void => this.controller.abort(new Error('Execution cancelled'));
  constructor(
    readonly store: Store,
    readonly runId: string,
    readonly external?: AbortSignal,
  ) {
    external?.addEventListener('abort', this.abort, { once: true });
    if (external?.aborted) this.abort();
    this.timer = setInterval(() => {
      void this.poll();
    }, 100);
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  async check(): Promise<void> {
    if (await this.store.get('cancellation', this.runId)) this.abort();
    this.signal.throwIfAborted();
  }
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.check();
    } catch {
      this.abort();
    } finally {
      this.polling = false;
    }
  }
  dispose(): void {
    clearInterval(this.timer);
    this.external?.removeEventListener('abort', this.abort);
  }
}
