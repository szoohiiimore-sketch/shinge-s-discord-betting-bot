/**
 * Historical ROI reporting — flat-stake idea-level P&L over settled backtest
 * opportunities. Reuses the production idea layer (groupIdeas/selectHeadline):
 * one idea = one flat unit on its headline row, exactly like live accounting.
 * CLV appears only as supporting diagnostics.
 */
import type { PrismaClient } from '@prisma/client';
import { groupIdeas, selectHeadline } from '@/value-detection/idea-aggregation';
import { clvStats } from './reporting';

export interface RoiRow {
  readonly eventId: string;
  readonly sportKey: string;
  readonly bookmaker: string;
  readonly bookmakerFamily: string;
  readonly bookmakerOdds: number;
  readonly edgePercentage: number;
  readonly isShadow: boolean;
  readonly detectedAt: Date;
  readonly pinnacleMove6h: number | null;
  /** De-vigged fair win probability at detection (reference book). */
  readonly fairProbability: number;
  readonly clvPercentage: number | null;
  readonly betResult: string | null;
  readonly profitLossUnits: number | null;
  /** Ideas/day denominators differ per run — carried per row. */
  readonly periodDays: number;
  // idea-aggregation adapter
  readonly matchId: string;
  readonly outcome: string;
  readonly createdAt: Date;
}

export async function loadRoiRows(
  prisma: PrismaClient,
  runs: ReadonlyArray<{ runId: string; days: number }>,
): Promise<RoiRow[]> {
  const out: RoiRow[] = [];
  for (const { runId, days } of runs) {
    const rows = await prisma.backtestOpportunity.findMany({ where: { runId } });
    for (const r of rows) {
      out.push({
        eventId: r.eventId,
        sportKey: r.sportKey,
        bookmaker: r.bookmaker,
        bookmakerFamily: r.bookmakerFamily,
        bookmakerOdds: r.bookmakerOdds.toNumber(),
        edgePercentage: r.edgePercentage.toNumber(),
        isShadow: r.isShadow,
        detectedAt: r.detectedAt,
        pinnacleMove6h: r.pinnacleMove6h?.toNumber() ?? null,
        fairProbability: r.consensusProbability.toNumber(),
        clvPercentage: r.clvPercentage?.toNumber() ?? null,
        betResult: r.betResult,
        profitLossUnits: r.profitLossUnits?.toNumber() ?? null,
        periodDays: days,
        matchId: r.eventId,
        outcome: r.outcome,
        createdAt: r.detectedAt,
      });
    }
  }
  return out;
}

/** Ideas formed from rows at/above an edge threshold; headline = best odds. */
export function ideasAtThreshold(rows: readonly RoiRow[], minEdgePct: number): RoiRow[] {
  const eligible = rows.filter(r => r.edgePercentage >= minEdgePct);
  const headlines: RoiRow[] = [];
  for (const members of groupIdeas(eligible).values()) {
    const headline = selectHeadline(members);
    if (headline) headlines.push(headline);
  }
  return headlines;
}

export interface RoiStats {
  readonly ideas: number;
  readonly ideasPerDay: number;
  readonly settled: number;
  readonly coveragePct: number;
  readonly won: number;
  readonly winRatePct: number | null;
  readonly profitUnits: number;
  readonly roiPct: number | null;
  readonly avgOdds: number | null;
  /**
   * Wins the de-vigged fair probabilities predicted for the SETTLED bets.
   * realized wins far below this = settlement-selection bias or model failure;
   * realized at/above = the settled subset is at least calibration-consistent.
   */
  readonly expectedWins: number | null;
  readonly clvTrimmed: number | null;
}

export function roiStats(headlines: readonly RoiRow[]): RoiStats {
  const settledRows = headlines.filter(h => h.betResult !== null && h.profitLossUnits !== null);
  const won = settledRows.filter(h => h.betResult === 'WIN').length;
  const profit = settledRows.reduce((s, h) => s + (h.profitLossUnits as number), 0);
  // ideas/day: rows carry their run's denominator; sum per-run rates.
  const byDays = new Map<number, number>();
  for (const h of headlines) byDays.set(h.periodDays, (byDays.get(h.periodDays) ?? 0) + 1);
  const ideasPerDay = [...byDays.entries()].reduce((s, [days, n]) => s + n / days, 0);
  const clv = clvStats(settledRows.map(h => h.clvPercentage).filter((v): v is number => v !== null));
  return {
    ideas: headlines.length,
    ideasPerDay,
    settled: settledRows.length,
    coveragePct: headlines.length > 0 ? (settledRows.length / headlines.length) * 100 : 0,
    won,
    winRatePct: settledRows.length > 0 ? (won / settledRows.length) * 100 : null,
    profitUnits: profit,
    roiPct: settledRows.length > 0 ? (profit / settledRows.length) * 100 : null,
    avgOdds: settledRows.length > 0 ? settledRows.reduce((s, h) => s + h.bookmakerOdds, 0) / settledRows.length : null,
    expectedWins: settledRows.length > 0 ? settledRows.reduce((s, h) => s + h.fairProbability, 0) : null,
    clvTrimmed: clv.trimmedMean,
  };
}

export function roiLine(label: string, stats: RoiStats): string {
  const f = (v: number | null, d = 1): string => (v === null ? '—' : v.toFixed(d));
  return `${label.padEnd(36)} ideas=${String(stats.ideas).padStart(3)} (${stats.ideasPerDay.toFixed(2)}/d)  settled=${String(stats.settled).padStart(3)} (${stats.coveragePct.toFixed(0)}%)  W-L=${stats.won}-${stats.settled - stats.won}  expW=${f(stats.expectedWins)}  win%=${f(stats.winRatePct)}  P&L=${stats.profitUnits >= 0 ? '+' : ''}${stats.profitUnits.toFixed(2)}u  ROI=${stats.roiPct !== null && stats.roiPct >= 0 ? '+' : ''}${f(stats.roiPct)}%  avgOdds=${f(stats.avgOdds, 2)}  clvTrim=${f(stats.clvTrimmed, 2)}%`;
}

export function movementClass6h(move: number | null, band = 1.0): string {
  if (move === null) return 'no-history';
  if (move <= -band) return 'steam-in';
  if (move >= band) return 'steam-out';
  return 'flat';
}

export function segmentRoi(
  headlines: readonly RoiRow[],
  classify: (row: RoiRow) => string,
): Array<[string, RoiStats]> {
  const groups = new Map<string, RoiRow[]>();
  for (const row of headlines) {
    const key = classify(row);
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(row);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, rows]) => [k, roiStats(rows)]);
}
