import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  const settled = await p.valueOpportunity.findFirst({
    where: { settledAt: { not: null }, sport: { notIn: ['cs2','dota2','lol','valorant','league-of-legends'] } },
    orderBy: { settledAt: 'desc' },
    include: { match: { include: { homeTeam: true, awayTeam: true, sport: true } } },
  });
  if (!settled) { console.log('NO_TRADITIONAL'); return; }
  console.log(JSON.stringify({
    id: settled.id, sport: settled.sport,
    match: {
      externalId: settled.match.externalId, status: settled.match.status,
      result: settled.match.result, homeScore: settled.match.homeScore,
      awayScore: settled.match.awayScore,
      homeTeam: settled.match.homeTeam.name, awayTeam: settled.match.awayTeam.name,
      sportSlug: settled.match.sport.slug,
    },
    outcome: settled.outcome, bookmakerOdds: Number(settled.bookmakerOdds),
    fairOdds: Number(settled.fairOdds), edgePercentage: Number(settled.edgePercentage),
    consensusProbability: Number(settled.consensusProbability),
    consensusBookmakers: settled.consensusBookmakers,
    betResult: settled.betResult, profitLossUnits: Number(settled.profitLossUnits ?? 0),
    settledAt: settled.settledAt, capturedAt: settled.capturedAt,
  }, null, 2));
  await p.$disconnect();
})();