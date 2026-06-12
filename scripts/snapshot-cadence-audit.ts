/* eslint-disable no-console */
/**
 * Read-only audit script: snapshot cadence — can existing data support movement models?
 * Run: npx tsx --env-file=.env scripts/snapshot-cadence-audit.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // 1. Pinnacle batches per match (traditional only): how many distinct capture points exist?
  const batches = await prisma.$queryRaw<Array<{ batches_bucket: string; matches: bigint }>>`
    WITH per_match AS (
      SELECT os.match_id, COUNT(DISTINCT os.captured_at) AS n_batches
      FROM odds_snapshots os
      JOIN matches m ON m.id = os.match_id
      JOIN sports sp ON sp.id = m.sport_id
      WHERE os.bookmaker = 'pinnacle' AND os.market = 'H2H' AND os.is_live = false
        AND sp.category = 'TRADITIONAL'
      GROUP BY os.match_id
    )
    SELECT CASE
             WHEN n_batches >= 20 THEN 'e >=20'
             WHEN n_batches >= 10 THEN 'd 10-19'
             WHEN n_batches >= 5  THEN 'c 5-9'
             WHEN n_batches >= 2  THEN 'b 2-4'
             ELSE 'a 1'
           END AS batches_bucket,
           COUNT(*)::bigint AS matches
    FROM per_match
    GROUP BY 1 ORDER BY 1
  `;
  console.log('=== PINNACLE H2H PRE-MATCH BATCHES PER TRADITIONAL MATCH ===');
  for (const r of batches) console.log(`${r.batches_bucket.padEnd(10)} matches=${r.matches}`);

  // 2. Median inter-batch gap for Pinnacle per match (minutes)
  const gaps = await prisma.$queryRaw<Array<{ p25: number; p50: number; p75: number; p95: number }>>`
    WITH batch_times AS (
      SELECT DISTINCT os.match_id, os.captured_at
      FROM odds_snapshots os
      JOIN matches m ON m.id = os.match_id
      JOIN sports sp ON sp.id = m.sport_id
      WHERE os.bookmaker = 'pinnacle' AND os.market = 'H2H' AND os.is_live = false
        AND sp.category = 'TRADITIONAL'
    ),
    diffs AS (
      SELECT EXTRACT(EPOCH FROM (captured_at - LAG(captured_at) OVER (PARTITION BY match_id ORDER BY captured_at))) / 60 AS gap_min
      FROM batch_times
    )
    SELECT percentile_cont(0.25) WITHIN GROUP (ORDER BY gap_min)::float AS p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY gap_min)::float AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY gap_min)::float AS p75,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY gap_min)::float AS p95
    FROM diffs WHERE gap_min IS NOT NULL
  `;
  console.log('\n=== INTER-BATCH GAP DISTRIBUTION (minutes, Pinnacle, traditional) ===');
  const g = gaps[0];
  console.log(`p25=${g.p25?.toFixed(0)} p50=${g.p50?.toFixed(0)} p75=${g.p75?.toFixed(0)} p95=${g.p95?.toFixed(0)}`);

  // 3. Pinnacle price movement magnitude across a match's observed life (first vs last pre-match batch)
  const moves = await prisma.$queryRaw<Array<{ bucket: string; n: bigint }>>`
    WITH batch AS (
      SELECT os.match_id, os.outcome, os.captured_at, os.price::float AS price,
             FIRST_VALUE(os.price::float) OVER w AS first_price,
             LAST_VALUE(os.price::float) OVER (PARTITION BY os.match_id, os.outcome ORDER BY os.captured_at
               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_price,
             ROW_NUMBER() OVER w AS rn
      FROM odds_snapshots os
      JOIN matches m ON m.id = os.match_id
      JOIN sports sp ON sp.id = m.sport_id
      WHERE os.bookmaker = 'pinnacle' AND os.market = 'H2H' AND os.is_live = false
        AND sp.category = 'TRADITIONAL'
      WINDOW w AS (PARTITION BY os.match_id, os.outcome ORDER BY os.captured_at)
    ),
    move AS (
      SELECT match_id, outcome, ABS(last_price / first_price - 1) * 100 AS move_pct
      FROM batch WHERE rn = 1 AND first_price > 1 AND last_price > 1
    )
    SELECT CASE
             WHEN move_pct >= 5 THEN 'e >=5%'
             WHEN move_pct >= 3 THEN 'd 3-5%'
             WHEN move_pct >= 2 THEN 'c 2-3%'
             WHEN move_pct >= 1 THEN 'b 1-2%'
             ELSE 'a <1%'
           END AS bucket, COUNT(*)::bigint AS n
    FROM move GROUP BY 1 ORDER BY 1
  `;
  console.log('\n=== PINNACLE PRICE MOVEMENT first→last OBSERVED BATCH (per match+outcome) ===');
  for (const r of moves) console.log(`${r.bucket.padEnd(8)} n=${r.n}`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
