import { z } from 'zod';
import type { BettingConfig } from './config.types';

const schema = z
  .object({
    BETTING_DEFAULT_BANKROLL: z
      .string()
      .default('10000')
      .pipe(
        z.coerce
          .number()
          .int('BETTING_DEFAULT_BANKROLL must be an integer')
          .positive('BETTING_DEFAULT_BANKROLL must be positive'),
      ),
    BETTING_MAX_CONCURRENT_BETS: z
      .string()
      .default('10')
      .pipe(
        z.coerce
          .number()
          .int('BETTING_MAX_CONCURRENT_BETS must be an integer')
          .positive('BETTING_MAX_CONCURRENT_BETS must be positive'),
      ),
    BETTING_ANALYSIS_BUDGET_DAILY: z
      .string()
      .default('50')
      .pipe(
        z.coerce
          .number()
          .int('BETTING_ANALYSIS_BUDGET_DAILY must be an integer')
          .positive('BETTING_ANALYSIS_BUDGET_DAILY must be positive'),
      ),
    MAX_ALERT_ODDS: z
      .string()
      .default('3.0')
      .pipe(
        z.coerce
          .number()
          .positive('MAX_ALERT_ODDS must be positive')
          .min(1.01, 'MAX_ALERT_ODDS must be at least 1.01'),
      ),
  })
  .transform((env) => ({
    defaultBankroll: env.BETTING_DEFAULT_BANKROLL,
    maxConcurrentBets: env.BETTING_MAX_CONCURRENT_BETS,
    analysisBudgetDaily: env.BETTING_ANALYSIS_BUDGET_DAILY,
    maxAlertOdds: env.MAX_ALERT_ODDS,
  }));

export function loadBettingConfig(env: Record<string, string | undefined>): BettingConfig {
  const result = schema.safeParse(env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');

    throw new Error(`Betting configuration validation failed:\n${missing}`);
  }

  return result.data;
}
