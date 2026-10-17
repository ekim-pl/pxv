import type { CliIo } from './arguments.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function label(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replaceAll('-', ' ')
    .toLowerCase();
}
function quote(value: string): string {
  return /^[a-zA-Z0-9_./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
function nextSteps(value: unknown, executable: string, projectRoot: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const step = object(item);
    if (!step) return [];
    const command: unknown[] = Array.isArray(step['command']) ? step['command'] : [];
    return [
      ...(typeof step['description'] === 'string' ? [step['description']] : []),
      ...(command.length
        ? [`  ${[executable, ...command.map(String), '--project-root', projectRoot].map(quote).join(' ')}`]
        : []),
    ];
  });
}
function render(value: unknown, executable: string, projectRoot: string, depth = 0): string[] {
  if (Array.isArray(value)) {
    if (!value.length) return ['No items.'];
    return value.flatMap((item: unknown, index) => [
      `${index + 1}.`,
      ...render(item, executable, projectRoot, depth + 1).map((line) => `  ${line}`),
    ]);
  }
  const result = object(value);
  if (!result) return [primitive(value)];
  if (depth > 8) return [JSON.stringify(value)];
  return Object.entries(result).flatMap(([key, item]) =>
    renderEntry(key, item, executable, projectRoot, depth),
  );
}
function primitive(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return JSON.stringify(value) ?? 'Unavailable';
}
function metadata(key: string, item: unknown, executable: string, projectRoot: string): string[] | undefined {
  if (key === 'reviewSummary' && typeof item === 'string') return ['Exact review:', item];
  if (key === 'nextSteps') return ['Next steps:', ...nextSteps(item, executable, projectRoot)];
  if (key === 'currentStateVerified' && item === false)
    return ['Evidence: stored; current device state has not been verified.'];
  if (key === 'evidenceSource' && item === 'stored') return ['Evidence: stored run history.'];
  if (key !== 'nextCursor') return undefined;
  return typeof item === 'string'
    ? [`Next page: ${executable} agent runs --cursor ${quote(item)} --project-root ${quote(projectRoot)}`]
    : [];
}
function renderEntry(
  key: string,
  item: unknown,
  executable: string,
  projectRoot: string,
  depth: number,
): string[] {
  const special = metadata(key, item, executable, projectRoot);
  if (special) return special;
  if (item !== null && typeof item === 'object')
    return [`${label(key)}:`, ...render(item, executable, projectRoot, depth + 1).map((line) => `  ${line}`)];
  return [`${label(key)}: ${primitive(item)}`];
}
function combined(results: unknown[]): unknown {
  if (results.length === 1) return results[0];
  const plans = results.filter((result) => typeof object(result)?.['reviewSummary'] === 'string');
  const final = results.filter((result) => !plans.includes(result));
  if (plans.length === results.length) return { plans };
  if (plans.length && final.length === 1) return { plans, ...(object(final[0]) ?? { result: final[0] }) };
  return { results };
}
export function cliOutput(
  io: CliIo,
  json: boolean,
  executable: string,
  projectRoot: string,
): {
  output(this: void, result: unknown): void;
  flush(this: void): void;
} {
  const results: unknown[] = [];
  return {
    output: (result) => {
      if (json) {
        results.push(result);
        const review = object(result)?.['reviewSummary'];
        if (typeof review === 'string') io.error(review);
      } else io.out(render(result, executable, projectRoot).join('\n'));
    },
    flush: () => {
      if (json && results.length) io.out(JSON.stringify(combined(results), null, 2));
      results.length = 0;
    },
  };
}
