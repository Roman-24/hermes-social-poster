/**
 * X session cookies → rettiwt-api key.
 *
 * rettiwt's `apiKey` is `base64("auth_token=…;ct0=…;twid=…;")` (README "The API_KEY"). The app
 * reads those cookies from the Chromium profile right after you log in through the remote browser
 * view, encrypts them, and hands the key to rettiwt. No password ever leaves the browser.
 */
export interface CookieLike {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export const REQUIRED_X_COOKIES = ['auth_token', 'ct0', 'twid'] as const;

export function findCookie(cookies: readonly CookieLike[], name: string): CookieLike | undefined {
  // Prefer the x.com cookie over a stale twitter.com one.
  const matches = cookies.filter((c) => c.name === name && c.value);
  return matches.find((c) => (c.domain ?? '').includes('x.com')) ?? matches[0];
}

export function missingXCookies(cookies: readonly CookieLike[]): string[] {
  return REQUIRED_X_COOKIES.filter((n) => !findCookie(cookies, n));
}

/** Build the rettiwt API key. Throws when a required cookie is missing. */
export function cookiesToApiKey(cookies: readonly CookieLike[]): string {
  const missing = missingXCookies(cookies);
  if (missing.length) throw new Error(`Missing X cookies: ${missing.join(', ')}`);
  const parts: string[] = [];
  for (const name of [...REQUIRED_X_COOKIES, 'kdt']) {
    const c = findCookie(cookies, name);
    if (c) parts.push(`${name}=${c.value}`);
  }
  return Buffer.from(`${parts.join(';')};`, 'utf8').toString('base64');
}

/** Inverse of cookiesToApiKey, for tests and diagnostics. */
export function apiKeyToCookieString(apiKey: string): string {
  return Buffer.from(apiKey, 'base64').toString('utf8');
}

/** `twid` is `u%3D<numeric user id>` (URL-encoded `u=<id>`). */
export function userIdFromTwid(twid: string | undefined): string | null {
  if (!twid) return null;
  const decoded = decodeURIComponent(twid.replace(/^"|"$/g, ''));
  const m = /^u=(\d+)$/.exec(decoded);
  return m?.[1] ?? null;
}

/** Keep only the fields we store (encrypted) so a re-login can diff them. */
export function pickStorableCookies(cookies: readonly CookieLike[]): CookieLike[] {
  const keep = new Set<string>([...REQUIRED_X_COOKIES, 'kdt']);
  return cookies
    .filter((c) => keep.has(c.name))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
}
