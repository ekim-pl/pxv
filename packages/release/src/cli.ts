#!/usr/bin/env node
import { releaseFailure } from './errors.js';
import { runRelease } from './release-service.js';
runRelease(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${releaseFailure(error, 'Release build failed')}\n`);
  process.exitCode = 1;
});
