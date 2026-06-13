import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import { aggregateSettledIdeas } from '@/value-detection';
import { LIVE_BASELINE, modelsFor, modelDisplay } from '../reporting-config';
import type { ModelFilter, DetectionModelValue } from '../reporting-config';

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  if (v !== null && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
  return 0;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return toNum(v);
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/**
 * Movement grouping band: |move| <= 1% is "neutral". Movement is the Pinnacle price
 * change before capture — negative = price shortened (market moved toward the outcome).
 */
const MOVEMENT_NEUTRAL_BAND_PCT = 1.0;

type MovementGroup = 'positive' | 'neutral' | 'negative';

function movementGroup(move: number): MovementGroup {
  if (move > MOVEMENT_NEUTRAL_BAND_PCT) return 'positive';
  if (move < -MOVEMENT_NEUTRAL_BAND_PCT) return 'negative';
  return 'neutral';
}

interface ClvMovementRow {
  readonly clv: number;
  readonly move1h: number | null;
  readonly move6h: number | null;
  readonly move24h: number | null;
}

/** Formats one movement window line: avg CLV per movement group, groups with n=0 omitted. */
function movementWindowLine(
  label: string,
  rows: readonly ClvMovementRow[],
  pick: (r: ClvMovementRow) => number | null,
): string | null {
  const groups: Record<MovementGroup, number[]> = { positive: [], neutral: [], negative: [] };
  for (const r of rows) {
    const move = pick(r);
    if (move === null) continue;
    groups[movementGroup(move)].push(r.clv);
  }

  const parts: string[] = [];
  const ORDER: ReadonlyArray<readonly [MovementGroup, string]> = [
    ['positive', '↑out'],
    ['neutral', '→flat'],
    ['negative', '↓in'],
  ];
  for (const [group, icon] of ORDER) {
    const values = groups[group];
    if (values.length === 0) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    parts.push(`${icon} ${signed(avg)} (n=${values.length})`);
  }

  return parts.length > 0 ? `${label}: ${parts.join(' | ')}` : null;
}

/**
 * Closing Line Value report.
 *
 * CLV% = (alert odds / de-vigged Pinnacle closing fair odds − 1) × 100, computed at
 * settlement. Consistently positive CLV is the fastest statistical evidence that
 * alerts beat the market; it converges in ~100–200 samples versus thousands for ROI.
 */
export async function getClvStats(
  prisma: PrismaClient,
  logger: Logger,
  model: ModelFilter = 'combined',
): Promise<{ content: string }> {
  logger.info({ command: 'clv', model }, 'Command execution started');

  const sections: string[] = ['📈 **CLOSING LINE VALUE**'];
  for (const m of modelsFor(model)) {
    sections.push('', `__**${modelDisplay(m)}**__`, ...(await clvSectionForModel(prisma, m)));
  }
  sections.push('', '*CLV = alert odds vs de-vigged Pinnacle closing price. Positive CLV = alerts beat the market.*');
  return { content: sections.join('\n') };
}

/** Renders the CLV section for one model (ideas never merge across models). */
async function clvSectionForModel(
  prisma: PrismaClient,
  model: DetectionModelValue,
): Promise<string[]> {
  const baseWhere = {
    settledAt: { not: null, gte: LIVE_BASELINE },
    model,
    match: { sport: { category: 'TRADITIONAL' as const } },
  };
  const productionWhere = { ...baseWhere, isShadow: false };
  const shadowWhere    = { ...baseWhere, isShadow: true };

  const [prodRows, shadowRows, shadowTotal] = await Promise.all([
    // All settled production rows — grouped into ideas below; the CLV gate is idea-level.
    prisma.valueOpportunity.findMany({
      where: productionWhere,
      select: {
        matchId: true,
        outcome: true,
        bookmaker: true,
        bookmakerOdds: true,
        createdAt: true,
        clvPercentage: true,
        clvPositive: true,
        pinnacleMove1h: true,
        pinnacleMove6h: true,
        pinnacleMove24h: true,
      },
    }),
    prisma.valueOpportunity.findMany({
      where: { ...shadowWhere, clvPercentage: { not: null } },
      select: { clvPercentage: true, clvPositive: true },
    }),
    prisma.valueOpportunity.count({ where: shadowWhere }),
  ]);

  // Idea-level: gate metrics are computed over headline rows (one per betting idea).
  const ideaHeadlines = aggregateSettledIdeas(prodRows).map(i => i.headline);
  const ideasWithClv = ideaHeadlines.filter(i => i.clvPercentage !== null);
  // Row-level: per-bookmaker diagnostic sample (all production rows with CLV).
  const clvRows = prodRows.filter(r => r.clvPercentage !== null);

  if (ideasWithClv.length === 0 && shadowRows.length === 0) {
    return ['No CLV data yet. CLV is computed when bets settle and requires a pre-kickoff Pinnacle closing price.'];
  }

  const lines: string[] = [];

  // Production CLV — idea-denominated (the V1.5 gate metric)
  if (ideasWithClv.length > 0) {
    const values = ideasWithClv.map(i => toNum(i.clvPercentage)).sort((a, b) => a - b);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const med = median(values);
    const positive = ideasWithClv.filter(i => i.clvPositive === true).length;
    const positivePct = (positive / ideasWithClv.length) * 100;
    lines.push(
      `**Production ideas**`,
      `Sample: ${ideasWithClv.length} ideas with CLV (${ideaHeadlines.length} settled ideas, from ${prodRows.length} bookmaker rows)`,
      `Avg: **${signed(avg)}** | Median: **${signed(med)}** | Positive: **${positivePct.toFixed(1)}%** (${positive}/${ideasWithClv.length})`,
    );
    // Row-level diagnostic (per-bookmaker sample) — kept for book-softness analysis.
    if (clvRows.length > 0) {
      const rowAvg = clvRows.reduce((a, r) => a + toNum(r.clvPercentage), 0) / clvRows.length;
      lines.push(`*Rows (per-book diagnostic): ${clvRows.length} with CLV, avg ${signed(rowAvg)}*`);
    }
  } else {
    lines.push(`**Production ideas:** No CLV data yet (${ideaHeadlines.length} settled ideas, awaiting closes)`);
  }

  // Shadow CLV (threshold-calibration tier — row-level, never alerted)
  if (shadowRows.length > 0) {
    const sValues = shadowRows.map(r => toNum(r.clvPercentage)).sort((a, b) => a - b);
    const sAvg = sValues.reduce((a, b) => a + b, 0) / sValues.length;
    const sMed = median(sValues);
    const sPositive = shadowRows.filter(r => r.clvPositive === true).length;
    const sPositivePct = (sPositive / shadowRows.length) * 100;
    lines.push(
      '',
      `**Shadow (2–3% — calibration only, rows)**`,
      `Sample: ${shadowRows.length} settled (${shadowTotal} total, ${((shadowRows.length / shadowTotal) * 100).toFixed(0)}% with CLV)`,
      `Avg: **${signed(sAvg)}** | Median: **${signed(sMed)}** | Positive: **${sPositivePct.toFixed(1)}%** (${sPositive}/${shadowRows.length})`,
    );
  } else if (shadowTotal > 0) {
    lines.push('', `**Shadow (2–3%):** ${shadowTotal} settled, no CLV data yet`);
  }

  // Movement analytics: idea-level (headline rows) CLV grouped by Pinnacle's trailing
  // price movement at capture time (1h / 6h / 24h windows).
  const movementRows: ClvMovementRow[] = ideasWithClv.map(i => ({
    clv: toNum(i.clvPercentage),
    move1h: toNumOrNull(i.pinnacleMove1h),
    move6h: toNumOrNull(i.pinnacleMove6h),
    move24h: toNumOrNull(i.pinnacleMove24h),
  }));

  const movementLines = [
    movementWindowLine('1h', movementRows, r => r.move1h),
    movementWindowLine('6h', movementRows, r => r.move6h),
    movementWindowLine('24h', movementRows, r => r.move24h),
  ].filter((l): l is string => l !== null);

  if (movementLines.length > 0) {
    lines.push(
      '',
      '**CLV by Pinnacle movement (production ideas)**',
      ...movementLines,
      '*Movement = Pinnacle price change before capture: ↓in = market moved toward outcome, ↑out = away, →flat = within ±1%.*',
    );
  }

  return lines;
}
