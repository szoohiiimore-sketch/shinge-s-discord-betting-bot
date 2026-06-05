import type { Logger } from '@/lib/logger';
import { QueueError } from '@/lib/errors';
import { closeQueues } from './queue-factory';
import { closeWorkers, pauseWorkers, resumeWorkers } from './worker-factory';
import type { QueueCollection, WorkerCollection } from './queue-types';

/**
 * Starts all BullMQ workers (resumes from paused state).
 *
 * Should be called after all queues and workers are created.
 *
 * @param workers - Collection of Worker instances
 * @param logger - Logger instance
 * @throws {QueueError} If workers fail to start
 */
export async function startWorkers(
  workers: WorkerCollection,
  logger: Logger,
): Promise<void> {
  logger.info('Starting BullMQ workers');

  try {
    await resumeWorkers(workers, logger);
    logger.info('All BullMQ workers started');
  } catch (err) {
    throw new QueueError('Failed to start BullMQ workers', {
      retryable: true,
      cause: err as Error,
    });
  }
}

/**
 * Stops all BullMQ workers and queues gracefully.
 *
 * Order:
 * 1. Pause workers (stop accepting new jobs)
 * 2. Close workers (wait for active jobs to complete)
 * 3. Close queues
 *
 * @param workers - Collection of Worker instances
 * @param queues - Collection of Queue instances
 * @param logger - Logger instance
 */
export async function stopQueuesAndWorkers(
  workers: WorkerCollection,
  queues: QueueCollection,
  logger: Logger,
): Promise<void> {
  logger.info('Stopping BullMQ queues and workers');

  const errors: Error[] = [];

  // Step 1: Pause workers
  try {
    await pauseWorkers(workers, logger);
  } catch (err) {
    errors.push(err as Error);
  }

  // Step 2: Close workers
  try {
    await closeWorkers(workers, logger);
  } catch (err) {
    errors.push(err as Error);
  }

  // Step 3: Close queues
  try {
    await closeQueues(queues, logger);
  } catch (err) {
    errors.push(err as Error);
  }

  if (errors.length > 0) {
    logger.error(
      { errors: errors.map((e) => e.message) },
      'Some BullMQ components failed to stop',
    );
  }
}
