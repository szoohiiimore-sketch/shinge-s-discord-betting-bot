import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import { QueueError } from '@/lib/errors';
import { QueueName, DEFAULT_WORKER_OPTIONS, type WorkerCollection } from './queue-types';

/**
 * Placeholder job processor.
 *
 * This is a temporary processor that will be replaced when
 * actual job handlers are implemented in later phases.
 * It prevents workers from crashing on unknown jobs.
 *
 * @param job - The BullMQ job
 */
async function placeholderProcessor(job: { name: string; data: unknown }): Promise<void> {
  // TODO: Replace with actual job processors in later phases
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
 * - A placeholder processor (to be replaced in later phases)
 *
 * Workers are created in a paused state by default. They must be
 * explicitly resumed after all workers are created.
 *
 * @param redis - Redis instance (shared with queues)
 * @param logger - Logger instance
 * @returns A collection of Worker instances, one per QueueName
 *
 * @example
 * const workers = createWorkers(redis, logger);
 * // Workers are paused — resume when ready
 * await Promise.all(Object.values(workers).map(w => w.resume()));
 */
export function createWorkers(
  redis: Redis,
  logger: Logger,
): WorkerCollection {
  logger.info('Creating BullMQ workers');

  const workers: Partial<WorkerCollection> = {};

  for (const name of Object.values(QueueName)) {
    try {
      const worker = new Worker(
        name,
        placeholderProcessor,
        {
          connection: redis as unknown as import('bullmq').ConnectionOptions,
          concurrency: DEFAULT_WORKER_OPTIONS.concurrency,
          lockDuration: DEFAULT_WORKER_OPTIONS.lockDuration,
          stalledInterval: DEFAULT_WORKER_OPTIONS.stalledInterval,
          // Start in paused state — resume after all workers are created
          autorun: false,
        },
      );

      // Log worker events
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

/**
 * Resumes all Worker instances (starts processing jobs).
 *
 * Workers are created in a paused state. Call this after all
 * workers are created to begin processing.
 *
 * @param workers - Collection of Worker instances
 * @param logger - Logger instance
 */
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

/**
 * Pauses all Worker instances (stops processing new jobs).
 *
 * In-progress jobs are allowed to complete.
 *
 * @param workers - Collection of Worker instances
 * @param logger - Logger instance
 */
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

/**
 * Closes all Worker instances gracefully.
 *
 * Waits for active jobs to complete (up to 30 seconds),
 * then closes the workers.
 *
 * @param workers - Collection of Worker instances
 * @param logger - Logger instance
 */
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
