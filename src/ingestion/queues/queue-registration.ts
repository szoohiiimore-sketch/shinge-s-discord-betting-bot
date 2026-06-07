import type { Job, Processor } from 'bullmq';
import type { Logger } from '@/lib/logger';
import { QueueName } from '@/lib/queue/queue-types';
import type { ReferenceDataWorker } from '@/ingestion/workers';
import type { MatchIngestionWorker } from '@/ingestion/workers';
import type { OddsSnapshotWorker } from '@/ingestion/workers';
import type { EsportsOddsSnapshotWorker } from '@/ingestion/workers';
import type { SettlementWorker } from '@/settlement';
import type { DailySummaryWorker } from '@/discord';
import { MATCH_FETCH_JOB_NAMES, ODDS_FETCH_JOB_NAMES } from './queue-names';

/**
 * Registration mapping:
 *
 * match-fetch queue:
 *   sync-reference-data     → ReferenceDataWorker.process
 *   sync-traditional-sport  → MatchIngestionWorker.process
 *   sync-esports-game       → MatchIngestionWorker.process
 *
 * odds-fetch queue:
 *   sync-odds-for-sport     → OddsSnapshotWorker.process
 */

/**
 * Creates a BullMQ Processor for the match-fetch queue.
 *
 * Dispatches to the correct worker based on the job's name field.
 * Unknown job names throw and move the job to the failed queue.
 *
 * @param referenceDataWorker - ReferenceDataWorker instance
 * @param matchIngestionWorker - MatchIngestionWorker instance
 * @param logger - Logger instance
 * @returns A BullMQ Processor function
 */
export function createMatchFetchProcessor(
  referenceDataWorker: ReferenceDataWorker,
  matchIngestionWorker: MatchIngestionWorker,
  settlementWorker: SettlementWorker,
  dailySummaryWorker: DailySummaryWorker,
  logger: Logger,
): Processor {
  return async (job: Job) => {
    logger.debug(
      { queue: QueueName.MATCH_FETCH, jobId: job.id, jobName: job.name },
      'Dispatching match-fetch job',
    );

    switch (job.name) {
      case MATCH_FETCH_JOB_NAMES.SYNC_REFERENCE_DATA:
        return referenceDataWorker.process(job);

      case MATCH_FETCH_JOB_NAMES.SYNC_TRADITIONAL_SPORT:
      case MATCH_FETCH_JOB_NAMES.SYNC_ESPORTS_GAME:
        return matchIngestionWorker.process(job);

      case MATCH_FETCH_JOB_NAMES.SETTLE_MATCHES:
        return settlementWorker.process(job);

      case MATCH_FETCH_JOB_NAMES.DAILY_SUMMARY:
        return dailySummaryWorker.process(job);

      default:
        throw new Error(`Unknown match-fetch job name: ${job.name}`);
    }
  };
}

/**
 * Creates a BullMQ Processor for the odds-fetch queue.
 *
 * Dispatches all jobs to the OddsSnapshotWorker. Currently only one
 * job name (sync-odds-for-sport) exists on this queue.
 *
 * @param oddsSnapshotWorker - OddsSnapshotWorker instance
 * @param logger - Logger instance
 * @returns A BullMQ Processor function
 */
export function createOddsFetchProcessor(
  oddsSnapshotWorker: OddsSnapshotWorker,
  esportsOddsSnapshotWorker: EsportsOddsSnapshotWorker,
  logger: Logger,
): Processor {
  return async (job: Job) => {
    logger.debug(
      { queue: QueueName.ODDS_FETCH, jobId: job.id, jobName: job.name },
      'Dispatching odds-fetch job',
    );

    switch (job.name) {
      case ODDS_FETCH_JOB_NAMES.SYNC_ODDS_FOR_SPORT:
        return oddsSnapshotWorker.process(job);

      case ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS:
        return esportsOddsSnapshotWorker.process(job);

      default:
        throw new Error(`Unknown odds-fetch job name: ${job.name}`);
    }
  };
}
