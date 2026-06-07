import type { Job } from 'bullmq';

/**
 * Handler function type for a registered queue job.
 * Accepts a BullMQ Job and returns the result as the job return value.
 */
export type JobHandler<TData = unknown, TReturn = unknown> = (job: Job<TData>) => Promise<TReturn>;

/**
 * Maps job names to their handler functions for a given queue.
 *
 * Each job name has exactly one handler. The handler receives the
 * BullMQ Job and returns a strongly-typed result.
 */
export type JobHandlerMap = Record<string, JobHandler>;

/**
 * Collection of handler maps for all ingestion queues.
 */
export interface QueueHandlerRegistry {
  readonly matchFetch: JobHandlerMap;
  readonly oddsFetch: JobHandlerMap;
}