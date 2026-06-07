import type { Job } from 'bullmq';
import type { Logger } from '@/lib/logger';
import type { DiscordNotificationService } from './discord-notification.service';

export class DailySummaryWorker {
  private readonly _notificationService: DiscordNotificationService;
  private readonly _logger: Logger;

  constructor(notificationService: DiscordNotificationService, logger: Logger) {
    this._notificationService = notificationService;
    this._logger = logger.child({ worker: 'DailySummaryWorker' });
  }

  async process(_job: Job): Promise<void> {
    this._logger.info('Daily summary job started');
    await this._notificationService.notifyDailySummary();
    this._logger.info('Daily summary job complete');
  }
}
