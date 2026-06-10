import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';

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
): Promise<{ content: string }> {
  logger.info({ command: 'roi', period }, 'Command execution started');

  const cutoff = periodCutoff(period);
  const where = cutoff
    ? { settledAt: { not: null, gte: cutoff }, match: { sport: { category: 'TRADITIONAL' as const } } }
    : { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } };

  const settled = await prisma.valueOpportunity.findMany({
    where,
    select: { betResult: true, profitLossUnits: true, edgePercentage: true },
  });

  if (settled.length === 0) {
    return { content: `📊 **ROI — ${periodLabel(period)}**\n\nNo settled bets yet.` };
  }

  const wins = settled.filter(s => s.betResult === 'WIN').length;
  const losses = settled.filter(s => s.betResult === 'LOSS').length;
  const pushes = settled.filter(s => s.betResult === 'PUSH').length;
  const totalStaked = settled.length;
  const totalPnl = settled.reduce((acc, s) => acc + toNum(s.profitLossUnits), 0);
  const roi = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0;
  const winRate = totalStaked > 0 ? (wins / totalStaked) * 100 : 0;
  const avgEdge = settled.reduce((acc, s) => acc + toNum(s.edgePercentage), 0) / settled.length;

  const pnlSign = totalPnl >= 0 ? '+' : '';

  const lines = [
    `📊 **ROI — ${periodLabel(period)}**`,
    '',
    `**Bets:** ${totalStaked} (${wins}W / ${losses}L / ${pushes}P)`,
    `**Win Rate:** ${winRate.toFixed(1)}%`,
    `**P&L:** ${pnlSign}${totalPnl.toFixed(2)} units`,
    `**ROI:** ${pnlSign}${roi.toFixed(2)}%`,
    `**Avg Edge:** +${avgEdge.toFixed(1)}%`,
  ];

  return { content: lines.join('\n') };
}
