import type { ArtifactPolicy, PolicyDocument, ExecutionPolicy, SettingPolicy } from './types.js';
import { validateExecutionPolicy, validatePolicyDocument } from './schemas.js';
import { canonicalJson } from './policy.js';

/** Serialize validated expanded engine data to the supported authoring format. */
export function toPolicyDocument(value: ExecutionPolicy): PolicyDocument {
  const policy = validateExecutionPolicy(value);
  const { profiles, osByCodename, ...base } = policy;
  const apps: Record<string, ArtifactPolicy> = {};
  const references = new Map<string, string>();
  const deviceSettings = new Map<string, SettingPolicy>();
  const document = {
    ...base,
    apps,
    deviceSettings: [] as SettingPolicy[],
    profiles: profiles.map(({ packages, settings, ...profile }) => ({
      ...profile,
      apps: packages.map((artifact) => {
        const identity = canonicalJson(artifact);
        let reference = references.get(identity);
        if (!reference) {
          const candidate = artifact.packageId.toLowerCase();
          reference =
            /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(candidate) && !Object.hasOwn(apps, candidate)
              ? candidate
              : `app-${Object.keys(apps).length + 1}`;
          while (Object.hasOwn(apps, reference)) reference += '-app';
          references.set(identity, reference);
          apps[reference] = structuredClone(artifact);
        }
        return reference;
      }),
      settings: settings.filter((setting) => {
        if (setting.namespace !== 'global') return true;
        deviceSettings.set(setting.key, structuredClone(setting));
        return false;
      }),
    })),
    ...(osByCodename ? { os: osByCodename } : {}),
  };
  document.deviceSettings = [...deviceSettings.values()];
  return validatePolicyDocument(document);
}
