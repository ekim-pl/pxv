import { profileLocale, validatePolicyPack, type ExecutionPolicy, type ProfilePolicy } from '@pxv/contracts';

type Locale = 'en' | 'pl';
type Kind = 'quickstart' | 'credentials';
const pageBreak = '<div class="page-break"></div>';

const copy = {
  en: {
    shortened: ' [shortened; use profile ID to match]',
    policyShortened: ' [name shortened]',
    installation: 'Intended installation',
    profileCount: 'GrapheneOS profiles',
    planned: 'Planned requirements only; verify actual setup in the handoff packet.',
    profile: 'Profile',
    role: 'Role',
    owner: 'Owner',
    secondary: 'Secondary',
    language: 'Language',
    lock: 'Initial ordinary lock type',
    password: 'password',
    unspecified: 'Not specified; agree privately',
    apps: 'Required app count',
    vpn: 'VPN app package',
    noVpn: 'None required by this policy',
    alwaysOn: 'Always-on VPN',
    lockdown: 'Block connections without VPN',
    backup: 'Backup enabled',
    yes: 'Yes',
    no: 'No',
    configuration: 'Profile configuration',
    requirements:
      'These are policy requirements, not observed device status. Confirm them with the preparer.',
    setup:
      'Open this profile and complete private app setup. Verify its ordinary lock, language and required VPN controls. Record checks and limitations in the handoff packet.',
    noSecrets:
      'No account identifiers or secret values are printed here. Use this profile’s matching private credential and recovery sheets.',
    noLocale: 'Choose the agreed language privately when the policy does not specify one.',
    ordinaryIntro:
      '**Complete privately for this profile.** Record ordinary unlock values only; mark initial or verified with the date.',
    accountIntro:
      '**Complete privately for this profile.** Use an agreed secure store for passwords, MFA and recovery secrets. Add copies for further accounts or backup scopes.',
    ordinaryOriginal: '**Copy for each profile.**',
    accountOriginal: '**Copy as needed.**',
    encloseOriginal: '**Enclose**',
    enclose:
      '**Enclosed:** one ordinary and one recovery sheet per planned profile; add copies for further accounts. Mark unused fields “not configured”. Detach and seal the optional erasure record separately.',
    privateIntro: '**PRIVATE WHEN COMPLETED.**',
    privateProtection: 'Match asset labels, seal for the recipient and store securely apart from the phone.',
    privateClosingOriginal: 'The completed insert is device-specific.',
    privateClosing:
      'Agree support retention, including encrypted history. Never put completed secrets in shared files or chat.',
    ordinaryNameField: 'Profile name and purpose',
    ordinaryRoleField: 'Owner or secondary profile',
    ordinaryLockField: 'Ordinary PIN or password type',
    accountIdentityField: 'Device asset label and profile name',
    assetField: 'Device asset label',
    erasureReferenceOriginal: '**No destructive credentials here.**',
    erasureReference:
      '**No destructive credentials here.** Keep the separately sealed “Optional erasure record” apart from daily unlock instructions.',
    restartOriginal: 'Unlock Owner first after restart.',
    acceptanceOriginal: '**Before acceptance**',
    acceptance:
      '**Before acceptance** verify ordinary unlock, required profile switching and ending secondary sessions with the preparer. Check that USB and Wireless debugging are off. Receive support and recovery access without this phone.',
    singleAcceptance:
      '**Before acceptance** verify this profile’s ordinary unlock with the preparer. Check that USB and Wireless debugging are off. Receive support and recovery access without this phone.',
    singleTitle: 'Use your Owner profile',
    singleBody:
      'This installation plans one GrapheneOS profile. Use this Owner profile for the supplied apps and accounts; no profile switching is needed.\n\n1. Unlock with this profile’s ordinary PIN or password.\n2. Check the intended account before using an app or entering credentials.\n3. Lock the phone when you finish.\n\nApps in one profile can share account context and identifiers. Use only the agreed accounts and permissions. Ask support before adding or removing profiles or changing required routing.\n\nKeep ordinary unlock and recovery access outside the phone. If access fails, report the problem before resetting or recreating anything.',
    multiRestartOriginal:
      "After restart, unlock Owner before starting secondary profiles. Know Owner's ordinary credential even if you usually use another profile.",
  },
  pl: {
    shortened: ' [skrócono; dopasuj według ID profilu]',
    policyShortened: ' [skrócona nazwa]',
    installation: 'Planowana instalacja',
    profileCount: 'Liczba profili GrapheneOS',
    planned: 'To plan wymagań; faktyczny stan potwierdza pakiet przekazania.',
    profile: 'Profil',
    role: 'Rola',
    owner: 'Owner (Właściciel)',
    secondary: 'Profil dodatkowy',
    language: 'Język',
    lock: 'Typ początkowej zwykłej blokady',
    password: 'hasło',
    unspecified: 'Nie określono; uzgodnij prywatnie',
    apps: 'Liczba wymaganych aplikacji',
    vpn: 'Pakiet aplikacji VPN',
    noVpn: 'Polityka nie wymaga VPN',
    alwaysOn: 'Zawsze włączony VPN',
    lockdown: 'Blokuj połączenia bez VPN',
    backup: 'Kopia zapasowa włączona',
    yes: 'Tak',
    no: 'Nie',
    configuration: 'Konfiguracja profilu',
    requirements: 'To wymagania polityki, nie odczyt stanu telefonu. Potwierdź je z operatorem.',
    setup:
      'Otwórz ten profil i dokończ prywatną konfigurację aplikacji. Sprawdź zwykłą blokadę, język i wymagane opcje VPN. Zapisz kontrole i ograniczenia w pakiecie przekazania.',
    noSecrets:
      'Nie drukujemy tu identyfikatorów kont ani sekretów. Użyj dopasowanych prywatnych kart danych dostępu i odzyskiwania tego profilu.',
    noLocale: 'Jeśli polityka nie określa języka, wybierz uzgodniony język prywatnie.',
    ordinaryIntro:
      '**Wypełnij prywatnie dla tego profilu.** Wpisuj tylko zwykłe dane odblokowania; oznacz początkowe lub sprawdzone i datę.',
    accountIntro:
      '**Wypełnij prywatnie dla tego profilu.** Hasła, MFA i sekrety odzyskiwania trzymaj w bezpiecznym magazynie. Dodaj kopie dla kolejnych kont lub zakresów kopii.',
    ordinaryOriginal: '**Kopiuj dla każdego profilu.**',
    accountOriginal: '**Kopiuj dla każdego konta lub zakresu kopii.**',
    encloseOriginal: '**Dołącz:**',
    enclose:
      '**Dołączono:** kartę zwykłej blokady i kartę odzyskiwania dla każdego planowanego profilu; dodaj kopie dla kolejnych kont. Nieużywane pola oznacz „nie skonfigurowano”. Kartę wymazania oddziel i zapieczętuj osobno.',
    privateIntro: '**PO WYPEŁNIENIU: PRYWATNE.**',
    privateProtection:
      'Dopasuj etykiety zasobu, zapieczętuj dla odbiorcy i przechowuj bezpiecznie poza telefonem.',
    privateClosingOriginal: 'Wypełniona wkładka dotyczy jednego urządzenia.',
    privateClosing:
      'Uzgodnij przechowywanie przez wsparcie, także szyfrowaną historię. Nie zapisuj sekretów we wspólnych plikach ani na czacie.',
    ordinaryNameField: 'Nazwa i przeznaczenie profilu',
    ordinaryRoleField: 'Owner (Właściciel) lub profil dodatkowy',
    ordinaryLockField: 'Typ zwykłej blokady: PIN lub hasło',
    accountIdentityField: 'Etykieta zasobu i profil',
    assetField: 'Etykieta zasobu urządzenia',
    erasureReferenceOriginal: '**Bez wartości przymusu i kluczy wymazania przez powiadomienie.**',
    erasureReference:
      '**Bez wartości przymusu i kluczy wymazania przez powiadomienie.** Kartę „Opcjonalne wymazanie” zapieczętuj oddzielnie od codziennych danych.',
    restartOriginal: 'Po restarcie najpierw odblokuj Owner.',
    acceptanceOriginal: '**Przed przyjęciem telefonu**',
    acceptance:
      '**Przed odbiorem** sprawdź z operatorem zwykłe blokady, przełączanie wymaganych profili i kończenie dodatkowej sesji. Sprawdź wyłączenie debugowania USB i bezprzewodowego. Odbierz kontakt i odzyskiwanie bez telefonu.',
    singleAcceptance:
      '**Przed odbiorem** sprawdź z operatorem zwykłą blokadę tego profilu. Sprawdź wyłączenie debugowania USB i bezprzewodowego. Odbierz kontakt i odzyskiwanie bez telefonu.',
    singleTitle: 'Korzystaj z profilu Owner',
    singleBody:
      'Ta instalacja przewiduje jeden profil GrapheneOS. Korzystaj z tego profilu Owner dla dostarczonych aplikacji i kont; nie trzeba przełączać profili.\n\n1. Odblokuj profil jego zwykłym PIN-em lub hasłem.\n2. Sprawdź właściwe konto przed użyciem aplikacji lub wpisaniem danych.\n3. Po zakończeniu zablokuj telefon.\n\nAplikacje w jednym profilu mogą łączyć kontekst kont i identyfikatory. Używaj uzgodnionych kont i uprawnień. Zapytaj wsparcie przed dodaniem lub usunięciem profilu i zmianą wymaganego kierowania ruchu.\n\nZwykłą blokadę i dostęp do odzyskiwania zachowaj poza telefonem. Gdy dostęp nie działa, zgłoś problem przed resetem lub ponownym tworzeniem profilu.',
    multiRestartOriginal:
      'Po restarcie odblokuj Owner przed dodatkowymi profilami. Znaj jego zwykłe dane odblokowania, nawet jeśli głównie używasz innego profilu.',
  },
} as const;

/** Metadata must remain literal both in Markdown and when passed through marked. */
function literal(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/[&<>"'\\`*_[\]{}()#+.!|~:=/-]/gu, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? `&#${character.codePointAt(0)!};`;
  });
}

function label(value: string, maximum: number, note: string): string {
  const characters = [...value.replace(/\s+/gu, ' ').trim()];
  const shortened = characters.length > maximum;
  return literal(characters.slice(0, maximum).join('') + (shortened ? `…${note}` : ''));
}

function profileName(profile: ProfilePolicy, locale: Locale): string {
  return label(profile.name, 80, copy[locale].shortened);
}

function lockType(profile: ProfilePolicy, locale: Locale): string {
  if (!profile.defaultCredential) return copy[locale].unspecified;
  return profile.defaultCredential.type === 'pin' ? 'PIN' : copy[locale].password;
}

function identity(profile: ProfilePolicy, locale: Locale): string {
  const text = copy[locale];
  const role = profile.kind === 'owner' ? text.owner : text.secondary;
  return `<div class="profile-identity"><strong>${text.profile}: ${profileName(profile, locale)}</strong><br>ID: ${literal(profile.id)}<br>${text.role}: ${role} · ${text.language}: ${literal(profileLocale(profile) ?? text.unspecified)}<br>${text.lock}: ${lockType(profile, locale)}</div>`;
}

function accountIdentity(profile: ProfilePolicy, locale: Locale): string {
  return `<div class="profile-identity"><strong>${copy[locale].profile}: ${profileName(profile, locale)}</strong><br>ID: ${literal(profile.id)}</div>`;
}

function canonicalPages(source: string, kind: Kind): string[] {
  const pages = source.split(pageBreak).map((page) => page.trim());
  const expected = kind === 'quickstart' ? 8 : 4;
  if (pages.length !== expected)
    throw new Error(`Cannot customize ${kind}: expected ${expected} canonical template pages`);
  pages.forEach((page, index) => {
    const headings = [...page.matchAll(/^## ([^\n]+)$/gmu)];
    if (headings.length !== 1 || !headings[0]?.[1]?.startsWith(`${index + 1} `))
      throw new Error(`Cannot customize ${kind}: template page ${index + 1} needs one numbered heading`);
  });
  return pages;
}

function replaceRequired(source: string, original: string, replacement: string): string {
  if (!source.includes(original)) throw new Error(`Booklet template slot missing: ${original}`);
  return source.replace(original, replacement);
}

function replaceParagraph(source: string, prefix: string, replacement: string): string {
  const paragraphs = source.split('\n\n');
  const index = paragraphs.findIndex((paragraph) => paragraph.startsWith(prefix));
  if (index < 0) throw new Error(`Booklet template paragraph missing: ${prefix}`);
  paragraphs[index] = replacement;
  return paragraphs.join('\n\n');
}

function replaceIntroduction(source: string, introduction: string): string {
  const paragraphs = source.split('\n\n');
  const heading = paragraphs.findIndex((paragraph) => /^## 1 /u.test(paragraph));
  if (heading < 0 || !paragraphs[heading + 1]) throw new Error('Booklet template introduction missing');
  paragraphs[heading + 1] = introduction;
  return paragraphs.join('\n\n');
}

function installation(policy: ExecutionPolicy, locale: Locale): string {
  const text = copy[locale];
  return `**${text.installation}:** ${label(policy.name, 100, text.policyShortened)}. ${text.profileCount}: **${policy.profiles.length}**. ${text.planned}`;
}

function restart(owner: ProfilePolicy, locale: Locale): string {
  const name = profileName(owner, locale);
  return locale === 'en'
    ? `After restart, unlock Owner (${name}) first with its ordinary PIN or password.`
    : `Po restarcie najpierw odblokuj Owner (${name}) zwykłym PIN-em lub hasłem.`;
}

function startStep(owner: ProfilePolicy, multiple: boolean, locale: Locale): string {
  const next =
    locale === 'en'
      ? ' Then switch to the intended profile and unlock it.'
      : ' Potem przełącz się na docelowy profil i odblokuj go.';
  return `2. ${restart(owner, locale)}${multiple ? next : ''}`;
}

function configurationPage(profile: ProfilePolicy, locale: Locale): string {
  const text = copy[locale];
  const boolean = (value: boolean): string => (value ? text.yes : text.no);
  const fields: [string, string][] = [
    [text.apps, String(profile.packages.length)],
    [text.vpn, profile.vpn.packageId ? label(profile.vpn.packageId, 100, text.policyShortened) : text.noVpn],
    [text.alwaysOn, boolean(profile.vpn.alwaysOn)],
    [text.lockdown, boolean(profile.vpn.lockdown)],
  ];
  if (profile.backup) fields.push([text.backup, boolean(profile.backup.enabled)]);
  const rows = fields.map(([key, value]) => `<p><strong>${key}:</strong> ${value}</p>`).join('\n');
  return `## 1 ${text.configuration}\n\n${identity(profile, locale)}\n\n${text.requirements}\n\n<div class="profile-requirements">\n${rows}\n</div>\n\n${text.setup}\n\n${text.noLocale}\n\n${text.noSecrets}`;
}

function quickstart(pages: string[], policy: ExecutionPolicy, locale: Locale): string[] {
  const text = copy[locale];
  const owner = policy.profiles.find((profile) => profile.kind === 'owner')!;
  const multiple = policy.profiles.length > 1;
  let first = replaceIntroduction(pages[0]!, installation(policy, locale));
  const step = first.split('\n').find((line) => line.startsWith('2. '));
  if (!step) throw new Error('Booklet template first-unlock step missing');
  first = replaceRequired(first, step, startStep(owner, multiple, locale));
  pages[0] = replaceParagraph(
    first,
    text.acceptanceOriginal,
    multiple ? text.acceptance : text.singleAcceptance,
  );
  pages[1] = multiple
    ? replaceRequired(pages[1]!, text.multiRestartOriginal, restart(owner, locale))
    : `## 2 ${text.singleTitle}\n\n${identity(owner, locale)}\n\n${text.singleBody}`;
  return [...pages, ...policy.profiles.map((profile) => configurationPage(profile, locale))];
}

function field(label: string): string {
  return `<div class="write-line">${label}</div>`;
}

function ordinarySheet(source: string, profile: ProfilePolicy, owner: ProfilePolicy, locale: Locale): string {
  const text = copy[locale];
  let page = replaceParagraph(source, text.ordinaryOriginal, text.ordinaryIntro);
  page = replaceRequired(page, field(text.ordinaryNameField), identity(profile, locale));
  page = replaceRequired(page, `${field(text.ordinaryRoleField)}\n`, '');
  page = replaceRequired(page, `${field(text.ordinaryLockField)}\n`, '');
  page = replaceRequired(page, text.restartOriginal, restart(owner, locale));
  return replaceParagraph(page, text.erasureReferenceOriginal, text.erasureReference);
}

function accountSheet(source: string, profile: ProfilePolicy, locale: Locale): string {
  const text = copy[locale];
  let page = replaceParagraph(source, text.accountOriginal, text.accountIntro);
  page = replaceRequired(
    page,
    field(text.accountIdentityField),
    `${accountIdentity(profile, locale)}\n${field(text.assetField)}`,
  );
  return page;
}

function credentials(pages: string[], policy: ExecutionPolicy, locale: Locale): string[] {
  const text = copy[locale];
  const owner = policy.profiles.find((profile) => profile.kind === 'owner')!;
  let intro = replaceIntroduction(
    pages[0]!,
    `${text.privateIntro} ${installation(policy, locale)} ${text.privateProtection}`,
  );
  intro = replaceParagraph(intro, text.encloseOriginal, text.enclose);
  intro = replaceParagraph(intro, text.privateClosingOriginal, text.privateClosing);
  const sheets = policy.profiles.flatMap((profile) => [
    ordinarySheet(pages[1]!, profile, owner, locale),
    accountSheet(pages[2]!, profile, locale),
  ]);
  return [intro, ...sheets, pages[3]!];
}

/** Derive public A5 content from policy requirements, never from private device inputs. */
export function renderPolicyBooklet(
  source: string,
  kind: Kind,
  policy: ExecutionPolicy,
  locale: Locale,
): string {
  const selected = validatePolicyPack(policy);
  const pages = canonicalPages(source, kind);
  const customized =
    kind === 'quickstart' ? quickstart(pages, selected, locale) : credentials(pages, selected, locale);
  return (
    customized
      .map((page, index) => page.replace(/^## \d+ /mu, `## ${index + 1} `))
      .join(`\n\n${pageBreak}\n\n`) + '\n'
  );
}
