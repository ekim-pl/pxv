import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { qualityReport } from '../../tools/lib/quality-report.mjs';
import type { writeMetrics } from '../../tools/lib/metrics.mjs';
type Metrics = Awaited<ReturnType<typeof writeMetrics>>;
const roots: string[] = [];
const source = { sha256: 'a'.repeat(64), revision: 'revision', files: 1 };
const coverage = {
  failures: [],
  total: { lines: { pct: 100 }, branches: { pct: 90 } },
  modules: { 'packages/example/src/index.ts': { lines: { pct: 100 }, branches: { pct: 90 } } },
};
const evidence: Record<string, unknown> = {
  deadcode: {
    reports: [
      { mode: 'development', status: 'passed' },
      { mode: 'production', status: 'passed' },
    ],
  },
  coverage,
  tests: { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: 12, numTotalTests: 12 },
  helpers: { status: 'passed' },
};
async function writeEvidence(root: string, name: string, value: unknown = evidence[name]) {
  await writeFile(join(root, '.quality', `${name}.json`), JSON.stringify(value));
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pxv-quality-report-'));
  roots.push(root);
  await mkdir(join(root, '.quality'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@12.11.2', devDependencies: { typescript: '7.0.2' } }),
  );
  const metrics: Metrics = {
    schemaVersion: 1,
    source,
    tools: { node: '24.22.0' },
    thresholds: { cyclomatic: 10, javascriptDepth: 4, javascriptFunctionLines: 80 },
    methods: { javascript: 'ESLint classic complexity', native: 'Rust Code Analysis' },
    modules: [
      {
        path: 'packages/example/src/index.ts',
        language: 'typescript',
        depth: 1,
        functions: [{ name: 'example', line: 1, column: 1, cyclomatic: 2, lines: 5 }],
        failures: [],
      },
    ],
    failures: [],
  };
  const stages: string[] = [];
  const dependencies = {
    source: () => Promise.resolve(source),
    metrics: () => Promise.resolve(metrics),
    now: () => new Date('2026-10-16T12:00:00Z'),
    run: async (stage: string) => {
      stages.push(stage);
      if (stage === 'check') await writeEvidence(root, 'deadcode');
      if (stage === 'test:coverage') {
        await writeEvidence(root, 'coverage');
        await writeEvidence(root, 'tests');
      }
      if (stage === 'check:helpers') await writeEvidence(root, 'helpers');
    },
  };
  return { root, metrics, dependencies, stages };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('quality report acceptance evidence', () => {
  it('passes only for unchanged sources, regenerated evidence and final metrics', async () => {
    const { root, dependencies, stages } = await fixture();
    const calls: string[] = [];
    const originalRun = dependencies.run;
    dependencies.run = async (stage) => {
      calls.push(stage);
      await originalRun(stage);
    };
    dependencies.source = () => {
      calls.push('source');
      return Promise.resolve(source);
    };
    const report = await qualityReport(root, dependencies);
    expect(report.status).toBe('passed');
    expect(report.sourceUnchanged).toBe(true);
    expect(calls).toEqual(['source', 'check', 'test:native', 'test:coverage', 'check:helpers']);
    expect(stages).toHaveLength(4);
    expect(Object.values(report.evidence).every((item) => item.current)).toBe(true);
    expect(report.declaredVersions.packageManager).toBe('pnpm@12.11.2');
    expect(JSON.parse(await readFile(join(root, '.quality/report.json'), 'utf8'))).toMatchObject({
      status: 'passed',
      tools: { node: '24.22.0' },
    });
    const markdown = await readFile(join(root, '.quality/report.md'), 'utf8');
    expect(markdown).toContain('Tests: 12 passed / 12 total; 0 failed.');
    expect(markdown).toContain('| packages/example/src/index.ts | typescript | 1 | 2 | 100% | 90% |');
  });
  it('writes a failed report if the final metric gate rejects a module', async () => {
    const { root, dependencies, metrics } = await fixture();
    metrics.failures.push('example.ts: complexity 11');
    const report = await qualityReport(root, dependencies);
    expect(report.status).toBe('failed');
    expect(report.failures).toContain('Final metrics failed: example.ts: complexity 11');
    expect(await readFile(join(root, '.quality/report.md'), 'utf8')).toContain('Status: **failed**');
  });
  it('rejects a source revision changed while stages ran', async () => {
    const { root, dependencies, metrics } = await fixture();
    metrics.source = { ...source, sha256: 'b'.repeat(64) };
    const report = await qualityReport(root, dependencies);
    expect(report.status).toBe('failed');
    expect(report.sourceUnchanged).toBe(false);
    expect(report.initialSource?.sha256).toBe(source.sha256);
    expect(report.failures).toContain('Source changed while quality stages ran');
  });
  it('retains old evidence without presenting it as current after a stage failure', async () => {
    const { root, dependencies } = await fixture();
    await Promise.all(Object.keys(evidence).map((name) => writeEvidence(root, name)));
    const originalRun = dependencies.run;
    dependencies.run = async (stage) => {
      if (stage === 'test:coverage') throw new Error('Coverage worker failed');
      await originalRun(stage);
    };
    const report = await qualityReport(root, dependencies);
    expect(report.status).toBe('failed');
    expect(report.stages.at(-1)).toEqual({
      stage: 'test:coverage',
      status: 'failed',
      error: 'Coverage worker failed',
    });
    expect(report.evidence['coverage']).toMatchObject({ status: 'present', current: false, value: coverage });
    expect(report.evidence['helpers']?.current).toBe(false);
    const markdown = await readFile(join(root, '.quality/report.md'), 'utf8');
    expect(markdown).toContain('Current test counts unavailable.');
    expect(markdown).not.toContain('| 100% | 90% |');
  });
  it('rejects stale reports even if a stage returns successfully without regenerating them', async () => {
    const { root, dependencies } = await fixture();
    await Promise.all(Object.keys(evidence).map((name) => writeEvidence(root, name)));
    dependencies.run = () => Promise.resolve();
    const report = await qualityReport(root, dependencies);
    expect(report.status).toBe('failed');
    expect(Object.values(report.evidence).every((item) => !item.current)).toBe(true);
    expect(report.failures).toHaveLength(4);
  });
  it('writes a failed report when metrics cannot be collected', async () => {
    const { root, dependencies } = await fixture();
    dependencies.metrics = () => Promise.reject(new Error('Analyzer unavailable'));
    const report = await qualityReport(root, dependencies);
    expect(report.status).toBe('failed');
    expect(report.metrics).toBeNull();
    expect(report.sourceUnchanged).toBe(false);
    expect(report.failures).toContain('Final metrics unavailable: Analyzer unavailable');
    expect(JSON.parse(await readFile(join(root, '.quality/report.json'), 'utf8'))).toMatchObject({
      status: 'failed',
      source: null,
    });
  });
  it.each([
    ['deadcode', { reports: [] }],
    ['coverage', { ...coverage, failures: ['uncovered module'] }],
    ['helpers', { status: 'failed' }],
    ['tests', { success: false, numFailedTests: 1, numFailedTestSuites: 0 }],
  ])('rejects failed or incomplete %s evidence after its stage succeeds', async (name, value) => {
    const { root, dependencies } = await fixture();
    const originalRun = dependencies.run;
    dependencies.run = async (stage) => {
      await originalRun(stage);
      if (stage === 'check:helpers') await writeEvidence(root, String(name), value);
    };
    const report = await qualityReport(root, dependencies);
    expect(report.status).toBe('failed');
    expect(report.failures).toContain(`Current ${String(name)} evidence did not pass`);
  });
});
