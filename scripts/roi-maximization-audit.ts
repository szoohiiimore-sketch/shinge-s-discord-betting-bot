/* eslint-disable no-console */
/**
 * Read-only audit script: ROI maximization analysis.
 * Run: npx tsx --env-file=.env scripts/roi-maximization-audit.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // 1. Settled bets by edge bucket — does higher recorded edge correlate with profit?
  const byEdge = await prisma.$queryRaw<Array<{ bucket: string; n: bigint; wins: bigint; pl: number | null }>>`
    SELECT CASE
             WHEN edge_percentage >= 20 THEN 'd >=20%'
             WHEN edge_percentage >= 10 THEN 'c 10-20%'
             WHEN edge_percentage >= 7  THEN 'b 7-10%'
             ELSE 'a 5-7%'
           END AS bucket,
           COUNT(*)::bigint AS n,
           COUNT(*) FILTER (WHERE bet_result = 'WIN')::bigint AS wins,
           SUM(profit_loss_units)::float AS pl
    FROM value_opportunities
    WHERE settled_at IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `;
  console.log('=== SETTLED BETS BY (OLD-MODEL) EDGE BUCKET ===');
  for (const r of byEdge) console.log(`${r.bucket.padEnd(10)} n=${String(r.n).padStart(3)} wins=${String(r.wins).padStart(3)} pl=${(r.pl ?? 0).toFixed(2)}`);

  // 2. Settled by sport
  const bySport = await prisma.$queryRaw<Array<{ sport: string; n: bigint; wins: bigint; pl: number | null }>>`
    SELECT sport, COUNT(*)::bigint AS n,
           COUNT(*) FILTER (WHERE bet_result = 'WIN')::bigint AS wins,
           SUM(profit_loss_units)::float AS pl
    FROM value_opportunities
    WHERE settled_at IS NOT NULL
    GROUP BY sport ORDER BY n DESC
  `;
  console.log('\n=== SETTLED BETS BY SPORT (all-time, mixed model) ===');
  for (const r of bySport) console.log(`${r.sport.padEnd(16)} n=${String(r.n).padStart(3)} wins=${String(r.wins).padStart(3)} pl=${(r.pl ?? 0).toFixed(2)}`);

  // 3. Pending (unsettled) opportunities
  const pending = await prisma.$queryRaw<Array<{ bookmaker: string; sport: string; n: bigint }>>`
    SELECT bookmaker, sport, COUNT(*)::bigint AS n
    FROM value_opportunities
    WHERE settled_at IS NULL
    GROUP BY bookmaker, sport ORDER BY n DESC
  `;
  console.log('\n=== PENDING OPPORTUNITIES ===');
  for (const r of pending) console.log(`${r.bookmaker.padEnd(16)} ${r.sport.padEnd(14)} n=${r.n}`);

  // 4. Edge distribution per sport (new-model simulation, latest batch, 30d, odds<=3)
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const edgeBySport = await prisma.$queryRaw<Array<{ sport: string; total: bigint; ge2: bigint; ge3: bigint; ge4: bigint; ge5: bigint }>>`
    WITH latest AS (
      SELECT match_id, MAX(captured_at) AS captured_at
      FROM odds_snapshots
      WHERE market = 'H2H' AND is_live = false AND captured_at >= ${since30d}
      GROUP BY match_id
    ),
    batch AS (
      SELECT os.match_id, os.bookmaker, os.outcome, os.price::float AS price
      FROM odds_snapshots os
      JOIN latest l ON l.match_id = os.match_id AND l.captured_at = os.captured_at
      WHERE os.market = 'H2H' AND os.is_live = false
    ),
    pin AS (
      SELECT match_id, outcome, MIN(price) AS price
      FROM batch WHERE bookmaker = 'pinnacle' GROUP BY match_id, outcome
    ),
    pin_over AS (
      SELECT match_id, SUM(1.0 / price) AS overround, COUNT(*) AS n_outcomes
      FROM pin GROUP BY match_id
      HAVING SUM(1.0 / price) BETWEEN 0.99 AND 1.15 AND COUNT(*) >= 2
    ),
    cand AS (
      SELECT b.match_id, b.bookmaker, b.outcome, MIN(b.price) AS price
      FROM batch b WHERE b.bookmaker <> 'pinnacle'
      GROUP BY b.match_id, b.bookmaker, b.outcome
    ),
    edges AS (
      SELECT c.match_id,
             (c.price * ((1.0 / p.price) / po.overround) - 1) * 100 AS edge_pct
      FROM cand c
      JOIN pin p ON p.match_id = c.match_id AND p.outcome = c.outcome
      JOIN pin_over po ON po.match_id = c.match_id
      JOIN (SELECT match_id, bookmaker, COUNT(DISTINCT outcome) AS n FROM batch WHERE bookmaker <> 'pinnacle' GROUP BY match_id, bookmaker) cn
        ON cn.match_id = c.match_id AND cn.bookmaker = c.bookmaker
      WHERE cn.n = po.n_outcomes AND c.price <= 3.0
    )
    SELECT sp.slug AS sport,
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE e.edge_pct >= 2)::bigint AS ge2,
           COUNT(*) FILTER (WHERE e.edge_pct >= 3)::bigint AS ge3,
           COUNT(*) FILTER (WHERE e.edge_pct >= 4)::bigint AS ge4,
           COUNT(*) FILTER (WHERE e.edge_pct >= 5)::bigint AS ge5
    FROM edges e
    JOIN matches m ON m.id = e.match_id
    JOIN sports sp ON sp.id = m.sport_id
    GROUP BY sp.slug ORDER BY total DESC
  `;
  console.log('\n=== NEW-MODEL EDGE CANDIDATES BY SPORT (latest batch, 30d, odds<=3.0) ===');
  for (const r of edgeBySport) {
    console.log(`${r.sport.padEnd(20)} evals=${String(r.total).padStart(5)} >=2%: ${String(r.ge2).padStart(3)}  >=3%: ${String(r.ge3).padStart(3)}  >=4%: ${String(r.ge4).padStart(3)}  >=5%: ${String(r.ge5).padStart(3)}`);
  }

  // 5. Edge candidates across ALL batches (not just latest) with permanent-dedup semantics:
  // distinct (match, bookmaker, outcome) where edge crossed threshold in ANY batch.
  const cumulative = await prisma.$queryRaw<Array<{ thr: number; logical_bets: bigint }>>`
    WITH batches AS (
      SELECT os.match_id, os.captured_at, os.bookmaker, os.outcome, os.price::float AS price
      FROM odds_snapshots os
      WHERE os.market = 'H2H' AND os.is_live = false AND os.captured_at >= ${since30d}
    ),
    pin AS (
      SELECT match_id, captured_at, outcome, MIN(price) AS price
      FROM batches WHERE bookmaker = 'pinnacle'
      GROUP BY match_id, captured_at, outcome
    ),
    pin_over AS (
      SELECT match_id, captured_at, SUM(1.0 / price) AS overround, COUNT(*) AS n_outcomes
      FROM pin GROUP BY match_id, captured_at
      HAVING SUM(1.0 / price) BETWEEN 0.99 AND 1.15 AND COUNT(*) >= 2
    ),
    cand AS (
      SELECT match_id, captured_at, bookmaker, outcome, MIN(price) AS price
      FROM batches WHERE bookmaker <> 'pinnacle'
      GROUP BY match_id, captured_at, bookmaker, outcome
    ),
    cand_n AS (
      SELECT match_id, captured_at, bookmaker, COUNT(DISTINCT outcome) AS n
      FROM batches WHERE bookmaker <> 'pinnacle'
      GROUP BY match_id, captured_at, bookmaker
    ),
    edges AS (
      SELECT c.match_id, c.bookmaker, c.outcome,
             MAX((c.price * ((1.0 / p.price) / po.overround) - 1) * 100) AS max_edge
      FROM cand c
      JOIN pin p ON p.match_id = c.match_id AND p.captured_at = c.captured_at AND p.outcome = c.outcome
      JOIN pin_over po ON po.match_id = c.match_id AND po.captured_at = c.captured_at
      JOIN cand_n cn ON cn.match_id = c.match_id AND cn.captured_at = c.captured_at AND cn.bookmaker = c.bookmaker
      WHERE cn.n = po.n_outcomes AND c.price <= 3.0
      GROUP BY c.match_id, c.bookmaker, c.outcome
    )
    SELECT t.thr, COUNT(*) FILTER (WHERE e.max_edge >= t.thr)::bigint AS logical_bets
    FROM edges e
    CROSS JOIN (VALUES (2.0), (3.0), (4.0), (5.0)) AS t(thr)
    GROUP BY t.thr ORDER BY t.thr
  `;
  console.log('\n=== CUMULATIVE LOGICAL BETS BY THRESHOLD (any batch crossed, permanent dedup, 30d) ===');
  for (const r of cumulative) console.log(`threshold ${r.thr}%: ${r.logical_bets} logical bets`);

  // 6. Snapshot date coverage — how many days of data do we actually have?
  const coverage = await prisma.$queryRaw<Array<{ day: Date; snaps: bigint; matches: bigint }>>`
    SELECT DATE_TRUNC('day', captured_at) AS day, COUNT(*)::bigint AS snaps, COUNT(DISTINCT match_id)::bigint AS matches
    FROM odds_snapshots
    GROUP BY 1 ORDER BY 1
  `;
  console.log('\n=== SNAPSHOT COVERAGE BY DAY ===');
  for (const r of coverage) console.log(`${r.day.toISOString().slice(0, 10)} snaps=${String(r.snaps).padStart(8)} matches=${r.matches}`);

  // 7. CLV columns populated so far
  const clv = await prisma.$queryRaw<Array<{ n: bigint; with_clv: bigint; avg_clv: number | null }>>`
    SELECT COUNT(*)::bigint AS n,
           COUNT(clv_percentage)::bigint AS with_clv,
           AVG(clv_percentage)::float AS avg_clv
    FROM value_opportunities
    WHERE settled_at IS NOT NULL
  `;
  console.log('\n=== CLV STATE ===');
  console.log(`settled=${clv[0].n} with_clv=${clv[0].with_clv} avg_clv=${clv[0].avg_clv?.toFixed(2) ?? 'n/a'}`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
