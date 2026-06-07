/**
 * Thrown when an external API's monthly quota has been exhausted.
 * Non-retryable — retrying would consume quota that doesn't exist.
 * Workers catching this error should complete the job gracefully (not fail).
 */
export class QuotaExhaustedError extends Error {
  readonly provider: string;
  readonly monthlyLimit: number;
  readonly currentUsage: number;

  constructor(provider: string, monthlyLimit: number, currentUsage: number) {
    super(`${provider} quota exhausted: ${currentUsage}/${monthlyLimit} requests used this month`);
    this.provider = provider;
    this.monthlyLimit = monthlyLimit;
    this.currentUsage = currentUsage;
    this.name = 'QuotaExhaustedError';
  }
}