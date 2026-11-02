import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserManagerApi } from '@poster/adapters';
import type { Database } from 'better-sqlite3';
import { loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db/index.js';
import { createLogger, nullLogger, type Logger } from './logger.js';
import { AccountService } from './services/accounts.js';
import { AuditService } from './services/audit.js';
import { AuthService } from './services/auth.js';
import { BrowserSessionService } from './services/browser-sessions.js';
import { CodeService } from './services/codes.js';
import { EventBus } from './services/events.js';
import { Jobs } from './services/jobs.js';
import { MediaService } from './services/media.js';
import { Metrics } from './services/metrics.js';
import { Notifier, type NotifyFetch } from './services/notifier.js';
import { PostService } from './services/posts.js';
import { Renderer } from './services/render.js';
import { Scheduler } from './services/scheduler.js';
import { SettingsService } from './services/settings.js';
import { loadMasterKey, Vault } from './vault.js';
import { buildAdapters } from './adapters.js';
import type { AdapterRegistry } from './services/accounts.js';

export interface Services {
  config: Config;
  logger: Logger;
  db: Db;
  sqlite: Database;
  vault: Vault;
  events: EventBus;
  audit: AuditService;
  settings: SettingsService;
  accounts: AccountService;
  adapters: AdapterRegistry;
  browser: BrowserManagerApi;
  media: MediaService;
  renderer: Renderer;
  codes: CodeService;
  notifier: Notifier;
  posts: PostService;
  scheduler: Scheduler;
  metrics: Metrics;
  auth: AuthService;
  browserSessions: BrowserSessionService;
  jobs: Jobs;
  startedAt: number;
  shutdown(): Promise<void>;
}

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  /** Override for tests. */
  dbPath?: string;
  masterKey?: Buffer;
  logger?: Logger;
  adapters?: AdapterRegistry;
  fetchImpl?: NotifyFetch;
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<Services> {
  const config = loadConfig(opts.env ?? process.env);
  const logger =
    opts.logger ??
    (config.isTest ? nullLogger() : createLogger(config.LOG_LEVEL, !!config.LOG_PRETTY));
  for (const d of [
    config.DATA_DIR,
    config.mediaDir,
    config.debugDir,
    config.browserDir,
    config.backupDir,
  ])
    mkdirSync(d, { recursive: true });

  const key =
    opts.masterKey ??
    loadMasterKey(
      config.MASTER_KEY_FILE,
      config.devAutokey ? { devAutokeyPath: join(config.DATA_DIR, 'dev-master.key') } : {},
    );
  const vault = new Vault(key);
  const { db, sqlite } = openDb({ path: opts.dbPath ?? config.dbPath });

  const events = new EventBus();
  const audit = new AuditService(db);
  const settings = new SettingsService(db, vault);
  const metrics = new Metrics();
  // Constructing adapters is side-effect free (no network, no browser launch).
  const built = buildAdapters(config, settings, logger);
  const adapters = opts.adapters ?? built.adapters;
  const browser: BrowserManagerApi = built.browser;
  const accounts = new AccountService(db, vault, settings, adapters, config, events, audit, logger);
  const media = new MediaService(db, config, settings, logger);
  const renderer = new Renderer(settings, accounts, media);
  const codes = new CodeService(db, () => settings.get().codeTtlMinutes);
  const notifier = new Notifier(
    db,
    settings,
    events,
    logger.child({ component: 'notifier' }),
    opts.fetchImpl,
  );
  const posts = new PostService(
    db,
    settings,
    accounts,
    media,
    renderer,
    codes,
    notifier,
    events,
    audit,
    logger.child({ component: 'posts' }),
  );
  const scheduler = new Scheduler(
    db,
    settings,
    accounts,
    media,
    renderer,
    posts,
    notifier,
    events,
    audit,
    metrics,
    logger.child({ component: 'scheduler' }),
  );
  const auth = new AuthService(db, vault, settings, audit, config.POSTER_MCP_TOKEN);
  const browserSessions = new BrowserSessionService(
    browser,
    accounts,
    settings,
    events,
    logger.child({ component: 'browser-sessions' }),
  );
  const jobs = new Jobs(
    db,
    config,
    settings,
    accounts,
    media,
    notifier,
    audit,
    logger.child({ component: 'jobs' }),
  );

  if (config.POSTER_UI_PASSWORD && auth.setupRequired()) {
    await auth.setPassword(config.POSTER_UI_PASSWORD);
    logger.info('UI password set from POSTER_UI_PASSWORD');
  }

  const services: Services = {
    config,
    logger,
    db,
    sqlite,
    vault,
    events,
    audit,
    settings,
    accounts,
    adapters,
    browser,
    media,
    renderer,
    codes,
    notifier,
    posts,
    scheduler,
    metrics,
    auth,
    browserSessions,
    jobs,
    startedAt: Date.now(),
    async shutdown() {
      jobs.stop();
      notifier.stop();
      await scheduler.stop();
      await browserSessions.closeAll();
      await browser.closeAll();
      sqlite.close();
    },
  };
  return services;
}
