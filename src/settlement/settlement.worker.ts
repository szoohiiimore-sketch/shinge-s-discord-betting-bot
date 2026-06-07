import type { Job } from 'bullmq';
import type { Logger } from '@/lib/logger';
import type { SettlementService } from './settlement.service';
import type { DiscordNotificationService } from '@/discord';
import type { EsportsVideogame } from '@/ingestion/contracts';
import type { SettledOpportunityNotification } from './settlement.types';

const ESPORTS_VIDEOGAMES: readonly EsportsVideogame[] = ['cs2', 'valorant', 'lol', 'dota2'];

const TRADITIONAL_SPORT_KEYS: readonly string[] = [
  'icehockey_nhl',
  'baseball_mlb',
  'basketball_wnba',
  'soccer_usa_mls',
  'tennis_atp_wimbledon',
  'tennis_atp_us_open',
  'tennis_atp_indian_wells',
  'tennis_atp_miami_open',
  'tennis_wta_wimbledon',
  'tennis_wta_us_open',
  'tennis_wta_indian_wells',
  'tennis_wta_miami_open',
  'basketball_nba',
  'soccer_epl',
  'soccer_uefa_champs_league',
  'americanfootball_ncaaf',
];

export class SettlementWorker {
  private readonly _service: SettlementService;
  private readonly _notificationService: DiscordNotificationService;
  private readonly _logger: Logger;

  constructor(
    service: SettlementService,
    notificationService: DiscordNotificationService,
    logger: Logger,
  ) {
    this._service = service;
    this._notificationService = notificationService;
    this._logger = logger.child({ worker: 'SettlementWorker' });
  }

  async process(_job: Job): Promise<void> {
    this._logger.info('Settlement job started');

    let traditionalNewlySettled: readonly SettledOpportunityNotification[] = [];
    let esportsNewlySettled: readonly SettledOpportunityNotification[] = [];

    try {
      const traditionalResult = await this._service.settleTraditional(TRADITIONAL_SPORT_KEYS);
      this._logger.info(
        { matchesUpdated: traditionalResult.matchesUpdated, settled: traditionalResult.opportunitiesSettled },
        'Traditional settlement complete',
      );
      traditionalNewlySettled = traditionalResult.newlySettled;
    } catch (err) {
      this._logger.error({ err: (err as Error).message }, 'Traditional settlement failed');
    }

    try {
      const esportsResult = await this._service.settleEsports(ESPORTS_VIDEOGAMES);
      this._logger.info(
        { matchesUpdated: esportsResult.matchesUpdated, settled: esportsResult.opportunitiesSettled },
        'Esports settlement complete',
      );
      esportsNewlySettled = esportsResult.newlySettled;
    } catch (err) {
      this._logger.error({ err: (err as Error).message }, 'Esports settlement failed');
    }

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
