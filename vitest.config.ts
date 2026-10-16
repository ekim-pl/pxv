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
    alias: Object.fromEntries([
      [
        '@pxv/contracts/extensions',
        fileURLToPath(new URL('./packages/contracts/src/extensions.ts', import.meta.url)),
      ] as const,
      ...names.map(
        (name) =>
          [
            `@pxv/${name}`,
            fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
          ] as const,
      ),
    ]),
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text', 'json'],
    },
  },
});
