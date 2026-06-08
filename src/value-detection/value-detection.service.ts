import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import type { ValueDetectionResult, ValueDetectionDecision, ValueOpportunityInsert } from './value-detection.types';
import type { ValueOpportunityRepository } from './value-opportunity.repository';

const MIN_EDGE_THRESHOLD_PCT = 5.0;
const MAX_EDGE_THRESHOLD_PCT = 100;
const MIN_CONSENSUS_BOOKMAKERS = 2;
const CANDIDATE_BOOKMAKER = 'pinnacle';

interface SnapshotRow {
  matchId: string;
  bookmaker: string;
  outcome: string;
  price: string | number | { toNumber(): number };
  capturedAt: Date;
  match: {
    externalId: string;
    sport: { slug: string };
  };
}

function toNumber(price: string | number | { toNumber(): number }): number {
  if (typeof price === 'number') return price;
  if (typeof price === 'string') return parseFloat(price);
  return price.toNumber();
}

export class ValueDetectionService {
  private readonly _prisma: PrismaClient;
  private readonly _repository: ValueOpportunityRepository;
  private readonly _logger: Logger;

  constructor(
    prisma: PrismaClient,
    repository: ValueOpportunityRepository,
    private readonly _maxAlertOdds: number,
    logger: Logger,
  ) {
    this._prisma = prisma;
    this._repository = repository;
    this._logger = logger.child({ service: 'ValueDetectionService' });
  }

  async detectForMatchExternalIds(
    matchExternalIds: readonly string[],
  ): Promise<ValueDetectionResult> {
    const startedAt = Date.now();

    if (matchExternalIds.length === 0) {
      return { matchesAnalyzed: 0, opportunitiesDetected: 0, opportunitiesRejected: 0, opportunitiesSkipped: 0, durationMs: 0 };
    }

    const snapshots = await this._prisma.oddsSnapshot.findMany({
      where: {
        match: { externalId: { in: matchExternalIds as string[] } },
        market: 'H2H',
        isLive: false,
      },
      select: {
        matchId: true,
        bookmaker: true,
        outcome: true,
        price: true,
        capturedAt: true,
        match: {
          select: {
            externalId: true,
            sport: { select: { slug: true } },
          },
        },
      },
    }) as SnapshotRow[];

    if (snapshots.length === 0) {
      return { matchesAnalyzed: 0, opportunitiesDetected: 0, opportunitiesRejected: 0, opportunitiesSkipped: 0, durationMs: Date.now() - startedAt };
    }

    // Group by matchId
    const byMatch = new Map<string, SnapshotRow[]>();
    for (const s of snapshots) {
      let arr = byMatch.get(s.matchId);
      if (!arr) { arr = []; byMatch.set(s.matchId, arr); }
      arr.push(s);
    }

    let detected = 0;
    let rejected = 0;
    let skipped = 0;
    const toInsert: ValueOpportunityInsert[] = [];

    for (const [matchId, matchSnapshots] of byMatch) {
      // Find latest capturedAt for this match (most recent ingestion batch)
      const latestCapturedAt = matchSnapshots.reduce(
        (max, s) => (s.capturedAt > max ? s.capturedAt : max),
        matchSnapshots[0].capturedAt,
      );

      // Only process the latest batch — prior batches are historical
      const latestSnapshots = matchSnapshots.filter(
        s => s.capturedAt.getTime() === latestCapturedAt.getTime(),
      );

      const sport = latestSnapshots[0].match.sport.slug;

      // Group by outcome
      const byOutcome = new Map<string, SnapshotRow[]>();
      for (const s of latestSnapshots) {
        if (!s.outcome || s.outcome.trim() === '') {
          this._decision('INVALID_DATA', { matchId, bookmaker: s.bookmaker, reason: 'empty outcome' });
          skipped++;
          continue;
        }
        let arr = byOutcome.get(s.outcome);
        if (!arr) { arr = []; byOutcome.set(s.outcome, arr); }
        arr.push(s);
      }

      for (const [outcome, outcomeSnapshots] of byOutcome) {
        const pinnacleSnaps = outcomeSnapshots.filter(s => s.bookmaker === CANDIDATE_BOOKMAKER);
        const consensusSnaps = outcomeSnapshots.filter(s => s.bookmaker !== CANDIDATE_BOOKMAKER);

        if (pinnacleSnaps.length === 0) {
          this._decision('INVALID_DATA', { matchId, outcome, reason: 'no Pinnacle snapshot' });
          skipped++;
          continue;
        }

        if (consensusSnaps.length < MIN_CONSENSUS_BOOKMAKERS) {
          this._decision('INSUFFICIENT_MARKET_DATA', {
            matchId, outcome, consensusCount: consensusSnaps.length, required: MIN_CONSENSUS_BOOKMAKERS,
          });
          skipped++;
          continue;
        }

        const pinnacleOdds = toNumber(pinnacleSnaps[0].price);
        const consensusOdds = consensusSnaps.map(s => toNumber(s.price));

        if (pinnacleOdds <= 1) {
          this._decision('INVALID_DATA', { matchId, outcome, reason: 'pinnacle odds <= 1', pinnacleOdds });
          skipped++;
          continue;
        }

        if (consensusOdds.some(o => o <= 1)) {
          this._decision('INVALID_DATA', { matchId, outcome, reason: 'consensus odds <= 1', consensusOdds });
          skipped++;
          continue;
        }

        const impliedProbs = consensusOdds.map(o => 1 / o);
        const consensusProbability = impliedProbs.reduce((a, b) => a + b, 0) / impliedProbs.length;

        if (consensusProbability <= 0 || consensusProbability >= 1) {
          this._decision('INVALID_DATA', { matchId, outcome, reason: 'invalid consensus probability', consensusProbability });
          skipped++;
          continue;
        }

        const fairOdds = 1 / consensusProbability;
        // Odds filter: reject opportunities where Pinnacle odds exceed the
        // configured maximum. Longshots (high odds) produce more volatile and
        // less reliable edge calculations in thin markets (e.g. WNBA).
        if (pinnacleOdds > this._maxAlertOdds) {
          this._decision('ODDS_FILTERED', {
            matchId, outcome,
            pinnacleOdds,
            maxAllowedOdds: this._maxAlertOdds,
          });
          skipped++;
          continue;
        }

        const edgePercentage = ((pinnacleOdds / fairOdds) - 1) * 100;

        if (edgePercentage < MIN_EDGE_THRESHOLD_PCT) {
          this._decision('REJECTED', { matchId, outcome, edgePct: edgePercentage.toFixed(2) });
          rejected++;
          continue;
        }

        if (edgePercentage > MAX_EDGE_THRESHOLD_PCT) {
          this._decision('INVALID_DATA', {
            matchId, outcome,
            reason: 'edge exceeds maximum threshold — likely a data quality anomaly in consensus odds',
            edgePct: edgePercentage.toFixed(2),
            maxAllowed: MAX_EDGE_THRESHOLD_PCT,
            pinnacleOdds,
            consensusOdds,
          });
          skipped++;
          continue;
        }

        this._decision('DETECTED', {
          matchId, outcome, edgePct: edgePercentage.toFixed(2),
          pinnacleOdds, fairOdds: fairOdds.toFixed(4), consensusProbability: consensusProbability.toFixed(4),
        });
        detected++;

        toInsert.push({
          matchId,
          sport,
          bookmaker: CANDIDATE_BOOKMAKER,
          outcome,
          bookmakerOdds: pinnacleOdds,
          fairOdds,
          edgePercentage,
          consensusProbability,
          consensusBookmakers: consensusSnaps.map(s => s.bookmaker),
          capturedAt: latestCapturedAt,
        });
      }
    }

    if (toInsert.length > 0) {
      await this._repository.insertMany(toInsert);
    }

    const durationMs = Date.now() - startedAt;

    this._logger.info({
      matchesAnalyzed: byMatch.size,
      opportunitiesDetected: detected,
      opportunitiesRejected: rejected,
      opportunitiesSkipped: skipped,
      durationMs,
    }, 'Value detection complete');

    return {
      matchesAnalyzed: byMatch.size,
      opportunitiesDetected: detected,
      opportunitiesRejected: rejected,
      opportunitiesSkipped: skipped,
      durationMs,
    };
  }

  private _decision(decision: ValueDetectionDecision, context: Record<string, unknown>): void {
    const level = decision === 'INVALID_DATA' ? 'warn' : 'debug';
    this._logger[level]({ decision, ...context }, `Value detection: ${decision}`);
  }
}
