import { readFile, readdir, writeFile, glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import { convert } from 'ast-v8-to-istanbul';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import { readCoverageTrace } from './coverage-traces.mjs';

const thresholds = { lines: 90, branches: 85 };
/** @param {string} root @param {string} url */
function compiledModule(root, url) {
  if (!url.startsWith('file:')) return undefined;
  const file = fileURLToPath(url),
    path = relative(root, file);
  if (!/^packages\/[^/]+\/(?:dist\/.*\.js|src\/.*\.ts)$/u.test(path)) return undefined;
  return file;
}
/** The converter receives the exact executable code and its source map.
 * @param {string} path */
async function executable(path) {
  const source = await readFile(path, 'utf8');
  if (path.endsWith('.ts')) {
    const result = transformSync(source, {
      loader: 'ts',
      format: 'esm',
      target: 'node24',
      sourcemap: 'inline',
      sourcesContent: true,
      sourcefile: path,
    });
    const encoded = /sourceMappingURL=data:application\/json;base64,([^\s]+)/u.exec(result.code)?.[1];
    if (!encoded) throw new Error('Missing executable coverage map: ' + path);
    return { code: result.code, sourceMap: JSON.parse(Buffer.from(encoded, 'base64').toString()) };
  }
  const sourceMap = JSON.parse(await readFile(path + '.map', 'utf8'));
  if (!sourceMap.sources?.length) throw new Error('Missing executable coverage map: ' + path);
  return { code: source, sourceMap };
}
/** @param {string} root @param {import('node:inspector').Profiler.ScriptCoverage} script */
async function mappedCoverage(root, script) {
  const path = compiledModule(root, script.url);
  if (!path) return {};
  const { code, sourceMap } = await executable(path);
  return convert({
    code,
    sourceMap,
    coverage: { ...script, url: 'file://' + path },
    wrapperLength: 0,
    ast: parse(code, { sourceType: 'module', plugins: ['estree'] }).program,
  });
}
/** @param {string} root @param {string} directory @param {import('istanbul-lib-coverage').CoverageMap} map */
async function mergeChildCoverage(root, directory, map) {
  const seen = new Set(),
    failures = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      for (const script of await readCoverageTrace(join(directory, name))) {
        const mapped = await mappedCoverage(root, script);
        mergeScript(root, map, mapped, seen);
      }
    } catch (error) {
      failures.push(
        `Coverage trace ${relative(root, join(directory, name))}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    files: [...seen].sort(),
    unmapped: [],
    failures,
    branchPolicy: 'AST executable source ranges; every trace requires a source map.',
  };
}
/** @param {import('istanbul-lib-coverage').CoverageSummary} summary */
function metrics(summary) {
  return {
    lines: summary.lines,
    branches: summary.branches,
    functions: summary.functions,
    statements: summary.statements,
  };
}
/** @param {string} root @param {import('istanbul-lib-coverage').CoverageMap} map */
function coverageResults(root, map) {
  /** @type {Record<string,ReturnType<typeof metrics>>} */
  const modules = {};
  /** @type {Map<string,import('istanbul-lib-coverage').CoverageSummary>} */
  const packages = new Map();
  const failures = [];
  for (const file of map.files().sort()) {
    const path = relative(root, file),
      summary = map.fileCoverageFor(file).toSummary();
    modules[path] = metrics(summary);
    const packageName = path.split('/')[1] ?? path;
    const aggregate = packages.get(packageName) ?? libCoverage.createCoverageSummary();
    aggregate.merge(summary);
    packages.set(packageName, aggregate);
    failures.push(...thresholdFailures(path, summary));
  }
  const packageResults = Object.fromEntries([...packages].map(([name, summary]) => [name, metrics(summary)]));
  for (const [name, summary] of packages) {
    // A module failure already fails the gate; avoid duplicate package diagnostics.
    if (failures.some((failure) => failure.startsWith(`packages/${name}/`))) continue;
    failures.push(...thresholdFailures(`Package ${name}`, summary));
  }
  return {
    thresholds,
    total: metrics(map.getCoverageSummary()),
    packages: packageResults,
    modules,
    failures,
  };
}
/** @param {string} root @param {import('istanbul-lib-coverage').CoverageMap} map */
async function omittedModules(root, map) {
  const included = new Set(map.files()),
    missing = [];
  for await (const path of glob('packages/*/src/**/*.ts', { cwd: root })) {
    if (included.has(join(root, path))) continue;
    const executableCode = await executable(join(root, path));
    const ast = parse(executableCode.code, { sourceType: 'module', plugins: ['estree'] });
    if (
      ast.program.body.every(
        (node) =>
          node.type === 'ExportNamedDeclaration' &&
          !node.declaration &&
          !node.source &&
          !node.specifiers.length,
      )
    )
      map.addFileCoverage(libCoverage.createFileCoverage(join(root, path)));
    else missing.push(`Component omitted from coverage: ${path}`);
  }
  return missing;
}
/** @param {string} root @param {string} directory */
export async function completeCoverage(root, directory) {
  const filename = join(root, 'coverage/coverage-final.json');
  const initial = await readFile(filename, 'utf8').catch(() => '{}');
  const map = libCoverage.createCoverageMap(JSON.parse(initial));
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'coverage'), { recursive: true }));
  const children = await mergeChildCoverage(root, directory, map);
  const missing = await omittedModules(root, map);
  const result = { ...coverageResults(root, map), children };
  result.failures.push(...children.failures);
  result.failures.push(...children.unmapped.map((file) => `Missing executable coverage map: ${file}`));
  result.failures.push(...missing);
  await writeFile(filename, JSON.stringify(map.toJSON()));
  await writeFile(join(root, '.quality/coverage.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

/** @param {string} root @param {import('istanbul-lib-coverage').CoverageMap} map @param {Record<string,import('istanbul-lib-coverage').FileCoverageData>} mapped @param {Set<string>} seen */
function mergeScript(root, map, mapped, seen) {
  for (const [file, coverage] of Object.entries(mapped)) {
    if (!/^packages\/[^/]+\/src\/.*\.ts$/u.test(relative(root, file))) continue;
    seen.add(relative(root, file));
    if (map.files().includes(file)) mergeCounters(map.fileCoverageFor(file), coverage);
    else map.merge({ [file]: coverage });
  }
}

/** @param {import('istanbul-lib-coverage').Range} loc */
function startKey(loc) {
  return JSON.stringify(loc.start);
}
/** Source starts identify executable AST nodes; unmatched branches stay uncovered.
 * @param {import('istanbul-lib-coverage').FileCoverage} base
 * @param {import('istanbul-lib-coverage').FileCoverageData} child */
function mergeCounters(base, child) {
  mergeLines(base, child);
  const branches = new Map();
  for (const [id, branch] of Object.entries(child.branchMap))
    branch.locations.forEach((_loc, index) =>
      branches.set(
        branchKey(branch, index),
        Math.max(branches.get(branchKey(branch, index)) ?? 0, child.b[id]?.[index] ?? 0),
      ),
    );
  for (const [id, branch] of Object.entries(base.branchMap))
    base.b[id] = branch.locations.map((_loc, index) =>
      Math.max(base.b[id]?.[index] ?? 0, branches.get(branchKey(branch, index)) ?? 0),
    );
  const functions = new Map(
    Object.entries(child.fnMap).map(([id, fn]) => [startKey(fn.decl), child.f[id] ?? 0]),
  );
  for (const [id, fn] of Object.entries(base.fnMap))
    base.f[id] = Math.max(base.f[id] ?? 0, functions.get(startKey(fn.decl)) ?? 0);
}

/** @param {import('istanbul-lib-coverage').FileCoverage} base @param {import('istanbul-lib-coverage').FileCoverageData} child */
function mergeLines(base, child) {
  const lines = new Map();
  for (const [id, loc] of Object.entries(child.statementMap))
    lines.set(loc.start.line, Math.max(lines.get(loc.start.line) ?? 0, child.s[id] ?? 0));
  for (const [id, loc] of Object.entries(base.statementMap))
    base.s[id] = Math.max(base.s[id] ?? 0, lines.get(loc.start.line) ?? 0);
}

/** @param {import('istanbul-lib-coverage').BranchMapping} branch @param {number} index */
function branchKey(branch, index) {
  return JSON.stringify([branch.type, branch.loc.start, branch.locations[index]?.start, index]);
}

/** @param {string} name @param {import('istanbul-lib-coverage').CoverageSummary} summary */
function thresholdFailures(name, summary) {
  if (summary.lines.pct >= thresholds.lines && summary.branches.pct >= thresholds.branches) return [];
  return [
    `${name}: ${summary.lines.pct}% lines / ${summary.branches.pct}% branches (requires ${thresholds.lines}% / ${thresholds.branches}%)`,
  ];
}
