import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import type { ApplicationState } from '@/lib/app/app-state';
import type { QueueCollection } from '@/lib/queue/queue-types';
import { createHealthServer } from './health-server';
import type { HealthServerConfig } from './health-types';

/**
 * Starts the health check HTTP server.
 *
 * Creates the server and begins listening on the configured port.
 * Logs the bound address on success.
 *
 * @param config - Health server configuration
 * @param prisma - PrismaClient instance
 * @param redis - Redis instance
 * @param queues - BullMQ Queue collection
 * @param getAppState - Function to get current application state
 * @param startTime - Application start timestamp
 * @param logger - Logger instance
 * @returns The started HTTP server
 * @throws If the server fails to start
 *
 * @example
 * const server = await startHealthServer(config, prisma, redis, queues, () => app.state, startTime, logger);
 */
export async function startHealthServer(
  config: HealthServerConfig,
  prisma: PrismaClient,
  redis: Redis,
  queues: QueueCollection,
  getAppState: () => ApplicationState,
  startTime: number,
  logger: Logger,
): Promise<http.Server> {
  const server = createHealthServer(
    prisma,
    redis,
    queues,
    getAppState,
    startTime,
    logger,
  );

  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', (err: Error) => {
      reject(err);
    });

    server.listen(config.port, config.host, () => {
      const addr = server.address();
      const bind = typeof addr === 'string' ? addr : `${addr?.address ?? 'localhost'}:${addr?.port ?? config.port}`;
      logger.info({ address: bind }, 'Health check server started');
      resolve(server);
    });
  });
}

/**
 * Stops the health check HTTP server gracefully.
 *
 * Closes all connections and stops accepting new requests.
 * Safe to call even if the server was never started.
 *
 * @param server - The HTTP server to stop
 * @param logger - Logger instance
 *
 * @example
 * await stopHealthServer(server, logger);
 */
export async function stopHealthServer(
  server: http.Server | undefined | null,
  logger: Logger,
): Promise<void> {
  if (!server) {
    logger.debug('Health check server not running, skipping shutdown');
    return;
  }

  return new Promise<void>((resolve) => {
    server.close(() => {
      logger.info('Health check server stopped');
      resolve();
    });

    // Force close after 5 seconds if graceful shutdown hangs
    setTimeout(() => {
      logger.warn('Health check server close timed out, force closing');
      server.closeAllConnections?.();
      resolve();
    }, 5_000).unref();
  });
}
