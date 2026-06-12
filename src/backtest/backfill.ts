/**
 * Backfill orchestrator — pulls historical snapshots from The Odds API into the
 * segregated historical_* tables. Offline CLI use only.
 *
 * Safety properties:
 *  - Hard credit budget per invocation (maxCredits) plus a floor on the
 *    account's remaining monthly quota (minRemainingCredits) so a backfill can
 *    never starve the live ingestion pipeline.
 *  - Resumable: a cursor row per (sport, plan) records the last fetched
 *    timestamp; re-runs skip already-fetched timestamps, and row inserts use
 *    skipDuplicates against the snapshot unique key, so re-runs are idempotent.
 *  - Never touches OddsSnapshot / Match / Team — historical identity lives in
 *    The Odds API's own event-id space.
 */
import type { PrismaClient } from '@prisma/client';
import type { HistoricalApiConfig } from './historical-api';
import { fetchHistoricalEvents, fetchHistoricalOdds, historicalOddsCreditCost } from './historical-api';

export interface BackfillPlan {
  readonly planKey: string;
  readonly sportKeys: readonly string[];
  readonly periodStart: string; // ISO
  readonly periodEnd: string;   // ISO
  /** Regions to request, e.g. 'eu,uk'. Each region multiplies credit cost ×10. */
  readonly regions: string;
  /**
   * 'interval': one snapshot every intervalMinutes across the period.
   * 'targeted': per match-day, snapshots at targetedOffsetsHours before each
   *             event's commence time (event lists cost 1 credit/day/sport).
   */
  readonly mode: 'interval' | 'targeted';
  readonly intervalMinutes?: number;
  /** e.g. [24, 6, 1, 0.083] → T−24h, T−6h, T−1h, T−5min (close). */
  readonly targetedOffsetsHours?: readonly number[];
  /** Hard budget for this invocation. The orchestrator stops at the boundary. */
  readonly maxCredits: number;
  /** Stop if the account's remaining monthly quota would drop below this. */
  readonly minRemainingCredits?: number;
  /** Delay between requests (default 300 ms). */
  readonly throttleMs?: number;
}

export interface BackfillSummary {
  readonly requests: number;
  readonly creditsUsed: number;
  readonly snapshotRowsInserted: number;
  readonly eventsUpserted: number;
  readonly stoppedReason: 'completed' | 'budget-exhausted' | 'quota-floor';
}

const DAY_MS = 24 * 3_600_000;
const DEFAULT_MIN_REMAINING = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The Odds API rejects ISO timestamps with milliseconds — format without them. */
function toApiIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

/** 5-minute grid alignment (the API's snapshot resolution since Sept 2022). */
function alignTo5Min(ms: number): number {
  return Math.floor(ms / 300_000) * 300_000;
}

export async function runBackfill(
  prisma: PrismaClient,
  api: HistoricalApiConfig,
  plan: BackfillPlan,
  log: (message: string) => void = () => undefined,
): Promise<BackfillSummary> {
  const startMs = Date.parse(plan.periodStart);
  const endMs = Date.parse(plan.periodEnd);
  const minRemaining = plan.minRemainingCredits ?? DEFAULT_MIN_REMAINING;
  const throttleMs = plan.throttleMs ?? 300;
  const oddsCost = historicalOddsCreditCost(plan.regions);

  let requests = 0;
  let creditsUsed = 0;
  let snapshotRowsInserted = 0;
  let eventsUpserted = 0;
  let stoppedReason: BackfillSummary['stoppedReason'] = 'completed';

  outer:
  for (const sportKey of plan.sportKeys) {
    const cursorId = `${sportKey}|${plan.planKey}`;
    const cursor = await prisma.historicalIngestionCursor.upsert({
      where: { id: cursorId },
      create: { id: cursorId, sportKey, planKey: plan.planKey },
      update: {},
    });
    const resumeAfterMs = cursor.lastTimestamp?.getTime() ?? -Infinity;

    // ── Build the desired timestamp list ──
    let timestamps: number[] = [];
    if (plan.mode === 'interval') {
      const stepMs = (plan.intervalMinutes ?? 360) * 60_000;
      for (let t = startMs; t <= endMs; t += stepMs) timestamps.push(t);
    } else {
      const offsets = plan.targetedOffsetsHours ?? [24, 6, 1, 0.083];
      for (let day = startMs; day < endMs; day += DAY_MS) {
        if (creditsUsed + 1 > plan.maxCredits) { stoppedReason = 'budget-exhausted'; break outer; }
        const events = await fetchHistoricalEvents(api, sportKey, toApiIso(day));
        requests++;
        creditsUsed += events.quota.lastCost ?? 1;
        if (events.quota.remaining !== null && events.quota.remaining < minRemaining) {
          stoppedReason = 'quota-floor';
          break outer;
        }
        for (const event of events.data) {
          const commenceMs = Date.parse(event.commence_time);
          if (commenceMs < day || commenceMs >= day + DAY_MS) continue;
          for (const offsetHours of offsets) {
            const t = alignTo5Min(commenceMs - offsetHours * 3_600_000);
            if (t >= startMs && t <= endMs) timestamps.push(t);
          }
        }
        await sleep(throttleMs);
      }
      timestamps = [...new Set(timestamps)];
    }
    timestamps.sort((a, b) => a - b);
    timestamps = timestamps.filter(t => t > resumeAfterMs);
    log(`${sportKey}: ${timestamps.length} snapshot timestamps planned (resume-after: ${cursor.lastTimestamp?.toISOString() ?? 'none'})`);

    // ── Fetch snapshots ──
    for (const t of timestamps) {
      if (creditsUsed + oddsCost > plan.maxCredits) { stoppedReason = 'budget-exhausted'; break outer; }

      const response = await fetchHistoricalOdds(api, sportKey, toApiIso(t), plan.regions);
      requests++;
      creditsUsed += response.quota.lastCost ?? oddsCost;

      // The API returns the snapshot at-or-before the requested time.
      const actualSnapshotAt = new Date(response.timestamp);

      const eventRows = response.data.map(e => ({
        id: e.id,
        sportKey: e.sport_key,
        commenceTime: new Date(e.commence_time),
        homeTeam: e.home_team,
        awayTeam: e.away_team,
      }));
      if (eventRows.length > 0) {
        const upserted = await prisma.historicalEvent.createMany({ data: eventRows, skipDuplicates: true });
        eventsUpserted += upserted.count;
      }

      const snapshotRows: Array<{
        eventId: string; sportKey: string; bookmaker: string; market: string;
        outcome: string; price: number; snapshotAt: Date;
      }> = [];
      for (const event of response.data) {
        for (const bookmaker of event.bookmakers) {
          for (const market of bookmaker.markets) {
            if (market.key !== 'h2h') continue;
            for (const outcome of market.outcomes) {
              snapshotRows.push({
                eventId: event.id,
                sportKey: event.sport_key,
                bookmaker: bookmaker.key,
                market: 'h2h',
                outcome: outcome.name,
                price: outcome.price,
                snapshotAt: actualSnapshotAt,
              });
            }
          }
        }
      }
      if (snapshotRows.length > 0) {
        const inserted = await prisma.historicalOddsSnapshot.createMany({ data: snapshotRows, skipDuplicates: true });
        snapshotRowsInserted += inserted.count;
      }

      await prisma.historicalIngestionCursor.update({
        where: { id: cursorId },
        data: {
          lastTimestamp: new Date(t),
          requestsUsed: { increment: 1 },
          creditsUsed: { increment: response.quota.lastCost ?? oddsCost },
        },
      });

      log(`${sportKey} @ ${new Date(t).toISOString()} → snapshot ${response.timestamp}: ${snapshotRows.length} rows (credits used ${creditsUsed}/${plan.maxCredits})`);

      if (response.quota.remaining !== null && response.quota.remaining < minRemaining) {
        stoppedReason = 'quota-floor';
        break outer;
      }
      await sleep(throttleMs);
    }
  }

  return { requests, creditsUsed, snapshotRowsInserted, eventsUpserted, stoppedReason };
}
