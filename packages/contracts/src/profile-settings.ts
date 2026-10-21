import type { ProfilePolicy, SettingPolicy } from './types.js';

export const PIN_SCRAMBLING_KEY = 'lockscreen_scramble_pin_layout';

/** Include derived settings without changing the authored policy or duplicating raw declarations. */
export function effectiveProfileSettings(
  profile: Pick<ProfilePolicy, 'settings' | 'scramblePinLayout'>,
): SettingPolicy[] {
  const settings = [...profile.settings];
  if (profile.scramblePinLayout === undefined) return settings;
  const value = profile.scramblePinLayout ? '1' : '0';
  const existing = settings.find(
    (setting) => setting.namespace === 'secure' && setting.key === PIN_SCRAMBLING_KEY,
  );
  if (existing && existing.value !== value)
    throw new Error('Profile scramblePinLayout conflicts with the raw secure setting');
  if (!existing) settings.push({ namespace: 'secure', key: PIN_SCRAMBLING_KEY, value });
  return settings;
}
