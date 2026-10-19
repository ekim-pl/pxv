import type { ExecutionPolicy } from '@pxv/contracts';
import { foldHeaderStyle } from '@pxv/guides';

function text(html: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };
  return html
    .replace(/<[^>]*>/gu, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => entities[entity] ?? entity);
}

function profileLines(
  policy: ExecutionPolicy | undefined,
  index: number,
  count: number,
  locale: 'en' | 'pl',
): string[] {
  if (!policy) return [];
  const profile = index > 0 && index < count - 1 ? policy.profiles[Math.floor((index - 1) / 2)] : undefined;
  if (!profile) return [locale === 'pl' ? 'Urządzenie / wszystkie profile' : 'Device / all profiles'];
  return [
    `${locale === 'pl' ? 'Profil' : 'Profile'}: ${profile.name}`,
    `ID: ${profile.id}`,
    profile.kind === 'owner' ? 'Owner' : locale === 'pl' ? 'Profil dodatkowy' : 'Secondary',
  ];
}

/** Policy identity is supplied structurally; it never depends on finding names in rendered prose. */
export function renderFoldSections(
  rendered: string,
  credentials: boolean,
  locale: 'en' | 'pl',
  policy?: ExecutionPolicy,
): { html: string; styles: string } {
  const sections = rendered.split(/<div class="page-break"><\/div>/u);
  const continued = locale === 'pl' ? 'Sekcja / ciąg dalszy' : 'Section / continued';
  const assetField = locale === 'pl' ? 'Etykieta zasobu' : 'Device asset label';
  const styles = credentials ? [foldHeaderStyle('pxvfold', { lines: [], assetField })] : [];
  const html = sections
    .map((section, index) => {
      const heading = /<h2(?:\s[^>]*)?>(.*?)<\/h2>/isu.exec(section);
      const group = credentials && section.includes('class="credential-warning"') ? 'erasure' : 'ordinary';
      const identity = credentials ? profileLines(policy, index, sections.length, locale) : [];
      const lines = [text(heading?.[1] ?? ''), continued, ...identity];
      const name = `foldsection${index}`;
      styles.push(
        foldHeaderStyle(name, {
          lines,
          ...(credentials ? { assetField } : {}),
          ...(credentials && !policy
            ? { profileField: locale === 'pl' ? 'Profil / zakres' : 'Profile / scope' }
            : {}),
        }),
      );
      return `<section class="fold-section" style="page:${name}" data-fold-group="${group}">${section}<div class="continuation">${continued}</div></section>`;
    })
    .join('');
  return { html, styles: styles.join('') };
}
