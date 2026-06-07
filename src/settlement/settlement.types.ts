export type BetOutcome = 'WIN' | 'LOSS' | 'PUSH';

/** Notification payload for a single newly-settled ValueOpportunity. */
export interface SettledOpportunityNotification {
  readonly sport: string;
  readonly outcome: string;
  readonly bookmakerOdds: number;
  readonly edgePercentage: number;
  readonly betResult: BetOutcome;
  readonly profitLossUnits: number;
  readonly homeTeamName: string;
  readonly awayTeamName: string;
  readonly settledAt: Date;
}

export interface SettlementResult {
  readonly matchesUpdated: number;
  readonly opportunitiesSettled: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly unresolvable: number;
  readonly durationMs: number;
  /** Opportunities settled in this run, ready for Discord notification. */
  readonly newlySettled: readonly SettledOpportunityNotification[];
}
