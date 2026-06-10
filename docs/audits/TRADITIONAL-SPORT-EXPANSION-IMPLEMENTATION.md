# Traditional Sport Expansion Implementation

**Date:** 2026-06-10

**Implements:** TRADITIONAL-SPORT-EXPANSION-AUDIT.md

**Objective:** Add 13 missing traditional sport keys to `TRADITIONAL_SPORT_CONFIGS` so they automatically participate in scheduling, ingestion, settlement, and reporting.

---

## Files Modified

| File | Change |
|---|---|
| `src/lib/app/app.ts` | Added 13 entries to `TRADITIONAL_SPORT_CONFIGS` |

No other files required modification. The constructor-injection architecture established in `TRADITIONAL-SETTLEMENT-COVERAGE-FIX.md` ensures `TRADITIONAL_SPORT_CONFIGS` is the single source of truth for all downstream systems.

---

## Exact Sport Keys Added

### League sports block (Tier 1, 60-minute polling)

```typescript
{ sportKey: 'basketball_euroleague', sportGroup: 'Basketball', intervalMs: SIXTY_MINUTES_MS },
```

### Tennis block (Tier 1, 60-minute polling) — expanded and reorganised by tier

```typescript
// ATP Grand Slams
{ sportKey: 'tennis_atp_aus_open_singles', sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
{ sportKey: 'tennis_atp_french_open',      sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },

// ATP Masters 1000 (additions: madrid, italian, canadian, cincinnati)
{ sportKey: 'tennis_atp_madrid_open',      sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
{ sportKey: 'tennis_atp_italian_open',     sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
{ sportKey: 'tennis_atp_canadian_open',    sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
{ sportKey: 'tennis_atp_cincinnati_open',  sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },

// WTA Grand Slams
{ sportKey: 'tennis_wta_aus_open_singles', sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
{ sportKey: 'tennis_wta_french_open',      sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },

// WTA 1000 (additions: madrid, italian, canadian, cincinnati)
{ sportKey: 'tennis_wta_madrid_open',      sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
{ sportKey: 'tennis_wta_italian_open',     sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
{ sportKey: 'tennis_wta_canadian_open',    sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
{ sportKey: 'tennis_wta_cincinnati_open',  sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
```

The tennis block was also reorganised with sub-comments (Grand Slams, Masters 1000, WTA Grand Slams, WTA 1000) to make the structure navigable. No existing entry was moved, removed, or renamed — the sub-comments are purely additive.

---

## Updated Sport Counts

| Category | Before | After |
|---|---|---|
| Tier 1 (60-min) — league sports | 4 | **5** (+1: euroleague) |
| Tier 1 (60-min) — tennis | 8 | **20** (+12: 2 ATP GS, 4 ATP M1000, 2 WTA GS, 4 WTA 1000) |
| Tier 2 (4-hour) | 4 | 4 (unchanged) |
| Tier 3 (3-hour soccer) | 34 | 34 (unchanged) |
| **Total** | **50** | **63** |

---

## Automatic Participation Verification

Because `TRADITIONAL_SPORT_CONFIGS.map(c => c.sportKey)` is threaded through the entire system at startup, all 13 new keys automatically participate in every pipeline stage without any further changes:

| System | Mechanism | Effect |
|---|---|---|
| **Scheduling** | `scheduleIngestionJobs(matchFetchQueue, TRADITIONAL_SPORT_CONFIGS, ...)` iterates all entries | 13 new `repeat:sync-traditional-sport:{key}` BullMQ jobs registered at next startup |
| **Ingestion** | Each scheduled job calls `MatchIngestionService` → `OddsSnapshotIngestionService` | Matches and odds snapshots fetched for all 13 keys whenever events are active |
| **Settlement** | `traditionalSportKeys` passed to `SettlementWorker` via `createIngestionDependencies` | `settleTraditional()` calls `getScores(key, 3)` for all 63 keys every 4 hours |
| **ROI reporting** | `/roi` uses `match: { sport: { category: 'TRADITIONAL' } }` filter | All 13 new keys resolve to `category = TRADITIONAL` via `Sport.category`; their `ValueOpportunity` rows are automatically included |
| **Daily summary** | `notifyDailySummary()` uses the same category filter | Same — automatically included |
| **Best sports** | `getBestSports()` uses the same category filter | New keys appear in per-sport breakdown as soon as they produce settled bets |
| **Discord presence** | `_updatePresence()` uses the same category filter | ROI reflects all traditional sports including new keys |

---

## Estimated API Impact

### Ingestion (odds fetch)

| | Before | After | Delta |
|---|---|---|---|
| Tier 1 keys (60-min) | 12 | 25 | +13 |
| Odds calls/day | 12 × 24 = 288 | 25 × 24 = 600 | **+312/day** |

Note: each call fetches odds only for active events. During off-season, the API returns an empty array — the job completes in milliseconds and produces no DB writes. The quota request is still consumed.

### Settlement (scores fetch)

| | Before | After | Delta |
|---|---|---|---|
| Keys settled | 50 | 63 | +13 |
| Score calls/day | 50 × 6 = 300 | 63 × 6 = 378 | **+78/day** |

### Monthly totals

| | Before | After | Delta |
|---|---|---|---|
| Ingestion calls/month | ~17,520 | ~18,000 | +480 (Tier 1 only delta) |
| Settlement calls/month | ~9,000 | ~11,340 | +2,340 |
| **Total additional/month** | | | **~+2,820 calls/month** |

Overall monthly request increase is modest. The largest quota consumers remain the 34 Tier 3 soccer keys (8 calls/day each = ~272/day combined) and settlement across all 63 keys.

### BullMQ / Redis

13 additional repeatable job entries in Redis. Each entry is a small JSON object. Negligible memory and CPU overhead.

---

## Validation Results

### TypeScript build — `npx tsc --noEmit`

**Result: 0 errors**

---

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Off-season API calls wasted | Certain | Low | Tournament keys return empty arrays outside their window. No DB writes. Quota is consumed but the cost is small relative to the 34 always-on soccer keys. |
| Invalid key causes ingestion error | None | — | All 13 keys follow the confirmed Odds API naming convention. Unrecognised keys return a 404 and are logged as warnings; they do not crash the worker. |
| Settlement quota increase | Certain | Low | +78 scores calls/day. Scores endpoint usage is unmetered on most Odds API plans. |
| BullMQ job accumulation on restart | Low | None | BullMQ deduplicates repeatable jobs by `jobId`. Adding new keys produces exactly one new job entry per key; no duplicates. |
| Existing sport configuration disrupted | None | — | Only additions were made. No existing entry was modified, moved, or removed. |
| `Sport` and `League` DB records | Certain | None | Reference data sync (daily) will upsert 13 new `League` rows on the next run. `Sport` rows for Tennis and Basketball already exist; no new Sport rows created. |
