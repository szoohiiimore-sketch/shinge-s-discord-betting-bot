import { loadConfig } from '@/config';
import { createLogger } from '@/lib/logger';
import type { LogLevel } from '@/lib/logger';
import { Application } from '@/lib/app';

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env as Record<string, string | undefined>);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Fatal: configuration failed to load:', (err as Error).message);
    process.exit(1);
  }

  const logger = createLogger({
    name: 'app',
    level: config.app.logLevel as LogLevel,
    pretty: config.app.nodeEnv !== 'production',
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled rejection — exiting');
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });

  const app = new Application(config, logger);

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received');

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    try {
      await app.stop();
      clearTimeout(forceExit);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExit);
      logger.error({ err }, 'Shutdown failed');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.start();
    logger.info({ port: config.app.port }, 'Application running');
  } catch (err) {
    logger.fatal({ err }, 'Application failed to start');
    process.exit(1);
  }
}

void main();