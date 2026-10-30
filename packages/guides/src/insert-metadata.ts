import {
  validateProjectInsertMetadata,
  type ProductDescriptor,
  type ProjectInsertMetadata,
} from '@pxv/contracts';

export interface ResolvedInsertMetadata {
  projectName?: string;
  support: string;
}

/** A project support contact replaces the complete product contact. */
export function resolveInsertMetadata(
  product: ProductDescriptor,
  input: ProjectInsertMetadata = {},
): ResolvedInsertMetadata {
  const metadata = validateProjectInsertMetadata(input);
  const support = metadata.support ?? product.support;
  const routes = [support.email, 'phone' in support ? support.phone : undefined, support.url].filter(Boolean);
  const name = metadata.support || support.name !== product.name ? `${support.name}: ` : '';
  return {
    ...(metadata.projectName ? { projectName: metadata.projectName } : {}),
    support: name + routes.join(' · '),
  };
}

const labels = {
  en: { project: 'Project', support: 'Support', field: 'Support contact and contact route' },
  pl: { project: 'Projekt', support: 'Wsparcie', field: 'Kontakt do wsparcia i sposób kontaktu' },
};

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Raw HTML paragraphs keep metadata literal in both Markdown and rendered HTML. */
export function renderBlankInsertMetadata(
  source: string,
  metadata: ResolvedInsertMetadata,
  locale: 'en' | 'pl',
): string {
  const t = labels[locale];
  const paragraph = (label: string, value: string) =>
    '<p class="insert-metadata"><strong>' + label + ':</strong> ' + escape(value) + '</p>';
  const content = [
    ...(metadata.projectName ? [paragraph(t.project, metadata.projectName)] : []),
    paragraph(t.support, metadata.support),
  ].join('\n\n');
  const field = '<div class="write-line">' + t.field + '</div>';
  if (!source.includes(field)) throw new Error('Credential insert support field missing');
  return source.replace(field, () => content);
}
