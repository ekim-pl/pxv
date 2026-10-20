import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import { describe, expect, test } from './../test-api.js';
import {
  toPolicyDocument,
  validatePolicy,
  validateExecutionPolicy,
  type ExecutionPolicy,
} from '@pxv/contracts';
import { policy as fixture } from '../contracts/fixtures.js';
import { renderPolicyBooklet } from '../../packages/release/src/booklet.js';

const locales = ['en', 'pl'] as const;
const kinds = ['quickstart', 'credentials'] as const;
const pageBreak = '<div class="page-break"></div>';
const sources = Object.fromEntries(
  locales.map((locale) => [
    locale,
    Object.fromEntries(
      kinds.map((kind) => [kind, readFileSync(`guides/source/markdown/${kind}-${locale}.md`, 'utf8')]),
    ),
  ]),
) as Record<(typeof locales)[number], Record<(typeof kinds)[number], string>>;

function installation(count: number): ExecutionPolicy {
  const template = fixture.profiles[0]!;
  return validateExecutionPolicy({
    ...fixture,
    name: 'Booklet test installation',
    profiles: Array.from({ length: count }, (_, index) => ({
      ...structuredClone(template),
      id: `p${index}`,
      name: index === count - 1 ? 'Main Administrator' : `Profile ${index + 1}`,
      kind: index === count - 1 ? 'owner' : 'secondary',
      language: index === count - 1 ? 'de-DE' : 'sr-Latn-RS',
      defaultCredential: { type: index % 2 === 0 ? 'pin' : 'password', secretRef: `privateref${index}` },
    })),
  });
}

function numbers(markdown: string): number[] {
  return [...markdown.matchAll(/^## (\d+) /gmu)].map((match) => Number(match[1]));
}

function html(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

describe('policy-specific recipient booklets', () => {
  test.each([1, 3, 5, 24])('supports %i profiles without a fixed count or page cap', (count) => {
    const policy = installation(count);
    for (const locale of locales) {
      for (const kind of kinds) {
        const result = renderPolicyBooklet(sources[locale][kind], kind, policy, locale);
        const expectedPages = kind === 'quickstart' ? 8 + count : 2 * count + 2;
        expect(numbers(result)).toEqual(Array.from({ length: expectedPages }, (_, index) => index + 1));
        expect(result.split(pageBreak)).toHaveLength(expectedPages);
        expect(result).toContain(`**${count}**`);
        expect(result).toContain('Booklet test installation');
        for (const profile of policy.profiles) expect(result).toContain(`ID: ${profile.id}`);
      }
    }
  });

  test('gives every profile adjacent ordinary and recovery sheets, retaining blank secret fields', () => {
    const policy = installation(5);
    for (const locale of locales) {
      const result = renderPolicyBooklet(sources[locale].credentials, 'credentials', policy, locale);
      const pages = result.split(pageBreak);
      policy.profiles.forEach((profile, index) => {
        const ordinary = pages[1 + index * 2]!;
        const recovery = pages[2 + index * 2]!;
        expect(ordinary).toContain(`ID: ${profile.id}`);
        expect(recovery).toContain(`ID: ${profile.id}`);
        expect(ordinary).toContain(profile.name);
        expect(recovery).toContain(profile.name);
        expect(ordinary).toContain(
          locale === 'en' ? '>Ordinary unlock value</div>' : '>Zwykły PIN lub hasło odblokowania</div>',
        );
        expect(ordinary).toContain(
          locale === 'en'
            ? '>Proton VPN password if applicable</div>'
            : '>Hasło Proton VPN, jeśli dotyczy</div>',
        );
      });
      expect(result).not.toMatch(/page [234]\b|stron(?:ę|ie) [234]\b/u);
      expect(pages.at(-1)).toContain(locale === 'en' ? 'Optional erasure record' : 'Opcjonalne wymazanie');
    }
  });

  test('uses Owner role rather than profile ID or ordering and preserves each profile language', () => {
    const policy = installation(3);
    for (const locale of locales) {
      const result = renderPolicyBooklet(sources[locale].quickstart, 'quickstart', policy, locale);
      const first = result.split(pageBreak)[0]!;
      expect(first).toContain('Owner (Main Administrator)');
      expect(first).not.toContain('Owner (Profile 1)');
      expect(result).toContain('de&#45;DE');
      expect(result).toContain('sr&#45;Latn&#45;RS');
      expect(result).toContain(locale === 'en' ? 'not observed device status' : 'nie odczyt stanu telefonu');
      expect(first).toContain(locale === 'en' ? 'Planned requirements only' : 'To plan wymagań');
    }
  });

  test('makes single-profile first use and chapter two independent of user switching', () => {
    const policy = installation(1);
    for (const locale of locales) {
      const pages = renderPolicyBooklet(sources[locale].quickstart, 'quickstart', policy, locale).split(
        pageBreak,
      );
      expect(pages[0]).not.toMatch(/Then switch|Potem przełącz/u);
      expect(pages[0]).not.toMatch(/ending secondary|kończenie dodatkowej/u);
      expect(pages[1]).toContain(
        locale === 'en' ? 'no profile switching is needed' : 'nie trzeba przełączać profili',
      );
      expect(pages[1]).not.toMatch(/user switcher|przełącznik użytkowników|End session|Zakończ sesję/u);
    }
  });

  test('preserves user-facing requirements when a v2 document is loaded again', () => {
    const policy = installation(3);
    const reloaded = validatePolicy(toPolicyDocument(policy));
    for (const locale of locales) {
      for (const kind of kinds) {
        const source = sources[locale][kind];
        expect(renderPolicyBooklet(source, kind, reloaded, locale)).toBe(
          renderPolicyBooklet(source, kind, policy, locale),
        );
      }
    }
  });

  test('renders all metadata literally without HTML, Markdown, image or link injection', () => {
    const policy = installation(1);
    policy.name = '<img src=x> [go](https://bad.invalid) **x**';
    policy.profiles[0]!.name = '<img src=x> [go](//bad.invalid) **x**';
    for (const locale of locales) {
      for (const kind of kinds) {
        const rendered = html(renderPolicyBooklet(sources[locale][kind], kind, policy, locale));
        expect(rendered).toContain('&lt;img src&#61;x&gt;');
        expect(rendered).toContain('&#91;go&#93;');
        expect(rendered).toContain('&#42;&#42;x&#42;&#42;');
        expect(rendered).not.toContain('<img');
        expect(rendered).not.toContain('<strong>x</strong>');
        expect(rendered).not.toContain('href="https://bad.invalid');
      }
    }
  });

  test('preserves complete Unicode names and VPN packages across flowing panels', () => {
    const policy = installation(1);
    policy.name = '🏠'.repeat(120);
    const profile = policy.profiles[0]!;
    profile.id = 'p'.repeat(128);
    profile.name = '🦊'.repeat(40);
    const vpn = `org.${'v'.repeat(150)}`;
    profile.packages[0]!.packageId = vpn;
    profile.permissions = [];
    profile.vpn.packageId = vpn;
    for (const locale of locales) {
      const result = renderPolicyBooklet(sources[locale].quickstart, 'quickstart', policy, locale);
      expect(result).toContain(policy.name);
      expect(result).toContain(profile.name);
      expect(result).toContain(profile.id);
      expect(result).toContain('v'.repeat(150));
    }
  });

  test('uses only safe profile requirements and excludes private and technical policy inputs', () => {
    const policy = installation(1);
    const profile = policy.profiles[0]!;
    const artifact = profile.packages[0]!;
    artifact.path = '/private/artifactpathsentinel.apk';
    artifact.url = 'https://example.invalid/artifacturlsentinel.apk';
    profile.settings = [{ namespace: 'secure', key: 'privatekey', value: 'settingvaluesentinel' }];
    profile.defaultCredential = { type: 'password', secretRef: 'credentialrefsentinel' };
    profile.defaultDuress = {
      ownerCredentialRef: 'ownerrefsentinel',
      pinRef: 'duresspinsentinel',
      passwordRef: 'duresspasswordsentinel',
    };
    profile.recipes = [
      {
        schemaVersion: 1,
        id: 'recipesentinel',
        packageId: artifact.packageId,
        versionCode: artifact.versionCode,
        signerSha256: artifact.signerSha256,
        buildFingerprint: 'buildsentinel',
        steps: [{ action: 'text', selector: { resourceId: 'privatefield' }, value: 'accountidsentinel' }],
        postconditions: [{ text: 'postconditionsentinel' }],
      },
    ];
    profile.networkProbe = {
      artifact: { ...artifact, packageId: 'org.pxv.probe', path: '/private/probesentinel.apk' },
      endpoint: 'https://example.invalid/probeendpointsentinel',
      expectedEgressCidrs: ['198.51.100.0/24'],
      requireVpn: true,
      failurePackages: [],
    };
    profile.backup = { enabled: true, transportPackage: 'org.example.backuptransportsentinel' };
    const normalized = validateExecutionPolicy(policy);
    const sentinels = [
      'artifactpathsentinel',
      'artifacturlsentinel',
      'settingvaluesentinel',
      'credentialrefsentinel',
      'ownerrefsentinel',
      'duresspinsentinel',
      'duresspasswordsentinel',
      'recipesentinel',
      'buildsentinel',
      'accountidsentinel',
      'postconditionsentinel',
      'probesentinel',
      'probeendpointsentinel',
      'backuptransportsentinel',
      artifact.sha256,
      artifact.signerSha256,
    ];
    for (const locale of locales) {
      for (const kind of kinds) {
        const result = html(renderPolicyBooklet(sources[locale][kind], kind, normalized, locale));
        for (const sentinel of sentinels) expect(result).not.toContain(sentinel);
        if (kind === 'quickstart') {
          expect(result).toContain('org&#46;example&#46;vpn');
          expect(result).toContain(locale === 'en' ? 'Required app count' : 'Liczba wymaganych aplikacji');
          expect(result).toContain(locale === 'en' ? 'Backup enabled' : 'Kopia zapasowa włączona');
        }
      }
    }
  });

  test('does not modify policy data or canonical generic source templates', () => {
    const policy = installation(3);
    const before = structuredClone(policy);
    for (const locale of locales) {
      for (const kind of kinds) {
        const source = sources[locale][kind];
        renderPolicyBooklet(source, kind, policy, locale);
        expect(readFileSync(`guides/source/markdown/${kind}-${locale}.md`, 'utf8')).toBe(source);
        expect(source.split(pageBreak)).toHaveLength(kind === 'quickstart' ? 8 : 4);
      }
    }
    expect(policy).toEqual(before);
  });

  test('fails helpfully when canonical pages, numbered headings or known slots change', () => {
    const policy = installation(3);
    expect(() => renderPolicyBooklet('## 1 Unexpected template', 'quickstart', policy, 'en')).toThrow(
      'expected 8 canonical template pages',
    );
    const source = sources.en.quickstart;
    expect(() => renderPolicyBooklet(source.replace('## 2 ', '## 9 '), 'quickstart', policy, 'en')).toThrow(
      'template page 2 needs one numbered heading',
    );
    expect(() =>
      renderPolicyBooklet(source.replace('## 2 ', '## Extra heading\n\n## 2 '), 'quickstart', policy, 'en'),
    ).toThrow('template page 2 needs one numbered heading');
    expect(() =>
      renderPolicyBooklet(source.replace('**Before acceptance**', '**Changed**'), 'quickstart', policy, 'en'),
    ).toThrow('template paragraph missing');
    const credentials = sources.en.credentials.replace('Profile name and purpose', 'Different label');
    expect(() => renderPolicyBooklet(credentials, 'credentials', policy, 'en')).toThrow(
      'template slot missing',
    );
  });
});
