import {
  buildReadinessRequirements,
  finalSetupActions,
  type DeviceTarget,
  type PolicyPack,
  type ProductDescriptor,
} from '@pxv/contracts';
import type { RunRecord } from '@pxv/engine';

function text(value: string): string {
  return value.replace(/[\\`*_[\]{}()#+.!|<>-]/gu, '\\$&');
}
/** Policy-derived operator guidance projects only public requirements, never input values. */
export function renderProjectGuide(
  product: ProductDescriptor,
  policy: PolicyPack,
  kind: DeviceTarget['kind'],
  locale: 'en' | 'pl',
): string {
  const pl = locale === 'pl';
  const profiles = policy.profiles
    .map(
      (profile) =>
        `- ${text(profile.id)}: ${text(profile.name)} (${profile.kind}); ${profile.packages.length} ${pl ? 'aplikacji' : 'apps'}; ${profile.settings.length} ${pl ? 'ustawień' : 'settings'}${profile.language ? `; ${profile.language}` : ''}.`,
    )
    .join('\n');
  const requirements = buildReadinessRequirements(policy, kind)
    .map((requirement) => `- \`${requirement.id}\`: ${requirement.instructions[locale]}`)
    .join('\n');
  const phases = finalSetupActions(policy)
    .map((action) =>
      action.kind === 'language'
        ? `${pl ? 'Język' : 'Language'} ${action.profileId}: ${action.language}`
        : action.kind === 'manual'
          ? action.capability
          : action.kind,
    )
    .map((phase, index) => `${index + 1}. \`${phase}\``)
    .join('\n');
  return `# ${text(product.name)} — ${text(policy.name)}\n\n${pl ? 'Profile wybranej polityki' : 'Selected policy profiles'}\n\n${profiles}\n\n${pl ? 'Wymagane kontrole' : 'Required checks'} (${kind})\n\n${requirements}\n\n${pl ? 'Kolejność prywatnej konfiguracji' : 'Private setup sequence'}\n\n${phases || (pl ? 'Brak dodatkowych etapów prywatnej konfiguracji.' : 'No additional private setup stages.')}\n\n${pl ? 'Hasła, MFA i dane odzyskiwania wpisuje prywatnie odbiorca. Nigdy nie testuj destrukcyjnego kodu przymusu.' : 'The recipient enters credentials, MFA and recovery material privately. Never test destructive duress activation.'}\n`;
}

export function guidedNextSteps(
  product: ProductDescriptor,
  run: RunRecord,
  locale: 'en' | 'pl',
  projectRoot: string,
  assetId: string,
): string[] {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const scope = `--project-root ${quote(projectRoot)}`;
  if (run.status === 'needs-inspection' || run.status === 'failed' || run.status === 'cancelled')
    return [
      locale === 'pl'
        ? 'Sprawdź urządzenie i zachowane zobowiązania odzyskiwania. Nie odtwarzaj przerwanej operacji.'
        : 'Inspect the device and retained recovery obligations. Do not replay the interrupted operation.',
    ];
  if (run.status === 'pending' && run.manualGate)
    return [
      `${locale === 'pl' ? 'Wykonaj etap na telefonie' : 'Complete the phone checkpoint'}: ${run.manualGate}.`,
      ...(run.manualGate.startsWith('language:')
        ? []
        : [
            `${product.command} device attest --asset ${quote(assetId)} --check ${quote(run.manualGate)} --operator OPERATOR --yes ${scope}`,
          ]),
      `${product.command} agent resume --run ${run.id} --yes ${scope}`,
      `${locale === 'pl' ? 'Po wygaśnięciu przeglądu przygotuj nowy i zatwierdź dokładnie pozostałe czynności' : 'If the review expires, prepare and approve a new review of the remaining work'}: ${product.command} agent refresh --run ${run.id} ${scope}`,
    ];
  return [
    locale === 'pl'
      ? 'Sprawdź aktualny raport, wykonaj wymagane kontrole i potwierdź je osobnymi poleceniami attest przed finalizacją.'
      : 'Read the current report, perform the required checks and record each with attest before finalization.',
  ];
}
