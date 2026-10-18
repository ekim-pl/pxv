import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, extname, join, resolve, relative } from 'node:path';
import { marked } from 'marked';
const root = process.cwd();
const files = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'guides/README.md',
  'tests/acceptance/README.md',
];
/** @param {string} directory */
async function walk(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
}
for (const directory of ['docs', 'guides/source/markdown', 'policy-packs', 'tools/optional'])
  await walk(directory);
const errors = [];
/** @type {Map<string,Set<string>>} */
const anchorCache = new Map();
/** GitHub-style heading IDs, including repeated headings and explicit HTML anchors.
 * @param {string} text */
function documentAnchors(text) {
  const anchors = new Set();
  for (const token of marked.lexer(text)) {
    if (token.type !== 'heading') continue;
    const base = token.text
      .replace(/<[^>]*>/gu, '')
      .replace(/!?\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
      .replace(/\s/gu, '-');
    let anchor = base;
    let suffix = 0;
    while (anchors.has(anchor)) anchor = `${base}-${++suffix}`;
    anchors.add(anchor);
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/giu))
    anchors.add(match[1]);
  return anchors;
}

/** @param {string} target @param {string} fragment */
async function hasAnchor(target, fragment) {
  let anchors = anchorCache.get(target);
  if (!anchors) {
    anchors = documentAnchors(await readFile(target, 'utf8'));
    anchorCache.set(target, anchors);
  }
  return anchors.has(decodeURIComponent(fragment));
}
/** @param {string} text @returns {string[]} */
function documentLinks(text) {
  /** @type {string[]} */
  const links = [];
  marked.walkTokens(marked.lexer(text), (token) => {
    if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string')
      links.push(token.href);
  });
  return links;
}
for (const file of files) {
  const text = await readFile(join(root, file), 'utf8');
  if (
    /(?<!\w)(?:python3?\s+-m|pip3?\s+install|pxv_app|fdroidcl|PXV_PYTHON|--coverage\.(?:reportsDirectory|reporter)|rustfmt|[Cc]lippy)\b/u.test(
      text,
    )
  )
    errors.push(`${file}: obsolete application command`);
  for (const link of documentLinks(text)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(link)) continue;
    const [path, fragment] = link.split('#');
    const target = path ? resolve(root, dirname(file), decodeURIComponent(path)) : join(root, file);
    if (relative(root, target).startsWith('..')) {
      errors.push(`${file}: link escapes public repository`);
      continue;
    }
    if (
      !(await access(target).then(
        () => true,
        () => false,
      ))
    )
      errors.push(`${file}: missing ${link}`);
    else if (fragment && extname(target) === '.md' && !(await hasAnchor(target, fragment)))
      errors.push(`${file}: missing heading ${link}`);
  }
}
if (errors.length) {
  process.stderr.write(errors.join('\n') + '\n');
  process.exitCode = 1;
} else
  process.stdout.write(
    `Validated links, heading anchors and obsolete commands in ${files.length} public Markdown documents.\n`,
  );
