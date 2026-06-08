# Sports Table Audit

**Date:** 2026-06-08  
**Scope:** Determine whether the `Sport` database table is actively used, authoritative, or stale  

---

## Methodology

Traced every reference to the `Sport` model, `SportRepository`, and `externalSportKey` field across all runtime TypeScript files, the Prisma schema, and all repository implementations.

---

## Findings

### 1. Is the Sports table actively used by runtime code?

**YES — as a foreign-key target.**

| Runtime Path | How Sport is Used |
|---|---|
| `ReferenceDataIngestionService.sync()` | Calls `sportRepository.upsertMany()` to write Sport records from The Odds API sports list |
| `MatchIngestionService.ingestTraditionalSport()` | Calls `sportRepository.upsertMany()` to write Sport records from ingestion plans |
| `MatchIngestionService.ingestEsportsGame()` | Calls `sportRepository.upsertMany()` to write Sport records from PandaScore ingestion plans |
| `SportRepository` (read) | `findId()` queries by `slug` — used by `_resolveSportId()` internally |
| `MatchRepository._resolveSportId()` | Queries `sport.findUnique({ where: { slug } })` to get the UUID for the Match FK |
| `OddsSnapshotWorker` / `ValueDetectionService` | Reads `match.sport.slug` via Prisma includes on OddsSnapshot queries |

The Sport table is **written on every ingestion run** and **queried as a FK target** for Match creation. It is not dead data.

### 2. Is `externalSportKey` read anywhere?

**NO.**

The `externalSportKey` field is:

1. **Written** in `sport.repository.ts` line 44 (during upsert, from `CanonicalSport.externalSportKey`)
2. **Set** in `odds-api-sport.mapper.ts` line 24 to `slugify(raw.group)` — which is identical to `slug`
3. **Set** in the Pandascore mapper (via `PandascoreMatchMapper.toIngestionPlan()`) to the PandaScore game key

But **no runtime code reads `externalSportKey` back** from the database:
- No `SELECT externalSportKey` in any repository method
- No `include: { sport: { select: { externalSportKey: true } } }` in any Prisma query
- No service, worker, or detection algorithm uses it

### 3. Is scheduler configuration sourced from the database or hardcoded?

**Hardcoded — entirely.**

The scheduler configuration lives in `src/lib/app/app.ts` (lines 63-80):

```typescript
const TRADITIONAL_SPORT_CONFIGS: readonly TraditionalSportScheduleConfig[] = [
  { sportKey: 'basketball_nba', sportGroup: 'Basketball', intervalMs: FOUR_HOURS_MS },
  // ... all 16 sports hardcoded
];
```

The database `Sport` table has:
- No `pollingIntervalMs` column
- No `active`/`inactive` scheduling flag that the scheduler reads
- No mechanism to add/remove sports from the schedule without code changes

The `Sport` table and the scheduler are **completely independent** — changing the Sport table content via the `sync-reference-data` job has zero effect on what sports are actually polled.

### 4. Is the Sports table authoritative or stale data?

**PARTIALLY STALE — the table contains records that the scheduler will never use, and the scheduler polls keys that may not exist in the table.**

| Aspect | Status |
|---|---|
| Sport records from scheduled keys | Present — created during ingestion from the polling results themselves |
| Sport records from non-scheduled keys | Present — the `sync-reference-data` job fetches ALL active sports from The Odds API (hundreds of entries), not only the 16 configured ones |
| Polled keys missing from table | Possible on first run — Sport record is created during the first successful `ingestTraditionalSport()` call, not pre-seeded |
| Esports Sport records | Created during `ingestEsportsGame()` — these exist in the table but have no OddsPapi correlation mapping |

**Data quality issues:**
1. `externalSportKey` always equals `slug` for The Odds API sources (both derived from `slugify(group)`) — making the field redundant
2. Hundreds of Sport records exist for competitions that will never be polled (all non-configured sports from the API)
3. No field links a Sport record to its scheduler configuration (no `pollingIntervalMs`, no `schedulerEnabled` flag)
4. The `status` field exists (`ACTIVE` / `DEPRECATED`) but no code uses `SportStatus` to control scheduling

### 5. Recommendations

#### Short-term (cleanup):
- Remove the `externalSportKey` column from the schema — it stores the same value as `slug` for The Odds API sources and is never read by runtime code. If a future use case requires storing a different API key per source, it can be added back with a clear purpose.

#### Medium-term (improvement):
- Add `pollingIntervalMs` and `schedulerEnabled` columns to the `Sport` model so that the scheduler can read its configuration from the database instead of hardcoded code
- This would allow operators to enable/disable sports and change polling frequencies without code deployments
- The `sync-reference-data` job already handles upsert — it would just need to write the scheduling fields

#### Long-term (architecture):
- If the scheduler moves to database-driven configuration, the `externalSportKey` field could be repurposed to store the actual The Odds API sport key (e.g. `"basketball_nba"`) rather than the redundant `slugify(group)` value

---

## Summary

| Question | Answer |
|---|---|
| Sport table actively used? | ✅ YES — as FK target for Match + Team + League |
| `externalSportKey` read by runtime? | ❌ NO — written but never read |
| Scheduler sourced from DB? | ❌ NO — fully hardcoded in `app.ts` |
| Table authoritative for scheduling? | ❌ NO — scheduler ignores the table entirely |
| Table contains stale/unused records? | ✅ YES — hundreds of non-configured sports |
| `externalSportKey` redundant? | ✅ YES — equals `slug` for all The Odds API sources |