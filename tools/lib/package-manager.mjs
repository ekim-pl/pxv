/** pnpm may be a standalone native executable or a JavaScript CLI.
 * @param {string[]} args @returns {{file:string,args:string[]}} */
export function packageManagerCommand(args) {
  const executable = process.env['npm_execpath'] ?? 'pnpm';
  return /\.[cm]?js$/u.test(executable)
    ? { file: process.execPath, args: [executable, ...args] }
    : { file: executable, args };
}
