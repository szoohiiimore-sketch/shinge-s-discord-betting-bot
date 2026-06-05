import { AppError } from './app-error';

/**
 * Business invariant violation.
 *
 * Thrown when a business rule is violated (e.g., insufficient bankroll,
 * maximum concurrent bets exceeded, duplicate prediction for same match).
 *
 * @example
 * throw new BusinessRuleError('Insufficient bankroll', {
 *   context: { userId: 'abc', balance: 100, requiredStake: 200 }
 * });
 */
export class BusinessRuleError extends AppError {
  constructor(message: string, options: BusinessRuleErrorOptions = {}) {
    super({
      message,
      code: 'BUSINESS_RULE_VIOLATION',
      statusCode: 422,
      retryable: false,
      cause: options.cause,
      context: options.context,
    });
  }
}

export interface BusinessRuleErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
}
