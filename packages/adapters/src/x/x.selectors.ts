import type { SelectorSet } from '../browser/selectors.js';

/**
 * X web client selectors. Only used by the Playwright composer fallback, the login detector and
 * the nightly self-test; normal posting goes through rettiwt-api. Bump `version` on every change.
 */
export const X_SELECTORS: SelectorSet = {
  version: '2026-11',
  network: 'x',
  composeUrl: 'https://x.com/compose/post',
  selectors: {
    composerTextbox: {
      css: '[data-testid="tweetTextarea_0"], div[role="textbox"][data-testid^="tweetTextarea"]',
      description: 'Main composer text area',
    },
    mediaInput: {
      css: 'input[data-testid="fileInput"], input[type="file"][accept*="image"]',
      description: 'Hidden file input for images/video',
    },
    postButton: {
      css: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
      description: 'Post / Reply submit button',
    },
    replyComposerTextbox: {
      css: '[data-testid="tweetTextarea_0"]',
      description: 'Reply composer text area (same component as the main composer)',
      checkOnCompose: false,
    },
    loggedInIndicator: {
      css: '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], [data-testid="SideNav_NewTweet_Button"]',
      description: 'Element only rendered for a logged-in user',
      checkOnCompose: false,
    },
    loginForm: {
      css: 'input[autocomplete="username"], [data-testid="loginButton"], a[href="/login"]',
      description: 'Login form / button, visible when logged out',
      checkOnCompose: false,
    },
    profileStatusLink: {
      css: 'article[data-testid="tweet"] a[href*="/status/"] time',
      description:
        'Timestamp link inside the newest tweet on a profile page (href carries the status id)',
      checkOnCompose: false,
    },
    toast: {
      css: '[data-testid="toast"]',
      description: 'Confirmation toast after posting',
      checkOnCompose: false,
    },
  },
};

export const X_ALLOWED_HOSTS = [
  'x.com',
  'twitter.com',
  'twimg.com',
  't.co',
  'api.x.com',
  'api.twitter.com',
  'ton.twitter.com',
  'ton.x.com',
];
