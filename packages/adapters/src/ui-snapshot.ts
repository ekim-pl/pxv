import type { UiSelector } from '@pxv/contracts';
import { AdapterError } from './command.js';
export interface UiNode {
  attributes: Record<string, string>;
}
function decodeXml(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(value))
    throw new AdapterError('UI XML contains unsupported entities');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_match: string, entity: string) => {
    const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const named = known[entity];
    if (named) return named;
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      throw new AdapterError('UI XML contains invalid codepoints');
    return String.fromCodePoint(code);
  });
}
/** A strict parser for the bounded hierarchy/node-only uiautomator format. No DTDs. */
export function parseUiSnapshot(xml: string): UiNode[] {
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!|<\?[^x]|[\0]/.test(xml))
    throw new AdapterError('UI snapshot exceeds limits or uses unsupported XML');
  const hierarchy = new UiHierarchy();
  let cursor = 0;
  for (const token of xml.matchAll(/<[^>]*>/g)) {
    if (xml.slice(cursor, token.index).trim()) throw new AdapterError('UI snapshot contains unexpected text');
    cursor = token.index + token[0].length;
    hierarchy.token(token[0], token.index);
  }
  hierarchy.complete(xml.slice(cursor));
  return hierarchy.nodes;
}
export function matchUiNode(
  nodes: readonly UiNode[],
  selector: UiSelector,
  packageId: string,
): UiNode | undefined {
  const names: Record<string, string> = {
    resourceId: 'resource-id',
    text: 'text',
    description: 'content-desc',
    checked: 'checked',
  };
  const matches = nodes.filter(
    (node) =>
      node.attributes['package'] === packageId &&
      node.attributes['enabled'] === 'true' &&
      Object.entries(selector).every(([key, value]) => node.attributes[names[key] ?? ''] === String(value)),
  );
  if (matches.length > 1) throw new AdapterError('UI selector is ambiguous; review the pinned recipe');
  return matches[0];
}
class UiHierarchy {
  readonly nodes: UiNode[] = [];
  private readonly stack: string[] = [];
  private roots = 0;
  token(raw: string, at: number): void {
    if (
      /^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])UTF-8\2)?(?:\s+standalone=(["'])(yes|no)\3)?\s*\?>$/i.test(
        raw,
      )
    ) {
      if (at !== 0) throw new AdapterError('UI XML declaration is misplaced');
      return;
    }
    const close = /^<\/(hierarchy|node)\s*>$/.exec(raw);
    if (close?.[1]) {
      if (this.stack.pop() !== close[1]) throw new AdapterError('UI XML nesting is malformed');
      return;
    }
    this.open(raw);
  }
  private open(raw: string): void {
    const opening = /^<(hierarchy|node)(\s[\s\S]*?)?\s*(\/?)>$/.exec(raw);
    if (!opening?.[1]) throw new AdapterError('UI XML contains unsupported elements');
    const tag = opening[1];
    this.root(tag);
    const attributes = parseAttributes(opening[2] ?? '');
    if (tag === 'node') {
      this.nodes.push({ attributes });
      if (this.nodes.length > 10_000) throw new AdapterError('UI snapshot contains too many nodes');
    }
    if (!opening[3]) {
      this.stack.push(tag);
      if (this.stack.length > 100) throw new AdapterError('UI XML nesting exceeds limits');
    }
  }
  private root(tag: string): void {
    if (tag === 'hierarchy') {
      if (this.stack.length || this.roots++) throw new AdapterError('UI hierarchy root is ambiguous');
    } else if (!this.stack.length || this.stack[0] !== 'hierarchy')
      throw new AdapterError('UI node is outside the hierarchy');
  }
  complete(trailing: string): void {
    if (trailing.trim() || this.roots !== 1 || this.stack.length)
      throw new AdapterError('UI XML hierarchy is incomplete');
  }
}
function parseAttributes(source: string): Record<string, string> {
  const attributes = Object.create(null) as Record<string, string>;
  let last = 0;
  for (const attribute of source.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"<>]*)"/g)) {
    if (source.slice(last, attribute.index).trim()) throw new AdapterError('UI XML attributes are malformed');
    const name = attribute[1],
      value = attribute[2];
    if (!name || value === undefined || Object.hasOwn(attributes, name))
      throw new AdapterError('UI XML attributes are duplicated');
    attributes[name] = decodeXml(value);
    last = attribute.index + attribute[0].length;
  }
  if (source.slice(last).trim()) throw new AdapterError('UI XML attributes are malformed');
  return attributes;
}
