import { posix } from 'node:path';

export interface GuideEdition {
  sourcePath: string;
  outputPath: string;
  html: string;
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function headingIds(html: string): string {
  const counts = new Map<string, number>();
  return html.replace(
    /<h([1-6])(\s[^>]*)?>(.*?)<\/h\1>/gisu,
    (heading: string, level: string, attributes: string | undefined, text: string) => {
      if (/\bid\s*=/iu.test(attributes ?? '')) return heading;
      const base =
        text
          .replace(/<[^>]*>/gu, '')
          .replace(/&[^;]+;/gu, '')
          .normalize('NFKC')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
          .trim()
          .replace(/\s+/gu, '-') || 'section';
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      return `<h${level}${attributes ?? ''} id="${id}">${text}</h${level}>`;
    },
  );
}

function relativeTarget(
  edition: GuideEdition,
  path: string,
  sources: Map<string, string>,
  files: Set<string>,
): string | undefined {
  const authored = posix.normalize(posix.join(posix.dirname(edition.sourcePath), path));
  const output = posix.normalize(posix.join(posix.dirname(edition.outputPath), path));
  const target = sources.get(authored) ?? sources.get(`guides/${output}`);
  if (target) return target;
  const copied = authored.startsWith('guides/') ? authored.slice('guides/'.length) : undefined;
  if (copied && files.has(copied)) return copied;
  return files.has(output) ? output : undefined;
}

function fragmentExists(target: string, fragment: string, pages: Map<string, string>): boolean {
  if (!fragment) return true;
  const id = decode(fragment);
  const html = pages.get(target);
  if (!id || !html) return false;
  return [...html.matchAll(/\bid="([^"]+)"/gu)].some((match) => match[1] === id);
}

function localHref(
  href: string,
  edition: GuideEdition,
  sources: Map<string, string>,
  files: Set<string>,
  pages: Map<string, string>,
): string | undefined {
  const [path = '', fragment] = href.split('#');
  const decoded = decode(path);
  if (decoded === undefined || /[\\?\p{Cc}]/u.test(decoded) || decoded.startsWith('/')) return undefined;
  const target = decoded ? relativeTarget(edition, decoded, sources, files) : edition.outputPath;
  if (!target) return undefined;
  if (fragment !== undefined && !fragmentExists(target, fragment, pages)) return undefined;
  return relativeHref(edition.outputPath, target, Boolean(decoded), fragment);
}

function relativeHref(output: string, target: string, path: boolean, fragment?: string): string | undefined {
  const relative = path
    ? posix.relative(posix.dirname(output), target).split('/').map(encodeURIComponent).join('/')
    : '';
  return `${relative}${fragment === undefined ? '' : `#${fragment}`}` || undefined;
}

function safeHref(
  href: string,
  edition: GuideEdition,
  sources: Map<string, string>,
  files: Set<string>,
  pages: Map<string, string>,
): string | undefined {
  if (href.trim() !== href || /[\\\s\p{Cc}]/u.test(href)) return undefined;
  if (/^(?:https?:|mailto:)/iu.test(href)) return href;
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(href)) return undefined;
  return localHref(href, edition, sources, files, pages);
}

/** Keep navigation inside this build's public outputs, independent of stale output files. */
export function guideNavigation(editions: GuideEdition[], publicFiles: string[]): GuideEdition[] {
  const prepared = editions.map((edition) => ({ ...edition, html: headingIds(edition.html) }));
  const pages = new Map(prepared.map(({ outputPath, html }) => [outputPath, html]));
  const sources = new Map(prepared.map(({ sourcePath, outputPath }) => [sourcePath, outputPath]));
  const files = new Set([...publicFiles, ...pages.keys()]);
  return prepared.map((edition) => ({
    ...edition,
    html: edition.html.replace(/<a\b[^>]*>/giu, (anchor) =>
      anchor.replace(
        /\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu,
        (_attribute, double: string | undefined, single: string | undefined, plain: string | undefined) => {
          const href = safeHref(double ?? single ?? plain ?? '', edition, sources, files, pages);
          return href === undefined ? '' : ` href="${href.replaceAll('"', '&quot;')}"`;
        },
      ),
    ),
  }));
}
