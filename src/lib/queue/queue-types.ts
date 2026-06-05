import type { Queue, Worker } from 'bullmq';

/**
 * Queue names used throughout the application.
 *
 * Only V1 queues are defined here. Additional queues will be
 * added in later phases as business logic is implemented.
 */
export enum QueueName {
  /** Fetch matches from external APIs */
  MATCH_FETCH = 'match-fetch',
  /** Fetch odds for active matches */
  ODDS_FETCH = 'odds-fetch',
  /** Run AI analysis on matches */
  AI_ANALYSIS = 'ai-analysis',
}

/**
 * Collection of BullMQ Queue instances.
 *
 * Each queue is created during startup and stored here.
 * Workers are stored separately.
 */
export interface QueueCollection {
  [QueueName.MATCH_FETCH]: Queue;
  [QueueName.ODDS_FETCH]: Queue;
  [QueueName.AI_ANALYSIS]: Queue;
}

/**
 * Collection of BullMQ Worker instances.
 *
 * Each worker is created during startup and stored here.
 */
export interface WorkerCollection {
  [QueueName.MATCH_FETCH]: Worker;
  [QueueName.ODDS_FETCH]: Worker;
  [QueueName.AI_ANALYSIS]: Worker;
}

/**
 * Default job options applied to all queues.
 */
export const DEFAULT_JOB_OPTIONS = {
  /** Remove completed jobs after 1 hour */
  removeOnComplete: {
    age: 3600,
  },
  /** Remove failed jobs after 24 hours */
  removeOnFail: {
    age: 86_400,
  },
} as const;

/**
 * Default worker options applied to all workers.
 */
export const DEFAULT_WORKER_OPTIONS = {
  /** Concurrency: 1 job at a time per worker */
  concurrency: 1,
  /** Lock duration: 30 seconds */
  lockDuration: 30_000,
  /** Stalled interval: 15 seconds */
  stalledInterval: 15_000,
} as const;
