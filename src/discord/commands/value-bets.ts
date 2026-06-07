import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';

type StatusFilter = 'open' | 'alerted' | 'all';

function formatOdds(v: unknown): string {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' ? parseFloat(v)
    : (v !== null && typeof v === 'object' && 'toNumber' in v) ? (v as { toNumber(): number }).toNumber()
    : NaN;
  return isNaN(n) ? '?' : n.toFixed(2);
}

function formatEdge(v: unknown): string {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' ? parseFloat(v)
    : (v !== null && typeof v === 'object' && 'toNumber' in v) ? (v as { toNumber(): number }).toNumber()
    : NaN;
  return isNaN(n) ? '?' : `${n.toFixed(1)}%`;
}

function formatTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export async function getValueBets(
  prisma: PrismaClient,
  opts: { status?: StatusFilter; sport?: string; limit?: number },
  logger: Logger,
): Promise<{ content: string }> {
  logger.info({ command: 'value-bets', opts }, 'Command execution started');

  const { status = 'all', sport, limit = 10 } = opts;

  const where: Record<string, unknown> = {};
  if (status === 'open') where['alertedAt'] = null;
  else if (status === 'alerted') where['alertedAt'] = { not: null };
  if (sport) where['sport'] = sport;

  const opportunities = await prisma.valueOpportunity.findMany({
    where,
    orderBy: { capturedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      sport: true,
      outcome: true,
      bookmakerOdds: true,
      edgePercentage: true,
      capturedAt: true,
      alertedAt: true,
      betResult: true,
      match: {
        select: {
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
    },
  });

  const statusLabel = status === 'open' ? 'OPEN' : status === 'alerted' ? 'ALERTED' : 'ALL';
  const sportLabel = sport ? ` | ${sport.toUpperCase()}` : '';
  const header = `📊 **VALUE BETS** [${statusLabel}${sportLabel}]`;

  if (opportunities.length === 0) {
    return { content: `${header}\n\nNo value opportunities found.` };
  }

  const lines: string[] = [header, ''];

  for (const opp of opportunities) {
    const home = opp.match.homeTeam.name;
    const away = opp.match.awayTeam.name;
    const match = `${home} vs ${away}`;
    const odds = formatOdds(opp.bookmakerOdds);
    const edge = formatEdge(opp.edgePercentage);
    const ts = formatTimestamp(opp.capturedAt);
    const statusIcon = opp.betResult
      ? (opp.betResult === 'WIN' ? '✅' : opp.betResult === 'LOSS' ? '❌' : '➖')
      : opp.alertedAt ? '📨' : '🔍';

    lines.push(
      `${statusIcon} **${opp.outcome}** — ${opp.sport.toUpperCase()}`,
      `Match: ${match}`,
      `Odds: ${odds} | Edge: ${edge} | ${ts}`,
      '',
    );
  }

  const content = lines.join('\n');
  if (content.length > 1900) {
    return { content: content.slice(0, 1870) + '\n\n*(truncated — use sport filter to narrow results)*' };
  }
  return { content };
}
