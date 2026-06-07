import type { Logger } from '@/lib/logger';
import { RateLimitError, QuotaExhaustedError } from '@/lib/errors';
import type { OddspapiClient } from './oddspapi.client';
import type { OddspapiVideogame, OddspapiMatchOdds } from './types';
import type { OddspapiQuotaTracker } from './quota.tracker';

export class ResilientOddspapiClient implements OddspapiClient {
  constructor(
    private readonly _inner: OddspapiClient,
    private readonly _quotaTracker: OddspapiQuotaTracker,
    private readonly _logger: Logger,
  ) {}

  async getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]> {
    const newCount = await this._quotaTracker.incrementAndCheck();

    if (newCount > this._quotaTracker.getHardLimit()) {
      await this._quotaTracker.decrement();
      throw new QuotaExhaustedError(
        'OddsPapi',
        this._quotaTracker.getHardLimit(),
        newCount - 1,
      );
    }

    if (newCount >= this._quotaTracker.getSoftLimit()) {
      this._logger.warn(
        { used: newCount, limit: this._quotaTracker.getHardLimit() },
        'OddsPapi quota warning — approaching monthly limit',
      );
    }

    try {
      return await this._inner.getOddsForGame(videogame);
    } catch (error) {
      if (error instanceof RateLimitError) {
        await this._quotaTracker.forceExhaust();
        throw new QuotaExhaustedError(
          'OddsPapi',
          this._quotaTracker.getHardLimit(),
          this._quotaTracker.getHardLimit(),
        );
      }
      throw error;
    }
  }
}