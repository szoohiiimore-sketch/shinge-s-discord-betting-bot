/* eslint-disable no-console */
/**
 * Read-only verification: idea grouping, headline selection, family collapse,
 * and corroboration count, replayed over the real production rows.
 * Run: npx tsx --env-file=.env scripts/idea-aggregation-verify.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  groupIdeas,
  selectHeadline,
  corroborationCount,
  isExchange,
  bookmakerFamily,
  aggregateSettledIdeas,
} from '../src/value-detection/idea-aggregation';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const rows = await prisma.valueOpportunity.findMany({
    where: { bookmaker: { not: 'pinnacle' } },
    select: {
      matchId: true, outcome: true, bookmaker: true, bookmakerOdds: true,
      edgePercentage: true, createdAt: true, isShadow: true,
    },
  });
  const production = rows.filter(r => !r.isShadow);
  console.log(`production rows: ${production.length} | all new-model rows: ${rows.length}`);

  const ideas = groupIdeas(production);
  console.log(`production ideas: ${ideas.size}`);
  for (const [, members] of ideas) {
    const headline = selectHeadline(members);
    const k = corroborationCount(members);
    console.log(`idea: ${members[0].outcome}`);
    console.log(
      `  members: ${members.map(m => `${m.bookmaker}@${m.bookmakerOdds}${isExchange(m.bookmaker) ? '(EX)' : ''} fam=${bookmakerFamily(m.bookmaker)}`).join(', ')}`,
    );
    console.log(`  headline: ${headline ? `${headline.bookmaker}@${headline.bookmakerOdds}` : 'NONE'} | k=${k}`);
  }

  const settled = aggregateSettledIdeas(production);
  console.log(
    `aggregateSettledIdeas: ${settled.length} ideas → ${settled.map(i => `${i.headline.bookmaker} (rows=${i.rowCount})`).join(' | ')}`,
  );

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
