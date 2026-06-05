import type { ApplicationState } from '@/lib/app/app-state';
import type { DatabaseHealth } from '@/lib/prisma/prisma-health';
import type { RedisHealth } from '@/lib/redis/redis-health';
import type { QueueHealth } from '@/lib/queue/queue-health';

/**
 * Complete health check response returned by the GET /health endpoint.
 *
 * Aggregates health status from all infrastructure dependencies.
 */
export interface HealthResponse {
  /** Overall health status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Current application lifecycle state */
  applicationState: ApplicationState;
  /** Application uptime in seconds */
  uptime: number;
  /** Database health status */
  database: DatabaseHealth;
  /** Redis health status */
  redis: RedisHealth;
  /** BullMQ queue health status */
  queues: QueueHealth;
  /** ISO 8601 timestamp of the health check */
  timestamp: string;
}

/**
 * Configuration for the health check HTTP server.
 */
export interface HealthServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to */
  host: string;
}
