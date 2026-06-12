/**
 * Historical Results Integration — infers H2H results from the in-play prices
 * already present in the stored historical snapshots (sport-level snapshots
 * captured other events mid-match). ZERO additional API usage.
 *
 * Inference rule, deliberately conservative:
 *  - Only in-play batches at least MIN_ELAPSED minutes (per sport) after
 *    commence time qualify — early in-play prices are not results.
 *  - Per batch and outcome, the MEDIAN price across all books is used
 *    (robust to a single stale book).
 *  - WIN evidence: median <= WIN_PRICE (1.03 ≈ >97% implied) in the latest
 *    qualifying batch. LOSS evidence: median >= LOSS_PRICE (15.0 ≈ <7%).
 *  - Anything in between stays UNRESOLVED and is excluded from ROI — coverage
 *    is reported, never imputed.
 *
 * Known biases, documented for every consumer:
 *  - Resolvable events skew toward one-sided matches (close finishes stay
 *    unresolved) and toward events that overlapped other fixtures' snapshot
 *    times. Fixture-timing is independent of bet outcomes; one-sidedness is not
 *    fully — ROI numbers carry this caveat.
 *  - A team at 1.03 late still loses occasionally (~1–3%); mis-settles are rare
 *    but slightly favourable to the bettor's side.
 */
import type { PrismaClient } from '@prisma/client';

export const WIN_PRICE = 1.03;
export const LOSS_PRICE = 15.0;

/** Minimum in-play elapsed minutes before a batch counts as result evidence. */
export function minElapsedMinutes(sportKey: string): number {
  if (sportKey.startsWith('soccer')) return 70;
  if (sportKey.startsWith('basketball')) return 100;
  if (sportKey.startsWith('icehockey')) return 80;
  if (sportKey.startsWith('tennis')) return 90;
  return 90;
}

export interface OutcomeEvidence {
  /** Median in-play price per outcome in the latest qualifying batch. */
  readonly medianByOutcome: ReadonlyMap<string, number>;
  readonly batchAt: Date;
  readonly elapsedMinutes: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Latest qualifying in-play evidence batch for an event, or null. */
export async function loadInplayEvidence(
  prisma: PrismaClient,
  eventId: string,
  sportKey: string,
  commenceTime: Date,
): Promise<OutcomeEvidence | null> {
  const minElapsedMs = minElapsedMinutes(sportKey) * 60_000;
  const rows = await prisma.historicalOddsSnapshot.findMany({
    where: {
      eventId,
      market: 'h2h',
      snapshotAt: { gte: new Date(commenceTime.getTime() + minElapsedMs) },
    },
    select: { bookmaker: true, outcome: true, price: true, snapshotAt: true },
    orderBy: { snapshotAt: 'desc' },
  });
  if (rows.length === 0) return null;

  const latest = rows[0].snapshotAt.getTime();
  const batch = rows.filter(r => r.snapshotAt.getTime() === latest);
  const pricesByOutcome = new Map<string, number[]>();
  for (const r of batch) {
    const price = r.price.toNumber();
    if (!(price > 1)) continue;
    let arr = pricesByOutcome.get(r.outcome);
    if (!arr) { arr = []; pricesByOutcome.set(r.outcome, arr); }
    arr.push(price);
  }
  if (pricesByOutcome.size === 0) return null;

  const medianByOutcome = new Map<string, number>();
  for (const [outcome, prices] of pricesByOutcome) medianByOutcome.set(outcome, median(prices));
  return {
    medianByOutcome,
    batchAt: new Date(latest),
    elapsedMinutes: Math.round((latest - commenceTime.getTime()) / 60_000),
  };
}

export interface ResultInferenceSummary {
  readonly eventsChecked: number;
  readonly winnersInferred: number;
  readonly alreadyResolved: number;
  readonly unresolved: number;
}

/**
 * Infers and persists event winners for all events of the given sports.
 * Winner = exactly one outcome at WIN evidence in the latest qualifying batch.
 */
export async function inferResults(
  prisma: PrismaClient,
  sportKeys: readonly string[],
  log: (message: string) => void = () => undefined,
): Promise<ResultInferenceSummary> {
  const events = await prisma.historicalEvent.findMany({
    where: { sportKey: { in: sportKeys as string[] } },
    select: { id: true, sportKey: true, commenceTime: true, resultOutcome: true, homeTeam: true, awayTeam: true },
  });

  let winnersInferred = 0;
  let alreadyResolved = 0;
  let unresolved = 0;
  for (const event of events) {
    if (event.resultOutcome) { alreadyResolved++; continue; }
    const evidence = await loadInplayEvidence(prisma, event.id, event.sportKey, event.commenceTime);
    if (!evidence) { unresolved++; continue; }

    const winners = [...evidence.medianByOutcome.entries()].filter(([, p]) => p <= WIN_PRICE);
    if (winners.length !== 1) { unresolved++; continue; }

    await prisma.historicalEvent.update({
      where: { id: event.id },
      data: {
        resultOutcome: winners[0][0],
        resultMethod: 'INPLAY_PRICE',
        resultEvidenceAt: evidence.batchAt,
      },
    });
    winnersInferred++;
    log(`${event.sportKey} ${event.homeTeam} vs ${event.awayTeam} → ${winners[0][0]} (median ${winners[0][1].toFixed(3)} @ +${evidence.elapsedMinutes}min)`);
  }
  return { eventsChecked: events.length, winnersInferred, alreadyResolved, unresolved };
}

export interface RunSettlementSummary {
  readonly rowsTotal: number;
  readonly rowsWon: number;
  readonly rowsLost: number;
  readonly rowsUnresolved: number;
}

/**
 * Settles a run's opportunities against inferred results.
 *
 * ONLY events with a known winner settle — every row of a resolved event then
 * settles symmetrically (WIN if outcome = winner, else LOSS). Rows must NOT be
 * settled from one-sided row-level evidence (e.g. "our outcome drifted to 15"):
 * loss evidence is structurally easier to observe than win evidence, so a
 * mixed rule loss-skews the settled subset and biases ROI downward. The
 * remaining selection effect (resolved events skew toward one-sided matches,
 * which correlates with favourites winning) biases the other way and is
 * documented wherever ROI is reported.
 *
 * Flat 1-unit stake: WIN P&L = odds − 1; LOSS P&L = −1. Label columns only.
 */
export async function settleRun(prisma: PrismaClient, runId: string): Promise<RunSettlementSummary> {
  const opportunities = await prisma.backtestOpportunity.findMany({
    where: { runId, betResult: null },
    select: { id: true, eventId: true, outcome: true, bookmakerOdds: true },
  });

  const eventIds = [...new Set(opportunities.map(o => o.eventId))];
  const events = await prisma.historicalEvent.findMany({
    where: { id: { in: eventIds }, resultOutcome: { not: null } },
    select: { id: true, resultOutcome: true },
  });
  const winnerByEvent = new Map(events.map(e => [e.id, e.resultOutcome as string]));

  let won = 0;
  let lost = 0;
  let unresolved = 0;
  for (const opp of opportunities) {
    const winner = winnerByEvent.get(opp.eventId);
    if (!winner) { unresolved++; continue; }
    const result: 'WIN' | 'LOSS' = winner === opp.outcome ? 'WIN' : 'LOSS';
    const odds = opp.bookmakerOdds.toNumber();
    await prisma.backtestOpportunity.update({
      where: { id: opp.id },
      data: { betResult: result, profitLossUnits: result === 'WIN' ? odds - 1 : -1 },
    });
    if (result === 'WIN') won++;
    else lost++;
  }
  return { rowsTotal: opportunities.length, rowsWon: won, rowsLost: lost, rowsUnresolved: unresolved };
}
