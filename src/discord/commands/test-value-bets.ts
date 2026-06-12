import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';

const SPORT_DISPLAY: Record<string, string> = {
  cs2: 'CS2',
  dota2: 'Dota 2',
  lol: 'League of Legends',
  valorant: 'Valorant',
  tennis: 'Tennis',
  soccer: 'Soccer',
  basketball: 'Basketball',
  baseball: 'Baseball',
  'ice-hockey': 'Ice Hockey',
  hockey: 'Ice Hockey',
};

function displaySport(slug: string): string {
  return SPORT_DISPLAY[slug] ?? slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function displayOdds(raw: unknown): string {
  const n = typeof raw === 'object' && raw !== null && 'toNumber' in raw
    ? (raw as { toNumber(): number }).toNumber()
    : Number(raw);
  return n.toFixed(2);
}

function displayEdge(raw: unknown): string {
  const n = typeof raw === 'object' && raw !== null && 'toNumber' in raw
    ? (raw as { toNumber(): number }).toNumber()
    : Number(raw);
  return `+${n.toFixed(1)}%`;
}

function displayTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function displayBookmaker(key: string): string {
  const KNOWN: Record<string, string> = {
    pinnacle: 'Pinnacle',
    bet365: 'Bet365',
    unibet: 'Unibet',
    '1xbet': '1xBet',
    betway: 'Betway',
  };
  return KNOWN[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Formats a list of ValueOpportunity records into a Discord embed message.
 * Uses the same formatting as production alerts.
 */
export function formatTestValueBets(
  opportunities: Array<{
    sport: string;
    bookmaker: string;
    outcome: string;
    bookmakerOdds: unknown;
    fairOdds: unknown;
    edgePercentage: unknown;
    capturedAt: Date;
    match: {
      homeTeam: { name: string };
      awayTeam: { name: string };
    };
  }>,
): string | null {
  if (opportunities.length === 0) {
    return null;
  }

  const lines: string[] = [
    '📊 **TOP VALUE BETS**',
    '',
  ];

  for (const opp of opportunities) {
    lines.push(
      `**${displaySport(opp.sport)}** | ${opp.match.homeTeam.name} vs ${opp.match.awayTeam.name}`,
      `Outcome: ${opp.outcome} @ ${displayBookmaker(opp.bookmaker)}`,
      `Odds: ${displayOdds(opp.bookmakerOdds)} | Fair: ${displayOdds(opp.fairOdds)} | Edge: ${displayEdge(opp.edgePercentage)}`,
      `Captured: ${displayTime(opp.capturedAt)}`,
      '',
    );
  }

  return lines.join('\n');
}

export async function getTopValueBets(
  prisma: PrismaClient,
  logger: Logger,
): Promise<{ content: string; count: number }> {
  const startedAt = Date.now();
  logger.info({ command: 'test-value-bets', dataSource: 'PostgreSQL (ValueOpportunity table)' }, 'Command execution started');

  const opportunities = await prisma.valueOpportunity.findMany({
    where: { isShadow: false },
    orderBy: { edgePercentage: 'desc' },
    take: 5,
    include: {
      match: {
        include: {
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
    },
  });

  const durationMs = Date.now() - startedAt;
  logger.info({
    command: 'test-value-bets',
    dataSource: 'PostgreSQL (ValueOpportunity table)',
    recordsRead: opportunities.length,
    apiCalls: 0,
    durationMs,
  }, 'Command execution complete');

  const content = formatTestValueBets(opportunities);

  if (!content) {
    return { content: 'No ValueOpportunity records found. Odds must be ingested and value detected first.', count: 0 };
  }

  const header = `**Data Source:** PostgreSQL (ValueOpportunity table)\n**Records:** ${opportunities.length} | **Duration:** ${durationMs}ms\n\n`;
  return { content: header + content, count: opportunities.length };
}
