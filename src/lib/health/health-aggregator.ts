import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import type { ApplicationState } from '@/lib/app/app-state';
import { checkDatabaseHealth } from '@/lib/prisma/prisma-health';
import { checkRedisHealth } from '@/lib/redis/redis-health';
import { checkQueueHealth } from '@/lib/queue/queue-health';
import type { QueueCollection } from '@/lib/queue/queue-types';
import type { HealthResponse } from './health-types';

/**
 * Aggregates health status from all infrastructure dependencies.
 *
 * Runs all health checks concurrently and combines the results
 * into a single HealthResponse. Determines overall status:
 *
 * - **healthy:** All dependencies are responsive
 * - **degraded:** Some dependencies are failing (non-critical)
 * - **unhealthy:** Critical dependencies (database, Redis) are failing
 *
 * @param prisma - PrismaClient instance
 * @param redis - Redis instance
 * @param queues - BullMQ Queue collection
 * @param appState - Current application lifecycle state
 * @param startTime - Application start timestamp (from performance.now())
 * @param logger - Logger instance
 * @returns Aggregated health response
 *
 * @example
 * const health = await aggregateHealth(prisma, redis, queues, app.state, appStartTime, logger);
 * // { status: 'healthy', database: { ok: true }, redis: { ok: true }, ... }
 */
export async function aggregateHealth(
  prisma: PrismaClient,
  redis: Redis,
  queues: QueueCollection,
  appState: ApplicationState,
  startTime: number,
  logger: Logger,
): Promise<HealthResponse> {
  // Run all health checks concurrently
  const [database, redisHealth, queueHealth] = await Promise.all([
    checkDatabaseHealth(prisma, logger),
    checkRedisHealth(redis, logger),
    checkQueueHealth(queues, logger),
  ]);

  // Calculate uptime in seconds
  const uptime = Math.floor((performance.now() - startTime) / 1000);

  // Determine overall status
  const status = determineOverallStatus(database.ok, redisHealth.ok, queueHealth.ok);

  return {
    status,
    applicationState: appState,
    uptime,
    database,
    redis: redisHealth,
    queues: queueHealth,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Determines the overall health status based on individual component statuses.
 *
 * - **healthy:** All components are ok
 * - **degraded:** Queues are failing but database and Redis are ok
 * - **unhealthy:** Database or Redis is failing
 */
function determineOverallStatus(
  databaseOk: boolean,
  redisOk: boolean,
  queuesOk: boolean,
): 'healthy' | 'degraded' | 'unhealthy' {
  if (!databaseOk || !redisOk) {
    return 'unhealthy';
  }

  if (!queuesOk) {
    return 'degraded';
  }

  return 'healthy';
}
