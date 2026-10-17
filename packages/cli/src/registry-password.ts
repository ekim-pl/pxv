import { readRegistryPrivateFile } from '@pxv/runtime';
import { stdin, stderr } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { ProjectCliContext } from './arguments.js';

async function hiddenPassword(label: string): Promise<Buffer> {
  if (!stdin.isTTY || !stderr.isTTY)
    throw new Error('Registry unlock needs a local terminal or --passphrase-file');
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({ input: stdin, output: muted, terminal: true, historySize: 0 });
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  prompt.once('SIGINT', interrupt);
  stderr.write(`${label}: `);
  try {
    return Buffer.from(await prompt.question('', { signal: controller.signal }), 'utf8');
  } catch {
    throw new Error('Registry unlock cancelled');
  } finally {
    prompt.close();
    muted.destroy();
    stderr.write('\n');
  }
}

async function passwordFromFile(path: string): Promise<Buffer> {
  const data = await readRegistryPrivateFile(path, 1026);
  const end = data.length - (data.at(-1) === 10 ? (data.at(-2) === 13 ? 2 : 1) : 0);
  const password = Buffer.from(data.subarray(0, end));
  data.fill(0);
  return password;
}

export async function registryPassword(
  context: ProjectCliContext,
  replacement = false,
  confirm = false,
): Promise<Buffer> {
  const flag = replacement ? 'new-passphrase-file' : 'passphrase-file';
  const label = replacement ? 'New registry passphrase' : 'Registry passphrase';
  if (context.values[flag] !== undefined) {
    return passwordFromFile(context.value(flag));
  }
  const password = await hiddenPassword(label);
  if (!confirm) return password;
  let repeated: Buffer | undefined;
  try {
    repeated = await hiddenPassword('Repeat new registry passphrase');
    if (!password.equals(repeated)) throw new Error('Registry passphrases do not match');
    return password;
  } catch (error) {
    password.fill(0);
    throw error;
  } finally {
    repeated?.fill(0);
  }
}
