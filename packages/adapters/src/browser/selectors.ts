/**
 * Versioned selector sets for browser-driven networks. Each network keeps one file
 * (`x.selectors.ts`, `farcaster.selectors.ts`) so a UI change is a one-file fix, and the nightly
 * self-test (`selfTest.ts`) checks every selector without posting.
 */
export interface SelectorDef {
  /** CSS selector; alternatives separated by commas are fine. */
  css: string;
  description: string;
  /** Checked on the compose page by the self-test. Login indicators and profile links are not. */
  checkOnCompose?: boolean;
}

export interface SelectorSet {
  version: string;
  network: string;
  composeUrl: string;
  selectors: Record<string, SelectorDef>;
}
