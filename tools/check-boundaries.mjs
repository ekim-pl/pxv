import { checkBoundaries } from './lib/boundaries.mjs';
const result = await checkBoundaries(process.cwd());
if (result.errors.length) {
  process.stderr.write(`${result.errors.join('\n')}\n`);
  process.exitCode = 1;
} else
  process.stdout.write(
    `Package boundaries, manifests and module cycles checked (${result.packages} packages, ${result.modules} modules).\n`,
  );
