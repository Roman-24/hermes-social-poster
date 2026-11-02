import type { SelectorSet } from '../browser/selectors.js';

/**
 * farcaster.xyz web client selectors. The whole Farcaster adapter is browser automation (no Neynar,
 * no own Snapchain node), so this file is the fragile part. Bump `version` on every change; the
 * nightly self-test reports which names went missing.
 *
 * Selectors are deliberately loose (role/aria/text based with data-testid alternatives) because the
 * client is a React app without stable test ids on every element.
 */
export const FARCASTER_SELECTORS: SelectorSet = {
  version: '2026-11',
  network: 'farcaster',
  composeUrl: 'https://farcaster.xyz/~/compose',
  selectors: {
    composerTextbox: {
      css: '[data-testid="cast-composer-textarea"], div[role="textbox"][contenteditable="true"], textarea[placeholder*="happening" i]',
      description: 'Cast composer text area',
    },
    mediaInput: {
      css: 'input[type="file"][accept*="image"], input[type="file"]',
      description: 'Hidden file input for embeds',
    },
    castButton: {
      css: '[data-testid="cast-composer-submit"], button[type="submit"]:has-text("Cast"), button:has-text("Cast"), button:has-text("Reply")',
      description: 'Cast / Reply submit button',
    },
    replyButton: {
      css: '[data-testid="cast-reply-button"], button[aria-label*="Reply" i], a[aria-label*="Reply" i]',
      description: 'Reply action on a cast page (opens the reply composer)',
      checkOnCompose: false,
    },
    loggedInIndicator: {
      css: '[data-testid="user-menu"], a[href="/~/notifications"], a[href="/~/compose"], button[aria-label*="Cast" i]',
      description: 'Element only rendered for a signed-in user',
      checkOnCompose: false,
    },
    signInIndicator: {
      css: 'button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Log in"), [data-testid="sign-in"], canvas[aria-label*="QR" i]',
      description: 'Sign-in button / QR code, visible when logged out',
      checkOnCompose: false,
    },
    profileCastLink: {
      css: 'a[href*="/0x"]',
      description: 'Link to a cast on a profile page; href is /<username>/0x<hash>',
      checkOnCompose: false,
    },
    settingsUsername: {
      css: '[data-testid="profile-username"], a[href^="/"][href]:has-text("@")',
      description: 'Username on the settings/profile page',
      checkOnCompose: false,
    },
  },
};

export const FARCASTER_ALLOWED_HOSTS = [
  'farcaster.xyz',
  'warpcast.com',
  'privy.io',
  'imagedelivery.net',
  'wrpcd.net',
  'merkle.zone',
];
