import type { Logger } from '@/lib/logger';
import { createMatchFetchProcessor, createOddsFetchProcessor } from '@/ingestion/queues';
import type { IngestionDependencies } from './ingestion-dependencies';

/**
 * Result of the ingestion bootstrap process.
 * Provides access to all workers and their queue processors.
 */
export interface IngestionBootstrapResult {
  readonly matchFetchProcessor: ReturnType<typeof createMatchFetchProcessor>;
  readonly oddsFetchProcessor: ReturnType<typeof createOddsFetchProcessor>;
}

/**
 * Bootstraps the ingestion system by wiring workers to BullMQ queue processors.
 *
 * This function:
 * 1. Takes the pre-built ingestion dependencies (workers)
 * 2. Creates BullMQ Processor functions that dispatch jobs by name
 * 3. Returns the processors ready for assignment to BullMQ Worker instances
 *
 * Processor → Queue mapping:
 *   matchFetchProcessor  → QueueName.MATCH_FETCH (match-fetch)
 *   oddsFetchProcessor   → QueueName.ODDS_FETCH  (odds-fetch)
 *
 * @param deps - Ingestion dependencies containing all worker instances
 * @param logger - Logger instance
 * @returns Processors ready to be assigned to BullMQ Workers
 */
export function bootstrapIngestion(
  deps: IngestionDependencies,
  logger: Logger,
): IngestionBootstrapResult {
  const bootLogger = logger.child({ module: 'ingestion-bootstrap' });

  bootLogger.info('Bootstrapping ingestion system');

  const matchFetchProcessor = createMatchFetchProcessor(
    deps.referenceDataWorker,
    deps.matchIngestionWorker,
    deps.settlementWorker,
    deps.dailySummaryWorker,
    logger,
  );

  const oddsFetchProcessor = createOddsFetchProcessor(
    deps.oddsSnapshotWorker,
    deps.esportsOddsSnapshotWorker,
    logger,
  );

  bootLogger.info(
    {
      matchFetchJobs: ['sync-reference-data', 'sync-traditional-sport', 'sync-esports-game'],
      oddsFetchJobs: ['sync-odds-for-sport', 'sync-esports-odds'],
    },
    'Ingestion processors created',
  );

  return {
    matchFetchProcessor,
    oddsFetchProcessor,
  };
}