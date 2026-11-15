import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from '../test-api.js';
import { renderBlankInsertMetadata, resolveInsertMetadata } from '@pxv/guides';
import { buildDocumentation } from '../../packages/release/src/docs.js';
import { createGuideFixture, product } from './guide-fixture.js';

const roots: string[] = [];
let source: string;
beforeEach(async () => {
  source = await createGuideFixture();
  roots.push(source);
});
const editions = ['operator', 'user', 'quickstart', 'credentials'].flatMap((kind) =>
  ['en', 'pl'].map((locale) => `${kind}-${locale}`),
);
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

it('resolves product fallback and replaces the complete contact with any project route', () => {
  expect(resolveInsertMetadata(product)).toEqual({
    support: `${product.support.email} · ${product.support.url}`,
  });
  expect(resolveInsertMetadata({ ...product, support: { ...product.support, name: 'Help desk' } })).toEqual({
    support: `Help desk: ${product.support.email} · ${product.support.url}`,
  });
  const matchingProduct = { ...product, support: { ...product.support, name: product.name } };
  expect(resolveInsertMetadata(matchingProduct)).toEqual({
    support: `${product.support.email} · ${product.support.url}`,
  });
  expect(
    resolveInsertMetadata(matchingProduct, { support: { name: product.name, phone: '+48 999' } }).support,
  ).toBe(`${product.name}: +48 999`);
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

it('personalizes every edition literally and preserves descriptive titles, commands and authoritative sources', async () => {
  const output = await mkdtemp('/tmp/pxv-insert-metadata-');
  roots.push(output);
  const projectName = 'Zażółć <script> **literal** & [link](https://malicious.example) $& $$ $`';
  const support = { name: 'Help <b> **literal**', phone: '+48 ' + '123-'.repeat(65) };
  const templates = new Map<string, string>();
  for (const edition of editions)
    templates.set(edition, await readFile(`guides/source/markdown/${edition}.md`, 'utf8'));
  await buildDocumentation(source, output, { insertMetadata: { projectName, support } });
  const escapedName =
    'Zażółć &lt;script&gt; **literal** &amp; [link](https://malicious.example) $&amp; $$ $`';
  for (const edition of editions) {
    const template = templates.get(edition)!;
    const originalTitle = template.split('\n')[0]!.slice(2);
    const markdown = await readFile(join(output, `source/markdown/${edition}.md`), 'utf8');
    const html = await readFile(join(output, `${edition}.html`), 'utf8');
    for (const content of [markdown, html]) {
      expect(content).toContain(escapedName);
      expect(content).toContain('Help &lt;b&gt; **literal**: ' + support.phone);
      expect(content).not.toContain('<script>');
      expect(content).not.toContain('<a href="https://malicious.example');
      expect(content).not.toContain(product.support.email);
      expect(content).not.toContain(product.name);
    }
    expect(markdown).toContain(`<p class="guide-subtitle">${originalTitle}</p>`);
    expect(html).toContain(`<p class="cover-subtitle">${originalTitle}</p>`);
    expect(/<h1\b[^>]*>(.*?)<\/h1>/su.exec(html)?.[1]).toBe(escapedName);
    expect(/<title>(.*?)<\/title>/su.exec(html)?.[1]).toContain(escapedName);
    expect(await readFile(`guides/source/markdown/${edition}.md`, 'utf8')).toBe(template);
    const supportLabel = edition.endsWith('-en') ? 'Support:' : 'Wsparcie:';
    expect(markdown).toContain(`<strong>${supportLabel}</strong>`);
    if (edition.startsWith('credentials')) {
      expect(markdown).toContain(
        edition.endsWith('-en') ? '<strong>Project:</strong>' : '<strong>Projekt:</strong>',
      );
    } else {
      expect(markdown).toContain('<p class="guide-support">');
    }
  }
  expect(await readFile(join(output, 'source/markdown/operator-en.md'), 'utf8')).toContain(
    'pxv project init --path "$P" --policy /absolute/path/to/reviewed-policy.json',
  );
  const index = await readFile(join(output, 'index.html'), 'utf8');
  expect(index).toContain(escapedName);
  expect(index).not.toContain(product.name);
  expect(await readFile(join(output, 'assets/brand.json'), 'utf8')).not.toContain(product.name);
});

it('preserves generic editions when no project metadata is supplied', async () => {
  const output = await mkdtemp('/tmp/pxv-generic-guides-');
  roots.push(output);
  await buildDocumentation(source, output);
  for (const edition of editions) {
    const template = await readFile(`guides/source/markdown/${edition}.md`, 'utf8');
    expect(await readFile(join(output, `source/markdown/${edition}.md`), 'utf8')).toBe(template);
    const html = await readFile(join(output, `${edition}.html`), 'utf8');
    expect(/<h1\b[^>]*>(.*?)<\/h1>/su.exec(html)?.[1]).toBe(template.split('\n')[0]!.slice(2));
    expect(html).not.toContain('<p class="guide-subtitle">');
    expect(html).not.toContain('<p class="guide-support">');
    expect(html).not.toContain(product.support.email);
    expect(html).not.toContain(product.name);
    expect(/<title>(.*?)<\/title>/su.exec(html)?.[1]).toBe(template.split('\n')[0]!.slice(2));
  }
  expect(await readFile(join(output, 'index.html'), 'utf8')).not.toContain(product.name);
  expect(await readFile(join(output, 'assets/brand.json'), 'utf8')).not.toContain(product.name);
});

it('handles independently optional project names and support overrides across all editions', async () => {
  const output = await mkdtemp('/tmp/pxv-guide-metadata-fallback-');
  roots.push(output);
  const variants = [
    { metadata: {}, name: undefined, contact: product.support.email },
    { metadata: { projectName: 'Example Fleet' }, name: 'Example Fleet', contact: product.support.email },
    {
      metadata: { support: { name: 'Phone support', phone: '+48 123' } },
      name: undefined,
      contact: '+48 123',
    },
  ];
  for (const [index, { metadata, name, contact }] of variants.entries()) {
    const destination = join(output, String(index));
    await buildDocumentation(source, destination, { insertMetadata: metadata });
    for (const edition of editions) {
      const template = await readFile(`guides/source/markdown/${edition}.md`, 'utf8');
      const html = await readFile(join(destination, `${edition}.html`), 'utf8');
      expect(/<h1\b[^>]*>(.*?)<\/h1>/su.exec(html)?.[1]).toBe(name ?? template.split('\n')[0]!.slice(2));
      expect(html).toContain(contact);
      expect(html).not.toContain(product.name);
      const subtitle = `<p class="cover-subtitle">${template.split('\n')[0]!.slice(2)}</p>`;
      if (name) expect(html).toContain(subtitle);
      else expect(html).not.toContain(subtitle);
      if (index === 2) expect(html).not.toContain(product.support.email);
      else expect(html).toContain(product.support.url);
    }
    const indexHtml = await readFile(join(destination, 'index.html'), 'utf8');
    expect(indexHtml).not.toContain(product.name);
    if (name) expect(indexHtml).toContain(name);
  }
});

it('preserves explicit project names and support names even when they match the product', async () => {
  const output = await mkdtemp('/tmp/pxv-explicit-guide-name-');
  roots.push(output);
  await buildDocumentation(source, output, {
    insertMetadata: { projectName: product.name, support: { name: product.name, phone: '+48 999' } },
  });
  for (const edition of editions) {
    const html = await readFile(join(output, `${edition}.html`), 'utf8');
    expect(/<h1\b[^>]*>(.*?)<\/h1>/su.exec(html)?.[1]).toBe(product.name);
    expect(html).toContain(`${product.name}: +48 999`);
  }
  expect(await readFile(join(output, 'index.html'), 'utf8')).toContain(product.name);
});

it('rejects authoritative output directories and invalid project metadata', async () => {
  const output = await mkdtemp('/tmp/pxv-invalid-guide-metadata-');
  roots.push(output);
  await expect(buildDocumentation(source, join(source, 'guides'), { insertMetadata: {} })).rejects.toThrow(
    'outside',
  );
  await expect(
    buildDocumentation(source, join(output, 'invalid'), { insertMetadata: { support: {} } }),
  ).rejects.toThrow();
});
