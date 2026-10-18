import type * as Koffi from 'koffi';
import { createRequire } from 'node:module';

/** Private Linux ABI boundary. No compiler or source-build fallback is permitted. */
export interface Kernel {
  lock(fd: number): void;
  closeOnExec(fd: number): void;
  prepare(): void;
  openPid(pid: number): number | undefined;
  signal(fd: number, signal: number): void;
  close(fd: number): void;
  reap(pid: number): void;
}
export function loadKernel(): Kernel {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Supervisor requires Linux x64 with glibc and pidfds');
  const require = createRequire(import.meta.url);
  let koffi: typeof Koffi;
  try {
    // Check the explicit platform dependency first; never invoke Koffi's installer.
    const platform = require.resolve('@koromix/koffi-linux-x64');
    require(platform.replace(/index\.js$/u, 'linux_x64/koffi.node'));
    koffi = require('koffi') as typeof Koffi;
    if (koffi.version !== '3.3.3') throw new Error('Incompatible Koffi prebuild version');
  } catch (cause) {
    throw new Error(
      'Koffi 3.3.3 Linux x64 prebuild unavailable or incompatible. Run pnpm install --frozen-lockfile on supported glibc Linux; native compilation is disabled.',
      { cause },
    );
  }
  const libc = koffi.load('libc.so.6');
  const flock = libc.func('int flock(int fd, int operation)');
  const fcntl = libc.func('int fcntl(int fd, int cmd, int flags)');
  const prctl = libc.func(
    'int prctl(int option, uint64_t arg2, uint64_t arg3, uint64_t arg4, uint64_t arg5)',
  );
  const getSubreaper = libc.func('prctl', 'int', ['int', '_Out_ int *', 'uint64_t', 'uint64_t', 'uint64_t']);
  const syscall = libc.func('long syscall(long number, ...)');
  const close = libc.func('int close(int fd)');
  const waitpid = libc.func('int waitpid(int pid, int *status, int options)');
  const check = (value: number, message: string): void => {
    if (value < 0) throw new Error(`${message} (errno ${koffi.errno()})`);
  };
  return {
    lock(fd) {
      check(
        flock(fd, 2 | 4) as number,
        'Physical device or transport is busy; native owner is still alive or recovery is busy',
      );
    },
    closeOnExec(fd) {
      check(fcntl(fd, 2, 1) as number, 'Cannot protect descriptor');
    },
    prepare() {
      check(prctl(36, 1, 0, 0, 0) as number, 'Linux child-subreaper unavailable');
      const enabled = [0];
      check(getSubreaper(37, enabled, 0, 0, 0) as number, 'Cannot verify child-subreaper');
      if (enabled[0] !== 1) throw new Error('Linux child-subreaper could not be verified');
      const fd = this.openPid(process.pid);
      if (fd === undefined) throw new Error('Linux pidfds unavailable');
      this.signal(fd, 0);
      this.close(fd);
    },
    openPid(pid) {
      const fd = Number(syscall(434, 'int', pid, 'uint', 0));
      if (fd < 0 && koffi.errno() === 3) return undefined;
      check(fd, 'pidfd_open unavailable; cleanup cannot be proven');
      return fd;
    },
    signal(fd, signal) {
      const result = Number(syscall(424, 'int', fd, 'int', signal, 'void *', null, 'uint', 0));
      if (result < 0 && koffi.errno() !== 3) check(result, 'pidfd_send_signal failed');
    },
    close(fd) {
      check(close(fd) as number, 'Cannot close pidfd');
    },
    reap(pid) {
      const result = waitpid(pid, null, 1) as number;
      if (result < 0 && koffi.errno() !== 10) check(result, 'Cannot reap adopted child');
    },
  };
}
