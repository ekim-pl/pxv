import { AdapterError } from './command.js';
import type { UiNode } from './ui-snapshot.js';

const SESSION_PACKAGE = 'network.loki.messenger';

export function normalizeSessionId(value: string): string | undefined {
  const normalized = value.trim();
  return /^05[0-9a-fA-F]{64}$/u.test(normalized) ? normalized.toLowerCase() : undefined;
}

/** Read only the account's own settings field, never arbitrary IDs in conversations. */
export function readSessionAccountId(nodes: UiNode[]): string {
  const matches = nodes.filter(
    (node) =>
      node.attributes['package'] === SESSION_PACKAGE &&
      ['Account ID', 'shareAccountId'].some(
        (id) =>
          node.attributes['resource-id'] === `${SESSION_PACKAGE}:id/${id}` ||
          node.attributes['resource-id'] === id ||
          node.attributes['content-desc'] === id,
      ),
  );
  if (matches.length !== 1 || matches[0]?.attributes['password'] === 'true')
    throw new AdapterError('Own Session account field is missing or ambiguous');
  const value = normalizeSessionId(matches[0]?.attributes['text'] ?? '');
  if (!value) throw new AdapterError('Own Session account ID is unavailable');
  return value;
}
