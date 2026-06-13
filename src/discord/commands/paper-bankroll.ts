import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import { aggregateSettledIdeas, oddsToNumber } from '@/value-detection';
import { LIVE_BASELINE, modelsFor, modelDisplay } from '../reporting-config';
import type { ModelFilter } from '../reporting-config';

const STARTING_BANKROLL = 1000;

export async function getPaperBankroll(
  prisma: PrismaClient,
  logger: Logger,
  model: ModelFilter = 'combined',
): Promise<{ content: string }> {
  logger.info({ command: 'paper-bankroll', model }, 'Command execution started');

  const models = modelsFor(model);
  const settledRows = await prisma.valueOpportunity.findMany({
    where: {
      settledAt: { not: null, gte: LIVE_BASELINE },
      isShadow: false,
      model: { in: [...models] },
      match: { sport: { category: 'TRADITIONAL' as const } },
    },
    select: {
      matchId: true,
      outcome: true,
      bookmaker: true,
      bookmakerOdds: true,
      createdAt: true,
      profitLossUnits: true,
      model: true,
    },
  });

  const lines = ['💰 **PAPER BANKROLL**'];

  // Each model runs its own paper bankroll — ideas never merge across models.
  for (const m of models) {
    const modelRows = settledRows.filter(r => r.model === m);
    // Idea-level accounting: one flat unit per betting idea, P&L from the headline row.
    const ideas = aggregateSettledIdeas(modelRows).map(i => i.headline);
    const totalPnl = ideas.reduce((acc, i) => acc + oddsToNumber(i.profitLossUnits ?? 0), 0);
    const currentBankroll = STARTING_BANKROLL + totalPnl;
    const roi = (totalPnl / STARTING_BANKROLL) * 100;
    const pnlSign = totalPnl >= 0 ? '+' : '';

    lines.push(
      '',
      `**${modelDisplay(m)}**`,
      `**Starting:** ${STARTING_BANKROLL.toFixed(2)} units | **Current:** ${currentBankroll.toFixed(2)} units`,
      `**P&L:** ${pnlSign}${totalPnl.toFixed(2)} units | **ROI:** ${pnlSign}${roi.toFixed(2)}%`,
      `**Settled Ideas:** ${ideas.length} (from ${modelRows.length} bookmaker rows)`,
    );
  }

  return { content: lines.join('\n') };
}
