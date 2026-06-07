import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import { QueueError } from '@/lib/errors';
import { QueueName, DEFAULT_WORKER_OPTIONS, type WorkerCollection } from './queue-types';

/**
 * Placeholder job processor.
 *
 * Throws when no processor is registered for a queue.
 */
async function placeholderProcessor(job: { name: string; data: unknown }): Promise<void> {
  throw new Error(
    `No processor registered for queue. ` +
    `Job: ${job.name}, Data: ${JSON.stringify(job.data)}`,
  );
}

/**
 * Creates all BullMQ Worker instances.
 *
 * Each worker is configured with:
 * - A connection to the shared Redis instance
 * - Default worker options (concurrency, lock duration, stall interval)
 * - A user-supplied processor function, or placeholderProcessor if none provided
 *
 * Workers are created in a paused state by default.
 *
 * @param redis - Redis instance (shared with queues)
 * @param logger - Logger instance
 * @param processors - Optional map of queue name to processor function.
 *                     Overrides placeholderProcessor for specific queues.
 * @returns A collection of Worker instances, one per QueueName
 */
export function createWorkers(
  redis: Redis,
  logger: Logger,
  processors?: Partial<Record<QueueName, (job: any) => Promise<unknown>>>,
): WorkerCollection {
  logger.info('Creating BullMQ workers');

  const workers: Partial<WorkerCollection> = {};

  for (const name of Object.values(QueueName)) {
    try {
      const processor = processors?.[name] ?? placeholderProcessor;

      const worker = new Worker(
        name,
        processor,
        {
          connection: redis as unknown as import('bullmq').ConnectionOptions,
          concurrency: DEFAULT_WORKER_OPTIONS.concurrency,
          lockDuration: DEFAULT_WORKER_OPTIONS.lockDuration,
          stalledInterval: DEFAULT_WORKER_OPTIONS.stalledInterval,
          autorun: false,
        },
      );

      worker.on('completed', (job) => {
        logger.debug(
          { queue: name, jobId: job.id, jobName: job.name },
          'Worker job completed',
        );
      });

      worker.on('failed', (job, err) => {
        logger.error(
          { err, queue: name, jobId: job?.id, jobName: job?.name },
          'Worker job failed',
        );
      });

      worker.on('error', (err) => {
        logger.error({ err, queue: name }, 'Worker error');
      });

      worker.on('active', (job) => {
        logger.debug(
          { queue: name, jobId: job.id, jobName: job.name },
          'Worker job active',
        );
      });

      workers[name] = worker;
      logger.debug({ queue: name }, 'Worker created');
    } catch (err) {
      throw new QueueError(`Failed to create worker: ${name}`, {
        retryable: true,
        cause: err as Error,
        context: { queueName: name },
      });
    }
  }

  logger.info('All BullMQ workers created', {
    queues: Object.values(QueueName),
  });

  return workers as WorkerCollection;
}

export async function resumeWorkers(
  workers: WorkerCollection,
  logger: Logger,
): Promise<void> {
  logger.info('Resuming BullMQ workers');

  for (const [name, worker] of Object.entries(workers)) {
    try {
      await worker.resume();
      logger.debug({ queue: name }, 'Worker resumed');
    } catch (err) {
      logger.error({ err, queue: name }, 'Error resuming worker');
    }
  }
}

export async function pauseWorkers(
  workers: WorkerCollection,
  logger: Logger,
): Promise<void> {
  logger.info('Pausing BullMQ workers');

  for (const [name, worker] of Object.entries(workers)) {
    try {
      await worker.pause();
      logger.debug({ queue: name }, 'Worker paused');
    } catch (err) {
      logger.error({ err, queue: name }, 'Error pausing worker');
    }
  }
}

export async function closeWorkers(
  workers: WorkerCollection,
  logger: Logger,
): Promise<void> {
  logger.info('Closing BullMQ workers');

  const errors: Error[] = [];

  for (const [name, worker] of Object.entries(workers)) {
    try {
      await worker.close();
      logger.debug({ queue: name }, 'Worker closed');
    } catch (err) {
      logger.error({ err, queue: name }, 'Error closing worker');
      errors.push(err as Error);
    }
  }

  if (errors.length > 0) {
    logger.error(
      { errors: errors.map((e) => e.message) },
      'Some workers failed to close',
    );
  }
}