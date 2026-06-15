/**
 * Historical ROI seed — read-only aggregation over the IMMUTABLE backtest
 * tables, so live reporting starts from evidence instead of zero.
 *
 * Rules honored:
 *  - Backtest outputs are never modified and never rerun; this module only
 *    SELECTs from backtest_opportunities for a frozen run manifest.
 *  - Historical and live stay separate: the seed feeds the "Historical" and
 *    "Combined" views only; "Live" remains the ValueOpportunity-based metrics.
 *  - Per-track filters mirror each live track's edge/odds rules, so the seed
 *    describes the strategy each track actually runs. (Conflict-resolution
 *    and ownership suppression did not exist in the backtests — the seed is
 *    therefore a close approximation, not a simulation of the final config.)
 *
 * Results are memoized: the underlying rows are immutable, one query per boot.
 */
import type { PrismaClient } from '@prisma/client';
import { groupIdeas, selectHeadline } from '@/value-detection/idea-aggregation';
import { isLowOdds, pinnacleLedLowOddsThresholdPct, legacyLowOddsThresholdPct } from '@/value-detection/low-odds-config';
import type { DetectionModelValue } from './reporting-config';

/**
 * Frozen manifest of the historical runs each track is seeded from
 * (docs/audits/HISTORICAL_ROI_SEEDING_IMPLEMENTATION.md §2).
 */
const PINNACLE_RUNS = [
  '24eabcd2-1e88-4634-b20e-f8a9b1f5b5a0', // core full-grid
  'e0c38b46-29f2-4188-a236-d6f21e381aaa', // nordic full-grid
  '3c6b62b1-c86d-41df-bd86-e203cee64d03', // tennis
  '601a4233-154f-486c-ab5c-c182581f2038', // soccer5 probe
  '35c6f9fd-221b-4197-b213-2047810dfcbd', // NBA/NHL probe
];
const LEGACY_RUNS = [
  '98ce37e9-4493-4e82-9334-010b2d04c69a',
  '13038965-6ea7-47c1-87b3-5c791d123dd8',
  'fa22fc28-6e80-4876-bccd-7d58d936aed7',
  '605e30e2-dcb2-4f90-98a4-3a65324bb62c',
  'd20de6a4-7295-4eee-9ab9-8e618d95c304',
];
const LEGACY_LOWEDGE_RUNS = [
  '48cd67b7-908d-4510-9f9e-795301cf2997',
  '1f7f77fa-44aa-4bc0-96fb-66224e37c811',
  'd11b863d-2a00-412d-b723-1778ebcb01ae',
];

export interface SeedStats {
  readonly settledIdeas: number;
  readonly wins: number;
  readonly losses: number;
  readonly profitUnits: number;
  readonly roiPct: number | null;
  readonly winRatePct: number | null;
}

export type HistoricalSeed = Readonly<Record<DetectionModelValue, SeedStats>>;

const EMPTY_SEED: SeedStats = { settledIdeas: 0, wins: 0, losses: 0, profitUnits: 0, roiPct: null, winRatePct: null };

interface SeedRow {
  readonly eventId: string;
  readonly outcome: string;
  readonly bookmaker: string;
  readonly bookmakerOdds: number;
  readonly edgePercentage: number;
  readonly isShadow: boolean;
  readonly detectedAt: Date;
  readonly betResult: string | null;
  readonly profitLossUnits: number | null;
  // idea-aggregation adapter
  readonly matchId: string;
  readonly createdAt: Date;
}

function statsOf(rows: readonly SeedRow[]): SeedStats {
  // Idea-level: one flat unit on the headline row, exactly like live accounting.
  const headlines: SeedRow[] = [];
  for (const members of groupIdeas(rows).values()) {
    const headline = selectHeadline(members);
    if (headline) headlines.push(headline);
  }
  const settled = headlines.filter(h => h.betResult !== null && h.profitLossUnits !== null);
  const wins = settled.filter(h => h.betResult === 'WIN').length;
  const losses = settled.length - wins;
  const profit = settled.reduce((s, h) => s + (h.profitLossUnits as number), 0);
  return {
    settledIdeas: settled.length,
    wins,
    losses,
    profitUnits: profit,
    roiPct: settled.length > 0 ? (profit / settled.length) * 100 : null,
    winRatePct: settled.length > 0 ? (wins / settled.length) * 100 : null,
  };
}

async function loadRows(prisma: PrismaClient, runIds: readonly string[]): Promise<SeedRow[]> {
  const rows = await prisma.backtestOpportunity.findMany({
    where: { runId: { in: runIds as string[] } },
    select: {
      eventId: true, outcome: true, bookmaker: true, bookmakerOdds: true,
      edgePercentage: true, isShadow: true, detectedAt: true,
      betResult: true, profitLossUnits: true,
    },
  });
  return rows.map(r => ({
    eventId: r.eventId,
    outcome: r.outcome,
    bookmaker: r.bookmaker,
    bookmakerOdds: r.bookmakerOdds.toNumber(),
    edgePercentage: r.edgePercentage.toNumber(),
    isShadow: r.isShadow,
    detectedAt: r.detectedAt,
    betResult: r.betResult,
    profitLossUnits: r.profitLossUnits?.toNumber() ?? null,
    matchId: r.eventId,
    createdAt: r.detectedAt,
  }));
}

let cache: HistoricalSeed | null = null;

/** Loads (and memoizes) the historical seed for all four tracks. */
export async function loadHistoricalSeed(prisma: PrismaClient): Promise<HistoricalSeed> {
  if (cache) return cache;

  const [pinnacleRows, legacyRows, legacyLowRows] = await Promise.all([
    loadRows(prisma, PINNACLE_RUNS),
    loadRows(prisma, LEGACY_RUNS),
    loadRows(prisma, LEGACY_LOWEDGE_RUNS),
  ]);

  cache = {
    // Main pinnacle track = production tier (>= 3%).
    PINNACLE_LED: statsOf(pinnacleRows.filter(r => !r.isShadow)),
    // Main legacy track = the >= 5% mirror runs (all rows are >= 5% there).
    LEGACY: statsOf(legacyRows),
    // Low-odds pinnacle = shadow-band rows meeting the per-bucket floors.
    LOW_ODDS_PINNACLE_LED: statsOf(pinnacleRows.filter(r => {
      if (!r.isShadow || !isLowOdds(r.bookmakerOdds)) return false;
      const threshold = pinnacleLedLowOddsThresholdPct(r.bookmakerOdds);
      return threshold !== null && r.edgePercentage >= threshold;
    })),
    // Low-odds legacy = 3–5% band in enabled buckets (from the lowered-floor runs).
    LOW_ODDS_LEGACY: statsOf(legacyLowRows.filter(r => {
      if (r.edgePercentage >= 5.0 || !isLowOdds(r.bookmakerOdds)) return false;
      const threshold = legacyLowOddsThresholdPct(r.bookmakerOdds);
      return threshold !== null && r.edgePercentage >= threshold;
    })),
    // SHARP_FINAL family — no in-play-inferred backtest seed exists (the engine
    // never ran a sharp-consensus model). Seeded empty; its history lives only in
    // the football-data CSV replay (HISTORICAL_CSV_SEED) and forward live results.
    SHARP_FINAL: EMPTY_SEED,
    SHARP_FINAL_LOW: EMPTY_SEED,
    SHARP_FINAL_V2: EMPTY_SEED,
    SHARP_FINAL_LOW_V2: EMPTY_SEED,
    LEGACY_QUALITY: EMPTY_SEED,
  };
  return cache;
}
