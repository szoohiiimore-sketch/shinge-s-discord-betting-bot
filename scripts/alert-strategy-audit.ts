/* eslint-disable no-console */
/**
 * Read-only audit: alert inflation — rows vs unique betting ideas under the new model.
 * Run: npx tsx --env-file=.env scripts/alert-strategy-audit.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // All new-model rows (candidate bookmaker != pinnacle)
  const rows = await prisma.$queryRaw<Array<{
    bookmaker: string; outcome: string; edge: number; odds: number;
    is_shadow: boolean; alerted: boolean; home: string; away: string; match_id: string;
  }>>`
    SELECT vo.bookmaker, vo.outcome, vo.edge_percentage::float AS edge, vo.bookmaker_odds::float AS odds,
           vo.is_shadow, (vo.alerted_at IS NOT NULL) AS alerted,
           ht.name AS home, at.name AS away, vo.match_id
    FROM value_opportunities vo
    JOIN matches m ON m.id = vo.match_id
    JOIN teams ht ON ht.id = m.home_team_id
    JOIN teams at ON at.id = m.away_team_id
    WHERE vo.bookmaker <> 'pinnacle'
    ORDER BY vo.created_at
  `;
  console.log(`NEW-MODEL ROWS: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `${r.home} vs ${r.away} | ${r.outcome} | ${r.bookmaker.padEnd(16)} | edge=${r.edge.toFixed(2)}% odds=${r.odds.toFixed(2)} shadow=${r.is_shadow} alerted=${r.alerted}`,
    );
  }

  // Idea-level grouping: one idea = (match, outcome), tiers merged
  const ideas = await prisma.$queryRaw<Array<{
    home: string; away: string; outcome: string; rows: number; books: string[];
    best: number; worst: number; any_production: boolean;
  }>>`
    SELECT ht.name AS home, at.name AS away, vo.outcome,
           COUNT(*)::int AS rows,
           ARRAY_AGG(DISTINCT vo.bookmaker) AS books,
           MAX(vo.bookmaker_odds::float) AS best,
           MIN(vo.bookmaker_odds::float) AS worst,
           BOOL_OR(NOT vo.is_shadow) AS any_production
    FROM value_opportunities vo
    JOIN matches m ON m.id = vo.match_id
    JOIN teams ht ON ht.id = m.home_team_id
    JOIN teams at ON at.id = m.away_team_id
    WHERE vo.bookmaker <> 'pinnacle'
    GROUP BY vo.match_id, ht.name, at.name, vo.outcome
    ORDER BY rows DESC
  `;
  console.log(`\nUNIQUE BETTING IDEAS (match+outcome): ${ideas.length}`);
  for (const i of ideas) {
    console.log(
      `rows=${String(i.rows).padStart(2)} prod=${i.any_production} odds ${i.worst.toFixed(2)}-${i.best.toFixed(2)} | ${i.home} vs ${i.away} | ${i.outcome} | [${i.books.join(', ')}]`,
    );
  }

  // Alerted-only view (what the user actually experienced)
  const alerted = rows.filter(r => r.alerted);
  const alertedIdeas = new Set(alerted.map(r => `${r.match_id}|${r.outcome}`));
  console.log(`\nALERTED rows: ${alerted.length}; unique alerted ideas: ${alertedIdeas.size}`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
