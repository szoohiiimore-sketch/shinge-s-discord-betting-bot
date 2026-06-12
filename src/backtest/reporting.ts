/**
 * Reporting layer — idea-denominated, per run, via the SAME idea-aggregation
 * functions production uses (groupIdeas / selectHeadline). Row-level numbers
 * appear only as per-book diagnostics, mirroring the live accounting rules.
 */
import type { PrismaClient } from '@prisma/client';
import { groupIdeas, selectHeadline, ideaKey } from '@/value-detection/idea-aggregation';

export interface ReportRow {
  readonly id: bigint;
  readonly eventId: string;
  readonly sportKey: string;
  readonly bookmaker: string;
  readonly outcome: string;
  readonly bookmakerOdds: number;
  readonly edgePercentage: number;
  readonly isShadow: boolean;
  readonly detectedAt: Date;
  readonly minutesToKickoff: number;
  readonly bookmakerFamily: string;
  readonly pinnacleMove6h: number | null;
  readonly priceGapPct: number | null;
  readonly corroborationK: number;
  readonly clvPercentage: number | null;
  // idea-aggregation adapter fields
  readonly matchId: string;   // = eventId
  readonly createdAt: Date;   // = detectedAt
}

export interface ClvStats {
  readonly n: number;
  readonly mean: number | null;
  readonly median: number | null;
  readonly positiveRate: number | null;
  /** Mean with the top decile (by CLV) excluded — the gate amendment. */
  readonly trimmedMean: number | null;
}

export function clvStats(values: readonly number[]): ClvStats {
  if (values.length === 0) return { n: 0, mean: null, median: null, positiveRate: null, trimmedMean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const positiveRate = sorted.filter(v => v > 0).length / sorted.length;
  const trimCount = Math.floor(sorted.length / 10);
  const trimmed = trimCount > 0 ? sorted.slice(0, sorted.length - trimCount) : sorted;
  const trimmedMean = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
  return { n: sorted.length, mean, median, positiveRate, trimmedMean };
}

export async function loadReportRows(prisma: PrismaClient, runId: string): Promise<ReportRow[]> {
  const rows = await prisma.backtestOpportunity.findMany({
    where: { runId },
    orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(r => ({
    id: r.id,
    eventId: r.eventId,
    sportKey: r.sportKey,
    bookmaker: r.bookmaker,
    outcome: r.outcome,
    bookmakerOdds: r.bookmakerOdds.toNumber(),
    edgePercentage: r.edgePercentage.toNumber(),
    isShadow: r.isShadow,
    detectedAt: r.detectedAt,
    minutesToKickoff: r.minutesToKickoff,
    bookmakerFamily: r.bookmakerFamily,
    pinnacleMove6h: r.pinnacleMove6h?.toNumber() ?? null,
    priceGapPct: r.priceGapPct?.toNumber() ?? null,
    corroborationK: r.corroborationK,
    clvPercentage: r.clvPercentage?.toNumber() ?? null,
    matchId: r.eventId,
    createdAt: r.detectedAt,
  }));
}

/** Ideas with their headline rows for one tier, derived via the shared idea layer. */
export function ideasForTier(rows: readonly ReportRow[], shadow: boolean): ReportRow[] {
  const tierRows = rows.filter(r => r.isShadow === shadow);
  const headlines: ReportRow[] = [];
  for (const members of groupIdeas(tierRows).values()) {
    const headline = selectHeadline(members);
    if (headline) headlines.push(headline);
  }
  return headlines;
}

function fmt(v: number | null, digits = 2, suffix = ''): string {
  return v === null ? '—' : `${v.toFixed(digits)}${suffix}`;
}

function statsLine(label: string, stats: ClvStats): string {
  return `${label.padEnd(28)} n=${String(stats.n).padStart(4)}  avg=${fmt(stats.mean)}%  median=${fmt(stats.median)}%  pos=${fmt(stats.positiveRate === null ? null : stats.positiveRate * 100, 1)}%  trimmed=${fmt(stats.trimmedMean)}%`;
}

function movementClass(move6h: number | null, neutralBandPct = 1.0): string {
  if (move6h === null) return 'no-history';
  if (move6h <= -neutralBandPct) return 'steam-in';
  if (move6h >= neutralBandPct) return 'steam-out';
  return 'flat';
}

function kickoffBucket(minutes: number): string {
  if (minutes <= 120) return '<=2h';
  if (minutes <= 360) return '2-6h';
  if (minutes <= 1440) return '6-24h';
  return '>24h';
}

function edgeBucket(edge: number): string {
  if (edge < 3) return '2-3%';
  if (edge < 4) return '3-4%';
  if (edge < 5) return '4-5%';
  return '>=5%';
}

function segmented(headlines: readonly ReportRow[], classify: (r: ReportRow) => string): string[] {
  const groups = new Map<string, number[]>();
  for (const row of headlines) {
    if (row.clvPercentage === null) continue;
    const key = classify(row);
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(row.clvPercentage);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, values]) => '  ' + statsLine(key, clvStats(values)));
}

/** Renders the standard per-run report as text lines. */
export async function renderRunReport(prisma: PrismaClient, runId: string): Promise<string[]> {
  const run = await prisma.backtestRun.findUniqueOrThrow({ where: { id: runId } });
  const rows = await loadReportRows(prisma, runId);
  const productionRows = rows.filter(r => !r.isShadow);
  const shadowRows = rows.filter(r => r.isShadow);
  const productionIdeas = ideasForTier(rows, false);
  const shadowIdeas = ideasForTier(rows, true);

  const lines: string[] = [];
  lines.push(`BACKTEST RUN ${run.id}`);
  lines.push(`name=${run.name} | cadence=${run.cadenceMode} | code=${run.codeVersion} | status=${run.status}`);
  lines.push(`period ${run.periodStart.toISOString()} → ${run.periodEnd.toISOString()}`);
  lines.push('');
  lines.push('── Volume ──');
  lines.push(`production: ${productionIdeas.length} ideas (from ${productionRows.length} bookmaker rows)`);
  lines.push(`shadow:     ${shadowIdeas.length} ideas (from ${shadowRows.length} bookmaker rows)`);
  const coverage = new Map<string, number>();
  for (const r of productionRows) coverage.set(r.bookmakerFamily, (coverage.get(r.bookmakerFamily) ?? 0) + 1);
  lines.push(`bookmaker families in production rows: ${[...coverage.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}(${n})`).join(' ') || '—'}`);
  lines.push('');

  lines.push('── CLV (idea-denominated, headline rows — the gate metric) ──');
  lines.push(statsLine('production ideas', clvStats(productionIdeas.map(r => r.clvPercentage).filter((v): v is number => v !== null))));
  lines.push(statsLine('shadow ideas', clvStats(shadowIdeas.map(r => r.clvPercentage).filter((v): v is number => v !== null))));
  lines.push('');

  lines.push('── Production-idea segments (idea CLV) ──');
  lines.push('by edge bucket:');
  lines.push(...segmented(productionIdeas, r => edgeBucket(r.edgePercentage)));
  lines.push('by movement class (6h):');
  lines.push(...segmented(productionIdeas, r => movementClass(r.pinnacleMove6h)));
  lines.push('by sport:');
  lines.push(...segmented(productionIdeas, r => r.sportKey));
  lines.push('by time-to-kickoff:');
  lines.push(...segmented(productionIdeas, r => kickoffBucket(r.minutesToKickoff)));
  lines.push('by corroboration k:');
  lines.push(...segmented(productionIdeas, r => `k=${Math.min(r.corroborationK, 4)}${r.corroborationK >= 4 ? '+' : ''}`));
  lines.push('');

  lines.push('── Per-book diagnostics (row-denominated) ──');
  lines.push('by bookmaker family:');
  lines.push(...segmented(productionRows.map(r => ({ ...r })), r => r.bookmakerFamily));

  return lines;
}

/**
 * Paired comparison of two runs over the identical snapshot stream: ideas are
 * joined on the idea key, so per-idea CLV deltas isolate the config change.
 */
export async function renderRunComparison(prisma: PrismaClient, runIdA: string, runIdB: string): Promise<string[]> {
  const [runA, runB] = await Promise.all([
    prisma.backtestRun.findUniqueOrThrow({ where: { id: runIdA } }),
    prisma.backtestRun.findUniqueOrThrow({ where: { id: runIdB } }),
  ]);
  const [rowsA, rowsB] = await Promise.all([loadReportRows(prisma, runIdA), loadReportRows(prisma, runIdB)]);
  const ideasA = new Map(ideasForTier(rowsA, false).map(r => [ideaKey(r), r]));
  const ideasB = new Map(ideasForTier(rowsB, false).map(r => [ideaKey(r), r]));

  const shared: Array<{ a: ReportRow; b: ReportRow }> = [];
  const onlyA: ReportRow[] = [];
  const onlyB: ReportRow[] = [];
  for (const [key, a] of ideasA) {
    const b = ideasB.get(key);
    if (b) shared.push({ a, b });
    else onlyA.push(a);
  }
  for (const [key, b] of ideasB) if (!ideasA.has(key)) onlyB.push(b);

  const lines: string[] = [];
  lines.push(`PAIRED COMPARISON  A=${runA.name} (${runIdA})  vs  B=${runB.name} (${runIdB})`);
  lines.push(`production ideas: A=${ideasA.size}  B=${ideasB.size}  shared=${shared.length}  A-only=${onlyA.length}  B-only=${onlyB.length}`);
  lines.push('');
  lines.push(statsLine('A ideas (CLV)', clvStats([...ideasA.values()].map(r => r.clvPercentage).filter((v): v is number => v !== null))));
  lines.push(statsLine('B ideas (CLV)', clvStats([...ideasB.values()].map(r => r.clvPercentage).filter((v): v is number => v !== null))));

  const pairedDeltas = shared
    .filter(p => p.a.clvPercentage !== null && p.b.clvPercentage !== null)
    .map(p => (p.b.clvPercentage as number) - (p.a.clvPercentage as number));
  lines.push(statsLine('paired Δ (B−A, shared)', clvStats(pairedDeltas)));
  lines.push('');
  lines.push(statsLine('A-only ideas (CLV)', clvStats(onlyA.map(r => r.clvPercentage).filter((v): v is number => v !== null))));
  lines.push(statsLine('B-only ideas (CLV)', clvStats(onlyB.map(r => r.clvPercentage).filter((v): v is number => v !== null))));
  return lines;
}
