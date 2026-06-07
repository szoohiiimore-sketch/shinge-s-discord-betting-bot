# Sprint 4 — End-to-End Ingestion Architecture Audit

**Date:** 2026-06-06
**Auditor:** Claude Sonnet 4.6
**Scope:** `src/ingestion/` (contracts, mappers, repositories, services, workers, queues, bootstrap)
**Integration verification:** `src/integrations/the-odds-api/`, `src/integrations/pandascore/`
**Schema verification:** `prisma/schema.prisma`
**Architecture reference:** `docs/designs/SPRINT4-INGESTION-ARCHITECTURE.md`

**Prior audits read:**
- `docs/audits/SPRINT4-PHASE1E-AUDIT.md`
- `docs/audits/SPRINT4-PHASE1E-REMEDIATION.md`
- `docs/audits/SPRINT4-PHASE2A-REVIEW.md`

---

## Executive Summary

**Architecture Score: 72/100**
**Implementation Score: 61/100**

The ingestion system has a well-designed contract layer, clean dependency injection, and sound service-level orchestration. Three critical failures prevent the system from functioning correctly in production:

1. The `sync-odds-for-sport` job is never enqueued after match ingestion — the odds pipeline is completely disconnected.
2. Sport slugs are computed incorrectly in both workers, causing phantom Sport records and broken FK chains.
3. `TeamLeagueRepository` is vulnerable to P2002 constraint races on every normal sync run due to undeduped batch entries and a surviving find-then-create pattern.

In addition, four major gaps exist: PandaScore pagination is unimplemented, Odds API quota pre-checks are absent, no repeatable job scheduling is registered at startup, and the `MatchFetchJobPayload` type models the wrong BullMQ data shape.

With three Critical findings and four Major findings, the system cannot enter production as-is.

---

## Findings

---

### F-01 — Critical: `sync-odds-for-sport` job is never enqueued after match ingestion

**File:** `src/ingestion/workers/match-ingestion.worker.ts:80–93` (`_handleTraditionalSport`)
**Also:** `src/ingestion/bootstrap/ingestion-dependencies.ts:44–48` (`_redis` parameter)

**Problem:**

`MatchIngestionService.ingestTraditionalSport` returns `nearTermMatchExternalIds` — the "oa:"-prefixed match IDs for matches within the 48-hour window — specifically so the worker can enqueue a `sync-odds-for-sport` job. The worker receives this result but never uses `nearTermMatchExternalIds`:

```typescript
// match-ingestion.worker.ts:80–93
const result = await this._service.ingestTraditionalSport(sportKey, sport);

return {
  sportKey,
  ...
  oddsSnapshots: { created: 0, updated: 0, skipped: 0 }, // always hardcoded to zero
  ...
};
// nearTermMatchExternalIds is discarded
```

`MatchIngestionWorker` has no reference to any BullMQ Queue instance. It cannot enqueue jobs. `createIngestionDependencies` accepts a `_redis: Redis` parameter (underscore-prefixed, intentionally unused) but never creates an odds-fetch queue or passes it to the worker. The `bootstrapIngestion` function returns only processor functions — no queue instances are created within the ingestion module.

**Impact:**

The odds ingestion pipeline is permanently disconnected. `OddsSnapshotIngestionService` and `OddsSnapshotWorker` are implemented but can only be triggered by manually adding a `sync-odds-for-sport` job to the queue. No `OddsSnapshot` records will be written during normal automated operation. The Tier 2 polling cycle (every 15 min, filtered odds) described in architecture §4.2 cannot occur. The entire odds arm of the system is dead.

**Recommendation:**

Pass a BullMQ `Queue` instance for the odds-fetch queue into `MatchIngestionWorker` (either directly or via a thin queue facade). After `ingestTraditionalSport` returns, if `nearTermMatchExternalIds.length > 0`, enqueue:

```typescript
await this._oddsFetchQueue.add(
  'sync-odds-for-sport',
  { sportKey, matchExternalIds: result.nearTermMatchExternalIds },
  { delay: 5000 }, // 5s delay per architecture §5.5
);
```

Wire the odds-fetch `Queue` in `createIngestionDependencies` using the `redis` parameter (remove the underscore prefix).

---

### F-02 — Critical: Wrong sport slug derivation in `MatchIngestionWorker` and `OddsSnapshotWorker`

**File:** `src/ingestion/workers/match-ingestion.worker.ts:70–76`
**Also:** `src/ingestion/workers/odds-snapshot.worker.ts:57–63`

**Problem:**

Both workers reconstruct a `CanonicalSport` from the job payload's `sportKey` field:

```typescript
// match-ingestion.worker.ts:70–76 and odds-snapshot.worker.ts:57–63
const sport: CanonicalSport = {
  slug: slugify(sportKey),          // e.g. "soccer-epl" — WRONG
  name: sportKey,                   // e.g. "soccer_epl" — WRONG
  category: 'TRADITIONAL',
  externalApiSource: 'THE_ODDS_API',
  externalSportKey: slugify(sportKey),
};
```

The architecture design §2.2 specifies that `Sport.slug` must be derived from `sport.group` (e.g., `slugify("Soccer")` = `"soccer"`), not from the sport key. `OddsApiSportMapper.toCanonicalSport` correctly uses `slugify(raw.group)`. The workers use `slugify(sportKey)` (e.g., `slugify("soccer_epl")` = `"soccer-epl"`).

The job payload `SyncTraditionalSportJobData` carries only `{ sportKey: string }`. The sport group (e.g., `"Soccer"`) is not present in the payload and cannot be recovered from `sportKey` alone.

**Impact:**

When `MatchIngestionService.ingestTraditionalSport` runs, it upserts a Sport entity using the mapper-produced `CanonicalSport`. The mapper (`OddsApiEventMapper`) uses `this._sport` — the incorrectly constructed sport injected at call time. Each sport key creates a phantom Sport record:

| Job payload `sportKey` | Worker-derived slug | Correct slug (from `group`) |
|---|---|---|
| `"soccer_epl"` | `"soccer-epl"` | `"soccer"` |
| `"soccer_bundesliga"` | `"soccer-bundesliga"` | `"soccer"` |
| `"basketball_nba"` | `"basketball-nba"` | `"basketball"` |

The `sync-reference-data` job writes Sport records with `slug: "soccer"`, `slug: "basketball"`, etc. The `sync-traditional-sport` jobs write phantom records with `slug: "soccer-epl"`, `slug: "soccer-bundesliga"`, etc.

All Leagues, Teams, and Matches written by `sync-traditional-sport` reference the phantom sport slugs via `sportSlug` on their canonical entities. Repository `_resolveSportId` resolves by slug, so all FK chains connect correctly — but to the phantom sport, not the reference data sport. The reference data sport (`slug: "soccer"`) has no matches, teams, or leagues attached to it, making it useless.

Additionally, `Sport.name` is set to the raw sport key string (e.g., `"soccer_epl"`) instead of the group display name (e.g., `"Soccer"`).

**Recommendation:**

Extend `SyncTraditionalSportJobData` to include the sport group:

```typescript
export interface SyncTraditionalSportJobData {
  readonly sportKey: string;
  readonly sportGroup: string; // e.g. "Soccer" — needed for slug derivation
}
```

Pass the group when enqueuing `sync-traditional-sport` jobs (the group is available from the `sync-reference-data` run or from `getSports()`). The worker then constructs:

```typescript
const sport: CanonicalSport = {
  slug: slugify(data.sportGroup),
  name: data.sportGroup,
  category: 'TRADITIONAL',
  externalApiSource: 'THE_ODDS_API',
  externalSportKey: slugify(data.sportGroup),
};
```

Alternative: have the worker query the Sport by `externalSportKey` to retrieve the canonical slug. This requires adding a `findByExternalKey` method to `SportRepository`.

The same fix applies to `OddsSnapshotWorker` — it must receive `sportGroup` in the `sync-odds-for-sport` job payload.

---

### F-03 — Critical: `TeamLeagueRepository` P2002 race with undeduped in-batch entries

**Files:**
- `src/ingestion/repositories/team-league.repository.ts:47–64` (find-then-create pattern)
- `src/ingestion/services/match-ingestion.service.ts:138` (`flatMap(p => [...p.teamLeagues])`)

**Problem:**

`TeamLeagueRepository.upsert` was NOT converted to atomic upsert during the Phase 1E remediation. It retains the find-then-create pattern:

```typescript
// team-league.repository.ts:47–64
const existing = await this._prisma.teamLeague.findUnique({ ... });
if (existing) return { id: existing.id, action: 'skipped' };
const created = await this._prisma.teamLeague.create({ data: { teamId, leagueId } });
```

`MatchIngestionService.ingestTraditionalSport` passes all TeamLeague entries without deduplication:

```typescript
// match-ingestion.service.ts:138
const canonicalTeamLeagues = plans.flatMap(p => [...p.teamLeagues]);
```

For 50 EPL matches, every match involving Chelsea produces a `(chelsea_id, epl_id)` TeamLeague entry. If Chelsea appears in 10 fixtures, the batch contains 10 identical entries. `upsertMany` chunks these into groups of 10 via `Promise.all`. If all 10 Chelsea entries land in the same chunk, they execute concurrently:

```
Worker 1: findUnique → null → create → SUCCESS
Workers 2–10: findUnique → null → create → P2002 (unique constraint: teamId_leagueId)
```

`translatePrismaError` on P2002 throws `ValidationError(retryable: false)`. BullMQ moves the job to the failed queue permanently. This failure mode is guaranteed on every sync run for any sport with multiple matches per team.

**Impact:**

Critical production failure. Any normal `sync-traditional-sport` or `sync-esports-game` run where a team appears in more than one match (which is virtually every run) will fail permanently. The match-fetch queue will accumulate failed jobs. No match data will persist past the initial run.

**Recommendation:**

Two fixes are required together:

1. **In `MatchIngestionService`**: deduplicate TeamLeague entries before calling `upsertMany`:
```typescript
const seenTL = new Set<string>();
const canonicalTeamLeagues = plans.flatMap(p => [...p.teamLeagues]).filter(tl => {
  const key = `${tl.sportSlug}:${tl.teamExternalId}:${tl.leagueExternalId}`;
  if (seenTL.has(key)) return false;
  seenTL.add(key);
  return true;
});
```

2. **In `TeamLeagueRepository.upsert`**: replace find-then-create with a native Prisma upsert or use `createMany({ skipDuplicates: true })` for the batch path to eliminate the race condition entirely.

---

### F-04 — Major: PandaScore client does not implement pagination

**File:** `src/integrations/pandascore/pandascore.client.ts:51–58`

**Problem:**

Both `getUpcomingMatches` and `getRunningMatches` make a single HTTP request with no pagination parameters:

```typescript
async getUpcomingMatches(videogame: VideogameKey): Promise<GetUpcomingMatchesResponse> {
  const response = await this.request(`/${videogame}/matches/upcoming`);
  return response as GetUpcomingMatchesResponse;
}
```

PandaScore returns 50 results per page by default. The API supports `page` and `per_page` query parameters. If more than 50 upcoming matches exist for a videogame (common for CS2 during major tournaments), matches beyond page 1 are silently dropped.

Architecture design §4.3 explicitly requires:
> Pagination must be handled (PandaScore returns pages of 50 results by default). Collect all pages for both responses.

**Impact:**

CS2, Valorant, and LoL can have 100+ upcoming matches during active tournament periods. The system will silently under-ingest, with no error or warning logged. Match data for later-page fixtures is lost until the next sync cycle — and if they're also on page 2 in the next cycle, they are permanently missed.

**Recommendation:**

Implement a paginated fetch loop, either in the client or as a utility. The PandaScore API returns total count in response headers (`X-Total` and `X-Per-Page`). The implementation should:

```typescript
async getUpcomingMatches(videogame: VideogameKey): Promise<GetUpcomingMatchesResponse> {
  const allMatches: Match[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { data, headers } = await this.requestWithHeaders(
      `/${videogame}/matches/upcoming`,
      new URLSearchParams({ page: String(page), per_page: '100' }),
    );
    allMatches.push(...(data as Match[]));
    const total = parseInt(headers.get('X-Total') ?? '0', 10);
    const perPage = parseInt(headers.get('X-Per-Page') ?? '100', 10);
    totalPages = Math.ceil(total / perPage);
    page++;
  } while (page <= totalPages);
  return allMatches;
}
```

---

### F-05 — Major: No pre-flight quota check before Odds API calls

**Files:**
- `src/ingestion/workers/reference-data.worker.ts:42`
- `src/ingestion/workers/match-ingestion.worker.ts:80`
- `src/ingestion/workers/odds-snapshot.worker.ts:65`

**Problem:**

Architecture design §4.2 and §5.4 require a quota pre-check before each Odds API call:
> Before each ingestion run, the job must check the remaining quota. If quota is below a minimum threshold, skip the run and log a warning.

None of the three workers perform this check. `OddsApiClient.getQuotaState()` exists and maintains a `QuotaState` object (updated from response headers), but the workers have no access to it — it lives on the client instance, which is hidden behind the service layer.

When quota is exhausted, the API returns HTTP 429, which triggers `RateLimitError(retryable: true)`. BullMQ retries 3 times with exponential backoff. Each retry consumes additional quota (or more accurately, these requests fail and the monthly reset timer is unaffected, but the retries accumulate in logs and occupy the worker).

**Impact:**

No warning is emitted before quota exhaustion. Quota can be silently consumed across all sport jobs running in parallel. When quota runs out mid-run, 3 × N sport jobs fail with `RateLimitError` and exhaust their retry attempts, filling the failed queue. There is no mechanism to pause ingestion proactively.

**Recommendation:**

Expose quota state through the service layer or make the `OddsApiClient` instance accessible to workers. Add a configurable threshold (e.g., `100` requests remaining). Before calling the service, check:

```typescript
const quotaState = this._oddsApiClient.getQuotaState();
if (quotaState.isExhausted || quotaState.requestsRemaining < QUOTA_THRESHOLD) {
  this._logger.warn({ quotaState }, 'Odds API quota low — skipping sync run');
  return emptyResult;
}
```

---

### F-06 — Major: No repeatable job scheduling registered at startup

**Files:**
- `src/ingestion/queues/queue-registration.ts`
- `src/ingestion/bootstrap/ingestion-bootstrap.ts`

**Problem:**

Architecture design §5.3 and §10 Step 5 require all repeatable jobs to be registered at application startup:
> Register all repeatable BullMQ jobs at application startup.
> - `sync-reference-data` — daily
> - `sync-traditional-sport` × N sports — every 30 minutes each
> - `sync-esports-game` × 3 videogames — every 30 minutes each

The `queue-registration.ts` file creates BullMQ `Processor` functions (mapping job names to handlers) but does not add repeatable jobs to any queue. The `bootstrapIngestion` function creates processors and returns them, but does not create BullMQ `Worker` instances, does not create Queue instances, and does not schedule any repeatable jobs.

The ingestion module provides no mechanism to register the scheduled job cycle.

**Impact:**

The ingestion cycle cannot self-start. All jobs must be manually enqueued (e.g., via Redis CLI or a management script). In a production deployment, the system would sit idle — no reference data, no match data, no odds data would be ingested until someone manually fires jobs.

**Recommendation:**

Add a `scheduleIngestionJobs` function that:
1. Creates BullMQ `Queue` instances for `match-fetch` and `odds-fetch`
2. Registers the daily repeatable job for `sync-reference-data`
3. Registers 30-minute repeatable jobs for each configured `TraditionalSportKey`
4. Registers 30-minute repeatable jobs for each `EsportsVideogame` (`cs2`, `valorant`, `lol`)

The sport and videogame lists must be sourced from `IngestionConfig` (not hardcoded) per architecture §5.3.

Additionally, create BullMQ `Worker` instances that bind the processors returned by `createMatchFetchProcessor` and `createOddsFetchProcessor` to the Redis connection.

---

### F-07 — Major: `MatchFetchJobPayload` models the wrong BullMQ job data structure

**Files:**
- `src/ingestion/contracts/queue-payload.types.ts:29–33`
- `src/ingestion/workers/match-ingestion.worker.ts:49, 53`

**Problem:**

`MatchFetchJobPayload` is a discriminated union that wraps both `name` and `data` fields:

```typescript
export type MatchFetchJobPayload =
  | { readonly name: 'sync-traditional-sport'; readonly data: SyncTraditionalSportJobData }
  | { readonly name: 'sync-esports-game'; readonly data: SyncEsportsGameJobData }
  | { readonly name: 'sync-reference-data'; readonly data: SyncReferenceDataJobData };
```

BullMQ separates job name from job data. When a job is added via `queue.add('sync-traditional-sport', { sportKey: 'soccer_epl' })`, `job.name === 'sync-traditional-sport'` and `job.data === { sportKey: 'soccer_epl' }`. The `name` is NOT part of `job.data`.

The `MatchIngestionWorker` acknowledges this mismatch with explicit double casts:

```typescript
// match-ingestion.worker.ts:49, 53
return this._handleTraditionalSport(jobId, job.data as unknown as SyncTraditionalSportJobData, startedAt);
return this._handleEsportsGame(jobId, job.data as unknown as SyncEsportsGameJobData, startedAt);
```

The `as unknown as T` bypass is required precisely because `job.data` is typed as `MatchFetchJobPayload` (which would have shape `{ name: ..., data: ... }`) but the worker expects `{ sportKey: ... }` directly.

**Impact:**

Type safety is bypassed at the worker boundary. If the enqueue side uses the `MatchFetchJobPayload` type as its guide (passing `{ name: ..., data: { sportKey: ... } }`), the worker would receive `job.data.sportKey === undefined` and fail silently at runtime. The mismatch is invisible to TypeScript.

**Recommendation:**

Remove the `name` field from the payload union and simplify:

```typescript
// These already exist and are sufficient
export type SyncTraditionalSportJobData = { readonly sportKey: string; readonly sportGroup: string };
export type SyncEsportsGameJobData = { readonly videogame: EsportsVideogame };
export type SyncReferenceDataJobData = Record<string, never>;
```

Type the worker as `Job<SyncTraditionalSportJobData | SyncEsportsGameJobData | SyncReferenceDataJobData>` and dispatch on `job.name` without casts. Remove `MatchFetchJobPayload` union entirely.

---

### F-08 — Minor: `isMain` flag uses API-provided value instead of configured bookmaker priority list

**File:** `src/ingestion/mappers/odds-api-event.mapper.ts:119`

**Problem:**

Architecture design §6.3 specifies:
> The primary bookmaker is determined by a prioritised list in configuration (e.g., `["pinnacle", "betfair", "williamhill"]`). If none of the preferred bookmakers are present, the first bookmaker in the API response is used.

The implementation uses the API's own `is_main` field:

```typescript
isMain: market.is_main ?? false,
```

`market.is_main` is a field returned by The Odds API indicating whether a market is the primary market for that bookmaker. This is per-market, not per-bookmaker. The architecture intends `isMain` to mark the preferred bookmaker's odds for analytical use — a user-configured priority, not the API's own designation.

**Impact:**

The analysis service's odds retrieval (`most recent snapshot per (matchId, bookmaker, market, outcome)` ordered by `capturedAt`) will use the API-designated `isMain` rather than our configured primary bookmaker. If Pinnacle is the preferred bookmaker but the API marks Bet365's market as `is_main`, analyses will use Bet365 odds as the reference. Minor quality concern for V1 with a small user base.

**Recommendation:**

Add a `primaryBookmakers: string[]` list to `IngestionConfig`. In `OddsApiEventMapper._mapOddsSnapshots`, after collecting all snapshots, mark exactly one bookmaker per market as `isMain` based on the priority list. If no preferred bookmaker is present, fall back to the first bookmaker in the response.

---

## Deferred Findings (Carried Forward from Phase 1E)

The following findings were raised in the Phase 1E audit and explicitly deferred. They are not re-raised as new findings here but are recorded for completeness.

| Prior ID | Description | Status |
|----------|-------------|--------|
| F-05 (1E) | `_resolveSportId` duplicated across 4 repositories | Still deferred |
| F-06 (1E) | TeamLeague 4–5 round trips per record | Still deferred |
| F-07 (1E) | `insertMany` returns `ids: []` — contract breach | Still deferred |
| F-08 (1E) | No semantic error code for missing reference data | Still deferred |
| F-09 (1E) | Terminal-match guard in OddsSnapshotIngestionService | **Resolved** in Phase 2A |

Note: Prior F-09 (terminal-match guard) is confirmed resolved — `OddsSnapshotIngestionService.ingestOddsForSport` correctly discards snapshots for FINISHED/CANCELLED/POSTPONED matches at lines 133–143.

---

## Validated Items

The following dimensions were audited and found correct. They are recorded to provide a complete picture.

### Dependency Graph

The wiring in `createIngestionDependencies` is correct:
- Config → `createOddsApiClient` / `createPandascoreClient` → API clients ✓
- Concrete repositories receive `PrismaClient` and `Logger` ✓
- `ReferenceDataIngestionService` receives `(OddsApiClient, OddsApiSportMapper, SportRepository, LeagueRepository, Logger)` — order matches constructor ✓
- `MatchIngestionService` receives all 9 dependencies in correct constructor order ✓
- `OddsSnapshotIngestionService` receives `(OddsApiClient, OddsSnapshotRepository, Logger)` ✓
- All three workers receive their respective services and loggers ✓
- `bootstrapIngestion` wires processors using correct worker instances ✓

### Constructor Injection Consistency

No global mutable state found anywhere in the ingestion module. All classes use constructor injection exclusively. The one deliberate exception (`OddsApiEventMapper` instantiated per service-method call with a `CanonicalSport` argument) is correctly documented and architecturally justified. ✓

### Queue → Worker → Service Routing

| Queue | Job name | Processor | Worker | Service method |
|-------|----------|-----------|--------|---------------|
| `match-fetch` | `sync-reference-data` | `createMatchFetchProcessor` | `ReferenceDataWorker.process` | `ReferenceDataIngestionService.sync` |
| `match-fetch` | `sync-traditional-sport` | `createMatchFetchProcessor` | `MatchIngestionWorker.process` | `MatchIngestionService.ingestTraditionalSport` |
| `match-fetch` | `sync-esports-game` | `createMatchFetchProcessor` | `MatchIngestionWorker.process` | `MatchIngestionService.ingestEsportsGame` |
| `odds-fetch` | `sync-odds-for-sport` | `createOddsFetchProcessor` | `OddsSnapshotWorker.process` | `OddsSnapshotIngestionService.ingestOddsForSport` |

All four routing paths are correctly wired. ✓

### Mapper Ownership and Boundaries

- `OddsApiSportMapper`: stateless, injected as singleton, called per sport entry in `ReferenceDataIngestionService` ✓
- `OddsApiEventMapper`: concrete class, instantiated per service call with `CanonicalSport`, only imported as a value in the two services that use it, never injected ✓
- `PandascoreMatchMapper`: stateless, injected as singleton in `MatchIngestionService` ✓
- No mapper is instantiated in repositories or workers (with the noted exception of `slugify` utility use in workers) ✓
- Mapper layer correctly imports from integration type definitions — appropriate cross-layer dependency ✓

### Service → Repository Usage

All services use repository interfaces from `@/ingestion/repositories/contracts` (type imports only). No concrete repository class is referenced in services. Write dependency order is enforced: Sport → League → Team → Match → TeamLeague in both `ingestTraditionalSport` and `ingestEsportsGame`. ✓

### Repository → Prisma Usage

All repositories use `PrismaClient` directly. No raw SQL. Upsert operations for Sport, League, Team, and Match use native Prisma upsert (`INSERT ... ON CONFLICT DO UPDATE`) — atomic, P2002-safe. OddsSnapshot uses `createMany` (append-only, correct). ✓

### OddsSnapshot Append-Only Behavior

`OddsSnapshotRepository` has no `update`, `upsert`, or `delete` methods. Only `insert` and `insertMany`. `createMany` is used for batch inserts. The terminal-match guard in `OddsSnapshotIngestionService` discards snapshots before they reach the repository. ✓

### Schema Alignment

| Entity | Schema unique key | Repository lookup key | Match |
|--------|-------------------|-----------------------|-------|
| Sport | `@@unique([slug])` | `where: { slug }` | ✓ |
| League | `@@unique([sportId, externalId])` | `where: { sportId_externalId: { sportId, externalId } }` | ✓ |
| Team | `@@unique([sportId, externalId])` | `where: { sportId_externalId: { sportId, externalId } }` | ✓ |
| TeamLeague | `@@unique([teamId, leagueId])` | `where: { teamId_leagueId: { teamId, leagueId } }` | ✓ |
| Match | `@@unique([externalId])` | `where: { externalId }` | ✓ |
| OddsSnapshot | no unique constraint | `createMany` (correct) | ✓ |

Prisma enums used in repositories (`MatchStatus`, `MatchResult`, `OddsMarket`, `ApiSource`, `SportCategory`) align with schema enum definitions. ✓

### Idempotency

Sport, League, Team, Match upserts are atomic (Prisma native upsert). TeamLeague has a race vulnerability (F-03). OddsSnapshot is append-only (no idempotency concern — correct by design). All services produce the same DB state on retry for the entity types that are correctly implemented. ✓ (with F-03 exception noted)

### Error Propagation

Errors thrown from repositories propagate to services, then to workers, then to BullMQ's failed-job handler. `DatabaseError(retryable: false)` moves jobs to the failed queue immediately. `ExternalApiError(retryable: true)` and `RateLimitError` are retried. `AuthenticationError` is non-retryable. The error hierarchy is correctly applied throughout. ✓

### No Business Logic, Prediction, or Discord Leakage

Reviewed all files under `src/ingestion/`. No imports from Discord, AI analysis, prediction, or settlement modules. No business logic (bet sizing, value calculation, prediction confidence) present. Ingestion is correctly isolated. ✓

### Integration Client Correctness

**The Odds API client:**
- Reads API key from config (`config.api.theOddsApiKey`) ✓
- Updates quota state from response headers (`x-requests-remaining`, `x-requests-used`) ✓
- Throws `AuthenticationError` on 401/403, `RateLimitError` on 429, `ExternalApiError` on 5xx ✓
- Enforces timeout via `AbortController` ✓
- API key is passed as query parameter (`apiKey`), not logged (URL logging uses `url.pathname` + `url.search`, which includes the API key in `url.search`). **Minor concern**: the `query: url.search` field in the debug log will include `?apiKey=...`. Not a secrets leak to external systems but could appear in log aggregation. Noted but not raised as a finding given V1 friends-only scope.

**PandaScore client:**
- Reads API token from config (`config.api.pandascoreApiKey`) ✓
- Sends token as `Authorization: Bearer` header ✓
- Throws correct error types ✓
- Enforces timeout via `AbortController` ✓
- Does NOT log the authorization token ✓

### `PandascoreMatchMapper` skip logic

The mapper correctly returns `null` for:
- `opponents` is `null` ✓
- `opponents.length !== 2` ✓
- Either opponent `type !== 'Team'` ✓
- `scheduled_at` and `begin_at` both `null` ✓

Architecture design §3.4 requirements are fully met. ✓

### Match externalId namespacing

- The Odds API: `oddsApiMatchExternalId(raw.id)` = `"oa:{uuid}"` ✓
- PandaScore: `pandascoreMatchExternalId(raw.id)` = `"ps:{match_id}"` ✓
- `OddsSnapshotIngestionService` correctly strips `"oa:"` prefix for API `eventIds` parameter ✓
- `allowedExternalIds` guard in `OddsSnapshotIngestionService` correctly compares prefixed IDs ✓

---

## Finding Summary

| ID | Severity | Location | Short Description |
|----|----------|----------|-------------------|
| F-01 | **Critical** | `match-ingestion.worker.ts:80–93` | `sync-odds-for-sport` job never enqueued — odds pipeline broken |
| F-02 | **Critical** | `match-ingestion.worker.ts:70–76`, `odds-snapshot.worker.ts:57–63` | Wrong sport slug derived from `sportKey`; phantom Sport records created |
| F-03 | **Critical** | `team-league.repository.ts:47–64`, `match-ingestion.service.ts:138` | TeamLeague P2002 race on every normal sync run |
| F-04 | **Major** | `pandascore.client.ts:51–58` | PandaScore pagination not implemented; only first 50 matches fetched |
| F-05 | **Major** | All three worker `process` methods | No pre-flight quota check before Odds API calls |
| F-06 | **Major** | `queue-registration.ts`, `ingestion-bootstrap.ts` | No repeatable job scheduling at startup; ingestion cannot self-start |
| F-07 | **Major** | `queue-payload.types.ts:29–33`, `match-ingestion.worker.ts:49,53` | `MatchFetchJobPayload` models wrong BullMQ data shape; requires double casts |
| F-08 | **Minor** | `odds-api-event.mapper.ts:119` | `isMain` uses API field; configured bookmaker priority list not implemented |

---

## Final Verdict

**FAIL**

Three Critical findings prevent correct operation:

- **F-01**: The odds pipeline is completely disconnected. `OddsSnapshotIngestionService` can never be invoked automatically. No odds data will be written.
- **F-02**: Every `sync-traditional-sport` run writes to a phantom Sport record. Reference data and match data will never share the same Sport record. The entire FK chain is wrong.
- **F-03**: Every `sync-traditional-sport` run with multiple matches per team will P2002-fail on TeamLeague writes and move to the failed queue permanently.

Any one of these three Critical findings alone is sufficient for a FAIL verdict. All three are present simultaneously.

---

## Readiness

**NOT READY FOR SPRINT 5**

The ingestion pipeline cannot produce correct, complete data in its current state:

1. **Data correctness**: Sport records are fragmented by sport key, not grouped by sport group. Match data links to phantom sports.
2. **Pipeline completeness**: No odds data will be written without manual queue intervention.
3. **Stability**: TeamLeague writes will fail on virtually every normal sync run.
4. **Operability**: No repeatable jobs scheduled; the system cannot self-start.

Sprint 5 (AI Analysis) consumes `Match` and `OddsSnapshot` records. With F-01 and F-02 unresolved, Sprint 5 would operate on malformed data (wrong Sport hierarchy) and no OddsSnapshot records. The analysis service cannot be meaningfully tested without correct ingestion data.

**Minimum work required before Sprint 5 can begin:**

| Priority | Fix |
|----------|-----|
| 1 (blocking) | F-02: Correct sport slug derivation; add `sportGroup` to job payload |
| 2 (blocking) | F-03: Add TeamLeague in-batch dedup; convert to atomic upsert |
| 3 (blocking) | F-01: Wire odds-fetch queue to `MatchIngestionWorker`; enqueue `sync-odds-for-sport` |
| 4 (blocking) | F-06: Register repeatable jobs at startup |
| 5 (recommended) | F-04: Implement PandaScore pagination |
| 6 (recommended) | F-07: Correct `MatchFetchJobPayload` type |
| 7 (optional) | F-05: Add quota pre-flight checks |
| 8 (optional) | F-08: Implement bookmaker priority list for `isMain` |

---

## Next Recommended Phase

**Phase 2E: Sprint 4 Remediation** — address F-01 through F-04 before proceeding.

Suggested remediation order:

1. **F-02 first** — all other work depends on correct sport identity. Add `sportGroup: string` to `SyncTraditionalSportJobData`. Update both workers. Update `OddsSnapshotWorker` job payload type correspondingly.

2. **F-03 second** — TeamLeague deduplication in `MatchIngestionService` + atomic upsert in `TeamLeagueRepository`. Service-level change is one-line; repository change is a pattern that was already applied to Sport/League/Team/Match.

3. **F-01 third** — wire the odds-fetch queue into `MatchIngestionWorker`. Requires creating a queue facade or passing the BullMQ `Queue` instance through `createIngestionDependencies`.

4. **F-06 fourth** — add a `scheduleIngestionJobs` function with configurable sport and videogame lists. Create BullMQ `Worker` instances in bootstrap.

5. **F-04 fifth** — paginate PandaScore requests. Self-contained client change.

6. **F-07 sixth** — simplify `MatchFetchJobPayload` type; remove double casts.

After remediation of F-01 through F-04, re-audit the boot path end-to-end before authorising Sprint 5 to begin.
