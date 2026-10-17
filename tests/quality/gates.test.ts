import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import ts from 'typescript';
import { checkBoundaries } from '../../tools/lib/boundaries.mjs';
import { runBuildCommand } from '../../tools/lib/build-command.mjs';
import { completeCoverage } from '../../tools/lib/coverage.mjs';
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const root = await mkdtemp('/tmp/pxv-quality-gate-');
  temporary.push(root);
  return root;
}

test('JavaScript undefined identifiers and excessive function complexity fail the real lint gate', () => {
  const decisions = Array.from({ length: 11 }, (_, index) => `if (value === ${index}) return ${index};`).join(
    '\n',
  );
  const source = `export function classify(value) { ${decisions} return missingIdentifier(); }`;
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/eslint/bin/eslint.js',
      '--stdin',
      '--stdin-filename',
      'tools/quality-diagnostic.mjs',
      '--format',
      'json',
    ],
    { input: source, encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('complexity');
  expect(result.stdout).toContain('no-undef');
});

test('architecture gate rejects module cycles, forbidden imports and undeclared package edges', async () => {
  const root = await scratch();
  const packages = [
    'contracts',
    'runtime',
    'adapters',
    'engine',
    'extensions',
    'extension-sdk',
    'guides',
    'mcp',
    'cli',
    'release',
  ];
  for (const name of packages) {
    await mkdir(join(root, 'packages', name, 'src'), { recursive: true });
    await writeFile(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@pxv/${name}`, dependencies: {} }),
    );
    await writeFile(join(root, 'packages', name, 'src', 'index.ts'), 'export {};');
  }
  await writeFile(join(root, 'packages/contracts/src/index.ts'), "import 'node:fs';");
  await writeFile(join(root, 'packages/runtime/src/a.ts'), "import './b.js';");
  await writeFile(join(root, 'packages/runtime/src/b.ts'), "import './a.js';");
  await writeFile(join(root, 'packages/engine/src/index.ts'), "import '@pxv/adapters';");
  const result = await checkBoundaries(root);
  expect(result.errors.join('\n')).toContain('domain contracts cannot import');
  expect(result.errors.join('\n')).toContain('Dependency cycle');
  expect(result.errors.join('\n')).toContain('missing declared dependency');
  expect(result.errors.join('\n')).toContain('engine cannot import');
});

test('documentation gate checks guide, optional tooling and acceptance documentation', async () => {
  const root = await scratch();
  for (const path of ['docs', 'guides/source/markdown', 'policy-packs', 'tests/acceptance', 'tools/optional'])
    await mkdir(join(root, path), { recursive: true });
  for (const path of [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'guides/README.md',
    'tests/acceptance/README.md',
  ])
    await writeFile(join(root, path), '# Public documentation\n');
  const script = fileURLToPath(new URL('../../tools/check-docs.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  expect(run().status).toBe(0);
  await writeFile(join(root, 'tools/optional/README.md'), '[Missing source tool](missing.mjs)\n');
  const brokenOptional = run();
  expect(brokenOptional.status).toBe(1);
  expect(brokenOptional.stderr).toContain('tools/optional/README.md: missing missing.mjs');
  await writeFile(join(root, 'tools/optional/README.md'), '# Optional source tooling\n');
  await writeFile(
    join(root, 'guides/README.md'),
    '`![Example](../../outside.svg)`\n\n```md\n[Example](missing.md)\n```\n',
  );
  expect(run().status).toBe(0);
  await writeFile(join(root, 'guides/README.md'), '[Missing branding asset](missing.svg)\n');
  const brokenGuide = run();
  expect(brokenGuide.status).toBe(1);
  expect(brokenGuide.stderr).toContain('guides/README.md: missing missing.svg');
  await writeFile(join(root, 'guides/README.md'), '[Reference][brand]\n\n[brand]: missing.svg\n');
  expect(run().status).toBe(1);
  await writeFile(join(root, 'guides/README.md'), '# Guide instructions\n');
  await writeFile(join(root, 'tests/acceptance/README.md'), 'python3 -m pxv_app\n');
  const obsoleteCommand = run();
  expect(obsoleteCommand.status).toBe(1);
  expect(obsoleteCommand.stderr).toContain('tests/acceptance/README.md: obsolete application command');
  await writeFile(join(root, 'tests/acceptance/README.md'), '# Acceptance\n');
  await writeFile(join(root, 'docs/guide.md'), '# Zażółć\n\n## Repeated\n\n## Repeated\n');
  await writeFile(
    join(root, 'guides/README.md'),
    '[Known](../docs/guide.md#zażółć)\n\n[Repeated](../docs/guide.md#repeated-1)\n',
  );
  expect(run().status).toBe(0);
  await writeFile(join(root, 'guides/README.md'), '# Guides\n\n[Stale](#removed-heading)\n');
  const brokenAnchor = run();
  expect(brokenAnchor.status).toBe(1);
  expect(brokenAnchor.stderr).toContain('missing heading #removed-heading');
});

test('build commands enforce bounded output, deadlines and redacted failure diagnostics', async () => {
  const env = { PATH: process.env['PATH'] };
  expect(await runBuildCommand([process.execPath, '-e', 'process.stdout.write("ok")'], { env })).toBe('ok');
  await expect(runBuildCommand([], { env })).rejects.toThrow('Missing build executable');
  await expect(runBuildCommand(['/nonexistent/pxv-build-command'], { env })).rejects.toThrow('ENOENT');
  await expect(
    runBuildCommand([process.execPath, '-e', 'process.stdout.write("x".repeat(1024))'], {
      env,
      maxOutput: 16,
    }),
  ).rejects.toThrow('exceeds limit');
  await expect(
    runBuildCommand([process.execPath, '-e', 'setTimeout(()=>{},1000)'], { env, timeoutMs: 20 }),
  ).rejects.toThrow('timed out');
  await expect(
    runBuildCommand([process.execPath, '-e', 'process.stderr.write("build-secret");process.exit(2)'], {
      env,
      secrets: ['build-secret'],
    }),
  ).rejects.toThrow('<secret>');
});

test('actual Node child coverage is mapped to original TypeScript before component gating', async () => {
  const root = await scratch(),
    source = join(root, 'packages/component/src'),
    output = join(root, 'packages/component/dist');
  for (const path of [source, output, join(root, 'coverage'), join(root, '.quality/v8')])
    await mkdir(path, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const code =
    'type Input = boolean;\n// Types and comments are not executable.\nexport function choose(value: Input): number { return value ? 1 : 2; }\n';
  const compiled = ts.transpileModule(code, {
    fileName: 'choice.ts',
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
      inlineSources: true,
    },
  });
  const sourceMap = JSON.parse(compiled.sourceMapText!) as { sources: string[] };
  sourceMap.sources = ['../src/choice.ts'];
  await writeFile(join(source, 'choice.ts'), code);
  await writeFile(join(output, 'choice.js'), compiled.outputText);
  await writeFile(join(output, 'choice.js.map'), JSON.stringify(sourceMap));
  const file = join(source, 'choice.ts');
  const canonical = {
    path: file,
    statementMap: { '0': { start: { line: 3, column: 0 }, end: { line: 3, column: 70 } } },
    s: { '0': 0 },
    branchMap: {},
    b: {},
    fnMap: {},
    f: {},
  };
  await writeFile(join(root, 'coverage/coverage-final.json'), JSON.stringify({ [file]: canonical }));
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const {choose}=await import(${JSON.stringify(pathToFileURL(join(output, 'choice.js')).href)});choose(true);choose(false);`,
    ],
    { env: { ...process.env, NODE_V8_COVERAGE: join(root, '.quality/v8') } },
  );
  const result = await completeCoverage(root, join(root, '.quality/v8'));
  expect(result.modules['packages/component/src/choice.ts']?.lines.pct).toBe(100);
  expect(result.modules['packages/component/src/choice.ts']?.lines.total).toBe(1);
  expect(result.children.files).toEqual(['packages/component/src/choice.ts']);
  expect(result.failures).toEqual([]);
  expect(JSON.parse(await readFile(join(root, '.quality/coverage.json'), 'utf8'))).toHaveProperty(
    'packages.component',
  );
  const unmatched = {
    type: 'cond-expr',
    line: 3,
    loc: { start: { line: 3, column: 1000 }, end: { line: 3, column: 1002 } },
    locations: [
      { start: { line: 3, column: 1000 }, end: { line: 3, column: 1001 } },
      { start: { line: 3, column: 1001 }, end: { line: 3, column: 1002 } },
    ],
  };
  await writeFile(
    join(root, 'coverage/coverage-final.json'),
    JSON.stringify({ [file]: { ...canonical, branchMap: { '0': unmatched }, b: { '0': [0, 0] } } }),
  );
  const conservative = await completeCoverage(root, join(root, '.quality/v8'));
  expect(conservative.modules['packages/component/src/choice.ts']?.branches.pct).toBe(0);
  expect(conservative.failures).toHaveLength(1);
});
