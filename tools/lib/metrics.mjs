import { parse } from 'java-parser';
import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, readlink, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { qualityTools } from './quality-tools.mjs';

/** @param {string} directory @param {RegExp} pattern @returns {Promise<string[]>} */
export async function sourceFiles(directory, pattern) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !['build', 'dist', 'target', 'node_modules'].includes(entry.name))
      files.push(...(await sourceFiles(path, pattern)));
    else if (entry.isFile() && pattern.test(entry.name)) files.push(path);
  }
  return files.sort();
}
/** @param {import('eslint').Linter.LintMessage} message @param {RegExp} pattern */
function measured(message, pattern) {
  return Number(pattern.exec(message.message)?.[1] ?? 0);
}
/** @param {string} root */
async function javascriptMetrics(root) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.mjs'],
        rules: {
          complexity: ['warn', { max: 0, variant: 'classic' }],
          'max-depth': ['warn', 0],
          'max-lines-per-function': [
            'warn',
            { max: 0, skipBlankLines: true, skipComments: true, IIFEs: true },
          ],
        },
      },
    ],
  });
  const files = await eslint.lintFiles(['packages/*/src/**/*.ts', 'tools/**/*.mjs', 'eslint.config.mjs']);
  const modules = files.map((result) => javascriptModule(root, result));
  return { modules, failures: modules.flatMap((module) => module.failures) };
}
/** @param {string} root @param {import('eslint').ESLint.LintResult} result */
function javascriptModule(root, result) {
  const path = relative(root, result.filePath);
  const functions = result.messages
    .filter((m) => m.ruleId === 'complexity')
    .map((message) => {
      const size = result.messages.find(
        (m) =>
          m.ruleId === 'max-lines-per-function' && m.line === message.line && m.column === message.column,
      );
      return {
        name: message.message.replace(/ has a complexity.*$/u, ''),
        line: message.line,
        column: message.column,
        cyclomatic: measured(message, /complexity of (\d+)/u),
        lines: size ? measured(size, /\((\d+)\)/u) : (message.endLine ?? message.line) - message.line + 1,
      };
    });
  const depth = Math.max(
    0,
    ...result.messages.filter((m) => m.ruleId === 'max-depth').map((m) => measured(m, /\((\d+)\)/u)),
  );
  const failures = functions
    .filter((f) => f.cyclomatic > 10 || f.lines > 80)
    .map((f) => `${path}:${f.line}: complexity ${f.cyclomatic}, lines ${f.lines}`);
  if (depth > 4) failures.push(`${path}: nesting ${depth}`);
  failures.push(
    ...result.messages.filter((m) => m.severity === 2).map((m) => `${path}:${m.line}: ${m.message}`),
  );
  return { path, language: path.endsWith('.ts') ? 'typescript' : 'javascript', depth, functions, failures };
}
/** Measure each executable independently; nested lambdas do not inflate their parent.
 * @param {import('java-parser').CstNode} node
 * @returns {number} */
function javaDecisions(node) {
  if (['methodDeclaration', 'constructorDeclaration', 'lambdaExpression'].includes(node.name)) return 0;
  let count = 0;
  for (const values of Object.values(node.children))
    for (const child of values) {
      if ('children' in child) count += javaDecisions(child);
      else if (['if', 'for', 'while', 'catch', 'case', '?', '&&', '||'].includes(child.image)) count++;
    }
  return count;
}
/** @param {import('java-parser').CstNode} node
 * @returns {{name:string,line:number,cyclomatic:number}[]} */
function javaFunctions(node) {
  const nested = Object.values(node.children)
    .flat()
    .filter((v) => 'children' in v)
    .flatMap((v) => javaFunctions(v));
  if (!['methodDeclaration', 'constructorDeclaration', 'lambdaExpression'].includes(node.name)) return nested;
  const complexity = Object.values(node.children)
    .flat()
    .filter((v) => 'children' in v)
    .reduce((sum, v) => sum + javaDecisions(v), 1);
  return [{ name: node.name, line: node.location?.startLine ?? 1, cyclomatic: complexity }, ...nested];
}
/** @param {string} root */
async function nativeMetrics(root) {
  const paths = [
    ...(await sourceFiles(join(root, 'android'), /\.java$/u)),
    join(root, 'resources/VerifyRepositoryIndex.java'),
  ];
  const modules = [];
  for (const path of paths) {
    const functions = javaComplexity(await readFile(path, 'utf8')),
      file = relative(root, path);
    modules.push({
      path: file,
      language: 'java',
      depth: 0,
      functions,
      failures: functions
        .filter((f) => f.cyclomatic > 10)
        .map((f) => `${file}:${f.line}: complexity ${f.cyclomatic}`),
    });
  }
  return { modules, failures: modules.flatMap((m) => m.failures) };
}
/** @param {string} root */
export async function sourceIdentity(root) {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path + '\0');
    const metadata = await lstat(join(root, path)).catch(() => undefined);
    if (!metadata) hash.update('deleted');
    else
      hash.update(
        metadata.isSymbolicLink() ? await readlink(join(root, path)) : await readFile(join(root, path)),
      );
  }
  return {
    sha256: hash.digest('hex'),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    files: paths.length,
  };
}
/** @param {string} root @returns {Promise<Record<string,string>>} */
async function installedVersions(root) {
  const names = [
    '@typescript/native',
    'typescript',
    'typescript-eslint',
    'eslint',
    'java-parser',
    'expect',
    'ast-v8-to-istanbul',
    '@babel/parser',
  ];
  const entries = await Promise.all(
    names.map(async (name) => {
      /** @type {{version:string}} */
      const data = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      return [name, data.version];
    }),
  );
  return Object.fromEntries(entries);
}
/** @returns {Record<string,string>} */
function nativeVersions() {
  return Object.fromEntries(
    ['javac', 'pnpm'].map((name) => [
      name,
      execFileSync(name, [name === 'javac' ? '-version' : '--version'], {
        encoding: 'utf8',
        timeout: 10_000,
      }).trim(),
    ]),
  );
}
/** @param {string} root */
export async function writeMetrics(root) {
  const [javascript, native, source, tools] = await Promise.all([
    javascriptMetrics(root),
    nativeMetrics(root),
    sourceIdentity(root),
    qualityTools(),
  ]);
  const modules = [...javascript.modules, ...native.modules];
  const report = {
    schemaVersion: 1,
    source,
    tools: {
      node: process.versions.node,
      ...nativeVersions(),
      ...(await installedVersions(root)),
      ...Object.fromEntries(Object.entries(tools).map(([name, t]) => [name, t.version])),
    },
    thresholds: { cyclomatic: 10, javascriptDepth: 4, javascriptFunctionLines: 80 },
    methods: {
      javascript: 'ESLint classic cyclomatic complexity; nonblank noncomment function lines',
      native: 'java-parser CST cyclomatic complexity; methods, constructors and lambdas independently',
    },
    modules,
    failures: [...javascript.failures, ...native.failures],
  };
  await mkdir(join(root, '.quality'), { recursive: true });
  await writeFile(join(root, '.quality/metrics.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

/** @param {string} source */
export function javaComplexity(source) {
  return javaFunctions(parse(source));
}
