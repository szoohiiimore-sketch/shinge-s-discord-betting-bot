import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import { QueueError } from '@/lib/errors';
import { QueueName, DEFAULT_JOB_OPTIONS, type QueueCollection } from './queue-types';

/**
 * Creates all BullMQ Queue instances.
 *
 * Each queue is configured with:
 * - A connection to the shared Redis instance
 * - Default job options (auto-remove completed/failed jobs)
 *
 * @param redis - Redis instance (shared with workers)
 * @param logger - Logger instance
 * @returns A collection of Queue instances, one per QueueName
 *
 * @example
 * const queues = createQueues(redis, logger);
 * await queues['match-fetch'].add('fetch', { sport: 'soccer' });
 */
export function createQueues(
  redis: Redis,
  logger: Logger,
): QueueCollection {
  logger.info('Creating BullMQ queues');

  const queues: Partial<QueueCollection> = {};

  for (const name of Object.values(QueueName)) {
    try {
      const queue = new Queue(name, {
        connection: redis as unknown as import('bullmq').ConnectionOptions,
        defaultJobOptions: {
          ...DEFAULT_JOB_OPTIONS,
        },
      });

      queues[name] = queue;
      logger.debug({ queue: name }, 'Queue created');
    } catch (err) {
      throw new QueueError(`Failed to create queue: ${name}`, {
        retryable: true,
        cause: err as Error,
        context: { queueName: name },
      });
    }
  }

  logger.info('All BullMQ queues created', {
    queues: Object.values(QueueName),
  });

  return queues as QueueCollection;
}

/**
 * Closes all Queue instances gracefully.
 *
 * Waits for pending operations to complete before closing.
 * Collects and logs errors without throwing.
 *
 * @param queues - Collection of Queue instances
 * @param logger - Logger instance
 */
export async function closeQueues(
  queues: QueueCollection,
  logger: Logger,
): Promise<void> {
  logger.info('Closing BullMQ queues');

  const errors: Error[] = [];

  for (const [name, queue] of Object.entries(queues)) {
    try {
      await queue.close();
      logger.debug({ queue: name }, 'Queue closed');
    } catch (err) {
      logger.error({ err, queue: name }, 'Error closing queue');
      errors.push(err as Error);
    }
  }

  if (errors.length > 0) {
    logger.error(
      { errors: errors.map((e) => e.message) },
      'Some queues failed to close',
    );
  }
}
