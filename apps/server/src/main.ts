import { bootstrap } from './bootstrap.js';
import { buildApp } from './http/app.js';

async function main(): Promise<void> {
  const services = await bootstrap();
  const { config, logger } = services;
  const app = await buildApp(services);

  services.scheduler.start(config.SCHEDULER_INTERVAL_MS);
  services.notifier.start();
  services.jobs.start();

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(
    {
      host: config.HOST,
      port: config.PORT,
      dataDir: config.DATA_DIR,
      inbox: config.INBOX_DIR,
      fakeAdapters: config.fakeAdapters,
      codeDelivery: services.notifier.codeDeliveryMode(),
    },
    'social poster listening',
  );
  if (services.auth.setupRequired())
    logger.warn('No UI password set yet: open the UI to set one, or run `poster set-password`.');
  if (!services.auth.hasToken('mcp') && !config.POSTER_MCP_TOKEN)
    logger.warn('No MCP token yet: run `poster gen-token mcp` and put it in Hermes config.');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await services.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
