import { globSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
/** @typedef {{name?:string,dependencies?:Record<string,string>,devDependencies?:Record<string,string>,optionalDependencies?:Record<string,string>,peerDependencies?:Record<string,string>}} Manifest */
/** @param {string} root @returns {Map<string,Manifest>} */
export function manifests(root) {
  return new Map(
    ['package.json', ...globSync('packages/*/package.json', { cwd: root })].map((path) => [
      path,
      JSON.parse(readFileSync(join(root, path), 'utf8')),
    ]),
  );
}
/** @param {string} root @param {string} file @param {Map<string,Manifest>} packages */
export function owner(root, file, packages) {
  const parts = relative(root, file).split('/');
  const path = parts[0] === 'packages' ? parts.slice(0, 2).join('/') + '/package.json' : 'package.json';
  return packages.has(path) ? path : 'package.json';
}
/** @param {Manifest} pkg @param {boolean} development */
function declarations(pkg, development) {
  return new Set(
    Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
      ...(development ? pkg.devDependencies : {}),
    }),
  );
}
/** @param {Map<string,Manifest>} packages @param {string} path @param {string} name */
function workspaceHarness(packages, path, name) {
  return path === 'package.json' && [...packages.values()].some((pkg) => pkg.name === name);
}
/** @param {Map<string,Set<string>>} uses @param {string} path @param {string} name */
function useDependency(uses, path, name) {
  const names = uses.get(path) ?? new Set();
  names.add(name);
  uses.set(path, names);
}
/** @param {Map<string,Manifest>} packages @param {Map<string,Set<string>>} uses @param {string} path @param {string} name @param {string} mode @param {boolean} typeOnly */
export function missingDependency(packages, uses, path, name, mode, typeOnly) {
  useDependency(uses, path, name);
  const pkg = packages.get(path) ?? {};
  const allowed = declarations(pkg, mode === 'development' || path === 'package.json' || typeOnly);
  return pkg.name !== name && !workspaceHarness(packages, path, name) && !allowed.has(name);
}
/** @param {Map<string,Manifest>} packages @param {Map<string,Set<string>>} uses @param {string} mode */
export function unusedDependencies(packages, uses, mode) {
  const findings = [];
  for (const [path, pkg] of packages) {
    const names = declarations(pkg, mode === 'development');
    for (const name of names)
      if (!uses.get(path)?.has(name)) findings.push(`Unused dependency: ${name} (${dirname(path)})`);
  }
  return findings;
}
