import type { Page } from 'playwright-core';
import type { SelectorSet } from './selectors.js';

export interface SelectorSelfTestResult {
  ok: boolean;
  version: string;
  checked: string[];
  missing: string[];
  /** True when the page looked logged-out (login indicator absent / login form present). */
  loggedOut?: boolean;
}

/**
 * Open the composer and assert that every `checkOnCompose` selector resolves to at least one
 * element. Never types or clicks "post". The page must already be on `set.composeUrl` (the caller
 * navigates so it can decide on the wait strategy and allowlist).
 */
export async function selfTestSelectors(
  page: Page,
  set: SelectorSet,
  timeoutMs = 10_000,
): Promise<SelectorSelfTestResult> {
  const checked: string[] = [];
  const missing: string[] = [];
  const entries = Object.entries(set.selectors).filter(([, d]) => d.checkOnCompose !== false);
  const deadline = Date.now() + timeoutMs;
  for (const [name, def] of entries) {
    checked.push(name);
    const remaining = Math.max(500, deadline - Date.now());
    const found = await page
      .locator(def.css)
      .first()
      .waitFor({ state: 'attached', timeout: Math.min(remaining, 5_000) })
      .then(() => true)
      .catch(() => false);
    if (!found) missing.push(name);
  }
  return { ok: missing.length === 0, version: set.version, checked, missing };
}

/** Does any selector of the set currently exist on the page? */
export async function anyVisible(page: Page, css: string, timeoutMs = 1_500): Promise<boolean> {
  return page
    .locator(css)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}
