import { describe, expect, it } from 'vitest';
import { hostAllowed, urlAllowed } from './allowlist.js';

describe('allowlist', () => {
  const hosts = ['x.com', 'twimg.com', '*.privy.io'];

  it('matches exact hosts and subdomains', () => {
    expect(hostAllowed('x.com', hosts)).toBe(true);
    expect(hostAllowed('api.x.com', hosts)).toBe(true);
    expect(hostAllowed('abs.twimg.com', hosts)).toBe(true);
    expect(hostAllowed('auth.privy.io', hosts)).toBe(true);
  });

  it('rejects look-alikes and other hosts', () => {
    expect(hostAllowed('notx.com', hosts)).toBe(false);
    expect(hostAllowed('x.com.evil.net', hosts)).toBe(false);
    expect(hostAllowed('accounts.google.com', hosts)).toBe(false);
  });

  it('allows everything when no allowlist is set', () => {
    expect(hostAllowed('anything.example', undefined)).toBe(true);
    expect(urlAllowed('https://anything.example/', undefined)).toBe(true);
  });

  it('checks URLs, allowing browser-internal schemes and blocking others', () => {
    expect(urlAllowed('https://x.com/home', hosts)).toBe(true);
    expect(urlAllowed('wss://x.com/ws', hosts)).toBe(true);
    expect(urlAllowed('about:blank', hosts)).toBe(true);
    expect(urlAllowed('data:text/html,hi', hosts)).toBe(true);
    expect(urlAllowed('https://evil.example/', hosts)).toBe(false);
    expect(urlAllowed('file:///etc/passwd', hosts)).toBe(false);
    expect(urlAllowed('not a url', hosts)).toBe(false);
  });
});
