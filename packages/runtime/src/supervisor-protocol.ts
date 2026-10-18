import { Socket } from 'node:net';
export type Message = Record<string, unknown> & { type: string };
const fields: Record<string, string[]> = {
  acquire: ['device_key', 'transport_key', 'operation_id'],
  acquire_recovery: ['device_key', 'transport_key', 'operation_id', 'previous_operation_id'],
  run: ['id', 'args', 'env', 'cwd', 'input', 'input_file', 'timeout_ms', 'expected_exit_codes'],
  authorize: ['id'],
  cancel: ['id'],
  finish: ['success'],
};
export function validateMessage(value: unknown): Message {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid ownership message');
  const v = value as Message;
  const allowed = fields[v.type];
  if (!allowed || Object.keys(v).some((k) => k !== 'type' && !allowed.includes(k)))
    throw new Error('Unknown protocol fields');
  const required = allowed.filter((k) => !['cwd', 'input', 'input_file', 'expected_exit_codes'].includes(k));
  if (required.some((k) => !(k in v))) throw new Error('Missing protocol fields');
  validateFields(v);
  return v;
}
export function validExitCodes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    new Set(value).size === value.length &&
    value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
  );
}
/** Bounded line protocol on a private socket. EOF and malformed frames fail closed. */
export class Channel {
  readonly socket = new Socket({ fd: 3, readable: true, writable: true });
  #buffer = Buffer.alloc(0);
  #queue: Message[] = [];
  #failure: Error | undefined;
  #wake: (() => void) | undefined;
  constructor() {
    this.socket.on('data', (chunk: Buffer) => {
      try {
        this.accept(chunk);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    this.socket.on('end', () => this.fail(new Error('Owner disconnected')));
    this.socket.on('error', (error) => this.fail(error));
  }
  private accept(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (let end = this.#buffer.indexOf(10); end >= 0; end = this.#buffer.indexOf(10)) {
      if (end > 16 * 1024 * 1024 || this.#queue.length >= 64) throw new Error('IPC message exceeds limit');
      this.#queue.push(validateMessage(JSON.parse(this.#buffer.subarray(0, end).toString('utf8'))));
      this.#buffer = this.#buffer.subarray(end + 1);
    }
    if (this.#buffer.length > 16 * 1024 * 1024) throw new Error('IPC message exceeds limit or is incomplete');
    this.#wake?.();
  }
  private fail(error: Error): void {
    // Stop consuming rejected frames while cleanup and receipt persistence run.
    this.socket.pause();
    this.#buffer = Buffer.alloc(0);
    this.#queue = [];
    this.#failure = error;
    this.#wake?.();
  }
  poll(): Message | undefined {
    if (this.#failure) throw this.#failure;
    return this.#queue.shift();
  }
  async receive(): Promise<Message> {
    for (;;) {
      const message = this.poll();
      if (message) return message;
      await new Promise<void>((done) => {
        this.#wake = done;
      });
      this.#wake = undefined;
    }
  }
  async send(value: unknown): Promise<void> {
    await new Promise<void>((done, reject) =>
      this.socket.write(JSON.stringify(value) + '\n', (error) => (error ? reject(error) : done())),
    );
  }
}

function validateFields(v: Message): void {
  for (const k of ['device_key', 'transport_key', 'operation_id', 'previous_operation_id', 'id'])
    if (k in v && typeof v[k] !== 'string') throw new Error('Invalid protocol identity');
  if (v.type === 'finish' && typeof v['success'] !== 'boolean') throw new Error('Invalid completion');
}
