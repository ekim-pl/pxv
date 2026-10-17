import type { ArtifactPolicy, PolicyDocumentV2, SettingPolicy } from './types.js';
import { validatePolicy, validatePolicyDocument } from './schemas.js';

/** Conversion returns new authoring data; callers decide where to save and activate it. */
export function convertPolicyToV2(value: unknown): PolicyDocumentV2 {
  const policy = validatePolicy(value);
  const { profiles, os, osByCodename, sourceSchemaVersion: _source, ...base } = policy;
  void _source;
  const apps: Record<string, ArtifactPolicy> = {};
  const references = new Map<string, string>();
  const deviceSettings = new Map<string, SettingPolicy>();
  const converted = {
    ...base,
    schemaVersion: 2 as const,
    apps,
    deviceSettings: [] as SettingPolicy[],
    profiles: profiles.map(({ packages, settings, ...profile }) => ({
      ...profile,
      apps: packages.map((artifact) => {
        let reference = references.get(artifact.packageId);
        if (!reference) {
          const candidate = artifact.packageId.toLowerCase();
          reference =
            /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(candidate) && !Object.hasOwn(apps, candidate)
              ? candidate
              : `app-${Object.keys(apps).length + 1}`;
          while (Object.hasOwn(apps, reference)) reference += '-app';
          references.set(artifact.packageId, reference);
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
    ...(osByCodename ? { os: osByCodename } : os ? { os: { [os.codename]: os } } : {}),
  };
  converted.deviceSettings = [...deviceSettings.values()];
  return validatePolicyDocument(converted) as PolicyDocumentV2;
}
