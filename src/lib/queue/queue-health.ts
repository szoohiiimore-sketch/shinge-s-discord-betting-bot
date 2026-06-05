import type { Logger } from '@/lib/logger';
import type { QueueCollection } from './queue-types';

/**
 * Result of a queue health check.
 */
export interface QueueHealth {
  /** Whether all queues are reachable and responsive */
  ok: boolean;
  /** Per-queue health status */
  queues: Record<string, QueueHealthItem>;
}

/**
 * Health status for a single queue.
 */
export interface QueueHealthItem {
  /** Whether the queue is reachable */
  ok: boolean;
  /** Approximate number of waiting jobs */
  waiting?: number;
  /** Approximate number of active jobs */
  active?: number;
  /** Approximate number of failed jobs */
  failed?: number;
  /** Error message if the check failed */
  error?: string;
}

/**
 * Performs a health check on all BullMQ queues.
 *
 * Checks each queue by querying its job counts.
 * Returns a structured result rather than throwing, making it
 * suitable for use in health check endpoints.
 *
 * @param queues - Collection of Queue instances
 * @param logger - Logger instance
 * @returns Queue health status
 *
 * @example
 * const health = await checkQueueHealth(queues, logger);
 * // { ok: true, queues: { 'match-fetch': { ok: true, waiting: 0, active: 0, failed: 0 } } }
 */
export async function checkQueueHealth(
  queues: QueueCollection,
  logger: Logger,
): Promise<QueueHealth> {
  const queueResults: Record<string, QueueHealthItem> = {};
  let allOk = true;

  for (const [name, queue] of Object.entries(queues)) {
    try {
      const jobCounts = await queue.getJobCounts(
        'waiting',
        'active',
        'failed',
        'completed',
      );

      queueResults[name] = {
        ok: true,
        waiting: jobCounts.waiting ?? 0,
        active: jobCounts.active ?? 0,
        failed: jobCounts.failed ?? 0,
      };

      logger.debug(
        {
          queue: name,
          waiting: jobCounts.waiting,
          active: jobCounts.active,
          failed: jobCounts.failed,
        },
        'Queue health check passed',
      );
    } catch (err) {
      allOk = false;

      queueResults[name] = {
        ok: false,
        error: (err as Error).message,
      };

      logger.error({ err, queue: name }, 'Queue health check failed');
    }
  }

  return {
    ok: allOk,
    queues: queueResults,
  };
}
