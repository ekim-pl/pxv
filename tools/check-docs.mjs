import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
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
for (const directory of ['docs', 'guides/source/markdown', 'policy-packs']) await walk(directory);
const errors = [];
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
  if (/\b(?:python3?\s+-m|pip3?\s+install|pxv_app|fdroidcl|PXV_PYTHON)\b/u.test(text))
    errors.push(`${file}: obsolete application command`);
  for (const link of documentLinks(text)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(link)) continue;
    const target = resolve(root, dirname(file), decodeURIComponent(link.split('#')[0] ?? ''));
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
  }
}
if (errors.length) {
  process.stderr.write(errors.join('\n') + '\n');
  process.exitCode = 1;
} else
  process.stdout.write(
    `Validated links and obsolete-command checks in ${files.length} public Markdown documents.\n`,
  );
