import type { Job } from 'bullmq';
import type { Logger } from '@/lib/logger';
import type { SettlementService } from './settlement.service';
import type { DiscordNotificationService } from '@/discord';
import type { SettledOpportunityNotification } from './settlement.types';

export class SettlementWorker {
  private readonly _service: SettlementService;
  private readonly _notificationService: DiscordNotificationService;
  private readonly _logger: Logger;
  private readonly _traditionalSportKeys: readonly string[];

  constructor(
    service: SettlementService,
    notificationService: DiscordNotificationService,
    logger: Logger,
    traditionalSportKeys: readonly string[],
  ) {
    this._service = service;
    this._notificationService = notificationService;
    this._logger = logger.child({ worker: 'SettlementWorker' });
    this._traditionalSportKeys = traditionalSportKeys;
  }

  async process(_job: Job): Promise<void> {
    this._logger.info('Settlement job started');

    let traditionalNewlySettled: readonly SettledOpportunityNotification[] = [];
    let esportsNewlySettled: readonly SettledOpportunityNotification[] = [];

    try {
      const traditionalResult = await this._service.settleTraditional(this._traditionalSportKeys);
      this._logger.info(
        { matchesUpdated: traditionalResult.matchesUpdated, settled: traditionalResult.opportunitiesSettled },
        'Traditional settlement complete',
      );
      traditionalNewlySettled = traditionalResult.newlySettled;
    } catch (err) {
      this._logger.error({ err: (err as Error).message }, 'Traditional settlement failed');
    }

    // Esports settlement disabled (V1) — see ESPORTS-DISABLE-IMPACT-AUDIT.md.
    // To re-enable, restore: await this._service.settleEsports(ESPORTS_VIDEOGAMES)

    const allNewlySettled = [...traditionalNewlySettled, ...esportsNewlySettled];
    if (allNewlySettled.length > 0) {
      try {
        await this._notificationService.notifySettledOutcomes(allNewlySettled);
      } catch (err) {
        this._logger.error({ err: (err as Error).message }, 'Failed to send settlement outcome notifications');
      }
    }

    this._logger.info({ notified: allNewlySettled.length }, 'Settlement job complete');
  }
}
