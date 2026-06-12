import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import type { OddsApiClient } from '@/integrations/the-odds-api';
import type { PandascoreClient, VideogameKey } from '@/integrations/pandascore';
import type { EsportsVideogame } from '@/ingestion/contracts';
import type { BetOutcome, SettlementResult, SettledOpportunityNotification } from './settlement.types';

/** Maps domain EsportsVideogame keys to PandaScore API path slugs. */
const ESPORTS_TO_PANDASCORE_SLUG: Record<EsportsVideogame, VideogameKey> = {
  cs2:      'csgo',
  valorant: 'valorant',
  lol:      'lol',
  dota2:    'dota2',
};

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  if (v !== null && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
  return NaN;
}

/** Pinnacle's last pre-kickoff price for one outcome: raw, and de-vigged fair. */
interface ClosingQuote {
  readonly raw: number;
  readonly fair: number;
}

const CLOSING_REFERENCE_BOOKMAKER = 'pinnacle';
/** Same overround sanity bounds as value detection — guards incomplete/anomalous markets. */
const MIN_CLOSING_OVERROUND = 0.99;
const MAX_CLOSING_OVERROUND = 1.15;

function calcProfitLoss(outcome: BetOutcome, odds: number): number {
  if (outcome === 'WIN') return odds - 1;
  if (outcome === 'LOSS') return -1;
  return 0;
}

/**
 * Determines the bet outcome for a ValueOpportunity given the settled match result.
 *
 * outcome is the team name string (or "Draw") stored in ValueOpportunity.
 * homeTeamName / awayTeamName are the canonical team names from Match relations.
 * matchResult is the Match.result enum value.
 */
function determineBetOutcome(
  outcome: string,
  homeTeamName: string,
  awayTeamName: string,
  matchResult: 'HOME_WIN' | 'AWAY_WIN' | 'DRAW',
): BetOutcome {
  const outcomeLower = outcome.toLowerCase().trim();
  const homeNameLower = homeTeamName.toLowerCase().trim();
  const awayNameLower = awayTeamName.toLowerCase().trim();

  if (outcomeLower === homeNameLower) {
    return matchResult === 'HOME_WIN' ? 'WIN' : 'LOSS';
  }
  if (outcomeLower === awayNameLower) {
    return matchResult === 'AWAY_WIN' ? 'WIN' : 'LOSS';
  }
  if (outcomeLower === 'draw') {
    return matchResult === 'DRAW' ? 'WIN' : 'LOSS';
  }
  // Fallback: partial match — covers minor name differences
  if (matchResult === 'HOME_WIN' && homeNameLower.includes(outcomeLower)) return 'WIN';
  if (matchResult === 'AWAY_WIN' && awayNameLower.includes(outcomeLower)) return 'WIN';
  // Unresolvable — cannot determine outcome from name matching
  return 'LOSS';
}

export class SettlementService {
  private readonly _prisma: PrismaClient;
  private readonly _oddsApiClient: OddsApiClient;
  private readonly _pandascoreClient: PandascoreClient;
  private readonly _logger: Logger;

  constructor(
    prisma: PrismaClient,
    oddsApiClient: OddsApiClient,
    pandascoreClient: PandascoreClient,
    logger: Logger,
  ) {
    this._prisma = prisma;
    this._oddsApiClient = oddsApiClient;
    this._pandascoreClient = pandascoreClient;
    this._logger = logger.child({ service: 'SettlementService' });
  }

  /**
   * Settles traditional sport ValueOpportunities.
   *
   * 1. Fetches completed match scores from The Odds API (/v4/sports/{sport}/scores).
   * 2. Updates Match records with FINISHED status and result.
   * 3. Settles all unsettled ValueOpportunities for those matches.
   */
  async settleTraditional(sportKeys: readonly string[]): Promise<SettlementResult> {
    const startedAt = Date.now();
    let matchesUpdated = 0;

    for (const sportKey of sportKeys) {
      try {
        const scores = await this._oddsApiClient.getScores(sportKey, 3);
        const completed = scores.filter(s => s.completed && s.scores && s.scores.length >= 2);

        for (const event of completed) {
          const externalId = `oa:${event.id}`;
          const homeScore = parseInt(event.scores!.find(s => s.name === event.home_team)?.score ?? '-1', 10);
          const awayScore = parseInt(event.scores!.find(s => s.name === event.away_team)?.score ?? '-1', 10);

          if (homeScore < 0 || awayScore < 0) continue;

          let result: 'HOME_WIN' | 'AWAY_WIN' | 'DRAW';
          if (homeScore > awayScore) result = 'HOME_WIN';
          else if (awayScore > homeScore) result = 'AWAY_WIN';
          else result = 'DRAW';

          const updated = await this._prisma.match.updateMany({
            where: {
              externalId,
              // Only update if not already settled to avoid unnecessary writes
              NOT: { status: 'FINISHED' },
            },
            data: { status: 'FINISHED', homeScore, awayScore, result },
          });
          if (updated.count > 0) matchesUpdated++;
        }
      } catch (err) {
        this._logger.warn({ sportKey, err: (err as Error).message }, 'Failed to fetch scores for sport — skipping');
      }
    }

    const settled = await this._settleUnsettled();
    const durationMs = Date.now() - startedAt;

    this._logger.info({ matchesUpdated, ...settled, durationMs }, 'Traditional sport settlement complete');
    return { matchesUpdated, durationMs, ...settled };
  }

  /**
   * Settles esports ValueOpportunities.
   *
   * 1. Fetches past finished matches from PandaScore.
   * 2. Updates Match records with FINISHED status and result.
   * 3. Settles all unsettled ValueOpportunities for those matches.
   */
  async settleEsports(videogames: readonly EsportsVideogame[]): Promise<SettlementResult> {
    const startedAt = Date.now();
    let matchesUpdated = 0;

    for (const videogame of videogames) {
      const slug = ESPORTS_TO_PANDASCORE_SLUG[videogame];
      try {
        const pastMatches = await this._pandascoreClient.getPastMatches(slug);

        for (const raw of (pastMatches as unknown) as Array<{
          id: number;
          status: string;
          draw: boolean;
          winner: { id: number } | null;
          results: Array<{ team_id: number; score: number }> | null;
          opponents: Array<{ opponent: { id: number } }>;
        }>) {
          if (raw.status !== 'finished') continue;

          const externalId = `ps:${raw.id}`;
          const opponents = raw.opponents ?? [];
          if (opponents.length < 2) continue;

          const homeTeamId = opponents[0].opponent.id;
          const awayTeamId = opponents[1].opponent.id;

          let result: 'HOME_WIN' | 'AWAY_WIN' | 'DRAW';
          if (raw.draw) {
            result = 'DRAW';
          } else if (raw.winner) {
            result = raw.winner.id === homeTeamId ? 'HOME_WIN' : 'AWAY_WIN';
          } else {
            continue;
          }

          const homeScore = raw.results?.find(r => r.team_id === homeTeamId)?.score ?? null;
          const awayScore = raw.results?.find(r => r.team_id === awayTeamId)?.score ?? null;

          const updated = await this._prisma.match.updateMany({
            where: { externalId, NOT: { status: 'FINISHED' } },
            data: {
              status: 'FINISHED',
              result,
              homeScore: homeScore ?? undefined,
              awayScore: awayScore ?? undefined,
            },
          });
          if (updated.count > 0) matchesUpdated++;
        }
      } catch (err) {
        this._logger.warn({ videogame, err: (err as Error).message }, 'Failed to fetch past matches — skipping');
      }
    }

    const settled = await this._settleUnsettled();
    const durationMs = Date.now() - startedAt;

    this._logger.info({ matchesUpdated, ...settled, durationMs }, 'Esports settlement complete');
    return { matchesUpdated, durationMs, ...settled };
  }

  /**
   * Settles all unsettled ValueOpportunities for matches that are already FINISHED.
   * Idempotent — opportunities with settledAt already set are skipped.
   *
   * At settlement time, Closing Line Value is computed per opportunity: the alert
   * odds are compared against the de-vigged Pinnacle price from the last pre-kickoff
   * snapshot batch. Opportunities without a usable Pinnacle close keep null CLV.
   */
  private async _settleUnsettled(): Promise<Omit<SettlementResult, 'matchesUpdated' | 'durationMs'>> {
    const unsettled = await this._prisma.valueOpportunity.findMany({
      where: {
        settledAt: null,
        match: { status: 'FINISHED', result: { not: null } },
      },
      select: {
        id: true,
        matchId: true,
        sport: true,
        outcome: true,
        bookmakerOdds: true,
        edgePercentage: true,
        match: {
          select: {
            result: true,
            startTime: true,
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
          },
        },
      },
    });

    let wins = 0;
    let losses = 0;
    let pushes = 0;
    const unresolvable = 0;
    const newlySettled: SettledOpportunityNotification[] = [];
    // One closing-quote lookup per match, shared by all its opportunities.
    const closingCache = new Map<string, ReadonlyMap<string, ClosingQuote>>();

    for (const opp of unsettled) {
      const matchResult = opp.match.result as 'HOME_WIN' | 'AWAY_WIN' | 'DRAW';
      const betOutcome = determineBetOutcome(
        opp.outcome,
        opp.match.homeTeam.name,
        opp.match.awayTeam.name,
        matchResult,
      );

      const alertOdds = toNumber(opp.bookmakerOdds);
      const profitLossUnits = calcProfitLoss(betOutcome, alertOdds);
      const settledAt = new Date();

      // Closing Line Value vs the de-vigged Pinnacle close.
      let quotes = closingCache.get(opp.matchId);
      if (!quotes) {
        quotes = await this._closingPinnacleQuotes(opp.matchId, opp.match.startTime);
        closingCache.set(opp.matchId, quotes);
      }
      const closing = quotes.get(opp.outcome);
      let clvData: { closingPinnacleOdds: number; clvPercentage: number; clvPositive: boolean } | undefined;
      if (closing) {
        const clvPercentage = (alertOdds / closing.fair - 1) * 100;
        clvData = {
          closingPinnacleOdds: closing.raw,
          clvPercentage,
          clvPositive: clvPercentage > 0,
        };
      } else {
        this._logger.debug(
          { opportunityId: opp.id, outcome: opp.outcome },
          'No usable Pinnacle closing quote — CLV left null',
        );
      }

      await this._prisma.valueOpportunity.update({
        where: { id: opp.id },
        data: {
          settledAt,
          betResult: betOutcome,
          profitLossUnits,
          ...(clvData ?? {}),
        },
      });

      if (betOutcome === 'WIN') wins++;
      else if (betOutcome === 'LOSS') losses++;
      else pushes++;

      newlySettled.push({
        sport: opp.sport,
        outcome: opp.outcome,
        bookmakerOdds: toNumber(opp.bookmakerOdds),
        edgePercentage: toNumber(opp.edgePercentage),
        betResult: betOutcome,
        profitLossUnits,
        homeTeamName: opp.match.homeTeam.name,
        awayTeamName: opp.match.awayTeam.name,
        settledAt,
      });
    }

    return {
      opportunitiesSettled: unsettled.length,
      wins,
      losses,
      pushes,
      unresolvable,
      newlySettled,
    };
  }

  /**
   * Loads Pinnacle's last pre-kickoff H2H snapshot batch for a match and returns
   * per-outcome closing quotes (raw price + de-vigged fair odds).
   *
   * Returns an empty map when no usable close exists: no pre-kickoff Pinnacle
   * snapshots, fewer than two outcomes, or overround outside sanity bounds.
   * De-vig: fairOdds(o) = rawOdds(o) × overround, where overround = Σ 1/rawOdds(k).
   */
  private async _closingPinnacleQuotes(
    matchId: string,
    startTime: Date,
  ): Promise<ReadonlyMap<string, ClosingQuote>> {
    const empty = new Map<string, ClosingQuote>();

    const snaps = await this._prisma.oddsSnapshot.findMany({
      where: {
        matchId,
        bookmaker: CLOSING_REFERENCE_BOOKMAKER,
        market: 'H2H',
        isLive: false,
        capturedAt: { lte: startTime },
      },
      select: { outcome: true, price: true, capturedAt: true },
    });

    if (snaps.length === 0) return empty;

    const latest = snaps.reduce(
      (max, s) => (s.capturedAt > max ? s.capturedAt : max),
      snaps[0].capturedAt,
    );

    const prices = new Map<string, number>();
    for (const s of snaps) {
      if (s.capturedAt.getTime() !== latest.getTime()) continue;
      const price = toNumber(s.price);
      if (!(price > 1) || prices.has(s.outcome)) continue;
      prices.set(s.outcome, price);
    }

    if (prices.size < 2) return empty;

    let overround = 0;
    for (const price of prices.values()) overround += 1 / price;
    if (overround < MIN_CLOSING_OVERROUND || overround > MAX_CLOSING_OVERROUND) {
      this._logger.debug(
        { matchId, overround: overround.toFixed(4) },
        'Pinnacle closing overround out of bounds — skipping CLV for match',
      );
      return empty;
    }

    const quotes = new Map<string, ClosingQuote>();
    for (const [outcome, raw] of prices) {
      quotes.set(outcome, { raw, fair: raw * overround });
    }
    return quotes;
  }
}
