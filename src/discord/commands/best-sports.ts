import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  if (v !== null && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
  return 0;
}

const SPORT_DISPLAY: Record<string, string> = {
  cs2: 'CS2', dota2: 'Dota 2', lol: 'LoL', valorant: 'Valorant',
  tennis: 'Tennis', soccer: 'Soccer', basketball: 'Basketball',
  baseball: 'Baseball', 'ice-hockey': 'Ice Hockey', hockey: 'Ice Hockey', football: 'Football',
};

function displaySport(slug: string): string {
  return SPORT_DISPLAY[slug] ?? slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export async function getBestSports(
  prisma: PrismaClient,
  logger: Logger,
): Promise<{ content: string }> {
  logger.info({ command: 'best-sports' }, 'Command execution started');

  const settled = await prisma.valueOpportunity.findMany({
    where: { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },
    select: { sport: true, betResult: true, profitLossUnits: true },
  });

  if (settled.length === 0) {
    return { content: '🏆 **BEST SPORTS**\n\nNo settled bets yet.' };
  }

  // Aggregate by sport
  const bySport = new Map<string, { wins: number; losses: number; pushes: number; pnl: number }>();
  for (const s of settled) {
    const sport = s.sport;
    if (!bySport.has(sport)) bySport.set(sport, { wins: 0, losses: 0, pushes: 0, pnl: 0 });
    const agg = bySport.get(sport)!;
    if (s.betResult === 'WIN') agg.wins++;
    else if (s.betResult === 'LOSS') agg.losses++;
    else agg.pushes++;
    agg.pnl += toNum(s.profitLossUnits);
  }

  // Sort by ROI descending
  const rows = [...bySport.entries()]
    .map(([sport, agg]) => {
      const total = agg.wins + agg.losses + agg.pushes;
      const roi = total > 0 ? (agg.pnl / total) * 100 : 0;
      const winRate = total > 0 ? (agg.wins / total) * 100 : 0;
      return { sport, total, roi, winRate, pnl: agg.pnl };
    })
    .sort((a, b) => b.roi - a.roi);

  const lines = ['🏆 **BEST SPORTS**', ''];
  for (const row of rows) {
    const pnlSign = row.pnl >= 0 ? '+' : '';
    const roiSign = row.roi >= 0 ? '+' : '';
    lines.push(
      `**${displaySport(row.sport)}** — ${row.total} bets`,
      `ROI: ${roiSign}${row.roi.toFixed(1)}% | Win Rate: ${row.winRate.toFixed(1)}% | P&L: ${pnlSign}${row.pnl.toFixed(2)}u`,
      '',
    );
  }

  const content = lines.join('\n');
  if (content.length > 1990) {
    return { content: content.slice(0, 1960) + '\n\n*(truncated — too many sports)*' };
  }
  return { content };
}
