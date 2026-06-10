import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';

const STARTING_BANKROLL = 1000;

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  if (v !== null && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
  return 0;
}

export async function getPaperBankroll(
  prisma: PrismaClient,
  logger: Logger,
): Promise<{ content: string }> {
  logger.info({ command: 'paper-bankroll' }, 'Command execution started');

  const settled = await prisma.valueOpportunity.findMany({
    where: { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },
    select: { profitLossUnits: true },
  });

  const totalPnl = settled.reduce((acc, s) => acc + toNum(s.profitLossUnits), 0);
  const currentBankroll = STARTING_BANKROLL + totalPnl;
  const roi = (totalPnl / STARTING_BANKROLL) * 100;
  const pnlSign = totalPnl >= 0 ? '+' : '';

  const lines = [
    '💰 **PAPER BANKROLL**',
    '',
    `**Starting:** ${STARTING_BANKROLL.toFixed(2)} units`,
    `**Current:** ${currentBankroll.toFixed(2)} units`,
    `**P&L:** ${pnlSign}${totalPnl.toFixed(2)} units`,
    `**ROI:** ${pnlSign}${roi.toFixed(2)}%`,
    `**Settled Bets:** ${settled.length}`,
  ];

  return { content: lines.join('\n') };
}
