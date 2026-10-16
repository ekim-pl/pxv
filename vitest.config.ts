import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const names = [
  'contracts',
  'runtime',
  'adapters',
  'engine',
  'extensions',
  'mcp',
  'cli',
  'release',
  'guides',
  'extension-sdk',
];
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      names.map((name) => [
        `@pxv/${name}`,
        fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
      ]),
    ),
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/main.ts', 'packages/release/**', '**/worker.ts'],
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
