import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from '../test-api.js';
import { checkGraph } from '../../tools/lib/repository-graph.mjs';
import { auditLock } from '../../tools/lib/dependency-audit.mjs';
import { javaComplexity } from '../../tools/lib/metrics.mjs';
import { completeCoverage } from '../../tools/lib/coverage.mjs';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp('/tmp/pxv-quality-replacement-');
  roots.push(root);
  for (const path of ['tools', 'packages/example/src', '.quality/v8'])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pxv-workspace', type: 'module' }));
  await writeFile(
    join(root, 'tools/repository-graph.json'),
    JSON.stringify({
      entries: ['packages/example/src/main.ts'],
      public: [],
      dependencies: [],
      exemptions: [],
    }),
  );
  await writeFile(join(root, 'packages/example/src/main.ts'), 'console.log("fixture");');
  return root;
}
it('rejects unused files, exports, dependencies, missing dependencies and unresolved imports in both graphs', async () => {
  const root = await fixture();
  await writeFile(join(root, 'packages/example/src/unreachable.ts'), 'export const unused=1;');
  await writeFile(
    join(root, 'packages/example/src/main.ts'),
    'import "./helper.js"; import "missing-dependency"; require("node:pxv-missing");',
  );
  await writeFile(join(root, 'packages/example/src/helper.ts'), 'export const unused=1;');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'pxv-workspace', devDependencies: { 'unused-dependency': '1.0.0' } }),
  );
  for (const mode of ['development', 'production']) {
    const result = checkGraph(root, mode);
    expect(result.status).toBe('failed');
    expect(result.findings.join('\n')).toMatch(/Unreachable file/);
    expect(result.findings.join('\n')).toMatch(/Unused export/);
    expect(result.findings.join('\n')).toMatch(/Missing dependency/);
    expect(result.findings.join('\n')).toMatch(/Unresolved import/);
    expect(result.findings.join('\n')).toContain('node:pxv-missing');
    if (mode === 'development') expect(result.findings.join('\n')).toMatch(/Unused dependency/);
  }
});
it('rejects stale graph exemptions', async () => {
  const root = await fixture();
  const path = join(root, 'tools/repository-graph.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  config['exemptions'] = [
    { mode: 'development', finding: 'Unused export: removed', reason: 'Removed exception' },
  ];
  await writeFile(path, JSON.stringify(config));
  expect(checkGraph(root, 'development').findings).toContain('Stale exemption: Unused export: removed');
});
it('rejects Rust families even when present only as optional lock entries', () => {
  for (const name of [
    '@oxc-parser/binding-linux-x64-gnu',
    'rolldown',
    'lightningcss-linux-x64-gnu',
    'unrs-resolver',
    '@swc/core',
    '@napi-rs/wasm-runtime',
  ])
    expect(auditLock(`packages:\n  '${name}@1.0.0':\n    optional: true\n`)).toHaveLength(1);
  expect(auditLock('packages:\n  koffi@3.3.3:\n')).toEqual([]);
});
it('measures Java methods, constructors and lambdas independently and rejects parse failures', () => {
  const source =
    'class Example { Example() { if (true) {} } void run() { Runnable r = () -> { if (true) {} }; if (true) {} } }';
  expect(javaComplexity(source).map((f) => f.cyclomatic)).toEqual([2, 2, 2]);
  const excessive = 'class Example { void run() { ' + 'if (true) {} '.repeat(10) + ' } }';
  expect(javaComplexity(excessive)[0]!.cyclomatic).toBe(11);
  expect(() => javaComplexity('class broken {')).toThrow();
});
it('fails coverage for uncovered branches and missing executable maps', async () => {
  const root = await fixture(),
    path = join(root, 'packages/example/src/main.ts');
  await writeFile(path, 'export function branch(value: boolean) { if (value) return 1; return 2; }');
  const uncovered = await completeCoverage(root, join(root, '.quality/v8'));
  expect(uncovered.failures.join('\n')).toMatch(/Component omitted/);
  await mkdir(join(root, 'packages/example/dist'));
  const script = join(root, 'packages/example/dist/main.js');
  await writeFile(script, 'export const value=1;');
  await writeFile(
    join(root, '.quality/v8/missing.json'),
    JSON.stringify({ result: [{ scriptId: '1', url: pathToFileURL(script).href, functions: [] }] }),
  );
  const missing = await completeCoverage(root, join(root, '.quality/v8'));
  expect(missing.failures.join('\n')).toContain('main.js.map');
});

it('follows compiled workspace imports to source exports for tool consumers', async () => {
  const root = await fixture();
  await writeFile(join(root, 'packages/example/src/main.ts'), 'import "../../../tools/load.mjs";');
  await writeFile(
    join(root, 'tools/load.mjs'),
    'import { used } from "../packages/example/dist/helper.js"; console.log(used);',
  );
  await writeFile(
    join(root, 'packages/example/src/helper.ts'),
    'export const used=1; export const unused=2;',
  );
  for (const mode of ['development', 'production']) {
    const result = checkGraph(root, mode);
    expect(result.findings).toEqual(['Unused export: packages/example/src/helper.ts#unused']);
  }
});
