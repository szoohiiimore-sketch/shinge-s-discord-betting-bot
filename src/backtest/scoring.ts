/**
 * Scoring layer — runs AFTER replay completes; the only component allowed to
 * read closing snapshots. Writes only the label columns of
 * backtest_opportunities (closing_*, clv_*), never the feature columns.
 *
 * CLV method (same formulas as live, better reference): the close is the last
 * historical reference-book snapshot strictly BEFORE commence_time whose market
 * passes the run's overround bounds. If the latest pre-kickoff snapshot fails
 * the bounds (in-play leak after a commence-time shift, or corrupt data), the
 * scorer walks back up to MAX_CLOSE_WALKBACK earlier timestamps.
 * No match results are required — CLV needs only the close.
 */
import type { PrismaClient } from '@prisma/client';
import type { BacktestRunConfig } from './types';

const MAX_CLOSE_WALKBACK = 5;

export interface ClvScoreSummary {
  readonly eventsScored: number;
  readonly eventsWithoutClose: number;
  readonly rowsScored: number;
  readonly rowsNullClv: number;
}

interface CloseResult {
  readonly fairOddsByOutcome: Map<string, number>;
  readonly rawPriceByOutcome: Map<string, number>;
}

function resolveClose(
  referenceRows: ReadonlyArray<{ outcome: string; price: number; snapshotAt: Date }>,
  config: BacktestRunConfig,
): CloseResult | null {
  // Group reference rows by timestamp, newest first.
  const byTime = new Map<number, Map<string, number>>();
  for (const row of referenceRows) {
    const t = row.snapshotAt.getTime();
    let prices = byTime.get(t);
    if (!prices) { prices = new Map(); byTime.set(t, prices); }
    if (!prices.has(row.outcome) && row.price > 1) prices.set(row.outcome, row.price);
  }
  const times = [...byTime.keys()].sort((a, b) => b - a);

  for (const t of times.slice(0, MAX_CLOSE_WALKBACK)) {
    const prices = byTime.get(t)!;
    if (prices.size < 2) continue;
    let overround = 0;
    for (const odds of prices.values()) overround += 1 / odds;
    if (overround < config.detector.minReferenceOverround || overround > config.detector.maxReferenceOverround) continue;

    const fair = new Map<string, number>();
    for (const [outcome, odds] of prices) fair.set(outcome, overround * odds); // 1 / ((1/odds)/overround)
    return { fairOddsByOutcome: fair, rawPriceByOutcome: prices };
  }
  return null;
}

export async function scoreRunClv(prisma: PrismaClient, runId: string): Promise<ClvScoreSummary> {
  const run = await prisma.backtestRun.findUniqueOrThrow({ where: { id: runId } });
  const config = run.config as unknown as BacktestRunConfig;

  const opportunities = await prisma.backtestOpportunity.findMany({
    where: { runId },
    select: { id: true, eventId: true, outcome: true, bookmakerOdds: true, commenceTime: true },
  });

  const byEvent = new Map<string, typeof opportunities>();
  for (const opp of opportunities) {
    let arr = byEvent.get(opp.eventId);
    if (!arr) { arr = []; byEvent.set(opp.eventId, arr); }
    arr.push(opp);
  }

  let eventsScored = 0;
  let eventsWithoutClose = 0;
  let rowsScored = 0;
  let rowsNullClv = 0;

  for (const [eventId, eventOpps] of byEvent) {
    const commenceTime = eventOpps[0].commenceTime;
    const referenceRows = await prisma.historicalOddsSnapshot.findMany({
      where: {
        eventId,
        bookmaker: config.detector.referenceBookmaker,
        market: 'h2h',
        snapshotAt: { lt: commenceTime },
      },
      select: { outcome: true, price: true, snapshotAt: true },
    });

    const close = resolveClose(
      referenceRows.map(r => ({ outcome: r.outcome, price: r.price.toNumber(), snapshotAt: r.snapshotAt })),
      config,
    );

    if (!close) {
      eventsWithoutClose++;
      rowsNullClv += eventOpps.length;
      continue;
    }
    eventsScored++;

    for (const opp of eventOpps) {
      const closingFair = close.fairOddsByOutcome.get(opp.outcome);
      const closingRaw = close.rawPriceByOutcome.get(opp.outcome);
      if (closingFair === undefined) {
        rowsNullClv++;
        continue;
      }
      const clvPct = (opp.bookmakerOdds.toNumber() / closingFair - 1) * 100;
      await prisma.backtestOpportunity.update({
        where: { id: opp.id },
        data: {
          closingPinnacleOdds: closingRaw,
          closingFairOdds: closingFair,
          clvPercentage: clvPct,
          clvPositive: clvPct > 0,
        },
      });
      rowsScored++;
    }
  }

  await prisma.backtestRun.update({ where: { id: runId }, data: { status: 'SCORED' } });
  return { eventsScored, eventsWithoutClose, rowsScored, rowsNullClv };
}
