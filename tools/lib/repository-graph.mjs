import { manifests, owner, missingDependency, unusedDependencies } from './repository-dependencies.mjs';
import ts from 'typescript';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
/** @typedef {import('typescript').Symbol} Symbol */
/** @typedef {{entries:string[],public:string[],requireContexts?:Record<string,string>,dependencies:{package:string,name:string,reason:string}[],exemptions:{mode:string,finding:string,reason:string}[]}} Config */
/** @typedef {{root:string,config:Config,checker:import('typescript').TypeChecker,options:import('typescript').CompilerOptions,program:import('typescript').Program,files:string[],entries:string[],graph:Map<string,Set<string>>,references:Map<Symbol,Set<string>>,publicReferences:Set<Symbol>,signatures:Map<Symbol,Set<Symbol>>,packages:ReturnType<typeof manifests>,dependencies:Map<string,Set<string>>,mode:string,findings:string[]}} Context */
/** @param {string} name */
const packageName = (name) =>
  name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : (name.split('/')[0] ?? name);
/** @param {string} root @param {string[]} patterns */
function expand(root, patterns) {
  return patterns.flatMap((p) => globSync(p, { cwd: root })).map((p) => resolve(root, p));
}
/** @param {string} root @param {string} mode @returns {Context} */
function context(root, mode) {
  /** @type {Config} */ const config = JSON.parse(
    readFileSync(join(root, 'tools/repository-graph.json'), 'utf8'),
  );
  const tests = mode === 'development' ? ['tests/**/*.ts'] : [];
  const files = expand(root, ['packages/*/src/**/*.ts', 'tools/**/*.mjs', 'eslint.config.mjs', ...tests]);
  const entries = expand(root, [
    ...config.entries,
    ...(mode === 'development' ? ['tests/**/*.test.ts'] : []),
  ]);
  const options = {
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    paths: { '@pxv/*': ['./packages/*/src/index.ts'] },
    baseUrl: root,
  };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, file) => names.map((name) => resolveImport(root, options, file, name));
  const program = ts.createProgram(files, options, host);
  return {
    root,
    config,
    files,
    entries,
    options,
    program,
    checker: program.getTypeChecker(),
    graph: new Map(),
    references: new Map(),
    publicReferences: new Set(),
    signatures: new Map(),
    packages: manifests(root),
    dependencies: new Map(),
    mode,
    findings: [],
  };
}
/** @param {Context} c @param {Symbol | undefined} symbol */
function target(c, symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? c.checker.getAliasedSymbol(symbol) : symbol;
}
/** @param {Context} c @param {string} file @param {string} name @param {Set<string>} edges @param {boolean} [typeOnly] @param {boolean} [commonjs] */
function importEdge(c, file, name, edges, typeOnly = false, commonjs = false) {
  if (isBuiltin(name)) return;
  if (name.startsWith('node:')) {
    c.findings.push(`Unresolved import ${relative(c.root, file)}: ${name}`);
    return;
  }
  const from = resolutionContext(c, file, commonjs);
  checkImportDependency(c, from, name, typeOnly);
  const resolved = resolveImport(c.root, c.options, from, name);
  if (!resolved) c.findings.push(`Unresolved import ${relative(c.root, file)}: ${name}`);
  else if (!resolved.isExternalLibraryImport || name.startsWith('@pxv/'))
    edges.add(resolve(resolved.resolvedFileName));
}
/** Compiled workspace imports consume their source exports in the repository graph.
 * @param {string} root @param {import('typescript').CompilerOptions} options
 * @param {string} file @param {string} name */
function resolveImport(root, options, file, name) {
  if (name.startsWith('.')) {
    const path = relative(root, resolve(dirname(file), name));
    if (/^packages\/[^/]+\/dist\/.*\.js$/u.test(path)) {
      const source = join(root, path.replace('/dist/', '/src/').replace(/\.js$/u, '.ts'));
      if (ts.sys.fileExists(source))
        return { resolvedFileName: source, isExternalLibraryImport: false, extension: ts.Extension.Ts };
    }
  }
  return ts.resolveModuleName(name, file, options, ts.sys).resolvedModule;
}
/** @param {import('typescript').Node} node */
function referenceNode(node) {
  if (!ts.isIdentifier(node)) return false;
  if (ts.isExportSpecifier(node.parent) || ts.isImportSpecifier(node.parent)) return false;
  return !('name' in node.parent) || node.parent.name !== node || ts.isPropertyAccessExpression(node.parent);
}
/** @param {Context} c @param {string} file */
function scan(c, file) {
  const source = c.program.getSourceFile(file);
  if (!source) throw new Error('Repository graph omitted ' + file);
  const edges = new Set();
  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (referenceNode(node)) {
      const symbol = target(c, c.checker.getSymbolAtLocation(node));
      if (symbol) {
        const uses = c.references.get(symbol) ?? new Set();
        uses.add(file);
        c.references.set(symbol, uses);
        signatureReference(c, node, symbol);
      }
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier))
        importEdge(c, file, specifier.text, edges, typeImport(node));
    }
    const dynamic = dynamicSpecifier(c, node, source);
    if (dynamic) importEdge(c, file, dynamic, edges, ts.isImportTypeNode(node), commonJS(c, node, source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const comment of source.text.matchAll(/\/\*\*[\s\S]*?\*\//gu))
    for (const match of comment[0].matchAll(/import\(['"]([^'"]+)['"]\)/gu))
      importEdge(c, file, match[1] ?? '', edges);
  c.graph.set(file, edges);
}
/** @param {Context} c */
function reachableFiles(c) {
  const reached = new Set();
  /** @param {string} file */
  const walk = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const edge of c.graph.get(file) ?? []) walk(edge);
  };
  c.entries.forEach(walk);
  return reached;
}
/** @param {Context} c @param {string} file */
function exportsOf(c, file) {
  const source = c.program.getSourceFile(file);
  const symbol = source && c.checker.getSymbolAtLocation(source);
  return symbol ? c.checker.getExportsOfModule(symbol) : [];
}
/** @param {Context} c */
function checkExports(c) {
  for (const file of c.config.public)
    for (const symbol of exportsOf(c, resolve(c.root, file))) {
      const original = target(c, symbol);
      if (original) c.publicReferences.add(original);
    }
  exposeSignatureTypes(c);
  const reached = reachableFiles(c);
  for (const file of c.files) {
    if (!reached.has(file)) {
      c.findings.push('Unreachable file: ' + relative(c.root, file));
      continue;
    }
    for (const symbol of exportsOf(c, file)) {
      if (typedefOnly(symbol)) continue;
      const original = target(c, symbol);
      if (original && !externallyUsed(c, original))
        c.findings.push(`Unused export: ${relative(c.root, file)}#${symbol.name}`);
    }
  }
}
/** @param {Context} c @param {string} mode */
function checkDependencies(c, mode) {
  for (const entry of c.config.dependencies) {
    const pkg = c.packages.get(entry.package);
    if (!entry.reason || !pkg) {
      c.findings.push('Invalid implicit dependency: ' + entry.name);
      continue;
    }
    const used = c.dependencies.get(entry.package)?.has(entry.name);
    if (used) c.findings.push('Stale implicit dependency: ' + entry.name);
    if (missingDependency(c.packages, c.dependencies, entry.package, entry.name, 'development', false))
      c.findings.push('Missing dependency: ' + entry.name + ' (' + entry.package + ')');
  }
  c.findings.push(...unusedDependencies(c.packages, c.dependencies, mode));
}
/** @param {Context} c @param {string} mode */
function exemptions(c, mode) {
  const used = new Set();
  const findings = c.findings.filter((finding) => {
    const e = c.config.exemptions.find((v) => v.mode === mode && v.finding === finding && v.reason);
    if (e) {
      used.add(e);
      return false;
    }
    return true;
  });
  for (const e of c.config.exemptions)
    if (e.mode === mode && !used.has(e)) findings.push('Stale exemption: ' + e.finding);
  return findings;
}
/** @param {string} root @param {string} mode */
export function checkGraph(root, mode) {
  const c = context(root, mode);
  c.files.forEach((file) => scan(c, file));
  checkExports(c);
  checkDependencies(c, mode);
  const findings = exemptions(c, mode);
  return { mode, status: findings.length ? 'failed' : 'passed', findings, diagnostics: '' };
}

/** @param {Context} c @param {import('typescript').Node} node @param {import('typescript').SourceFile} source */
function dynamicSpecifier(c, node, source) {
  if (
    ts.isCallExpression(node) &&
    (['import', 'importModule'].includes(node.expression.getText(source)) || commonJS(c, node, source))
  ) {
    const arg = node.arguments[0];
    if (arg && ts.isStringLiteral(arg)) return arg.text;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  )
    return node.argument.literal.text;
  return undefined;
}

/** @param {Context} c @param {string} file @param {string} name @param {boolean} typeOnly */
function checkImportDependency(c, file, name, typeOnly) {
  if (name.startsWith('.') || name.startsWith('/')) return;
  const path = owner(c.root, file, c.packages);
  if (missingDependency(c.packages, c.dependencies, path, packageName(name), c.mode, typeOnly))
    c.findings.push(`Missing dependency: ${packageName(name)} (${relative(c.root, file)})`);
}
/** @param {Context} c @param {Symbol} symbol */
function externallyUsed(c, symbol) {
  if (c.publicReferences.has(symbol)) return true;
  const definitions = new Set(symbol.declarations?.map((node) => resolve(node.getSourceFile().fileName)));
  return [...(c.references.get(symbol) ?? [])].some((file) => !definitions.has(file));
}
/** @param {import('typescript').ImportDeclaration | import('typescript').ExportDeclaration} node */
function typeImport(node) {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  const clause = node.importClause;
  if (clause?.isTypeOnly) return true;
  const bindings = clause?.namedBindings;
  return (
    !clause?.name &&
    !!bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((v) => v.isTypeOnly)
  );
}

/** @param {Symbol} symbol */
function typedefOnly(symbol) {
  return symbol.declarations?.every((node) => ts.isJSDocTypedefTag(node));
}

/** @param {Context} c @param {import('typescript').Node} node @param {import('typescript').SourceFile} source */
function commonJS(c, node, source) {
  if (!ts.isCallExpression(node)) return false;
  const expression =
    ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve'
      ? node.expression.expression
      : node.expression;
  if (expression.getText(source) === 'require') return true;
  const symbol = c.checker.getSymbolAtLocation(expression);
  return (
    symbol?.declarations?.some(
      (decl) => ts.isVariableDeclaration(decl) && !!decl.initializer && requireFactory(c, decl.initializer),
    ) ?? requireFactory(c, expression)
  );
}
/** @param {Context} c @param {import('typescript').Node} node */
function requireFactory(c, node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'createRequire')
    return nodeModuleBinding(c, expression.expression);
  const symbol = c.checker.getSymbolAtLocation(expression);
  return (
    symbol?.declarations?.some(
      (decl) =>
        ts.isImportSpecifier(decl) &&
        (decl.propertyName ?? decl.name).text === 'createRequire' &&
        nodeModuleDeclaration(decl),
    ) ?? false
  );
}
/** @param {Context} c @param {import('typescript').Node} node */
function nodeModuleBinding(c, node) {
  return c.checker.getSymbolAtLocation(node)?.declarations?.some(nodeModuleDeclaration) ?? false;
}
/** @param {import('typescript').Node} node */
function nodeModuleDeclaration(node) {
  let parent = node.parent;
  while (parent && !ts.isSourceFile(parent)) {
    if (ts.isImportDeclaration(parent))
      return (
        ts.isStringLiteral(parent.moduleSpecifier) &&
        ['node:module', 'module'].includes(parent.moduleSpecifier.text)
      );
    parent = parent.parent;
  }
  return false;
}
/** Types in consumed signatures remain externally available, including inferred public class members.
 * @param {Context} c @param {import('typescript').Node} node @param {Symbol} symbol */
function signatureReference(c, node, symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Type)) return;
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isBlock(current)) return;
    if (ts.isDeclarationStatement(current) && current.name) {
      const parent = c.checker.getSymbolAtLocation(current.name);
      if (parent) {
        const dependencies = c.signatures.get(parent) ?? new Set();
        dependencies.add(symbol);
        c.signatures.set(parent, dependencies);
      }
      return;
    }
    current = current.parent;
  }
}
/** @param {Context} c */
function exposeSignatureTypes(c) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [symbol, types] of c.signatures) {
      if (!externallyUsed(c, symbol)) continue;
      for (const type of types) {
        if (c.publicReferences.has(type)) continue;
        c.publicReferences.add(type);
        changed = true;
      }
    }
  }
}

/** @param {Context} c @param {string} file @param {boolean} commonjs */
function resolutionContext(c, file, commonjs) {
  const context = commonjs && c.config.requireContexts?.[relative(c.root, file)];
  return context ? resolve(c.root, context) : file;
}
