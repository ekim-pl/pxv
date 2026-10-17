import { describe, expect, it, vi } from 'vitest';
import { cliOutput } from '../../packages/cli/src/output.js';

describe('CLI output contracts', () => {
  it('renders stored state and actionable commands as human text by default', () => {
    const io = { out: vi.fn(), error: vi.fn() };
    const emitter = cliOutput(io, false, 'pxv', '/work/project');
    emitter.output({
      run: {
        id: 'run-1',
        status: 'pending',
        evidenceSource: 'stored',
        manualGate: 'normal_credentials',
        reviewExpiresAt: '2099-01-01T00:00:00Z',
        nextSteps: [
          {
            description: 'Complete the phone checkpoint before resuming.',
            command: ['agent', 'resume', '--run', 'run-1'],
            requiresConfirmation: true,
          },
        ],
      },
    });
    emitter.flush();
    expect(io.out).toHaveBeenCalledTimes(1);
    const text = io.out.mock.calls[0]?.[0] as string;
    expect(text).toContain('stored run history');
    expect(text).toContain('manual gate: normal_credentials');
    expect(text).toContain('review expires at: 2099-01-01');
    expect(text).toContain('pxv agent resume --run run-1 --project-root /work/project');
    expect(() => JSON.parse(text) as unknown).toThrow();
  });
  it('emits one JSON document combining all plans and the final run result', () => {
    const io = { out: vi.fn(), error: vi.fn() };
    const emitter = cliOutput(io, true, 'pxv', '/project');
    const reviewSummary = 'exact\r\nreview\n  ';
    emitter.output({ planId: 'a', reviewSummary, expiresAt: '2099-01-01T00:00:00Z' });
    emitter.output({ planId: 'b', reviewSummary: 'second', expiresAt: '2099-01-01T00:00:00Z' });
    emitter.output({ runs: [{ id: 'run-1', status: 'pending' }] });
    expect(io.out).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(reviewSummary);
    emitter.flush();
    expect(io.out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(io.out.mock.calls[0]?.[0] as string)).toEqual({
      plans: [
        { planId: 'a', reviewSummary, expiresAt: '2099-01-01T00:00:00Z' },
        { planId: 'b', reviewSummary: 'second', expiresAt: '2099-01-01T00:00:00Z' },
      ],
      runs: [{ id: 'run-1', status: 'pending' }],
    });
  });
  it('preserves the single-plan JSON interface and review bytes', () => {
    const io = { out: vi.fn(), error: vi.fn() };
    const emitter = cliOutput(io, true, 'pxv', '/project');
    const prepared = { planId: 'id', reviewSummary: 'EXACT\r\nBYTES\n', expiresAt: '2099-01-01T00:00:00Z' };
    emitter.output(prepared);
    emitter.flush();
    expect(JSON.parse(io.out.mock.calls[0]?.[0] as string)).toEqual(prepared);
    emitter.flush();
    expect(io.out).toHaveBeenCalledTimes(1);
  });
  it('renders empty inventory and a stored readiness report without implying live verification', () => {
    const io = { out: vi.fn(), error: vi.fn() };
    const emitter = cliOutput(io, false, 'pxv', '/project');
    emitter.output({ schemaVersion: 1, devices: [] });
    emitter.output([
      {
        assetId: 'phone',
        ready: false,
        currentStateVerified: false,
        missing: ['verified_boot'],
        optional: null,
      },
    ]);
    expect(io.out.mock.calls[0]?.[0]).toBe('schema version: 1\ndevices:\n  No items.');
    expect(io.out.mock.calls[1]?.[0]).toContain('current device state has not been verified');
    expect(io.out.mock.calls[1]?.[0]).toContain('verified_boot');
    expect(io.out.mock.calls[1]?.[0]).toContain('optional: None');
  });
  it('shows human review bytes and quotes continuation commands for paths and cursors containing spaces', () => {
    const io = { out: vi.fn(), error: vi.fn() };
    const emitter = cliOutput(io, false, 'pxv', "/work/operator's project");
    const reviewSummary = 'EXACT\r\nREVIEW  \n';
    emitter.output({ planId: 'review', reviewSummary, expiresAt: '2099-01-01T00:00:00Z' });
    emitter.output({ items: [{ key: 'run', value: { status: 'pending' } }], nextCursor: 'next page' });
    emitter.output({ items: [], nextCursor: null });
    expect(io.out.mock.calls[0]?.[0]).toContain(reviewSummary);
    const continuation = io.out.mock.calls[1]?.[0] as string;
    expect(continuation).toContain("--cursor 'next page'");
    expect(continuation).toContain("--project-root '/work/operator'\\''s project'");
    expect(io.out.mock.calls[2]?.[0]).not.toContain('Next page');
  });
  it('preserves nested observation details and tolerates unavailable optional next-step metadata', () => {
    const io = { out: vi.fn(), error: vi.fn() };
    const emitter = cliOutput(io, false, 'pxv', '/project');
    let details: unknown = { result: 'retained', count: 0 };
    for (let index = 0; index < 10; index++) details = { details };
    emitter.output({
      details,
      nextSteps: [
        null,
        { description: 'Inspect the phone.' },
        { command: ['device', 'inspect', '--asset', 'phone'] },
        {},
      ],
    });
    emitter.output({ nextSteps: undefined, raw: undefined });
    emitter.output(null);
    expect(io.out.mock.calls[0]?.[0]).toContain('retained');
    expect(io.out.mock.calls[0]?.[0]).toContain('Inspect the phone.');
    expect(io.out.mock.calls[0]?.[0]).toContain('pxv device inspect --asset phone');
    expect(io.out.mock.calls[1]?.[0]).toContain('raw: None');
    expect(io.out.mock.calls[2]?.[0]).toBe('None');
  });
  it('emits all dry-run fleet reviews in one JSON envelope and keeps non-plan output coherent', () => {
    const io = { out: vi.fn(), error: vi.fn() };
    const emitter = cliOutput(io, true, 'pxv', '/project');
    const first = { planId: 'first', reviewSummary: 'FIRST', expiresAt: '2099-01-01T00:00:00Z' };
    const second = { ...first, planId: 'second', reviewSummary: 'SECOND' };
    emitter.output(first);
    emitter.output(second);
    emitter.flush();
    expect(JSON.parse(io.out.mock.calls[0]?.[0] as string)).toEqual({ plans: [first, second] });
    emitter.output(first);
    emitter.output(null);
    emitter.flush();
    expect(JSON.parse(io.out.mock.calls[1]?.[0] as string)).toEqual({ plans: [first], result: null });
    emitter.output({ phase: 'one' });
    emitter.output({ phase: 'two' });
    emitter.flush();
    expect(JSON.parse(io.out.mock.calls[2]?.[0] as string)).toEqual({
      results: [{ phase: 'one' }, { phase: 'two' }],
    });
  });
});
