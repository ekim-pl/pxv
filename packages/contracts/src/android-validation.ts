/** Constraints shared by authored configuration and the executable Android boundary. */
export function validAndroidUserName(value: string): boolean {
  return value.length > 0 && value.length <= 80 && !/[\p{Cc}:}]/u.test(value);
}
export function validAndroidSettingKey(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}
export function validAndroidPermission(value: string): boolean {
  return /^android\.permission\.[A-Z0-9_]+$/u.test(value);
}
export function validAndroidSettingValue(value: string): boolean {
  return value.length <= 4096 && !/[\0\r\n]/u.test(value);
}
/** These configured values belong exclusively to the witnessed VPN Settings workflow. */
export function isManagedVpnSetting(setting: { namespace: string; key: string }): boolean {
  return (
    setting.namespace === 'secure' && ['always_on_vpn_app', 'always_on_vpn_lockdown'].includes(setting.key)
  );
}
/** Inspect the original endpoint without normalizing reviewed bytes. */
export function validProbeEndpoint(value: string): boolean {
  if (!value || value.length > 4096 || /[\s\p{Cc}#\\]/u.test(value)) return false;
  const authority = /^https:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || authority.includes('@')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}
