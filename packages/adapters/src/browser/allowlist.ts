/**
 * Hostname allowlist for browser contexts. A remote login session and every automated publish run
 * inside an allowlist so a hijacked page (or a mis-typed URL) cannot pull the profile's cookies to
 * an arbitrary origin. A host matches when it equals an entry or is a subdomain of one.
 */
export function hostAllowed(
  hostname: string,
  allowedHosts: readonly string[] | undefined,
): boolean {
  if (!allowedHosts) return true;
  const h = hostname.toLowerCase().replace(/\.$/, '');
  for (const raw of allowedHosts) {
    const a = raw.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (!a) continue;
    if (h === a || h.endsWith(`.${a}`)) return true;
  }
  return false;
}

export function urlAllowed(url: string, allowedHosts: readonly string[] | undefined): boolean {
  if (!allowedHosts) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Non-network schemes used by the browser itself.
  if (parsed.protocol === 'about:' || parsed.protocol === 'data:' || parsed.protocol === 'blob:')
    return true;
  if (
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'wss:' &&
    parsed.protocol !== 'ws:'
  ) {
    return false;
  }
  return hostAllowed(parsed.hostname, allowedHosts);
}
