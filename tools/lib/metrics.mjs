import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, readlink, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { qualityExecutable, qualityTools } from './quality-tools.mjs';

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
  const files = await eslint.lintFiles([
    'packages/*/src/**/*.ts',
    'tools/**/*.mjs',
    'guides/source/rebuild.mjs',
    'eslint.config.mjs',
    'vitest.config.ts',
  ]);
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
/** @typedef {{name:string,kind:string,start_line:number,end_line:number,spaces:RcaSpace[],metrics:{cyclomatic:{sum:number},cognitive:{sum:number}}}} RcaSpace */
/** @param {RcaSpace} space @returns {{name:string,line:number,cyclomatic:number,cognitive:number}[]} */
function rcaFunctions(space) {
  const nested = space.spaces.flatMap(rcaFunctions);
  if (space.kind !== 'function' && space.kind !== 'closure') return nested;
  const children = space.spaces.reduce((sum, item) => sum + item.metrics.cyclomatic.sum, 0);
  return [
    {
      name: space.name,
      line: space.start_line,
      cyclomatic: space.metrics.cyclomatic.sum - children,
      cognitive: space.metrics.cognitive.sum,
    },
    ...nested,
  ];
}
/** @param {string} root */
async function nativeMetrics(root) {
  const executable = await qualityExecutable('rca');
  const paths = [
    ...(await sourceFiles(join(root, 'native/supervisor'), /\.rs$/u)),
    ...(await sourceFiles(join(root, 'android'), /\.java$/u)),
    join(root, 'resources/VerifyRepositoryIndex.java'),
  ];
  const modules = paths.map((path) => {
    const parseErrors = execFileSync(executable, ['-f', 'ERROR', '-p', path], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (parseErrors.trim())
      throw new Error(`Native metric parser rejected ${relative(root, path)}: ${parseErrors}`);
    /** @type {RcaSpace} */
    const result = JSON.parse(
      execFileSync(executable, ['-m', '-p', path, '-O', 'json'], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    const functions = rcaFunctions(result),
      file = relative(root, path);
    return {
      path: file,
      language: path.endsWith('.rs') ? 'rust' : 'java',
      cognitiveMetric: path.endsWith('.rs') ? 'rust-code-analysis' : 'unsupported by pinned analyzer',
      functions: functions.map((fn) => ({ ...fn, cognitive: path.endsWith('.rs') ? fn.cognitive : null })),
      failures: functions
        .filter((f) => f.cyclomatic > 10)
        .map((f) => `${file}:${f.line}: complexity ${f.cyclomatic}`),
    };
  });
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
  const names = ['@typescript/native', 'typescript', 'typescript-eslint', 'eslint', 'knip', 'vitest'];
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
    ['rustc', 'cargo', 'javac', 'pnpm'].map((name) => [
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
      native: 'Pinned Rust Code Analysis; local cyclomatic excluding nested function totals',
    },
    modules,
    failures: [...javascript.failures, ...native.failures],
  };
  await mkdir(join(root, '.quality'), { recursive: true });
  await writeFile(join(root, '.quality/metrics.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
