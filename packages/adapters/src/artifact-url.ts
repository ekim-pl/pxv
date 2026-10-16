import { AdapterError } from './command.js';
export function artifactUrl(value: string, hosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdapterError('Invalid artifact URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !hosts.has(url.hostname.toLowerCase()) ||
    (url.port && url.port !== '443')
  )
    throw new AdapterError('Artifact URL is outside the approved HTTPS hosts');
  return url;
}
