import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {Awaited<ReturnType<typeof import('./metrics.mjs').writeMetrics>>} Metrics */
/** @typedef {Awaited<ReturnType<typeof import('./metrics.mjs').sourceIdentity>>} Source */
/** @typedef {{stage:string,status:'passed'|'failed',error?:string}} Stage */
/** @typedef {{path:string,current:boolean,status:'present'|'unavailable',value:unknown,fingerprint?:string,error?:string}} Evidence */
/** @typedef {{run(stage:string):Promise<void>,metrics(root:string):Promise<Metrics>,source(root:string):Promise<Source>,now?:()=>Date}} Dependencies */
const STAGES = ['check', 'test:supervisor', 'test:coverage', 'check:helpers'];
/** @type {[string,string][]} */
const EVIDENCE = [
  ['deadcode', 'check'],
  ['coverage', 'test:coverage'],
  ['tests', 'test:coverage'],
  ['helpers', 'check:helpers'],
];

/** @param {unknown} error */
function failure(error) {
  return error instanceof Error ? error.message : 'Unknown quality verification failure';
}
/** @param {string} root @param {string} name @returns {Promise<Evidence>} */
async function readEvidence(root, name) {
  const path = `.quality/${name}.json`;
  try {
    const metadata = await stat(join(root, path), { bigint: true });
    return {
      path,
      current: false,
      status: 'present',
      fingerprint: `${metadata.ino}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.size}`,
      value: JSON.parse(await readFile(join(root, path), 'utf8')),
    };
  } catch (error) {
    return { path, current: false, status: 'unavailable', value: null, error: failure(error) };
  }
}
/** @param {string} root @returns {Promise<Record<string,Evidence>>} */
async function evidenceSnapshot(root) {
  const entries = await Promise.all(EVIDENCE.map(async ([name]) => [name, await readEvidence(root, name)]));
  return Object.fromEntries(entries);
}
/** @param {string} root @param {Stage[]} stages @param {Record<string,Evidence>} previous */
async function evidenceFor(root, stages, previous) {
  const evidence = await evidenceSnapshot(root);
  for (const [name, stage] of EVIDENCE) {
    const item = evidence[name];
    if (item)
      item.current =
        item.status === 'present' &&
        item.fingerprint !== previous[name]?.fingerprint &&
        stages.some((value) => value.stage === stage && value.status === 'passed');
  }
  return evidence;
}
/** @param {unknown} value @returns {Record<string,unknown>|undefined} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string,unknown>} */ (value)
    : undefined;
}
/** @param {unknown} value */
function deadcodePassed(value) {
  if (!Array.isArray(value)) return false;
  return (
    ['development', 'production'].every((mode) =>
      value.some((row) => {
        const item = record(row);
        return item?.mode === mode && item.status === 'passed';
      }),
    ) && value.every((row) => record(row)?.status === 'passed')
  );
}
/** @param {string} name @param {unknown} value */
function evidenceValid(name, value) {
  const data = record(value);
  if (!data) return false;
  if (name === 'deadcode') return deadcodePassed(data.reports);
  if (name === 'helpers') return data.status === 'passed';
  if (name === 'tests')
    return data.success === true && data.numFailedTests === 0 && data.numFailedTestSuites === 0;
  return (
    Array.isArray(data.failures) &&
    data.failures.length === 0 &&
    !!record(data.total) &&
    !!record(data.modules)
  );
}
/** @param {Record<string,Evidence>} evidence */
function evidenceFailures(evidence) {
  const failures = [];
  for (const [name, item] of Object.entries(evidence)) {
    if (!item.current || item.status !== 'present')
      failures.push(`Current ${name} evidence is unavailable or was not regenerated`);
    else if (!evidenceValid(name, item.value)) failures.push(`Current ${name} evidence did not pass`);
  }
  return failures;
}
/** @param {Dependencies} dependencies @param {Stage[]} stages */
async function runStages(dependencies, stages) {
  for (const stage of STAGES) {
    try {
      await dependencies.run(stage);
      stages.push({ stage, status: 'passed' });
    } catch (error) {
      stages.push({ stage, status: 'failed', error: failure(error) });
      throw error;
    }
  }
}
/** @param {string} root */
async function declaredVersions(root) {
  try {
    const pkg = record(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
    return {
      packageManager: pkg?.packageManager ?? null,
      developmentDependencies: pkg?.devDependencies ?? null,
    };
  } catch {
    return { packageManager: null, developmentDependencies: null };
  }
}
/** @param {string} root @param {Dependencies} dependencies */
async function verify(root, dependencies) {
  /** @type {Stage[]} */ const stages = [];
  /** @type {string[]} */ const failures = [];
  /** @type {Source|undefined} */ let initial;
  /** @type {Metrics|undefined} */ let metrics;
  try {
    initial = await dependencies.source(root);
    await runStages(dependencies, stages);
  } catch (error) {
    failures.push(failure(error));
  }
  try {
    metrics = await dependencies.metrics(root);
  } catch (error) {
    failures.push(`Final metrics unavailable: ${failure(error)}`);
  }
  if (metrics?.failures.length) failures.push(`Final metrics failed: ${metrics.failures.join('; ')}`);
  if (initial && metrics && initial.sha256 !== metrics.source.sha256)
    failures.push('Source changed while quality stages ran');
  return { stages, failures, initial, metrics };
}
/** @param {Source|undefined} initial @param {Source|undefined} final */
function sameSource(initial, final) {
  return !!initial && !!final && initial.sha256 === final.sha256;
}
/** @param {string} root @param {Dependencies} dependencies */
export async function qualityReport(root, dependencies) {
  const now = dependencies.now ?? (() => new Date()),
    startedAt = now().toISOString();
  const previous = await evidenceSnapshot(root);
  const { stages, failures, initial, metrics } = await verify(root, dependencies);
  const evidence = await evidenceFor(root, stages, previous);
  failures.push(...evidenceFailures(evidence));
  const report = {
    schemaVersion: 1,
    status: failures.length ? 'failed' : 'passed',
    startedAt,
    checkedAt: now().toISOString(),
    initialSource: initial ?? null,
    source: metrics?.source ?? null,
    sourceUnchanged: sameSource(initial, metrics?.source),
    tools: metrics?.tools ?? null,
    declaredVersions: await declaredVersions(root),
    stages,
    metrics: metrics ?? null,
    evidence,
    failures,
  };
  await mkdir(join(root, '.quality'), { recursive: true });
  await writeFile(join(root, '.quality/report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(root, '.quality/report.md'), renderReport(report));
  return report;
}
/** @param {unknown} value */
function cell(value) {
  return String(value)
    .replaceAll('|', '\\|')
    .replace(/[\r\n]/gu, ' ');
}
/** @param {unknown} value */
function percent(value) {
  const item = record(value);
  return typeof item?.pct === 'number' ? `${item.pct}%` : 'unavailable';
}
/** @param {unknown} value @param {string} path */
function moduleCoverage(value, path) {
  return record(record(value)?.modules)?.[path];
}
/** @param {Metrics['modules'][number]} module @param {unknown} coverage */
function moduleRow(module, coverage) {
  const measured = record(moduleCoverage(coverage, module.path));
  const complexity = Math.max(0, ...module.functions.map((fn) => fn.cyclomatic));
  return `| ${cell(module.path)} | ${module.language} | ${module.functions.length} | ${complexity} | ${percent(measured?.lines)} | ${percent(measured?.branches)} |`;
}
/** @param {Awaited<ReturnType<typeof qualityReport>>} report */
function evidenceSummary(report) {
  return Object.entries(report.evidence)
    .map(([name, item]) => `- ${name}: ${item.current ? 'current' : 'retained or unavailable'}; ${item.path}`)
    .join('\n');
}
/** @param {unknown} value */
function testSummary(value) {
  const data = record(value);
  return `Tests: ${cell(data?.numPassedTests ?? 'unavailable')} passed / ${cell(data?.numTotalTests ?? 'unavailable')} total; ${cell(data?.numFailedTests ?? 'unavailable')} failed.`;
}
/** @param {Awaited<ReturnType<typeof qualityReport>>} report @param {string} name */
function currentEvidence(report, name) {
  const item = report.evidence[name];
  return item?.current ? item.value : undefined;
}
/** @param {Awaited<ReturnType<typeof qualityReport>>} report */
function renderReport(report) {
  const coverage = currentEvidence(report, 'coverage');
  const rows = report.metrics?.modules.map((module) => moduleRow(module, coverage)).join('\n') ?? '';
  const stages = report.stages
    .map((stage) => `- ${stage.stage}: ${stage.status}${stage.error ? ` — ${cell(stage.error)}` : ''}`)
    .join('\n');
  const failures = report.failures.map((value) => `- ${cell(value)}`).join('\n');
  const tests = currentEvidence(report, 'tests')
    ? testSummary(currentEvidence(report, 'tests'))
    : 'Current test counts unavailable.';
  return `# pxv quality verification\n\nStatus: **${report.status}**. Checked: ${report.checkedAt}.\n\nSource: ${report.source?.sha256 ?? 'unavailable'}. Source unchanged during stages: ${report.sourceUnchanged}.\n\n## Stages\n\n${stages || 'No stage completed.'}\n\n${failures ? `## Failures\n\n${failures}\n\n` : ''}## Evidence\n\n${tests}\n\n${evidenceSummary(report)}\n\nActual analyzer/runtime versions and declared dependency versions are recorded separately in report.json.\n\n## Per-module evidence\n\nOnly current coverage appears below. Coverage percentages apply to TypeScript application packages; native/Java and build-tool metrics have separate checks. Retained evidence from incomplete stages is not current acceptance.\n\n| Module | Language | Functions | Maximum cyclomatic | Lines | Branches |\n| --- | --- | ---: | ---: | ---: | ---: |\n${rows}\n`;
}
