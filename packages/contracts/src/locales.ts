import type { ProfilePolicy } from './types.js';

/** One explicit Android locale; locale lists and unspecified languages are unsupported. */
export function canonicalLocale(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu.test(value) ||
    /^und(?:-|$)/iu.test(value)
  )
    throw new Error('Expected one explicit BCP 47 locale tag');
  try {
    return Intl.getCanonicalLocales(value)[0]!;
  } catch {
    throw new Error('Expected one explicit BCP 47 locale tag');
  }
}

/** Prefer the explicit default locale, then the alternate language field. */
export function profileLocale(
  profile: Pick<ProfilePolicy, 'defaultLocale' | 'language'>,
): string | undefined {
  return profile.defaultLocale ?? profile.language;
}
