# Esports Disable Implementation

**Date:** 2026-06-10

**Implements:** ESPORTS-DISABLE-IMPACT-AUDIT.md — Option B

**Objective:** Disable all automatic esports functionality (ingestion, settlement, Discord alerts) while preserving all historical records intact.

---

## Files Modified

| File | Change |
|---|---|
| `src/ingestion/bootstrap/ingestion-scheduler.ts` | Removed esports scheduling loop; removed unused `SyncEsportsGameJobData` import |
| `src/settlement/settlement.worker.ts` | Removed `settleEsports()` execution block; removed unused `ESPORTS_VIDEOGAMES` constant and `EsportsVideogame` import |
| `src/discord/discord-notification.service.ts` | Added `match: { sport: { category: 'TRADITIONAL' } }` filter to `notifyPendingOpportunities()` |

---

## Exact Changes

### 1. `src/ingestion/bootstrap/ingestion-scheduler.ts`

**Import removed:**
```typescript
// Before
import type { SyncTraditionalSportJobData, SyncEsportsGameJobData, SettleMatchesJobData, DailySummaryJobData } from '@/ingestion/contracts';

// After
import type { SyncTraditionalSportJobData, SettleMatchesJobData, DailySummaryJobData } from '@/ingestion/contracts';
```

**Scheduling loop replaced:**
```typescript
// Before — scheduled 8 jobs/day
for (const videogame of ESPORTS_VIDEOGAMES) {
  const data: SyncEsportsGameJobData = { videogame };
  await matchFetchQueue.add(
    MATCH_FETCH_JOB_NAMES.SYNC_ESPORTS_GAME,
    data,
    {
      repeat: { pattern: '0 12,17 * * *', tz: 'Europe/Budapest' },
      jobId: `repeat:sync-esports-game:${videogame}`,
    },
  );
  schedLogger.debug({ videogame }, 'Registered sync-esports-game (12:00 + 17:00 Budapest)');
}

// After — disabled, with rollback instructions preserved in comment
// Esports videogames — DISABLED (V1)
// Esports ingestion is disabled pending resolution of the OddsPapi fixture
// correlation collision bug (see ESPORTS-DISABLE-IMPACT-AUDIT.md).
schedLogger.info('Esports ingestion disabled — no sync-esports-game jobs registered');
```

---

### 2. `src/settlement/settlement.worker.ts`

**Constant and import removed:**
```typescript
// Before
import type { EsportsVideogame } from '@/ingestion/contracts';
import type { SettledOpportunityNotification } from './settlement.types';

const ESPORTS_VIDEOGAMES: readonly EsportsVideogame[] = ['cs2', 'valorant', 'lol', 'dota2'];

// After
import type { SettledOpportunityNotification } from './settlement.types';
```

**Settlement block removed:**
```typescript
// Before — ran every 4 hours, called PandaScore, sent settlement notifications
try {
  const esportsResult = await this._service.settleEsports(ESPORTS_VIDEOGAMES);
  this._logger.info(
    { matchesUpdated: esportsResult.matchesUpdated, settled: esportsResult.opportunitiesSettled },
    'Esports settlement complete',
  );
  esportsNewlySettled = esportsResult.newlySettled;
} catch (err) {
  this._logger.error({ err: (err as Error).message }, 'Esports settlement failed');
}

// After — disabled, with rollback instructions preserved in comment
// Esports settlement disabled (V1) — see ESPORTS-DISABLE-IMPACT-AUDIT.md.
// To re-enable, restore: await this._service.settleEsports(ESPORTS_VIDEOGAMES)
```

---

### 3. `src/discord/discord-notification.service.ts`

**Alert query filter added:**
```typescript
// Before — queried all pending opportunities regardless of sport
where: { alertedAt: null },

// After — restricts to traditional sport opportunities only
where: { alertedAt: null, match: { sport: { category: 'TRADITIONAL' as const } } },
```

---

## Before / After Behavior

### Scheduler

| Before | After |
|---|---|
| 4 `sync-esports-game` repeatable jobs registered at startup (12:00 + 17:00 Budapest) | No esports jobs registered |
| 8 esports match-fetch runs/day | 0 |
| 8 `sync-esports-odds` jobs enqueued/day | 0 |

Traditional sport jobs (`sync-traditional-sport`, `sync-reference-data`, `settle-matches`, `daily-summary`) are unchanged.

### Settlement (every 4 hours)

| Before | After |
|---|---|
| `settleTraditional()` called | `settleTraditional()` called — unchanged |
| `settleEsports()` called (4 PandaScore calls per cycle) | Not called |
| Esports settlement outcome notifications sent to Discord | Not sent |
| Traditional settlement outcome notifications sent to Discord | Unchanged |

### Discord Alerts

| Before | After |
|---|---|
| All `ValueOpportunity` rows with `alertedAt = null` alerted, including esports | Only `TRADITIONAL` sport opportunities alerted |
| Corrupted esports alerts (e.g. 262% edge) sent to alerts channel | Not sent |
| Any future esports opportunities (if pipeline re-enabled) would be alerted | Not alerted |

### Data

No rows modified, deleted, or archived. All 10 historical esports `ValueOpportunity` records, their `OddsSnapshot` rows, `Match` records, `Team` records, and `League` records remain fully intact.

Existing esports `ValueOpportunity` rows with `alertedAt = null` (if any remain) will no longer be sent as alerts. Their `alertedAt` field remains `null` — they are not marked as alerted, just silently skipped by the query filter.

---

## APIs No Longer Called

| API | Endpoint | Previous frequency | After |
|---|---|---|---|
| OddsPapi | `GET /odds/{game}` | 8 calls/day (~240/month) | 0 |
| PandaScore | `GET /{game}/matches/upcoming` | 8 calls/day via match ingestion | 0 |
| PandaScore | `GET /{game}/matches/past` | 24 calls/day via settlement (4 games × 6 cycles) | 0 |

The Odds API (traditional ingestion and settlement) is unaffected.

---

## Queues No Longer Executed

| Queue | Job name | Previous frequency | After |
|---|---|---|---|
| `match-fetch` | `sync-esports-game` | 8/day (4 games × 2 cron fires) | 0 |
| `odds-fetch` | `sync-esports-odds` | 8/day (enqueued by match ingestion) | 0 |

Traditional jobs (`sync-traditional-sport`, `sync-reference-data`, `settle-matches`, `daily-summary`, `sync-odds-for-sport`) are unaffected.

**Note:** The `EsportsOddsSnapshotWorker` and `EsportsOddsSnapshotIngestionService` remain instantiated in `createIngestionDependencies` and the odds-fetch processor still has a `sync-esports-odds` case. These are dormant dead code — no jobs are ever dispatched to them. The `/force-ingestion esports` Discord command also remains available but is admin-manual-only and not automatically triggered.

---

## Rollback Procedure

To fully re-enable esports (three file changes):

**1. `src/ingestion/bootstrap/ingestion-scheduler.ts`**

Restore the `SyncEsportsGameJobData` import and replace the disabled comment block with:
```typescript
for (const videogame of ESPORTS_VIDEOGAMES) {
  const data: SyncEsportsGameJobData = { videogame };
  await matchFetchQueue.add(
    MATCH_FETCH_JOB_NAMES.SYNC_ESPORTS_GAME,
    data,
    {
      repeat: { pattern: '0 12,17 * * *', tz: 'Europe/Budapest' },
      jobId: `repeat:sync-esports-game:${videogame}`,
    },
  );
}
```

**2. `src/settlement/settlement.worker.ts`**

Restore the `EsportsVideogame` import, the `ESPORTS_VIDEOGAMES` constant, and the `settleEsports()` block:
```typescript
import type { EsportsVideogame } from '@/ingestion/contracts';

const ESPORTS_VIDEOGAMES: readonly EsportsVideogame[] = ['cs2', 'valorant', 'lol', 'dota2'];

// inside process():
try {
  const esportsResult = await this._service.settleEsports(ESPORTS_VIDEOGAMES);
  esportsNewlySettled = esportsResult.newlySettled;
} catch (err) {
  this._logger.error({ err: (err as Error).message }, 'Esports settlement failed');
}
```

**3. `src/discord/discord-notification.service.ts`**

Revert the `notifyPendingOpportunities` query:
```typescript
where: { alertedAt: null },
```

Before re-enabling, the consensus bookmaker deduplication fix (documented in `CONSENSUS-DUPLICATION-EVIDENCE-AUDIT.md`) should be applied to `ValueDetectionService` to prevent new corrupted opportunities from being created.

---

## Validation Results

### TypeScript build — `npx tsc --noEmit`

**Result: 0 errors**

---

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Traditional sports ingestion disrupted | None | — | Traditional scheduler loop unchanged; no shared state with esports loop |
| Traditional settlement disrupted | None | — | `settleTraditional()` call unchanged; esports block was sequentially after it |
| Discord traditional alerts disrupted | None | — | Filter is additive; traditional opportunities still pass `category = TRADITIONAL` |
| Existing unsettled esports opportunities never settle | Low | Low | All 10 historical esports opportunities are already settled. Any future unsettled esports row (created by `/force-ingestion esports`) will not settle automatically, but no such rows exist |
| Esports historical data lost | None | — | Zero data operations performed |
| OddsPapi quota permanently wasted | None | — | 0 calls; quota preserved for future use |
| BullMQ queue has stale repeatable job entries | Low | Low | Repeatable jobs registered in prior deployments will be removed from Redis on the next application restart (BullMQ deduplication by `jobId`) |
