import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import { aggregateSettledIdeas } from '@/value-detection';
import { ROI_V2_BASELINE, modelsFor, modelDisplay } from '../reporting-config';
import type { ModelFilter } from '../reporting-config';
import { loadHistoricalSeed } from '../historical-seed';

type Period = '7d' | '30d' | 'all';

function periodLabel(period: Period): string {
  if (period === '7d') return 'Last 7 Days';
  if (period === '30d') return 'Last 30 Days';
  return 'All Time';
}

function periodCutoff(period: Period): Date | null {
  if (period === 'all') return null;
  const days = period === '7d' ? 7 : 30;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  if (v !== null && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
  return 0;
}

export async function getRoiStats(
  prisma: PrismaClient,
  period: Period,
  logger: Logger,
  model: ModelFilter = 'combined',
): Promise<{ content: string }> {
  logger.info({ command: 'roi', period, model }, 'Command execution started');

  const periodCut = periodCutoff(period);
  // ROI V2: never look before the clean baseline; take the later of period cutoff and baseline
  const cutoff = periodCut && periodCut > ROI_V2_BASELINE ? periodCut : ROI_V2_BASELINE;
  const models = modelsFor(model);
  const where = {
    settledAt: { not: null, gte: cutoff },
    isShadow: false,
    model: { in: [...models] },
    match: { sport: { category: 'TRADITIONAL' as const } },
  };

  const settledRows = await prisma.valueOpportunity.findMany({
    where,
    select: {
      matchId: true,
      outcome: true,
      bookmaker: true,
      bookmakerOdds: true,
      createdAt: true,
      betResult: true,
      profitLossUnits: true,
      edgePercentage: true,
      model: true,
      confidence: true,
    },
  });

  const seed = await loadHistoricalSeed(prisma);
  const fmt = (units: number): string => `${units >= 0 ? '+' : ''}${units.toFixed(2)}u`;
  const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

  const lines = [`📊 **ROI — ${periodLabel(period)}**`];

  // Three views per model: Historical (immutable backtest seed), Live (real
  // settlements since the V2 baseline), Combined (sum — never a blind merge:
  // both components stay visible). Ideas never merge across models.
  for (const m of models) {
    const modelRows = settledRows.filter(r => r.model === m);
    const ideas = aggregateSettledIdeas(modelRows).map(i => i.headline);

    const wins = ideas.filter(i => i.betResult === 'WIN').length;
    const losses = ideas.filter(i => i.betResult === 'LOSS').length;
    const pushes = ideas.filter(i => i.betResult === 'PUSH').length;
    const liveSettled = ideas.length;
    const livePnl = ideas.reduce((acc, i) => acc + toNum(i.profitLossUnits), 0);
    const liveRoi = liveSettled > 0 ? (livePnl / liveSettled) * 100 : null;
    const liveWinRate = liveSettled > 0 ? (wins / liveSettled) * 100 : null;

    const h = seed[m];
    const combSettled = h.settledIdeas + liveSettled;
    const combPnl = h.profitUnits + livePnl;
    const combWins = h.wins + wins;
    const combRoi = combSettled > 0 ? (combPnl / combSettled) * 100 : null;
    const combWinRate = combSettled > 0 ? (combWins / combSettled) * 100 : null;

    if (combSettled === 0 && model === 'combined') continue;

    lines.push(
      '',
      `**${modelDisplay(m)}**`,
      `**Historical:** ${h.settledIdeas} ideas (${h.wins}W/${h.losses}L) | Win ${pct(h.winRatePct)} | P&L ${fmt(h.profitUnits)} | ROI **${pct(h.roiPct)}**`,
      liveSettled > 0
        ? `**Live:** ${liveSettled} ideas (${wins}W/${losses}L/${pushes}P, from ${modelRows.length} rows) | Win ${pct(liveWinRate)} | P&L ${fmt(livePnl)} | ROI **${pct(liveRoi)}**`
        : `**Live:** no settled ideas yet`,
      `**Combined:** ${combSettled} ideas | Win ${pct(combWinRate)} | P&L ${fmt(combPnl)} | ROI **${pct(combRoi)}**`,
    );

    // Legacy-family confidence distribution (live rows; A/B/C — reporting only).
    const graded = ideas.filter(i => i.confidence);
    if (graded.length > 0) {
      const dist = (['A', 'B', 'C'] as const)
        .map(g => `${g}: ${graded.filter(i => i.confidence === g).length}`)
        .join(' | ');
      lines.push(`**Confidence (live):** ${dist}`);
    }
  }

  lines.push('', '*Historical = immutable backtest seed (in-play-inferred results). Live = real settlements. Combined = both.*');

  return { content: lines.join('\n') };
}
