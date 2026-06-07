import type { Job } from 'bullmq';
import type { ReferenceDataIngestionService } from '@/ingestion/services';
import type { Logger } from '@/lib/logger';
import type { SyncReferenceDataJobData } from '@/ingestion/contracts';
import type { ReferenceSyncResult } from '@/ingestion/contracts';

/**
 * BullMQ worker processor for the sync-reference-data job.
 *
 * Handles jobs on the match-fetch queue with name "sync-reference-data".
 * Delegates to ReferenceDataIngestionService to fetch sports from The Odds API
 * and upsert Sport and League records.
 *
 * Constructor injection: all dependencies passed explicitly.
 * No global mutable state.
 */
export class ReferenceDataWorker {
  private readonly _service: ReferenceDataIngestionService;
  private readonly _logger: Logger;

  constructor(
    service: ReferenceDataIngestionService,
    logger: Logger,
  ) {
    this._service = service;
    this._logger = logger.child({ worker: 'ReferenceDataWorker' });
  }

  /**
   * Processes a sync-reference-data job.
   *
   * Fetches all active sports from The Odds API and upserts
   * Sport and League reference entities. Returns the sync result
   * as the BullMQ job return value.
   */
  async process(job: Job<SyncReferenceDataJobData>): Promise<ReferenceSyncResult> {
    const jobId = job.id ?? 'unknown';
    const startedAt = Date.now();

    this._logger.info({ jobId }, 'Processing reference data sync job');

    const result = await this._service.sync();

    const durationMs = Date.now() - startedAt;

    this._logger.info(
      { jobId, sports: result.sports, leagues: result.leagues, durationMs },
      'Reference data sync job complete',
    );

    return {
      sports: result.sports,
      leagues: result.leagues,
      errors: result.errors,
      completedAt: new Date(),
      durationMs,
    };
  }
}