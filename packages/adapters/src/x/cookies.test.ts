import { describe, expect, it } from 'vitest';
import {
  apiKeyToCookieString,
  cookiesToApiKey,
  missingXCookies,
  pickStorableCookies,
  userIdFromTwid,
} from './cookies.js';

const cookies = [
  { name: 'auth_token', value: 'AUTH', domain: '.x.com', path: '/' },
  { name: 'ct0', value: 'CT0', domain: '.x.com', path: '/' },
  { name: 'twid', value: 'u%3D123456789', domain: '.x.com', path: '/' },
  { name: 'guest_id', value: 'ignored', domain: '.x.com', path: '/' },
];

describe('X cookies → rettiwt API key', () => {
  it('encodes the three required cookies in rettiwt order', () => {
    const key = cookiesToApiKey(cookies);
    expect(apiKeyToCookieString(key)).toBe('auth_token=AUTH;ct0=CT0;twid=u%3D123456789;');
  });

  it('includes kdt when present', () => {
    const key = cookiesToApiKey([...cookies, { name: 'kdt', value: 'KDT', domain: '.x.com' }]);
    expect(apiKeyToCookieString(key)).toBe('auth_token=AUTH;ct0=CT0;twid=u%3D123456789;kdt=KDT;');
  });

  it('prefers the x.com cookie over a stale twitter.com one', () => {
    const key = cookiesToApiKey([
      { name: 'auth_token', value: 'OLD', domain: '.twitter.com' },
      ...cookies,
    ]);
    expect(apiKeyToCookieString(key)).toContain('auth_token=AUTH;');
  });

  it('reports missing cookies', () => {
    expect(missingXCookies(cookies.slice(1))).toEqual(['auth_token']);
    expect(() => cookiesToApiKey([])).toThrow(/Missing X cookies: auth_token, ct0, twid/);
  });

  it('parses the user id out of twid', () => {
    expect(userIdFromTwid('u%3D123456789')).toBe('123456789');
    expect(userIdFromTwid('"u%3D42"')).toBe('42');
    expect(userIdFromTwid('garbage')).toBeNull();
    expect(userIdFromTwid(undefined)).toBeNull();
  });

  it('stores only the session cookies', () => {
    expect(pickStorableCookies(cookies).map((c) => c.name)).toEqual(['auth_token', 'ct0', 'twid']);
  });
});
