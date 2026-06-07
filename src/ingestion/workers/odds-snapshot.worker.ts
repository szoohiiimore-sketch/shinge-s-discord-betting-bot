import type { Job } from 'bullmq';
import type { OddsSnapshotIngestionService } from '@/ingestion/services';
import type { Logger } from '@/lib/logger';
import type { CanonicalSport, SyncOddsForSportJobData } from '@/ingestion/contracts';
import type { ValueDetectionService } from '@/value-detection';
import type { DiscordNotificationService } from '@/discord';
import { slugify } from '@/ingestion/mappers';

export class OddsSnapshotWorker {
  private readonly _service: OddsSnapshotIngestionService;
  private readonly _valueDetectionService: ValueDetectionService;
  private readonly _discordNotificationService: DiscordNotificationService;
  private readonly _logger: Logger;

  constructor(
    service: OddsSnapshotIngestionService,
    valueDetectionService: ValueDetectionService,
    discordNotificationService: DiscordNotificationService,
    logger: Logger,
  ) {
    this._service = service;
    this._valueDetectionService = valueDetectionService;
    this._discordNotificationService = discordNotificationService;
    this._logger = logger.child({ worker: 'OddsSnapshotWorker' });
  }

  async process(
    job: Job<SyncOddsForSportJobData>,
  ): Promise<{ oddsSnapshots: { created: number; updated: number; skipped: number }; durationMs: number }> {
    const jobId = job.id ?? 'unknown';
    const { sportKey, sportGroup, matchExternalIds } = job.data;
    const startedAt = Date.now();

    this._logger.info(
      { jobId, sportKey, matchCount: matchExternalIds.length },
      'Processing odds snapshot job',
    );

    if (matchExternalIds.length === 0) {
      this._logger.info({ jobId, sportKey }, 'No matches to process — skipping');
      return {
        oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
        durationMs: 0,
      };
    }

    const sport: CanonicalSport = {
      slug: slugify(sportGroup),
      name: sportGroup,
      category: 'TRADITIONAL',
      externalApiSource: 'THE_ODDS_API',
      externalSportKey: slugify(sportGroup),
    };

    const result = await this._service.ingestOddsForSport(sportKey, sport, matchExternalIds);

    if (result.oddsSnapshots.created > 0) {
      try {
        const detection = await this._valueDetectionService.detectForMatchExternalIds(matchExternalIds);
        this._logger.info({ jobId, sportKey, detection }, 'Value detection complete');
      } catch (detectionErr) {
        this._logger.error(
          { jobId, sportKey, err: (detectionErr as Error).message },
          'Value detection failed — ingestion result unaffected',
        );
      }
    }

    try {
      const notifyResult = await this._discordNotificationService.notifyPendingOpportunities();
      if (notifyResult.notified > 0 || notifyResult.failed > 0) {
        this._logger.info({ jobId, sportKey, notifyResult }, 'Discord notification run complete');
      }
    } catch (notifyErr) {
      this._logger.error(
        { jobId, sportKey, err: (notifyErr as Error).message },
        'Discord notification failed — job unaffected',
      );
    }

    this._logger.info(
      { jobId, sportKey, oddsSnapshots: result.oddsSnapshots, durationMs: Date.now() - startedAt },
      'Odds snapshot job complete',
    );

    return {
      oddsSnapshots: result.oddsSnapshots,
      durationMs: Date.now() - startedAt,
    };
  }
}
