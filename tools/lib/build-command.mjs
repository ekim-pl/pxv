import { spawn } from 'node:child_process';

/** Build commands never access phones; bound their output, lifetime and diagnostics.
 * @param {string[]} args
 * @param {{env: NodeJS.ProcessEnv,cwd?:string,secrets?:string[],timeoutMs?:number,maxOutput?:number}} options
 * @returns {Promise<string>} */
export function runBuildCommand(args, options) {
  const [executable, ...arguments_] = args;
  if (!executable) return Promise.reject(new Error('Missing build executable'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: options.env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      diagnostics = '',
      bytes = 0;
    /** @type {Error | undefined} */
    let failure;
    const timer = setTimeout(() => stop('Build command timed out'), options.timeoutMs ?? 120_000);
    /** @param {string} message */
    function stop(message) {
      failure = new Error(message);
      child.kill('SIGKILL');
    }
    /** @param {Buffer} data @param {boolean} error */
    function capture(data, error) {
      bytes += data.length;
      if (bytes > (options.maxOutput ?? 4 * 1024 * 1024)) {
        stop('Build output exceeds limit');
        return;
      }
      if (error) diagnostics += data.toString();
      else output += data.toString();
    }
    child.stdout.on('data', (data) => capture(data, false));
    child.stderr.on('data', (data) => capture(data, true));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      for (const secret of options.secrets ?? []) diagnostics = diagnostics.replaceAll(secret, '<secret>');
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Android build command failed (${code}): ${diagnostics}`));
      else resolve(output);
    });
  });
}
