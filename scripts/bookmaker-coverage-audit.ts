/* eslint-disable no-console */
/**
 * Read-only audit script: bookmaker coverage in OddsSnapshot.
 * Run: npx tsx --env-file=.env scripts/bookmaker-coverage-audit.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // 1. Unique bookmakers in last 30 days, with snapshot counts and first/last seen
  const byBookmaker = await prisma.$queryRaw<Array<{
    bookmaker: string; snapshots: bigint; matches: bigint; first_seen: Date; last_seen: Date;
  }>>`
    SELECT bookmaker,
           COUNT(*)::bigint AS snapshots,
           COUNT(DISTINCT match_id)::bigint AS matches,
           MIN(captured_at) AS first_seen,
           MAX(captured_at) AS last_seen
    FROM odds_snapshots
    WHERE captured_at >= ${since30d}
    GROUP BY bookmaker
    ORDER BY snapshots DESC
  `;
  console.log('=== BOOKMAKERS (last 30 days) ===');
  for (const r of byBookmaker) {
    console.log(
      `${r.bookmaker.padEnd(24)} snaps=${String(r.snapshots).padStart(8)} matches=${String(r.matches).padStart(5)} first=${r.first_seen.toISOString().slice(0, 10)} last=${r.last_seen.toISOString().slice(0, 10)}`,
    );
  }
  console.log(`Total unique bookmakers: ${byBookmaker.length}`);

  // 2. Bookmaker count by sport
  const bySport = await prisma.$queryRaw<Array<{ sport: string; bookmakers: bigint; snapshots: bigint; matches: bigint }>>`
    SELECT sp.slug AS sport,
           COUNT(DISTINCT os.bookmaker)::bigint AS bookmakers,
           COUNT(*)::bigint AS snapshots,
           COUNT(DISTINCT os.match_id)::bigint AS matches
    FROM odds_snapshots os
    JOIN matches m ON m.id = os.match_id
    JOIN sports sp ON sp.id = m.sport_id
    WHERE os.captured_at >= ${since30d}
    GROUP BY sp.slug
    ORDER BY snapshots DESC
  `;
  console.log('\n=== BOOKMAKER COUNT BY SPORT (last 30 days) ===');
  for (const r of bySport) {
    console.log(`${r.sport.padEnd(20)} bookmakers=${String(r.bookmakers).padStart(3)} matches=${String(r.matches).padStart(5)} snaps=${String(r.snapshots).padStart(8)}`);
  }

  // 3. Bookmaker count by league
  const byLeague = await prisma.$queryRaw<Array<{ league: string; sport: string; bookmakers: bigint; matches: bigint }>>`
    SELECT l.slug AS league, sp.slug AS sport,
           COUNT(DISTINCT os.bookmaker)::bigint AS bookmakers,
           COUNT(DISTINCT os.match_id)::bigint AS matches
    FROM odds_snapshots os
    JOIN matches m ON m.id = os.match_id
    JOIN leagues l ON l.id = m.league_id
    JOIN sports sp ON sp.id = m.sport_id
    WHERE os.captured_at >= ${since30d}
    GROUP BY l.slug, sp.slug
    ORDER BY matches DESC
  `;
  console.log('\n=== BOOKMAKER COUNT BY LEAGUE (last 30 days) ===');
  for (const r of byLeague) {
    console.log(`${r.league.padEnd(36)} sport=${r.sport.padEnd(14)} bookmakers=${String(r.bookmakers).padStart(3)} matches=${String(r.matches).padStart(5)}`);
  }

  // 4. Pinnacle co-presence: of matches with Pinnacle quotes, how many other books quote them
  const pinnaclePresence = await prisma.$queryRaw<Array<{ total_matches: bigint; pinnacle_matches: bigint }>>`
    SELECT COUNT(DISTINCT match_id)::bigint AS total_matches,
           COUNT(DISTINCT match_id) FILTER (WHERE bookmaker = 'pinnacle')::bigint AS pinnacle_matches
    FROM odds_snapshots
    WHERE captured_at >= ${since30d}
  `;
  console.log('\n=== PINNACLE PRESENCE (last 30 days) ===');
  console.log(`matches with any odds: ${pinnaclePresence[0].total_matches}, with Pinnacle: ${pinnaclePresence[0].pinnacle_matches}`);

  // 5. For matches WITH Pinnacle, which candidate books co-occur (these can produce alerts)
  const coOccur = await prisma.$queryRaw<Array<{ bookmaker: string; matches_with_pinnacle: bigint }>>`
    WITH pin_matches AS (
      SELECT DISTINCT match_id FROM odds_snapshots
      WHERE bookmaker = 'pinnacle' AND captured_at >= ${since30d}
    )
    SELECT os.bookmaker, COUNT(DISTINCT os.match_id)::bigint AS matches_with_pinnacle
    FROM odds_snapshots os
    JOIN pin_matches pm ON pm.match_id = os.match_id
    WHERE os.bookmaker <> 'pinnacle' AND os.captured_at >= ${since30d}
    GROUP BY os.bookmaker
    ORDER BY matches_with_pinnacle DESC
  `;
  console.log('\n=== CANDIDATE BOOKS CO-OCCURRING WITH PINNACLE ===');
  for (const r of coOccur) {
    console.log(`${r.bookmaker.padEnd(24)} matches=${String(r.matches_with_pinnacle).padStart(5)}`);
  }

  // 6. All-time bookmaker list (in case 30d window hides anything)
  const allTime = await prisma.$queryRaw<Array<{ bookmaker: string; snapshots: bigint }>>`
    SELECT bookmaker, COUNT(*)::bigint AS snapshots
    FROM odds_snapshots
    GROUP BY bookmaker
    ORDER BY snapshots DESC
  `;
  console.log('\n=== ALL-TIME BOOKMAKERS ===');
  for (const r of allTime) {
    console.log(`${r.bookmaker.padEnd(24)} snaps=${String(r.snapshots).padStart(8)}`);
  }

  // 7. Opportunities by bookmaker (which books have actually generated alerts)
  const oppsByBook = await prisma.$queryRaw<Array<{ bookmaker: string; opportunities: bigint; settled: bigint; wins: bigint; pl: number | null; avg_edge: number | null }>>`
    SELECT bookmaker,
           COUNT(*)::bigint AS opportunities,
           COUNT(*) FILTER (WHERE settled_at IS NOT NULL)::bigint AS settled,
           COUNT(*) FILTER (WHERE bet_result = 'WIN')::bigint AS wins,
           SUM(profit_loss_units) FILTER (WHERE settled_at IS NOT NULL)::float AS pl,
           AVG(edge_percentage)::float AS avg_edge
    FROM value_opportunities
    GROUP BY bookmaker
    ORDER BY opportunities DESC
  `;
  console.log('\n=== OPPORTUNITIES BY BOOKMAKER (all-time) ===');
  for (const r of oppsByBook) {
    console.log(`${r.bookmaker.padEnd(24)} opps=${String(r.opportunities).padStart(4)} settled=${String(r.settled).padStart(4)} wins=${String(r.wins).padStart(3)} pl=${(r.pl ?? 0).toFixed(2).padStart(8)} avgEdge=${(r.avg_edge ?? 0).toFixed(2)}%`);
  }

  // 8. Edge distribution under new model — what would thresholds 2/3/4/5% have produced?
  // Reconstruct per latest batch per match: pinnacle devig, candidate edges (last 30 days, H2H, prematch)
  console.log('\n=== EDGE DISTRIBUTION SIMULATION (latest batch per match, last 30 days) ===');
  const edgeRows = await prisma.$queryRaw<Array<{ bucket: string; n: bigint }>>`
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
      FROM batch WHERE bookmaker = 'pinnacle'
      GROUP BY match_id, outcome
    ),
    pin_over AS (
      SELECT match_id, SUM(1.0 / price) AS overround, COUNT(*) AS n_outcomes
      FROM pin GROUP BY match_id
      HAVING SUM(1.0 / price) BETWEEN 0.99 AND 1.15 AND COUNT(*) >= 2
    ),
    cand AS (
      SELECT b.match_id, b.bookmaker, b.outcome, MIN(b.price) AS price,
             COUNT(*) OVER (PARTITION BY b.match_id, b.bookmaker) AS cand_outcomes
      FROM batch b
      WHERE b.bookmaker <> 'pinnacle'
      GROUP BY b.match_id, b.bookmaker, b.outcome
    ),
    edges AS (
      SELECT c.match_id, c.bookmaker, c.outcome,
             (c.price * ((1.0 / p.price) / po.overround) - 1) * 100 AS edge_pct
      FROM cand c
      JOIN pin p ON p.match_id = c.match_id AND p.outcome = c.outcome
      JOIN pin_over po ON po.match_id = c.match_id
      JOIN (SELECT match_id, bookmaker, COUNT(DISTINCT outcome) AS n FROM batch WHERE bookmaker <> 'pinnacle' GROUP BY match_id, bookmaker) cn
        ON cn.match_id = c.match_id AND cn.bookmaker = c.bookmaker
      WHERE cn.n = po.n_outcomes
        AND c.price <= 3.0
    )
    SELECT CASE
             WHEN edge_pct >= 5 THEN '>=5%'
             WHEN edge_pct >= 4 THEN '4-5%'
             WHEN edge_pct >= 3 THEN '3-4%'
             WHEN edge_pct >= 2 THEN '2-3%'
             WHEN edge_pct >= 1 THEN '1-2%'
             WHEN edge_pct >= 0 THEN '0-1%'
             ELSE '<0%'
           END AS bucket,
           COUNT(*)::bigint AS n
    FROM edges
    GROUP BY 1 ORDER BY 1
  `;
  for (const r of edgeRows) {
    console.log(`${r.bucket.padEnd(6)} ${r.n}`);
  }

  // 8b. Per-bookmaker positive-edge counts at >=3% (who would generate alerts at lower threshold)
  const edgeByBook = await prisma.$queryRaw<Array<{ bookmaker: string; ge2: bigint; ge3: bigint; ge4: bigint; ge5: bigint }>>`
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
      FROM batch WHERE bookmaker = 'pinnacle'
      GROUP BY match_id, outcome
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
      SELECT c.bookmaker,
             (c.price * ((1.0 / p.price) / po.overround) - 1) * 100 AS edge_pct
      FROM cand c
      JOIN pin p ON p.match_id = c.match_id AND p.outcome = c.outcome
      JOIN pin_over po ON po.match_id = c.match_id
      JOIN (SELECT match_id, bookmaker, COUNT(DISTINCT outcome) AS n FROM batch WHERE bookmaker <> 'pinnacle' GROUP BY match_id, bookmaker) cn
        ON cn.match_id = c.match_id AND cn.bookmaker = c.bookmaker
      WHERE cn.n = po.n_outcomes
        AND c.price <= 3.0
    )
    SELECT bookmaker,
           COUNT(*) FILTER (WHERE edge_pct >= 2)::bigint AS ge2,
           COUNT(*) FILTER (WHERE edge_pct >= 3)::bigint AS ge3,
           COUNT(*) FILTER (WHERE edge_pct >= 4)::bigint AS ge4,
           COUNT(*) FILTER (WHERE edge_pct >= 5)::bigint AS ge5
    FROM edges
    GROUP BY bookmaker
    HAVING COUNT(*) FILTER (WHERE edge_pct >= 2) > 0
    ORDER BY ge2 DESC
  `;
  console.log('\n=== POSITIVE EDGES BY BOOKMAKER (latest batches, 30d, odds<=3.0) ===');
  for (const r of edgeByBook) {
    console.log(`${r.bookmaker.padEnd(24)} >=2%: ${String(r.ge2).padStart(4)}  >=3%: ${String(r.ge3).padStart(4)}  >=4%: ${String(r.ge4).padStart(4)}  >=5%: ${String(r.ge5).padStart(4)}`);
  }

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
