import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** @param {string} value */
function decodedAttribute(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

/** @param {string} destination @param {string} file @param {string} href */
async function verifyLocalLink(destination, file, href) {
  const [path = '', fragment] = href.split('#');
  const target = await realpath(path ? resolve(dirname(file), decodeURIComponent(path)) : file);
  if (!target.startsWith(`${destination}${sep}`) || !(await stat(target)).isFile())
    throw Error(`Guide link is outside the public output or is not a file: ${file}: ${href}`);
  if (!fragment) return;
  const id = decodeURIComponent(fragment);
  const html = await readFile(target, 'utf8');
  if (![...html.matchAll(/\bid="([^"]+)"/gu)].some((match) => match[1] === id))
    throw Error(`Missing guide link fragment: ${file}: ${href}`);
}

/** Verify navigation in every generated page, including cross-edition fragments. @param {string} destination @param {string[]} files */
export async function verifyGuideLinks(destination, files) {
  const root = await realpath(destination);
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/\bhref=(?:"([^"]*)"|'([^']*)')/giu)) {
      const href = decodedAttribute(match[1] ?? match[2] ?? '');
      if (/^(?:https?:|mailto:)/iu.test(href)) continue;
      if (!href || /^(?:[a-z][a-z\d+.-]*:|\/)|[\\?\s\p{Cc}]/iu.test(href))
        throw Error(`Unsafe guide link: ${file}: ${href}`);
      await verifyLocalLink(root, file, href);
    }
  }
}
