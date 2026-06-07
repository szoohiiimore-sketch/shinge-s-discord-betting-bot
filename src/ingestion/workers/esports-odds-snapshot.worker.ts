import type { Job } from 'bullmq';
import type { EsportsOddsSnapshotIngestionService } from '@/ingestion/services';
import type { Logger } from '@/lib/logger';
import { QuotaExhaustedError } from '@/lib/errors';
import type { SyncEsportsOddsJobData } from '@/ingestion/contracts';
import type { EsportsOddsIngestionResult } from '@/ingestion/services/types';
import type { ValueDetectionService } from '@/value-detection';
import type { DiscordNotificationService } from '@/discord';

export class EsportsOddsSnapshotWorker {
  private readonly _service: EsportsOddsSnapshotIngestionService;
  private readonly _valueDetectionService: ValueDetectionService;
  private readonly _discordNotificationService: DiscordNotificationService;
  private readonly _logger: Logger;

  constructor(
    service: EsportsOddsSnapshotIngestionService,
    valueDetectionService: ValueDetectionService,
    discordNotificationService: DiscordNotificationService,
    logger: Logger,
  ) {
    this._service = service;
    this._valueDetectionService = valueDetectionService;
    this._discordNotificationService = discordNotificationService;
    this._logger = logger.child({ worker: 'EsportsOddsSnapshotWorker' });
  }

  async process(job: Job<SyncEsportsOddsJobData>): Promise<EsportsOddsIngestionResult> {
    const jobId = job.id ?? 'unknown';
    const { videogame, matchExternalIds } = job.data;
    const startedAt = Date.now();

    this._logger.info({ jobId, videogame, matchCount: matchExternalIds.length }, 'Processing esports odds job');

    if (matchExternalIds.length === 0) {
      return {
        videogame,
        oddsMatchesReceived: 0,
        oddsMatchesCorrelated: 0,
        oddsMatchesSkipped: 0,
        oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
        quotaUsedThisCall: 0,
        errors: [],
        durationMs: 0,
      };
    }

    try {
      const result = await this._service.ingestOddsForGame(videogame, matchExternalIds);

      if (result.oddsSnapshots.created > 0) {
        try {
          const detection = await this._valueDetectionService.detectForMatchExternalIds(matchExternalIds);
          this._logger.info({ jobId, videogame, detection }, 'Value detection complete');
        } catch (detectionErr) {
          this._logger.error(
            { jobId, videogame, err: (detectionErr as Error).message },
            'Value detection failed — ingestion result unaffected',
          );
        }
      }

      try {
        const notifyResult = await this._discordNotificationService.notifyPendingOpportunities();
        if (notifyResult.notified > 0 || notifyResult.failed > 0) {
          this._logger.info({ jobId, videogame, notifyResult }, 'Discord notification run complete');
        }
      } catch (notifyErr) {
        this._logger.error(
          { jobId, videogame, err: (notifyErr as Error).message },
          'Discord notification failed — job unaffected',
        );
      }

      this._logger.info(
        {
          jobId,
          videogame,
          oddsMatchesReceived: result.oddsMatchesReceived,
          oddsMatchesCorrelated: result.oddsMatchesCorrelated,
          oddsMatchesSkipped: result.oddsMatchesSkipped,
          oddsSnapshots: result.oddsSnapshots,
          durationMs: Date.now() - startedAt,
        },
        'Esports odds job complete',
      );

      return result;
    } catch (error) {
      if (error instanceof QuotaExhaustedError) {
        this._logger.warn(
          { videogame, provider: error.provider, usage: error.currentUsage, limit: error.monthlyLimit },
          'OddsPapi quota exhausted — skipping esports odds for remainder of month',
        );
        return {
          videogame,
          oddsMatchesReceived: 0,
          oddsMatchesCorrelated: 0,
          oddsMatchesSkipped: 0,
          oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
          quotaUsedThisCall: 0,
          errors: [],
          durationMs: Date.now() - startedAt,
        };
      }
      throw error;
    }
  }
}
