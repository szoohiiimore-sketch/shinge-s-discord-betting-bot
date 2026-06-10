# Esports Disable Impact Audit

**Date:** 2026-06-10

**Prerequisites:** TRADITIONAL-ONLY-REPORTING-FILTER.md has been implemented. ROI, Paper Bankroll, Best Sports, Daily Summary, and Discord Presence already exclude esports via `match: { sport: { category: 'TRADITIONAL' } }`.

**Objective:** Determine the safest way to completely disable esports functionality while preserving all historical records.

---

## 1. Current Esports Data State

| Metric | Value |
|---|---|
| `ValueOpportunity` rows — esports total | 10 |
| `ValueOpportunity` rows — esports settled | 10 (all) |
| `ValueOpportunity` rows — with duplicated `consensusBookmakers` | 8 |
| `ValueOpportunity` rows — confirmed false positives (1 real bookmaker) | 4 |
| `OddsSnapshot` rows — esports-sourced (estimated, H2H with 2–4 bookmakers) | ~200 |

### Reporting surfaces — already excluded?

| Surface | Esports excluded? |
|---|---|
| `/roi` | ✅ Yes — `match.sport.category = TRADITIONAL` filter |
| `/paper-bankroll` | ✅ Yes — same filter |
| `/best-sports` | ✅ Yes — same filter |
| Daily summary (23:00) | ✅ Yes — same filter |
| Discord presence | ✅ Yes — same filter |
| **Discord value bet alerts** | ❌ **No — `notifyPendingOpportunities()` has no sport filter** |
| **Settlement outcome notifications** | ❌ **No — `notifySettledOutcomes()` forwards all from `settleEsports()`** |

**Critical gap:** The reporting layer is clean, but the alert layer is not. Any new esports `ValueOpportunity` created by the still-running pipeline will be sent to the Discord alerts channel as live value bet alerts. This is user-visible and operates independently of the reporting filter.

---

## 2. All Remaining Active Esports Code Paths

### 2.1 Scheduler — `src/ingestion/bootstrap/ingestion-scheduler.ts`

```
ESPORTS_VIDEOGAMES = ['cs2', 'valorant', 'lol', 'dota2']
```

Four repeatable BullMQ jobs registered at application startup, one per videogame:

```
job name : sync-esports-game
schedule : cron 0 12,17 * * * (Europe/Budapest)
frequency: 2 runs/day × 4 games = 8 jobs/day
```

Each fires triggers the `MatchIngestionWorker` via `SYNC_ESPORTS_GAME` job name dispatch.

### 2.2 Match Ingestion — `src/ingestion/workers/match-ingestion.worker.ts`

When a `sync-esports-game` job fires:

1. Calls `MatchIngestionService` to fetch upcoming/running esports matches from PandaScore.
2. Upserts `Match` records tagged with `sport.category = ESPORTS`.
3. Enqueues a `sync-esports-odds` job to the `odds-fetch` queue for each match batch.

**PandaScore API usage:** ~8 calls/day for match ingestion.

### 2.3 Esports Odds Ingestion — `src/ingestion/services/esports-odds-ingestion.service.ts` + `src/ingestion/workers/esports-odds-snapshot.worker.ts`

When a `sync-esports-odds` job fires:

1. Loads DB matches by PandaScore external IDs.
2. Calls `OddspapiClient.getOddsForGame()` — one OddsPapi quota call per videogame.
3. Correlates OddsPapi fixtures to DB matches by team name + time proximity.
4. Inserts `OddsSnapshot` rows (no deduplication — the confirmed duplication bug runs here).
5. Triggers `ValueDetectionService.detectForMatchExternalIds()`.
6. Triggers `DiscordNotificationService.notifyPendingOpportunities()`.

**OddsPapi API usage:** 4 games × 2 runs/day = 8 calls/day ≈ 240/month. Free-tier limit is 10,000/month. Usage is negligible relative to the quota but still non-zero.

**Database growth:** Each run inserts OddsSnapshot rows. Because of the fixture collision bug, each match typically generates 2× the expected snapshots. A conservative estimate is 20–40 new OddsSnapshot rows per run.

### 2.4 Value Detection (triggered by 2.3)

`ValueDetectionService.detectForMatchExternalIds()` is called immediately after esports odds ingestion. It:

1. Queries all H2H non-live snapshots for the given match IDs (no deduplication — known bug).
2. Computes fair odds and edge.
3. Inserts new `ValueOpportunity` records when edge > threshold and odds within limits.

New esports opportunities are created here and immediately enter the alert pipeline.

### 2.5 Discord Value Bet Alerts — `src/discord/discord-notification.service.ts:notifyPendingOpportunities`

```typescript
where: { alertedAt: null }   // no sport filter
```

No filter. Sends a Discord alert message for every `ValueOpportunity` with `alertedAt = null`. This is called immediately after esports odds ingestion (see 2.3) and also after every traditional odds ingestion cycle. All newly created esports opportunities are alerted here, including false positives with edge values up to 262%.

### 2.6 Settlement — `src/settlement/settlement.worker.ts`

`SettlementWorker.process()` runs every 4 hours and calls both:

```typescript
await this._service.settleTraditional(this._traditionalSportKeys);
await this._service.settleEsports(ESPORTS_VIDEOGAMES);
```

`settleEsports()` in `src/settlement/settlement.service.ts`:

1. Calls `PandascoreClient.getPastMatches()` for each of `['cs2', 'valorant', 'lol', 'dota2']`.
2. Updates `Match` records to `FINISHED`.
3. Calls `_settleUnsettled()` which settles all unsettled `ValueOpportunity` rows on finished matches.

**PandaScore API usage:** 4 games × 6 settlement cycles/day = 24 calls/day for settlement alone.

### 2.7 Settlement Outcome Notifications

`SettlementWorker` collects `esportsNewlySettled` from `settleEsports()` and passes it to:

```typescript
await this._notificationService.notifySettledOutcomes(allNewlySettled);
```

No filter. Esports settlement outcome messages (WIN/LOSS/VOID) are sent to the outcomes Discord channel.

### 2.8 Discord `/force-ingestion esports` Command

`src/discord/discord-bot.service.ts` registers a `force-ingestion` slash command with a `source` option that accepts `'esports'` or `'all'`. Admin users can manually trigger esports ingestion from Discord. This path enqueues jobs and ultimately follows the same path as 2.2–2.5.

### 2.9 Instantiated but currently idle integrations

Both API clients are instantiated unconditionally in `createIngestionDependencies`:

- `pandascoreClient` — used by `MatchIngestionService` and `SettlementService`
- `oddspapiClient` — used by `EsportsOddsSnapshotIngestionService`

The OddsPapi client holds a Redis-backed quota counter. Even with zero calls, the Redis key persists and the counter is read on each call attempt.

---

## 3. Option Comparison

### Option A — Leave esports active, keep reporting filters (current state)

**What it does:** No code changes. The reporting filter from `TRADITIONAL-ONLY-REPORTING-FILTER.md` is the only protection.

| Dimension | Impact |
|---|---|
| API usage (OddsPapi) | 240 calls/month — within free tier, but consuming quota for data we discard |
| API usage (PandaScore) | ~32 calls/day (~960/month) — match ingestion + settlement |
| Redis usage | OddsPapi quota counter increments; BullMQ queues accumulate 8 esports job entries/day |
| Database growth | ~40 OddsSnapshot rows/run × 8 runs/day = ~320 rows/day; new ValueOpportunity rows every time esports odds produce an edge above threshold |
| Discord alerts (value bets) | **Esports alerts still fire** — false positives with 262% edge will appear in the alerts channel |
| Discord alerts (settlement outcomes) | **Esports settlement outcomes still fire** — WIN/LOSS notifications for esports matches |
| Historical auditing | Full history preserved |
| Rollback | N/A — no change to revert |

**Assessment:** Not recommended. The alert channel is still polluted with corrupted esports signals. The data quality problem is hidden from reporting but visible operationally.

---

### Option B — Disable all esports ingestion and alerts, preserve historical records

**What it does:** Stops esports scheduled jobs, suppresses esports alerts, removes esports settlement. No data is deleted. All historical records remain intact and queryable.

| Dimension | Impact |
|---|---|
| API usage (OddsPapi) | **0 calls** — scheduler no longer enqueues `sync-esports-odds` jobs |
| API usage (PandaScore) | **Reduced** — match ingestion calls drop to 0; settlement calls drop to 0 |
| Redis usage | BullMQ esports repeatable jobs removed from scheduler on next startup; OddsPapi quota counter no longer incremented |
| Database growth | OddsSnapshot and ValueOpportunity tables stop growing from esports |
| Discord alerts (value bets) | **Esports alerts suppressed** — `notifyPendingOpportunities` gains sport filter |
| Discord alerts (settlement outcomes) | **Esports settlement notifications suppressed** — `settleEsports()` call removed from `SettlementWorker` |
| Historical auditing | All existing esports records remain intact and queryable via `/value-bets sport:valorant` or direct DB query |
| Rollback | Remove the three changes to re-enable esports |

**Implementation — three files, minimal changes:**

| File | Change |
|---|---|
| `src/ingestion/bootstrap/ingestion-scheduler.ts` | Remove or skip the `ESPORTS_VIDEOGAMES` loop — stops scheduling `sync-esports-game` jobs |
| `src/settlement/settlement.worker.ts` | Remove the `settleEsports()` call block — stops esports settlement and its outcome notifications |
| `src/discord/discord-notification.service.ts` | Add `match: { sport: { category: 'TRADITIONAL' } }` to `notifyPendingOpportunities()` query — suppresses esports Discord alerts |

No schema changes. No data changes. No changes to settlement logic for traditional sports. No changes to value detection.

**Assessment: Recommended.**

---

### Option C — Delete historical esports records

**What it does:** Issues `DELETE` statements against `ValueOpportunity`, `OddsSnapshot`, `Match`, `Team`, and `League` rows for esports. Removes all historical evidence.

| Dimension | Impact |
|---|---|
| API usage | Same as Option B (must also implement Option B to stop new ingestion) |
| Database growth | Same as Option B |
| Discord alerts | Same as Option B |
| Historical auditing | **Impossible** — evidence of duplication bug, false positive alerts, and corrupted edge values is permanently destroyed |
| Rollback | **Impossible** — data cannot be recovered without a backup restore |

**Assessment: Not recommended.** Violates the explicit constraint ("DO NOT delete historical records"). Eliminates the audit trail needed to understand V1 performance. Cascade deletes would also remove `Match` and related data which may be referenced by other records.

---

## 4. Impact Summary Matrix

| Dimension | Option A (current) | Option B (recommended) | Option C (prohibited) |
|---|---|---|---|
| Esports in ROI | ❌ Excluded (filter) | ❌ Excluded (filter) | N/A |
| Esports in Paper Bankroll | ❌ Excluded (filter) | ❌ Excluded (filter) | N/A |
| Esports in Best Sports | ❌ Excluded (filter) | ❌ Excluded (filter) | N/A |
| Esports in Daily Summary | ❌ Excluded (filter) | ❌ Excluded (filter) | N/A |
| Esports in Discord Presence | ❌ Excluded (filter) | ❌ Excluded (filter) | N/A |
| Esports value bet alerts | **✅ Still firing** | ❌ Suppressed | ❌ Suppressed |
| Esports settlement notifications | **✅ Still firing** | ❌ Suppressed | ❌ Suppressed |
| OddsPapi calls | **~240/month** | 0 | 0 |
| PandaScore calls (esports) | **~960/month** | 0 | 0 |
| DB rows growing | **Yes** | No | N/A |
| Historical records preserved | Yes | **Yes** | No |
| Rollback capability | N/A | Easy (3 file changes) | Impossible |
| Implementation size | 0 changes | 3 file changes | Migration + data ops |

---

## 5. Recommendation

**Option B: Disable all esports ingestion and alerts. Preserve all historical records.**

The reporting layer is already clean. The remaining user-visible problems under Option A are:

1. **Value bet alert channel receives corrupted esports signals.** False positives with edge values of 17%–262% continue to fire. These are not filtered by the reporting layer.
2. **Settlement outcome channel receives esports WIN/LOSS notifications.** These are unrelated to any traditional-sports ROI evaluation.
3. **OddsPapi and PandaScore API quota is consumed** for data that is immediately discarded from reporting.
4. **The database continues to grow** with esports OddsSnapshot rows that compound the confirmed duplication issue.

Option B resolves all four with three narrowly scoped file changes and zero data operations. The esports historical record remains fully intact for auditing purposes, and the entire pipeline can be re-enabled by reverting those three changes when the consensus deduplication bug is fixed and esports data quality is clean.

---

## 6. Residual Items After Option B

These items remain but are not user-visible and do not require immediate action:

| Item | Notes |
|---|---|
| `EsportsOddsSnapshotWorker` instantiated | Class exists in memory at runtime; zero jobs dispatched to it |
| `EsportsOddsSnapshotIngestionService` instantiated | Same — class exists, never called |
| `oddspapiClient` instantiated | Client object created; zero API calls made |
| `pandascoreClient` instantiated | Still used by traditional settlement (`SettlementService` constructor) — cannot be removed without refactor |
| `/force-ingestion esports` command | Still registered; admin-only; manually triggered only; no automatic execution |
| BullMQ `sync-esports-game` repeatable jobs | Removed from queue on first application restart after Option B implementation |
| `ESPORTS_VIDEOGAMES` constant in `settlement.worker.ts` | Unused constant after `settleEsports()` removal; can be cleaned up in a follow-on refactor |
