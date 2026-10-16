import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
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
const graph = new Map(Object.keys(allowed).map((name) => [name, new Set()]));
const errors = [];

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...(await files(join(directory, entry.name))));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(join(directory, entry.name));
  }
  return result;
}

for (const [name, dependencies] of Object.entries(allowed)) {
  const directory = join(root, 'packages', name, 'src');
  for (const file of await files(directory)) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      let dependency;
      if (specifier.startsWith('@pxv/')) dependency = specifier.slice(5).split('/')[0];
      if (specifier.startsWith('.')) {
        const path = resolve(dirname(file), specifier);
        const within = relative(join(root, 'packages', name), path);
        if (within.startsWith('..'))
          errors.push(`${relative(root, file)}: relative import crosses package boundary`);
      }
      if (dependency) {
        if (!dependencies.includes(dependency))
          errors.push(`${relative(root, file)}: ${name} cannot import ${specifier}`);
        graph.get(name).add(dependency);
      }
      if (
        name === 'contracts' &&
        /^(?:node:)?(?:child_process|sqlite|worker_threads|fs|net|http|https)(?:\/|$)/u.test(specifier)
      )
        errors.push(`${relative(root, file)}: domain contracts cannot import ${specifier}`);
    }
  }
}

const visiting = new Set();
const visited = new Set();
function cycle(name, path) {
  if (visiting.has(name)) {
    errors.push(`Dependency cycle: ${[...path, name].join(' -> ')}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) cycle(dependency, [...path, name]);
  visiting.delete(name);
  visited.add(name);
}
for (const name of graph.keys()) cycle(name, []);
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Package boundaries and dependency cycles checked (${graph.size} packages).\n`);
