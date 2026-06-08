import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const settled = await prisma.valueOpportunity.findFirst({
    where: { settledAt: { not: null } },
    orderBy: { settledAt: 'desc' },
    include: {
      match: {
        include: {
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
          sport: { select: { slug: true, name: true } },
        },
      },
    },
  });
  if (!settled) { console.log('NO_SETTLED'); return; }
  console.log(JSON.stringify({
    id: settled.id,
    sport: settled.sport,
    match: {
      externalId: settled.match.externalId,
      status: settled.match.status,
      result: settled.match.result,
      homeScore: settled.match.homeScore,
      awayScore: settled.match.awayScore,
      homeTeam: settled.match.homeTeam.name,
      awayTeam: settled.match.awayTeam.name,
      sportSlug: settled.match.sport.slug,
      sportName: settled.match.sport.name,
    },
    outcome: settled.outcome,
    bookmakerOdds: Number(settled.bookmakerOdds),
    fairOdds: Number(settled.fairOdds),
    edgePercentage: Number(settled.edgePercentage),
    consensusProbability: Number(settled.consensusProbability),
    consensusBookmakers: settled.consensusBookmakers,
    betResult: settled.betResult,
    profitLossUnits: Number(settled.profitLossUnits ?? 0),
    settledAt: settled.settledAt,
    capturedAt: settled.capturedAt,
    alertedAt: settled.alertedAt,
  }, null, 2));
  await prisma.$disconnect();
}
main();