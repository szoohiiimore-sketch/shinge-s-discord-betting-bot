import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import type { ApplicationState } from '@/lib/app/app-state';
import type { QueueCollection } from '@/lib/queue/queue-types';
import { aggregateHealth } from './health-aggregator';
import type { HealthResponse } from './health-types';

/**
 * Creates a health check HTTP server using Node.js built-in http module.
 *
 * Serves a single endpoint:
 *
 * **GET /health**
 *
 * Returns a JSON response with:
 * - Overall health status (healthy/degraded/unhealthy)
 * - Application state
 * - Uptime
 * - Database health
 * - Redis health
 * - Queue health
 * - Timestamp
 *
 * All other routes return 404.
 *
 * @param prisma - PrismaClient instance
 * @param redis - Redis instance
 * @param queues - BullMQ Queue collection
 * @param getAppState - Function to get current application state
 * @param startTime - Application start timestamp (from performance.now())
 * @param logger - Logger instance
 * @returns The created HTTP server (not yet listening)
 *
 * @example
 * const server = createHealthServer(prisma, redis, queues, () => app.state, startTime, logger);
 * server.listen(port, host);
 */
export function createHealthServer(
  prisma: PrismaClient,
  redis: Redis,
  queues: QueueCollection,
  getAppState: () => ApplicationState,
  startTime: number,
  logger: Logger,
): http.Server {

  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Only handle GET /health
      if (req.method === 'GET' && req.url === '/health') {
        await handleHealthRequest(req, res, prisma, redis, queues, getAppState, startTime, logger);
        return;
      }

      // All other routes: 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    },
  );

  return server;
}

/**
 * Handles a single GET /health request.
 *
 * Runs the health aggregation and returns the JSON response.
 * Sets appropriate HTTP status codes:
 * - 200: healthy
 * - 200: degraded (still operational)
 * - 503: unhealthy
 */
async function handleHealthRequest(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  prisma: PrismaClient,
  redis: Redis,
  queues: QueueCollection,
  getAppState: () => ApplicationState,
  startTime: number,
  logger: Logger,
): Promise<void> {
  try {
    const health: HealthResponse = await aggregateHealth(
      prisma,
      redis,
      queues,
      getAppState(),
      startTime,
      logger,
    );

    // Determine HTTP status code
    const httpStatus = health.status === 'unhealthy' ? 503 : 200;

    res.writeHead(httpStatus, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });

    res.end(JSON.stringify(health, null, 2));
  } catch (err) {
    logger.error({ err }, 'Health check request failed');

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'unhealthy',
        error: 'Health check failed with unexpected error',
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
