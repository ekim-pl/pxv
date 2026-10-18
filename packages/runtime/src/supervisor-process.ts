import { performance } from 'node:perf_hooks';
import { readFileSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { Kernel } from './supervisor-native.js';
export interface Identity {
  pid: number;
  start_ticks: string;
  boot_id: string;
  uid: number;
}
export function identity(pid: number): Identity {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.trim().split(/\s+/u);
  if (!fields[19]) throw new Error('Missing process start time');
  return {
    pid,
    start_ticks: fields[19],
    boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    uid: statSync(`/proc/${pid}`).uid,
  };
}
export function sameIdentity(a: Identity | undefined, b: Identity): boolean {
  return (
    !!a && a.pid === b.pid && a.start_ticks === b.start_ticks && a.boot_id === b.boot_id && a.uid === b.uid
  );
}
export function existingIdentity(pid: number): Identity | undefined {
  try {
    return identity(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export function parseChildren(value: string): number[] {
  if (!value.trim()) return [];
  return value
    .trim()
    .split(/\s+/u)
    .map((v) => {
      if (!/^[1-9]\d*$/u.test(v) || Number(v) > 2147483647)
        throw new Error('Malformed native child enumeration');
      return Number(v);
    });
}
export function children(pid: number): number[] {
  return parseChildren(readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8'));
}
export function ownedDescendant(pid: number): boolean {
  if (pid <= 0 || pid === process.pid) return false;
  for (let count = 0; count < 4096; count++) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const parent = Number(stat.split(') ').at(-1)!.trim().split(/\s+/u)[1]);
    if (!Number.isInteger(parent)) throw new Error('Malformed descendant parent');
    if (parent === process.pid) return true;
    if (parent <= 1) return false;
    pid = parent;
  }
  throw new Error('Descendant ancestry exceeds safety bound');
}
export function signalPid(kernel: Kernel, pid: number, signal: number): void {
  const before = existingIdentity(pid);
  if (!before) return;
  const fd = kernel.openPid(pid);
  if (fd === undefined) return;
  try {
    if (sameIdentity(existingIdentity(pid), before) && ownedDescendant(pid)) kernel.signal(fd, signal);
  } finally {
    kernel.close(fd);
  }
}
function descendants(pid: number): number[] {
  const result: number[] = [];
  for (const child of children(pid)) {
    try {
      result.push(...descendants(child));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    result.push(child);
  }
  return result;
}
/** Direct children remain exclusively owned by libuv, even after their exit event. */
export function reapAdopted(kernel: Kernel, direct: Set<number>): void {
  for (const pid of children(process.pid)) if (!direct.has(pid)) kernel.reap(pid);
}
export async function terminateDescendants(kernel: Kernel, direct: Set<number>): Promise<boolean> {
  const deadline = performance.now() + 5000;
  let proven = true;
  while (performance.now() < deadline) {
    try {
      const pids = descendants(process.pid);
      if (!pids.length) return proven;
      for (const pid of pids) {
        try {
          signalPid(kernel, pid, 9);
        } catch {
          proven = false;
        }
      }
      reapAdopted(kernel, direct);
    } catch {
      return false;
    }
    await delay(5);
  }
  return false;
}
