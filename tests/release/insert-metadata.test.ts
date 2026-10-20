import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from '../test-api.js';
import { renderBlankInsertMetadata, resolveInsertMetadata } from '@pxv/guides';
import { buildDocumentation } from '../../packages/release/src/docs.js';
import { product } from '../contracts/fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

it('resolves product fallback and replaces the complete contact with any project route', () => {
  expect(resolveInsertMetadata(product)).toEqual({
    support: `${product.support.name}: ${product.support.email} · ${product.support.url}`,
  });
  expect(resolveInsertMetadata(product, { projectName: 'Fleet' }).projectName).toBe('Fleet');
  for (const route of [
    { email: 'other@example.org' },
    { phone: '+48 123' },
    { url: 'https://other.example.org' },
  ]) {
    const resolved = resolveInsertMetadata(product, { support: { name: 'Private contact', ...route } });
    expect(resolved.support).toBe('Private contact: ' + Object.values(route)[0]);
    expect(resolved.support).not.toContain(product.support.email);
    expect(resolved.support).not.toContain(product.support.url);
  }
  expect(
    resolveInsertMetadata(product, {
      support: { name: 'Help', email: 'a@example.org', phone: '123', url: 'https://a.example.org' },
    }).support,
  ).toBe('Help: a@example.org · 123 · https://a.example.org');
});

it('requires the expected support field rather than silently dropping metadata', () => {
  expect(() => renderBlankInsertMetadata('# Missing', resolveInsertMetadata(product), 'en')).toThrow(
    'support field missing',
  );
});

it('personalizes only credential editions, retains generated Markdown and preserves authoritative sources', async () => {
  const output = await mkdtemp('/tmp/pxv-insert-metadata-');
  roots.push(output);
  const projectName = 'Zażółć <script> **literal** & [link](https://malicious.example) $& $$ $`';
  const support = { name: 'Help <b> **literal**', phone: '+48 ' + '123-'.repeat(65) };
  const templates = new Map<string, string>();
  for (const locale of ['en', 'pl'])
    templates.set(locale, await readFile(`guides/source/markdown/credentials-${locale}.md`, 'utf8'));
  await buildDocumentation(process.cwd(), output, { insertMetadata: { projectName, support } });
  for (const locale of ['en', 'pl']) {
    const markdown = await readFile(join(output, `source/markdown/credentials-${locale}.md`), 'utf8');
    const html = await readFile(join(output, `credentials-${locale}.html`), 'utf8');
    for (const content of [markdown, html]) {
      expect(content).toContain(
        'Zażółć &lt;script&gt; **literal** &amp; [link](https://malicious.example) $&amp; $$ $`',
      );
      expect(content).toContain('Help &lt;b&gt; **literal**: ' + support.phone);
      expect(content).not.toContain('<script>');
      expect(content).not.toContain('<a href="https://malicious.example');
      expect(content).not.toContain(product.support.email);
    }
    expect(markdown).toContain(locale === 'en' ? '<strong>Project:</strong>' : '<strong>Projekt:</strong>');
    expect(await readFile(`guides/source/markdown/credentials-${locale}.md`, 'utf8')).toBe(
      templates.get(locale),
    );
    expect(await readFile(join(output, `quickstart-${locale}.html`), 'utf8')).not.toContain(support.phone);
  }
  await expect(
    buildDocumentation(process.cwd(), join(process.cwd(), 'guides'), { insertMetadata: {} }),
  ).rejects.toThrow('outside');
  await expect(
    buildDocumentation(process.cwd(), join(output, 'invalid'), { insertMetadata: { support: {} } }),
  ).rejects.toThrow();
});
