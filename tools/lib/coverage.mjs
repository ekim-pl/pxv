import { readFile, readdir, writeFile, glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

/** @param {string} root @param {string} url */
function compiledModule(root, url) {
  if (!url.startsWith('file:')) return undefined;
  const file = fileURLToPath(url),
    path = relative(root, file);
  if (!/^packages\/[^/]+\/(?:dist\/.*\.js|src\/.*\.ts)$/u.test(path)) return undefined;
  return file;
}
/** @param {import('istanbul-lib-coverage').Range} location */
function rangeKey(location) {
  return JSON.stringify([location.start.line, location.start.column, location.end.line, location.end.column]);
}
/** Keep Vitest's executable maps: V8 line maps also contain erased types/comments.
 * Unmatched branch ranges remain uncovered instead of inferring a branch hit.
 * @param {import('istanbul-lib-coverage').FileCoverage} base
 * @param {import('istanbul-lib-coverage').FileCoverageData} child */
function mergeStatements(base, child) {
  const lines = new Map();
  for (const [id, location] of Object.entries(child.statementMap))
    lines.set(location.start.line, Math.max(lines.get(location.start.line) ?? 0, child.s[id] ?? 0));
  for (const [id, location] of Object.entries(base.statementMap))
    base.s[id] = Math.max(base.s[id] ?? 0, lines.get(location.start.line) ?? 0);
}
/** @param {import('istanbul-lib-coverage').FileCoverage} base
 * @param {import('istanbul-lib-coverage').FileCoverageData} child */
function mergeBranches(base, child) {
  const branches = new Map();
  for (const [id, branch] of Object.entries(child.branchMap))
    branch.locations.forEach((location, index) =>
      branches.set(
        rangeKey(location),
        Math.max(branches.get(rangeKey(location)) ?? 0, child.b[id]?.[index] ?? 0),
      ),
    );
  for (const [id, branch] of Object.entries(base.branchMap))
    base.b[id] = branch.locations.map((location, index) =>
      Math.max(base.b[id]?.[index] ?? 0, branches.get(rangeKey(location)) ?? 0),
    );
}
/** @param {import('istanbul-lib-coverage').FileCoverage} base
 * @param {import('istanbul-lib-coverage').FileCoverageData} child */
function mergeExecutableCounters(base, child) {
  mergeStatements(base, child);
  mergeBranches(base, child);
  const functions = new Map(
    Object.entries(child.fnMap).map(([id, fn]) => [rangeKey(fn.loc), child.f[id] ?? 0]),
  );
  for (const [id, fn] of Object.entries(base.fnMap))
    base.f[id] = Math.max(base.f[id] ?? 0, functions.get(rangeKey(fn.loc)) ?? 0);
}
/** @param {string} root @param {string} directory @param {import('istanbul-lib-coverage').CoverageMap} map */
async function mergeChildCoverage(root, directory, map) {
  const seen = new Set(),
    unmapped = new Set();
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    /** @type {{result:import('node:inspector').Profiler.ScriptCoverage[]}} */
    const data = JSON.parse(await readFile(join(directory, name), 'utf8'));
    for (const script of data.result) {
      const path = compiledModule(root, script.url);
      if (!path) continue;
      const converter = v8ToIstanbul(path);
      await converter.load();
      converter.applyCoverage(script.functions);
      const mapped = converter.toIstanbul();
      converter.destroy();
      for (const [file, coverage] of Object.entries(mapped)) {
        if (!/^packages\/[^/]+\/src\/.*\.ts$/u.test(relative(root, file))) continue;
        seen.add(relative(root, file));
        if (map.files().includes(file)) mergeExecutableCounters(map.fileCoverageFor(file), coverage);
        else unmapped.add(relative(root, file));
      }
    }
  }
  return {
    files: [...seen].sort(),
    unmapped: [...unmapped].sort(),
    branchPolicy: 'Exact source ranges only; unmatched child ranges do not imply coverage.',
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
    if (summary.lines.pct < 90 || summary.branches.pct < 85)
      failures.push(`${path}: ${summary.lines.pct}% lines / ${summary.branches.pct}% branches`);
  }
  const packageResults = Object.fromEntries([...packages].map(([name, summary]) => [name, metrics(summary)]));
  return {
    thresholds: { lines: 90, branches: 85 },
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
    if (!included.has(join(root, path))) missing.push(`Component omitted from coverage: ${path}`);
  }
  return missing;
}
/** @param {string} root @param {string} directory */
export async function completeCoverage(root, directory) {
  const filename = join(root, 'coverage/coverage-final.json');
  const map = libCoverage.createCoverageMap(JSON.parse(await readFile(filename, 'utf8')));
  const children = await mergeChildCoverage(root, directory, map);
  const result = { ...coverageResults(root, map), children };
  result.failures.push(...children.unmapped.map((file) => `Missing executable coverage map: ${file}`));
  result.failures.push(...(await omittedModules(root, map)));
  await writeFile(filename, JSON.stringify(map.toJSON()));
  await writeFile(join(root, '.quality/coverage.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
