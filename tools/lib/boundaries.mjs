import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const allowed = {
  contracts: [],
  runtime: ['contracts'],
  adapters: ['contracts', 'runtime'],
  engine: ['contracts', 'runtime'],
  extensions: ['contracts', 'runtime'],
  'extension-sdk': ['contracts'],
  guides: ['contracts', 'runtime'],
  mcp: ['contracts', 'engine', 'extensions', 'runtime'],
  cli: ['contracts', 'runtime', 'adapters', 'engine', 'extensions', 'guides', 'mcp'],
  release: ['contracts', 'runtime', 'guides'],
};
/** @param {string} directory @returns {Promise<string[]>} */
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(path);
  }
  return result;
}
/** @param {import('typescript').Node} node */
function dynamicImport(node) {
  if (!ts.isCallExpression(node)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0];
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') return node.arguments[0];
  return undefined;
}
/** @param {import('typescript').SourceFile} source */
function imports(source) {
  /** @type {{specifier:string,runtime:boolean}[]} */
  const result = [];
  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push({ specifier: node.moduleSpecifier.text, runtime: !node.importClause?.isTypeOnly });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      result.push({ specifier: node.moduleSpecifier.text, runtime: !node.isTypeOnly });
    } else {
      const value = dynamicImport(node);
      if (value && ts.isStringLiteral(value)) result.push({ specifier: value.text, runtime: true });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}
/** @param {Map<string,Set<string>>} graph @returns {string[]} */
function cycles(graph) {
  const visiting = new Set(),
    visited = new Set();
  /** @type {string[]} */
  const errors = [];
  /** @param {string} name @param {string[]} path */
  function visit(name, path) {
    if (visiting.has(name)) {
      errors.push(`Dependency cycle: ${[...path, name].join(' -> ')}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name, []);
  return errors;
}
/** @param {string} root @param {string} name @param {string} file @param {string} specifier */
function importError(root, name, file, specifier) {
  if (
    specifier.startsWith('.') &&
    relative(join(root, 'packages', name), resolve(dirname(file), specifier)).startsWith('..')
  )
    return `${relative(root, file)}: relative import crosses package boundary`;
  if (
    name === 'contracts' &&
    /^(?:node:)?(?:child_process|sqlite|worker_threads|fs|net|http|https)(?:\/|$)/u.test(specifier)
  )
    return `${relative(root, file)}: domain contracts cannot import ${specifier}`;
  return undefined;
}
/** @param {string} root @param {string} file @param {string} specifier */
function moduleTarget(root, file, specifier) {
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier).replace(/\.js$/u, '.ts');
  if (specifier.startsWith('@pxv/')) {
    const [name, ...subpath] = specifier.slice(5).split('/');
    if (name)
      return join(root, 'packages', name, 'src', subpath.length ? subpath.join('/') + '.ts' : 'index.ts');
  }
  return undefined;
}
/** @param {string} root @returns {Promise<{errors:string[],packages:number,modules:number}>} */
export async function checkBoundaries(root) {
  /** @type {Map<string, Set<string>>} */
  const graph = new Map(Object.keys(allowed).map((name) => [name, new Set()]));
  /** @type {Map<string, Set<string>>} */
  const modules = new Map();
  const errors = [];
  for (const [name, dependencies] of Object.entries(allowed)) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }));
    for (const file of await files(join(root, 'packages', name, 'src'))) {
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const edges = new Set();
      modules.set(file, edges);
      for (const item of imports(source)) {
        const problem = importError(root, name, file, item.specifier);
        if (problem) errors.push(problem);
        validateWorkspaceImport({ root, name, file, dependencies, declared, graph, errors }, item.specifier);
        const target = moduleTarget(root, file, item.specifier);
        if (target && item.runtime) edges.add(target);
      }
    }
  }
  return {
    errors: [...errors, ...cycles(graph), ...cycles(modules)],
    packages: graph.size,
    modules: modules.size,
  };
}
/** @param {{root:string,name:string,file:string,dependencies:string[],declared:Set<string>,graph:Map<string,Set<string>>,errors:string[]}} context @param {string} specifier */
function validateWorkspaceImport(context, specifier) {
  if (!specifier.startsWith('@pxv/')) return;
  const { root, name, file, dependencies, declared, graph, errors } = context;
  const dependency = specifier.slice(5).split('/')[0];
  if (!dependency || !dependencies.includes(dependency))
    errors.push(`${relative(root, file)}: ${name} cannot import ${specifier}`);
  if (!declared.has(`@pxv/${dependency}`))
    errors.push(`${relative(root, file)}: missing declared dependency ${specifier}`);
  if (dependency) graph.get(name)?.add(dependency);
}
