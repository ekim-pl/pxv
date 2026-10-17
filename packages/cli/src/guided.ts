import {
  buildReadinessRequirements,
  finalSetupActions,
  profileLocale,
  type DeviceTarget,
  type ExecutionPolicy,
  type ProductDescriptor,
} from '@pxv/contracts';
import { runPauseReason, type RunPauseReason, type RunRecord } from '@pxv/engine';

function text(value: string): string {
  return value.replace(/[\\`*_[\]{}()#+.!|<>-]/gu, '\\$&');
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
/** Policy-derived operator guidance projects only public requirements, never input values. */
export function renderProjectGuide(
  product: ProductDescriptor,
  policy: ExecutionPolicy,
  kind: DeviceTarget['kind'],
  locale: 'en' | 'pl',
): string {
  const pl = locale === 'pl';
  const profiles = policy.profiles
    .map((profile) => {
      const locale = profileLocale(profile);
      return `- ${text(profile.id)}: ${text(profile.name)} (${profile.kind}); ${profile.packages.length} ${pl ? 'aplikacji' : 'apps'}; ${profile.settings.length} ${pl ? 'ustawień' : 'settings'}${locale ? `; ${locale}` : ''}.`;
    })
    .join('\n');
  const requirements = buildReadinessRequirements(policy, kind)
    .map((requirement) => `- \`${requirement.id}\`: ${requirement.instructions[locale]}`)
    .join('\n');
  const phases = finalSetupActions(policy)
    .map((action) =>
      action.kind === 'language'
        ? `${pl ? 'Ustawienia regionalne' : 'Locale'} ${action.profileId}: ${action.language}`
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
  const scope = `--project-root ${quote(projectRoot)}`;
  const pause = runPauseReason(run);
  if (pause?.kind === 'inspection')
    return [
      locale === 'pl'
        ? 'Sprawdź urządzenie i zachowane zobowiązania odzyskiwania. Nie odtwarzaj przerwanej operacji.'
        : 'Inspect the device and retained recovery obligations. Do not replay the interrupted operation.',
    ];
  if (pause?.kind === 'reenrollment')
    return [
      locale === 'pl'
        ? 'Zakończ konfigurację telefonu, autoryzuj debugowanie USB i sprawdź tożsamość przed nowym planem.'
        : pause.instructions,
      `${product.command} device inspect --asset ${quote(assetId)} --transport usb ${scope}`,
      `${product.command} device provision --asset ${quote(assetId)} --operator OPERATOR ${scope}`,
    ];
  if (pause?.kind === 'manual-step') return manualNextSteps(product, run.id, pause, locale, scope, assetId);
  return [
    locale === 'pl'
      ? 'Sprawdź aktualny raport, wykonaj wymagane kontrole i potwierdź je osobnymi poleceniami attest przed finalizacją.'
      : 'Read the current report, perform the required checks and record each with attest before finalization.',
  ];
}

function manualNextSteps(
  product: ProductDescriptor,
  runId: string,
  pause: Extract<RunPauseReason, { kind: 'manual-step' }>,
  locale: 'en' | 'pl',
  scope: string,
  assetId: string,
): string[] {
  return [
    `${locale === 'pl' ? 'Wykonaj etap na telefonie' : 'Complete the phone checkpoint'}: ${pause.gate}${pause.profileId ? ` (${pause.profileId})` : ''}${pause.recipeId ? ` / ${pause.recipeId}` : ''}.`,
    ...(pause.instructions ? [pause.instructions] : []),
    ...(pause.gate.startsWith('language:')
      ? []
      : [
          `${product.command} device attest --asset ${quote(assetId)} --check ${quote(pause.gate)} --operator OPERATOR --yes ${scope}`,
        ]),
    `${product.command} agent resume --run ${runId} --yes ${scope}`,
    `${locale === 'pl' ? 'Po wygaśnięciu przeglądu przygotuj nowy i zatwierdź dokładnie pozostałe czynności' : 'If the review expires, prepare and approve a new review of the remaining work'}: ${product.command} agent refresh --run ${runId} ${scope}`,
  ];
}
