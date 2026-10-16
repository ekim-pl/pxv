import { runCli } from './cli.js';
type CliRunner = (argv: string[]) => Promise<number>;
export async function startCli(
  run: CliRunner = runCli,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  try {
    process.exitCode = await run(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'pxv failed'}\n`);
    process.exitCode = 2;
  }
}
