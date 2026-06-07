# Sprint 5 — Esports Odds Implementation Plan

**Date:** 2026-06-07
**Author:** Implementation planning (based on Sprint 4 architecture + V1 Final Optimization Audit)
**Scope:** End-to-end esports odds ingestion via OddsPapi — new client, new queue job, new worker, new service, event-driven trigger wiring.
**Constraint:** No implementation in this document. Plan only.

---

## 1. Summary

This sprint adds the missing esports odds pipeline to a codebase that already has:
- PandaScore match data ingestion for CS2, Dota2, LoL, Valorant (complete)
- Traditional odds ingestion via The Odds API (complete)
- OddsSnapshot database model (reusable as-is)

After Sprint 5, the `sync-esports-game` job will enqueue `sync-esports-odds` whenever near-term esports matches exist, and OddsPapi will be called to fetch current h2h odds for those matches. OddsSnapshot records will be written to the same table used by traditional sports.

V1 esports odds scope: **CS2, Dota 2, LoL, Valorant only.**
R6 Siege and MLBB: PandaScore match data continues; OddsPapi odds integration excluded from V1.

---

## 2. Current State

### What exists

```
PandaScore → MatchIngestionService.ingestEsportsGame
           → Sport/League/Team/Match upserts
           → EsportsMatchIngestionResult (no nearTermMatchExternalIds)
           → MatchIngestionWorker._handleEsportsGame
           → RETURNS — no odds job enqueued
```

### What is missing

| Component | Status |
|-----------|--------|
| OddsPapi HTTP client | ❌ Not built |
| OddsPapi quota tracker | ❌ Not built |
| `SyncEsportsOddsJobData` contract type | ❌ Not defined |
| `sync-esports-odds` job name | ❌ Not registered |
| `EsportsOddsSnapshotIngestionService` | ❌ Not built |
| `EsportsOddsSnapshotWorker` | ❌ Not built |
| `nearTermMatchExternalIds` in esports result | ❌ Missing from `EsportsMatchIngestionResult` |
| Event-driven odds trigger in `_handleEsportsGame` | ❌ Not wired |
| `ODDSPAPI_API_KEY` environment variable | ❌ Not in config |

### What is reusable without changes

| Component | Reusable? | Notes |
|-----------|-----------|-------|
| `OddsSnapshot` Prisma model | ✅ Full reuse | Source-agnostic; no new fields required |
| `OddsSnapshotRepository` | ✅ Full reuse | `insertMany` works for any `CanonicalOddsSnapshot` source |
| `CanonicalOddsSnapshot` type | ✅ Full reuse | `matchExternalId` holds the `ps:` ID; same structure |
| `IngestionOddsMarket` type | ✅ Full reuse | `'H2H'` covers all esports needs |
| `NEAR_TERM_WINDOW_MS` constant | ✅ Full reuse | 48h window applies equally to esports |
| Error hierarchy (`ExternalApiError`, `RateLimitError`, etc.) | ✅ Full reuse | |
| BullMQ wiring patterns (`DEFAULT_JOB_OPTIONS`, `QueueName`) | ✅ Full reuse | |

---

## 3. Data Flow

### After Sprint 5

```
Every 30 min
    │
    ▼
sync-esports-game (match-fetch queue)
    │
    ▼
MatchIngestionWorker._handleEsportsGame
    │
    ▼
MatchIngestionService.ingestEsportsGame(videogame)
    │
    ├─ PandaScore: getUpcomingMatches + getRunningMatches
    ├─ Upserts: Sport / League / Team / Match / TeamLeague
    └─ Returns: EsportsMatchIngestionResult
                + nearTermMatchExternalIds (NEW)
    │
    ├─ nearTermMatchExternalIds.length === 0 → DONE
    │
    └─ nearTermMatchExternalIds.length > 0
           │
           ▼
       oddsFetchQueue.add('sync-esports-odds', {
         videogame,
         matchExternalIds: nearTermMatchExternalIds,
       }, { delay: 5000 })
           │
           ▼
    sync-esports-odds (odds-fetch queue)
           │
           ▼
    EsportsOddsSnapshotWorker.process(job)
           │
           ▼
    EsportsOddsSnapshotIngestionService.ingestOddsForGame(videogame, matchExternalIds)
           │
           ├─ Load DB Match records (with homeTeam + awayTeam names) by ps: IDs
           ├─ Check OddsPapi quota → ABORT if ≥ QUOTA_SOFT_LIMIT
           ├─ OddsPapiClient.getOddsForGame(videogame)    ← 1 OddsPapi request
           ├─ For each OddsPapi match: correlate to DB Match by team name + start time
           └─ Write CanonicalOddsSnapshot records → OddsSnapshotRepository.insertMany
```

---

## 4. Component Designs

---

### 4.1 OddsPapi Client

#### 4.1.1 Client Interface

**File:** `src/integrations/oddspapi/oddspapi.client.ts`

```typescript
export interface OddspapiClient {
  /**
   * Fetches current pre-match odds for all upcoming matches of a game.
   * Returns an empty array when no matches are currently listed.
   *
   * ⚠️ VERIFY endpoint path and response shape with OddsPapi documentation.
   * Estimated: GET /v2/odds?game={videogame}
   */
  getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]>;
}
```

#### 4.1.2 OddsPapi Type Definitions

**File:** `src/integrations/oddspapi/types.ts`

```typescript
/**
 * Esports game identifiers as used by OddsPapi.
 * ⚠️ VERIFY: confirm OddsPapi's exact game key strings from their documentation.
 * These values may differ from PandaScore slugs ('cs2' vs 'counter-strike', etc.).
 */
export type OddspapiVideogame = 'cs2' | 'dota2' | 'lol' | 'valorant';

export interface OddspapiOutcome {
  readonly name: 'home' | 'away';  // ⚠️ VERIFY: may be team name or 'home'/'away'
  readonly price: number;           // decimal odds
}

export interface OddspapiBookmaker {
  readonly key: string;            // e.g. 'pinnacle', 'bet365'
  readonly title: string;          // display name
  readonly outcomes: readonly OddspapiOutcome[];
}

export interface OddspapiMatchOdds {
  readonly id: string;             // OddsPapi internal match ID
  readonly game: OddspapiVideogame;
  readonly home_team: string;      // ⚠️ VERIFY: exact field name
  readonly away_team: string;      // ⚠️ VERIFY: exact field name
  readonly commence_time: string;  // ISO 8601
  readonly bookmakers: readonly OddspapiBookmaker[];
}

/** Response from OddsPapi getOddsForGame. */
export type GetOddsForGameResponse = readonly OddspapiMatchOdds[];
```

> **⚠️ API Verification Checklist for OddsPapi:**
> Before implementation begins, the following must be confirmed from official OddsPapi documentation:
>
> 1. Base URL (e.g. `https://api.oddspapi.com` or `https://app.oddspapi.com/api`)
> 2. Authentication method (header `Authorization: Bearer {key}` or query `?apiKey={key}`)
> 3. Game key strings for CS2, Dota2, LoL, Valorant
> 4. Endpoint path for fetching current pre-match odds
> 5. Whether endpoint supports filtering by match ID (or returns all matches for a game)
> 6. Response field names for team names and start time
> 7. Whether quota usage is reported in response headers

#### 4.1.3 Client Configuration

**File:** `src/integrations/oddspapi/oddspapi.config.ts`

```typescript
export interface OddspapiClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;    // populated from ODDSPAPI_BASE_URL or constant default
  readonly timeoutMs: number;
}

export const ODDSPAPI_DEFAULTS = {
  BASE_URL: 'https://api.oddspapi.com',  // ⚠️ VERIFY
  TIMEOUT_MS: 15_000,
  MONTHLY_QUOTA: 250,
  QUOTA_SOFT_LIMIT: 225,   // 90% — stop making calls, log warning
  QUOTA_HARD_LIMIT: 250,   // 100% — reject unconditionally
} as const;
```

#### 4.1.4 DefaultOddspapiClient Implementation

**File:** `src/integrations/oddspapi/oddspapi.client.ts` (implementation class in same file)

The implementation follows the exact same pattern as `DefaultOddsApiClient` and `DefaultPandascoreClient`:
- `native fetch` + `AbortController` timeout
- Error translation to `ExternalApiError`, `RateLimitError`, `AuthenticationError`
- `buildSearchParams` helper for query parameters
- Authentication: ⚠️ method depends on OddsPapi docs (likely `Authorization: Bearer {apiKey}` header)

`getOddsForGame(videogame)`:
```typescript
async getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]> {
  const params = new URLSearchParams({ game: videogame });
  const response = await this.request('/v2/odds', params);  // ⚠️ VERIFY path
  return response as OddspapiMatchOdds[];
}
```

Error handling:
- 401/403 → `AuthenticationError`
- 429 → `RateLimitError` (quota exhausted for the month)
- 5xx → `ExternalApiError` with `retryable: true`
- Timeout → `ExternalApiError` with `retryable: true`

#### 4.1.5 OddsPapi Quota Tracker

**File:** `src/integrations/oddspapi/quota.tracker.ts`

The OddsPapi free tier (250 req/month) provides **no** response headers reporting remaining quota. The application must track usage internally.

**Design: Redis INCR counter with monthly rotation**

```typescript
export class OddspapiQuotaTracker {
  private readonly _redis: Redis;
  private readonly _softLimit: number;
  private readonly _hardLimit: number;

  constructor(redis: Redis, softLimit = 225, hardLimit = 250) { ... }

  /**
   * Returns the Redis key for the current calendar month.
   * Format: "oddspapi:quota:2026-06" — automatically rotates on month boundary.
   * TTL: 31 days ensures the key is cleaned up automatically.
   */
  private _monthlyKey(): string {
    const now = new Date();
    return `oddspapi:quota:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Returns the current request count for this calendar month.
   */
  async getMonthlyUsage(): Promise<number> { ... }

  /**
   * Checks whether making a new request is allowed.
   *
   * Returns:
   * - 'allowed'    — under soft limit, proceed
   * - 'warned'     — between soft and hard limit, proceed but log warning
   * - 'exhausted'  — at or above hard limit, do NOT proceed
   */
  async checkQuota(): Promise<'allowed' | 'warned' | 'exhausted'> { ... }

  /**
   * Increments the monthly counter after a successful API call.
   * Sets TTL to 31 days if the key is new (prevents stale keys).
   */
  async increment(): Promise<number> { ... }
}
```

**Quota lifecycle:**
1. Before each `getOddsForGame` call: `await quotaTracker.checkQuota()`
2. If `'exhausted'`: throw `QuotaExhaustedError` (new non-retryable error type — see §4.4.3)
3. If `'warned'`: log warning, proceed
4. After successful call: `await quotaTracker.increment()`
5. On 429 response from OddsPapi: force-set usage to `QUOTA_HARD_LIMIT` to prevent further calls this month

**Note:** The `ResilientOddspapiClient` (§4.1.6) wraps the raw client and owns the quota check/increment lifecycle.

#### 4.1.6 ResilientOddspapiClient

**File:** `src/integrations/oddspapi/oddspapi.resilient-client.ts`

Follows the `ResilientOddsApiClient` decorator pattern:
- Wraps `OddspapiClient`
- Adds retry logic for transient errors
- **Strict retry policy:** `attempts: 2` (original + 1 retry), `backoff: fixed 30s`
- **Never retry on QuotaExhaustedError or AuthenticationError** — these are permanent failures
- Checks quota before calling inner client; increments quota after success

Retry budget rationale: with 250 req/month, an accidental retry storm (e.g., 3 retries × 4 games × 60 active days = 720 requests) would destroy the free tier. Maximum 1 retry per call is the safe limit.

#### 4.1.7 Factory Function

**File:** `src/integrations/oddspapi/oddspapi.factory.ts`

```typescript
export function createOddspapiClient(
  config: { apiKey: string },
  redis: Redis,
  logger: Logger,
): OddspapiClient {
  const clientConfig: OddspapiClientConfig = {
    apiKey: config.apiKey,
    baseUrl: ODDSPAPI_DEFAULTS.BASE_URL,
    timeoutMs: ODDSPAPI_DEFAULTS.TIMEOUT_MS,
  };
  const quotaTracker = new OddspapiQuotaTracker(
    redis,
    ODDSPAPI_DEFAULTS.QUOTA_SOFT_LIMIT,
    ODDSPAPI_DEFAULTS.QUOTA_HARD_LIMIT,
  );
  const base = new DefaultOddspapiClient(clientConfig, logger);
  return new ResilientOddspapiClient(base, quotaTracker, logger);
}
```

---

### 4.2 Contract Types

#### 4.2.1 New: `SyncEsportsOddsJobData`

**File:** `src/ingestion/contracts/queue-payload.types.ts` (ADD)

```typescript
/** Job data for the sync-esports-odds queue job. */
export interface SyncEsportsOddsJobData {
  /** The esports game — determines which OddsPapi endpoint to query. */
  readonly videogame: EsportsVideogame;
  /**
   * "ps:"-prefixed match external IDs from the preceding sync-esports-game job.
   * Only the 4 OddsPapi-supported games should appear here.
   * Used to identify which DB Match records to link snapshots to.
   */
  readonly matchExternalIds: readonly string[];
}
```

Add to `MatchFetchJobPayload` discriminated union:
```typescript
// No change — sync-esports-odds is an odds-fetch job, not a match-fetch job.
```

Add new `OddsFetchJobPayload` union (or extend existing):
```typescript
export type OddsFetchJobPayload =
  | { readonly name: 'sync-odds-for-sport'; readonly data: SyncOddsForSportJobData }
  | { readonly name: 'sync-esports-odds'; readonly data: SyncEsportsOddsJobData };
```

#### 4.2.2 Updated: `EsportsMatchIngestionResult`

**File:** `src/ingestion/services/types.ts` (MODIFY)

```typescript
export interface EsportsMatchIngestionResult {
  readonly sports: EntityWriteOutcome;
  readonly leagues: EntityWriteOutcome;
  readonly teams: EntityWriteOutcome;
  readonly matches: EntityWriteOutcome;
  readonly nearTermMatchExternalIds: readonly string[];  // ← ADD: "ps:"-prefixed IDs within 48h
  readonly skippedMatches: number;
  readonly errors: readonly SyncError[];
  readonly durationMs: number;
}
```

#### 4.2.3 New: `EsportsOddsIngestionResult`

**File:** `src/ingestion/services/types.ts` (ADD)

```typescript
/** Result returned by EsportsOddsSnapshotIngestionService.ingestOddsForGame(). */
export interface EsportsOddsIngestionResult {
  readonly videogame: EsportsVideogame;
  readonly oddsMatchesReceived: number;    // matches returned by OddsPapi
  readonly oddsMatchesCorrelated: number;  // successfully matched to DB Match records
  readonly oddsMatchesSkipped: number;     // OddsPapi matches with no DB correlation
  readonly oddsSnapshots: EntityWriteOutcome;
  readonly quotaUsedThisCall: number;      // always 1 if successful, 0 if quota-skipped
  readonly errors: readonly SyncError[];
  readonly durationMs: number;
}
```

#### 4.2.4 New error type: `QuotaExhaustedError`

**File:** `src/lib/errors/index.ts` or existing error module (ADD)

```typescript
/**
 * Thrown when an external API's monthly quota has been exhausted.
 * This error is non-retryable — retrying would consume quota that doesn't exist.
 * Workers catching this error should complete the job gracefully (not move to failed).
 */
export class QuotaExhaustedError extends Error {
  readonly provider: string;
  readonly monthlyLimit: number;
  readonly currentUsage: number;

  constructor(provider: string, monthlyLimit: number, currentUsage: number) {
    super(`${provider} quota exhausted: ${currentUsage}/${monthlyLimit} requests used this month`);
    this.provider = provider;
    this.monthlyLimit = monthlyLimit;
    this.currentUsage = currentUsage;
    this.name = 'QuotaExhaustedError';
  }
}
```

---

### 4.3 Queue Design

#### 4.3.1 New job name

**File:** `src/ingestion/queues/queue-names.ts` (MODIFY)

```typescript
export const ODDS_FETCH_JOB_NAMES = {
  SYNC_ODDS_FOR_SPORT: 'sync-odds-for-sport',
  SYNC_ESPORTS_ODDS:   'sync-esports-odds',    // ← ADD
} as const;
```

#### 4.3.2 BullMQ job options

`sync-esports-odds` jobs use the following options:

```typescript
await oddsFetchQueue.add(
  ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS,
  payload,
  {
    delay: 5000,      // 5-second delay after match sync (matches the traditional sport pattern)
    attempts: 2,      // original + 1 retry maximum (quota budget is tight)
    backoff: {
      type: 'fixed',
      delay: 30_000,  // 30-second fixed backoff between attempts
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
);
```

**Retry policy rationale:**
- `attempts: 2` (not 3) because each failed attempt that retries consumes one OddsPapi request.
- Fixed backoff (not exponential) because the likely failure mode is a transient 5xx, not an overload scenario.
- `QuotaExhaustedError` and `AuthenticationError` must be caught in the worker and resolved as a non-failed completion (see §4.5.3).

#### 4.3.3 Queue placement

`sync-esports-odds` runs on the **existing `odds-fetch` queue** (`QueueName.ODDS_FETCH`). A separate queue is not needed because:
- Volume is very low (< 10 jobs/day for 4 games combined)
- The existing queue processor can dispatch on job name (same switch pattern)
- Adding a new queue would require a new QueueName, new processor, and new Worker instantiation — unjustified overhead for this volume

---

### 4.4 Service Design

#### 4.4.1 `EsportsOddsSnapshotIngestionService`

**File:** `src/ingestion/services/esports-odds-ingestion.service.ts`

```typescript
export class EsportsOddsSnapshotIngestionService {
  constructor(
    oddspapiClient: OddspapiClient,
    matchRepository: MatchRepository,       // to look up ps: Match records with team names
    oddsSnapshotRepository: OddsSnapshotRepository,
    logger: Logger,
  ) { ... }

  async ingestOddsForGame(
    videogame: EsportsVideogame,
    matchExternalIds: readonly string[],    // "ps:"-prefixed IDs
  ): Promise<EsportsOddsIngestionResult> { ... }
}
```

#### 4.4.2 `ingestOddsForGame` algorithm

```
1. VALIDATE INPUTS
   - Filter matchExternalIds to only "ps:"-prefixed IDs (guard against cross-contamination)
   - Return empty result if no valid IDs remain

2. LOAD DB MATCHES (pre-call, free)
   - Query: matchRepository.findManyWithTeams({ externalIds: psIds })
   - Returns: Array of { id, externalId, startTime, homeTeam: { name }, awayTeam: { name } }
   - Log: count of DB matches loaded
   - If 0 matches found in DB: log warning + return empty result (matches not yet committed)

3. FETCH ODDS FROM ODDSPAPI (quota-consuming)
   - oddspapiClient.getOddsForGame(videogameToOddspapiKey(videogame))
   - This call is made exactly ONCE per job invocation
   - Returns all current pre-match matches for that game from OddsPapi
   - Log: count of OddsPapi matches received

4. CORRELATE ODDSPAPI MATCHES TO DB MATCHES
   - For each OddsPapi match in response:
       a. Normalize both team names (see §5)
       b. Find DB match where:
             normalizedName(dbMatch.homeTeam.name) matches normalizedName(oddsMatch.home_team)
          AND normalizedName(dbMatch.awayTeam.name) matches normalizedName(oddsMatch.away_team)
          AND abs(dbMatch.startTime - oddsMatch.commenceTime) ≤ CORRELATION_TIME_TOLERANCE_MS (30 min)
       c. If no match found: log debug (team names for inspection) + increment skippedCount
       d. If match found: mark as correlated

5. BUILD CANONICAL ODDS SNAPSHOTS
   - For each correlated pair (oddsMatch, dbMatch):
       - capturedAt = now
       - For each bookmaker in oddsMatch.bookmakers:
           - For each outcome in bookmaker.outcomes:
               - Create CanonicalOddsSnapshot:
                   matchExternalId = dbMatch.externalId    ("ps:xxx")
                   bookmaker = bookmaker.key                ("pinnacle", etc.)
                   market = 'H2H'
                   outcome = outcome.name                  (team name or 'home'/'away')
                   price = outcome.price
                   isMain = (bookmaker.key === 'pinnacle') // Pinnacle is the sharp market
                   isLive = false
                   capturedAt = capturedAt

6. PERSIST SNAPSHOTS
   - oddsSnapshotRepository.insertMany(snapshots)

7. RETURN EsportsOddsIngestionResult
```

#### 4.4.3 `MatchRepository` extension needed

The existing `MatchRepository` interface (`src/ingestion/repositories/contracts/match.repository.ts`) likely has no method to query matches by external ID with team names included. A new method must be added:

**New method on `MatchRepository` interface and implementation:**

```typescript
// In match.repository.ts contract:
findManyWithTeamsByExternalIds(
  externalIds: readonly string[],
): Promise<Array<{
  id: string;
  externalId: string;
  startTime: Date;
  homeTeam: { id: string; name: string };
  awayTeam: { id: string; name: string };
}>>;
```

This is a simple Prisma query:
```typescript
this._prisma.match.findMany({
  where: { externalId: { in: [...externalIds] } },
  select: {
    id: true,
    externalId: true,
    startTime: true,
    homeTeam: { select: { id: true, name: true } },
    awayTeam: { select: { id: true, name: true } },
  },
})
```

**Note:** This query is free — it reads from the database with no external API cost.

---

### 4.5 Worker Design

#### 4.5.1 `EsportsOddsSnapshotWorker`

**File:** `src/ingestion/workers/esports-odds-snapshot.worker.ts`

```typescript
export class EsportsOddsSnapshotWorker {
  private readonly _service: EsportsOddsSnapshotIngestionService;
  private readonly _logger: Logger;

  constructor(
    service: EsportsOddsSnapshotIngestionService,
    logger: Logger,
  ) {
    this._service = service;
    this._logger = logger.child({ worker: 'EsportsOddsSnapshotWorker' });
  }

  async process(
    job: Job<SyncEsportsOddsJobData>,
  ): Promise<EsportsOddsIngestionResult> { ... }
}
```

#### 4.5.2 `process` implementation

```
1. Extract: videogame, matchExternalIds from job.data
2. Log: { jobId, videogame, matchCount: matchExternalIds.length } 'Processing esports odds job'
3. Guard: if matchExternalIds.length === 0 → log + return empty result
4. Call: service.ingestOddsForGame(videogame, matchExternalIds)
5. Log: { result.oddsMatchesReceived, result.oddsMatchesCorrelated,
          result.oddsSnapshots, result.durationMs } 'Esports odds job complete'
6. Return result
```

#### 4.5.3 Quota exhaustion handling

`QuotaExhaustedError` must not move the job to the failed queue — it is a known operational state, not an error. The worker catches it explicitly:

```typescript
try {
  return await this._service.ingestOddsForGame(videogame, matchExternalIds);
} catch (error) {
  if (error instanceof QuotaExhaustedError) {
    this._logger.warn(
      { videogame, provider: error.provider, usage: error.currentUsage, limit: error.monthlyLimit },
      'OddsPapi quota exhausted — skipping esports odds ingestion for remainder of month',
    );
    // Return a zero-work result. Job completes successfully. No retry.
    return {
      videogame,
      oddsMatchesReceived: 0, oddsMatchesCorrelated: 0, oddsMatchesSkipped: 0,
      oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
      quotaUsedThisCall: 0,
      errors: [],
      durationMs: 0,
    };
  }
  throw error; // All other errors propagate to BullMQ for retry
}
```

---

### 4.6 Event-Driven Trigger Changes

#### 4.6.1 `MatchIngestionService.ingestEsportsGame` (MODIFY)

**File:** `src/ingestion/services/match-ingestion.service.ts`

Current return type: `EsportsMatchIngestionResult` without `nearTermMatchExternalIds`.

Required change:
- After all match upserts complete, calculate near-term IDs using the same 48h window as the traditional path:
  ```typescript
  const now = Date.now();
  const nearTermMatchExternalIds = writtenMatches
    .filter(m => m.startTime.getTime() - now <= NEAR_TERM_WINDOW_MS
                && m.startTime.getTime() >= now)   // exclude matches that already started
    .map(m => m.externalId);
  ```
- Include `nearTermMatchExternalIds` in the returned `EsportsMatchIngestionResult`.

**Near-term filtering for esports: only V1 odds-eligible games**

Not all 6 esports games in the scheduler have OddsPapi coverage in V1. Only CS2, Dota2, LoL, Valorant do. However, `ingestEsportsGame` should not encode this business rule — it should return near-term IDs for all games. The caller (`MatchIngestionWorker._handleEsportsGame`) is responsible for deciding whether to enqueue an odds job.

#### 4.6.2 `MatchIngestionWorker._handleEsportsGame` (MODIFY)

**File:** `src/ingestion/workers/match-ingestion.worker.ts`

The worker needs:
1. Access to `_oddsFetchQueue` (already present — it was added in Sprint 4 Phase 2E for the traditional sport path)
2. A constant or set of games eligible for OddsPapi odds:

```typescript
// At the top of the file, or imported from a config:
const ODDSPAPI_SUPPORTED_GAMES: ReadonlySet<EsportsVideogame> =
  new Set(['cs2', 'dota2', 'lol', 'valorant']);
```

Updated `_handleEsportsGame`:
```typescript
private async _handleEsportsGame(jobId, data, startedAt) {
  const { videogame } = data;
  const result = await this._service.ingestEsportsGame(videogame);

  // Enqueue esports odds job if:
  // (a) near-term matches exist, AND
  // (b) this game is supported by OddsPapi in V1
  if (
    result.nearTermMatchExternalIds.length > 0 &&
    ODDSPAPI_SUPPORTED_GAMES.has(videogame)
  ) {
    const oddsPayload: SyncEsportsOddsJobData = {
      videogame,
      matchExternalIds: result.nearTermMatchExternalIds,
    };
    await this._oddsFetchQueue.add(
      ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS,
      oddsPayload,
      { delay: 5000, attempts: 2, backoff: { type: 'fixed', delay: 30_000 } },
    );
    this._logger.info(
      { jobId, videogame, nearTermCount: result.nearTermMatchExternalIds.length },
      'Enqueued sync-esports-odds job',
    );
  }

  return { /* EsportsGameSyncResult */ };
}
```

---

### 4.7 Database Design

#### 4.7.1 OddsSnapshot model assessment

| Field | Traditional usage | Esports usage |
|-------|------------------|---------------|
| `matchId` | FK to Match (Odds API source) | FK to Match (PandaScore source) — same FK, different source |
| `bookmaker` | e.g. `"pinnacle"`, `"bet365"` | Same — OddsPapi aggregates same bookmakers |
| `market` | `H2H`, `SPREADS`, `TOTALS` | `H2H` only (esports is moneyline-only market) |
| `outcome` | Home team name or `"Draw"` | Home team name or away team name |
| `price` | Decimal odds | Decimal odds |
| `isMain` | True for Pinnacle lines | True for Pinnacle lines (same convention) |
| `isLive` | False (pre-match only) | False (pre-match only) |
| `capturedAt` | Ingestion timestamp | Ingestion timestamp |

**Verdict: OddsSnapshot model is fully reusable. No migration required.**

The `matchId` FK links to the `Match` table regardless of whether the match came from The Odds API or PandaScore. The `OddsSnapshot` model has no `apiSource` field and does not need one.

#### 4.7.2 No schema migration needed

The sprint introduces no Prisma schema changes. The only database concern is the new `findManyWithTeamsByExternalIds` query on the Match table, which uses existing indexed fields (`externalId` is unique, `homeTeamId`/`awayTeamId` are indexed).

#### 4.7.3 Index adequacy

The existing `OddsSnapshot` indexes:
- `@@index([matchId])` — sufficient for reading all snapshots for a match
- `@@index([matchId, capturedAt])` — sufficient for time-series queries

No additional indexes are needed for the esports path.

---

### 4.8 Dependency Wiring

#### 4.8.1 `ingestion-dependencies.ts` (MODIFY)

**File:** `src/ingestion/bootstrap/ingestion-dependencies.ts`

Add to `IngestionDependencies` interface:
```typescript
readonly esportsOddsSnapshotWorker: EsportsOddsSnapshotWorker;
```

Add to factory function:
```typescript
// After pandascoreClient creation:
const oddspapiClient = createOddspapiClient(
  { apiKey: config.api.oddsPapiApiKey },
  redis,   // ← redis is already available (used for oddsFetchQueue)
  logger,
);

// New service (alongside existing oddsSnapshotService):
const esportsOddsSnapshotService = new EsportsOddsSnapshotIngestionService(
  oddspapiClient,
  matchRepository,          // already instantiated
  oddsSnapshotRepository,   // already instantiated
  logger,
);

// New worker:
const esportsOddsSnapshotWorker = new EsportsOddsSnapshotWorker(
  esportsOddsSnapshotService,
  logger,
);
```

Return the new worker in the `IngestionDependencies` object.

#### 4.8.2 `queue-registration.ts` (MODIFY)

**File:** `src/ingestion/queues/queue-registration.ts`

`createOddsFetchProcessor` currently accepts `(oddsSnapshotWorker, logger)`. Add `esportsOddsSnapshotWorker` parameter and extend the switch:

```typescript
export function createOddsFetchProcessor(
  oddsSnapshotWorker: OddsSnapshotWorker,
  esportsOddsSnapshotWorker: EsportsOddsSnapshotWorker,  // ← ADD
  logger: Logger,
): Processor {
  return async (job: Job) => {
    switch (job.name) {
      case ODDS_FETCH_JOB_NAMES.SYNC_ODDS_FOR_SPORT:
        return oddsSnapshotWorker.process(job);
      case ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS:         // ← ADD
        return esportsOddsSnapshotWorker.process(job);
      default:
        throw new Error(`Unknown odds-fetch job name: ${job.name}`);
    }
  };
}
```

#### 4.8.3 `ingestion-bootstrap.ts` (MODIFY)

The bootstrap file that calls `createOddsFetchProcessor` must pass the new worker. The exact change depends on the bootstrap file structure, but it will be a one-argument addition to the `createOddsFetchProcessor` call.

---

## 5. Match Correlation Algorithm

This is the highest-risk component in the sprint. OddsPapi's team names will frequently differ from PandaScore's team names.

### 5.1 Normalization function

```typescript
function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')  // remove all non-alphanumeric characters
    .trim();
}
```

Examples:
| Raw name | Normalized |
|----------|-----------|
| `"Natus Vincere"` | `"natusvincere"` |
| `"NaVi"` | `"navi"` |
| `"Cloud9"` | `"cloud9"` |
| `"Cloud 9"` | `"cloud9"` |
| `"FaZe Clan"` | `"fazeclan"` |
| `"FaZe"` | `"faze"` |
| `"G2 Esports"` | `"g2esports"` |
| `"G2"` | `"g2"` |

### 5.2 Correlation algorithm

```typescript
const CORRELATION_TIME_TOLERANCE_MS = 30 * 60 * 1000; // ±30 minutes

function correlateMatch(
  oddsMatch: OddspapiMatchOdds,
  dbMatches: DbMatchWithTeams[],
): DbMatchWithTeams | null {
  const oddsHome = normalizeTeamName(oddsMatch.home_team);
  const oddsAway = normalizeTeamName(oddsMatch.away_team);
  const oddsTime = new Date(oddsMatch.commence_time).getTime();

  for (const dbMatch of dbMatches) {
    const dbHome = normalizeTeamName(dbMatch.homeTeam.name);
    const dbAway = normalizeTeamName(dbMatch.awayTeam.name);
    const dbTime = dbMatch.startTime.getTime();

    const timeDiff = Math.abs(oddsTime - dbTime);

    // Exact name match + time within tolerance
    if (dbHome === oddsHome && dbAway === oddsAway && timeDiff <= CORRELATION_TIME_TOLERANCE_MS) {
      return dbMatch;
    }

    // Substring match for cases like "FaZe Clan" ↔ "FaZe"
    // (longer name must contain the shorter as a prefix/suffix)
    if (timeDiff <= CORRELATION_TIME_TOLERANCE_MS) {
      const homeMatch = dbHome.includes(oddsHome) || oddsHome.includes(dbHome);
      const awayMatch = dbAway.includes(oddsAway) || oddsAway.includes(dbAway);
      if (homeMatch && awayMatch) {
        return dbMatch;
      }
    }
  }

  return null;
}
```

### 5.3 Unmatched match handling

When `correlateMatch` returns `null`:
- **Do not throw.** Log at `debug` level with both team name sets for post-hoc inspection.
- Increment `oddsMatchesSkipped` counter in the result.
- Continue processing remaining matches.

A high `oddsMatchesSkipped` count in production logs indicates team name alias pairs that need to be added.

### 5.4 Known alias risks

| Provider A (PandaScore) | Provider B (OddsPapi likely) | Risk |
|------------------------|------------------------------|------|
| Natus Vincere | NaVi | HIGH — abbreviation |
| Team Liquid | Liquid | MEDIUM — word drop |
| FaZe Clan | FaZe | MEDIUM — word drop |
| Team Vitality | Vitality | MEDIUM — word drop |
| Fnatic | Fnatic | LOW — identical |
| G2 Esports | G2 | MEDIUM — word drop |
| Cloud9 | Cloud9 / Cloud 9 | LOW — normalization handles |

**Mitigation:** Log all unmatched OddsPapi team names on first occurrence. A future V2 enhancement can add an alias table (`src/integrations/oddspapi/team-aliases.ts`) mapping OddsPapi names to canonical names.

### 5.5 OddsPapi videogame key mapping

OddsPapi may use different game keys than PandaScore slugs. The mapping must be confirmed from OddsPapi docs:

```typescript
// src/integrations/oddspapi/game-key.map.ts
export const PANDASCORE_TO_ODDSPAPI_KEY: Record<EsportsVideogame, OddspapiVideogame | null> = {
  cs2:      'cs2',       // ⚠️ VERIFY: OddsPapi key for CS2
  dota2:    'dota2',     // ⚠️ VERIFY
  lol:      'lol',       // ⚠️ VERIFY
  valorant: 'valorant',  // ⚠️ VERIFY
  r6siege:  null,        // Not in V1 esports odds scope
  mlbb:     null,        // Not in V1 esports odds scope
};
```

The `EsportsOddsSnapshotIngestionService` uses this map to translate the PandaScore videogame key to the OddsPapi game key before calling the client.

---

## 6. OddsPapi Quota Protection

### 6.1 Protection layers (defense in depth)

| Layer | Mechanism | Where |
|-------|-----------|-------|
| 1 (pre-call check) | Redis counter check before each API call | `ResilientOddspapiClient` |
| 2 (post-call increment) | Redis counter increment after success | `ResilientOddspapiClient` |
| 3 (429 response handling) | Force counter to HARD_LIMIT on OddsPapi 429 | `DefaultOddspapiClient` |
| 4 (worker-level catch) | `QuotaExhaustedError` → graceful no-op completion | `EsportsOddsSnapshotWorker` |
| 5 (monitoring) | Log warning when usage ≥ SOFT_LIMIT (225) | `OddspapiQuotaTracker` |

### 6.2 Redis key design

```
Key:    oddspapi:quota:{YYYY}-{MM}
Type:   String (integer counter)
TTL:    31 days (set on first INCR of each month)
```

Month boundary: the key rotates automatically. On December 31 at 23:59, the key is `oddspapi:quota:2026-12`. On January 1 at 00:00, a new call writes to `oddspapi:quota:2027-01` with a fresh TTL.

### 6.3 Budget allocation per game

With 250 req/month and event-driven polling:

| Scenario | CS2 | Dota2 | LoL | Valorant | Total | % of limit |
|----------|-----|-------|-----|----------|-------|-----------|
| Minimum (quiet month) | 5 | 5 | 8 | 5 | 23 | 9% |
| Expected | 12 | 10 | 18 | 10 | 50 | 20% |
| Worst-case (all major events) | 25 | 20 | 30 | 20 | 95 | 38% |
| Absolute worst (back-to-back tournaments) | 40 | 35 | 50 | 35 | 160 | 64% |

Even at absolute worst case (160 req/month), there is 90 requests of headroom. This is the expected benefit of event-driven polling.

### 6.4 Development environment protection

During local development and staging, the same Redis quota counter applies. Risks:
- Running tests that hit OddsPapi live depletes production-month quota
- Recommendation: use a separate Redis DB or key namespace for non-production environments (`ENVIRONMENT=production` guards in the quota tracker key prefix)

---

## 7. Environment Variable Addition

**Required new variable:**

| Name | Required | Purpose |
|------|----------|---------|
| `ODDSPAPI_API_KEY` | ✅ Yes | Authentication for OddsPapi REST API |

**Files to update:**
- `src/config/api.config.ts` — add `ODDSPAPI_API_KEY` to Zod schema, map to `oddsPapiApiKey`
- `src/config/config.types.ts` — add `oddsPapiApiKey: string` to `ApiConfig` interface

**No other environment variables are needed.** OddsPapi's base URL is a constant; quota limits are constants in `oddspapi.config.ts`.

---

## 8. File Manifest

### New files

| File | Purpose |
|------|---------|
| `src/integrations/oddspapi/types.ts` | OddsPapi API response types + `OddspapiVideogame` union |
| `src/integrations/oddspapi/oddspapi.config.ts` | `OddspapiClientConfig` interface + `ODDSPAPI_DEFAULTS` constants |
| `src/integrations/oddspapi/oddspapi.client.ts` | `OddspapiClient` interface + `DefaultOddspapiClient` implementation |
| `src/integrations/oddspapi/oddspapi.resilient-client.ts` | Retry decorator wrapping `OddspapiClient` |
| `src/integrations/oddspapi/quota.tracker.ts` | `OddspapiQuotaTracker` — Redis-backed monthly counter |
| `src/integrations/oddspapi/oddspapi.factory.ts` | `createOddspapiClient` factory function |
| `src/integrations/oddspapi/game-key.map.ts` | PandaScore videogame slug → OddsPapi game key mapping |
| `src/integrations/oddspapi/index.ts` | Public exports for the integration module |
| `src/ingestion/services/esports-odds-ingestion.service.ts` | `EsportsOddsSnapshotIngestionService` |
| `src/ingestion/workers/esports-odds-snapshot.worker.ts` | `EsportsOddsSnapshotWorker` |

### Modified files

| File | Change |
|------|--------|
| `src/config/api.config.ts` | Add `ODDSPAPI_API_KEY` to Zod schema; map to `oddsPapiApiKey` |
| `src/config/config.types.ts` | Add `oddsPapiApiKey: string` to `ApiConfig` |
| `src/lib/errors/index.ts` (or equivalent) | Add `QuotaExhaustedError` class |
| `src/ingestion/contracts/queue-payload.types.ts` | Add `SyncEsportsOddsJobData`; add `OddsFetchJobPayload` union |
| `src/ingestion/contracts/index.ts` | Re-export `SyncEsportsOddsJobData` |
| `src/ingestion/services/types.ts` | Add `nearTermMatchExternalIds` to `EsportsMatchIngestionResult`; add `EsportsOddsIngestionResult` |
| `src/ingestion/services/match-ingestion.service.ts` | `ingestEsportsGame`: calculate + return `nearTermMatchExternalIds` |
| `src/ingestion/services/index.ts` | Export `EsportsOddsSnapshotIngestionService` |
| `src/ingestion/repositories/contracts/match.repository.ts` | Add `findManyWithTeamsByExternalIds` method signature |
| `src/ingestion/repositories/match.repository.ts` | Implement `findManyWithTeamsByExternalIds` |
| `src/ingestion/workers/match-ingestion.worker.ts` | `_handleEsportsGame`: enqueue `sync-esports-odds` when near-term matches + supported game |
| `src/ingestion/workers/index.ts` | Export `EsportsOddsSnapshotWorker` |
| `src/ingestion/queues/queue-names.ts` | Add `SYNC_ESPORTS_ODDS` to `ODDS_FETCH_JOB_NAMES` |
| `src/ingestion/queues/queue-registration.ts` | Add `esportsOddsSnapshotWorker` param + switch case |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | Wire OddsPapi client → service → worker; add `esportsOddsSnapshotWorker` to `IngestionDependencies` |
| `src/ingestion/bootstrap/ingestion-bootstrap.ts` | Pass `esportsOddsSnapshotWorker` to `createOddsFetchProcessor` |
| `src/ingestion/bootstrap/index.ts` | No change expected (existing exports cover new re-exports through their respective modules) |

**Total: 10 new files, 16 modified files.**

---

## 9. Monthly Request Estimates

### OddsPapi requests/month (event-driven)

| Scenario | CS2 | Dota2 | LoL | Valorant | Total | Free tier % |
|----------|-----|-------|-----|----------|-------|------------|
| Minimum (quiet) | 5 | 5 | 8 | 5 | **23** | 9% |
| Expected | 12 | 10 | 18 | 10 | **50** | 20% |
| Worst-case realistic | 25 | 20 | 30 | 20 | **95** | 38% |
| Absolute worst | 40 | 35 | 50 | 35 | **160** | 64% |

All scenarios are within the 250 req/month free tier. The hard budget cap at 225 requests prevents exceeding it.

### OddsPapi requests/month (fixed 2×/day — DO NOT IMPLEMENT)

For reference: 4 games × 2 polls/day × 30 days = **240 requests/month** (96% utilization, unsafe).

---

## 10. Risks

### Mapping Risks

| Risk | Description | Likelihood | Impact | Mitigation |
|------|-------------|-----------|--------|------------|
| **M-01 — Team name mismatch** | OddsPapi team names differ from PandaScore (abbreviations, word drops) | HIGH | Medium — affected matches get no odds | Log unmatched names; implement alias table in V2 |
| **M-02 — Start time mismatch** | OddsPapi and PandaScore report different times (timezone, rounding) | LOW | Low — 30-minute tolerance covers most cases | Widen tolerance to 60 minutes if needed |
| **M-03 — Game key mismatch** | OddsPapi game keys differ from assumed values | MEDIUM | HIGH — all calls return empty | Verify from OddsPapi docs before building client |
| **M-04 — Odds outcome format** | OddsPapi outcome names are `"home"`/`"away"` vs actual team names vs something else | MEDIUM | Medium — affects outcome field storage | Verify from OddsPapi docs; normalize to team name if possible |
| **M-05 — PandaScore match not yet in DB** | `sync-esports-odds` fires 5s after `sync-esports-game`; match DB writes may not be committed | LOW | Low — query returns 0 matches, job completes with no snapshots | Already mitigated by 5-second delay; log + skip gracefully |

### Provider Risks

| Risk | Description | Likelihood | Impact | Mitigation |
|------|-------------|-----------|--------|------------|
| **P-01 — OddsPapi free tier changes** | OddsPapi reduces quota or removes free tier | LOW | HIGH — sprint becomes blocked | Monitor OddsPapi pricing page; budget for paid tier |
| **P-02 — Coverage gaps** | OddsPapi has no odds for specific tournaments | MEDIUM | Low — those matches get no snapshots | Acceptable for V1; log gaps via correlation metrics |
| **P-03 — OddsPapi downtime** | OddsPapi has service outages | MEDIUM | Low — event-driven means no data for that window | Retry policy handles transient failures; no stale-data problem (snapshots are append-only) |
| **P-04 — API response structure changes** | OddsPapi changes field names between versions | LOW | Medium — TypeScript types break | Pin to specific API version in base URL; add integration test assertions |
| **P-05 — PandaScore ToS** | PandaScore terminates free tier access due to betting-related usage | LOW | HIGH — esports match data gone | Contact PandaScore for ToS clarification before expanding usage |

### Operational Risks

| Risk | Description | Likelihood | Impact | Mitigation |
|------|-------------|-----------|--------|------------|
| **O-01 — Quota counter Redis key loss** | Redis eviction or restart resets monthly counter | LOW | Medium — may allow calls past 250 | Set `maxmemory-policy noeviction` for the quota key namespace; monitor counter |
| **O-02 — Development calls deplete production quota** | Dev/staging environments hit live OddsPapi API | MEDIUM | Medium — quota wasted on test traffic | Add environment prefix to Redis quota key (`prod:oddspapi:quota:...` vs `dev:...`) |
| **O-03 — BullMQ job retry storm** | Many failed jobs retry simultaneously after an OddsPapi outage | LOW | Medium — multiple quota requests in burst | `attempts: 2` limit prevents storm; quota check prevents over-call |
| **O-04 — Missing `ODDSPAPI_API_KEY`** | Key not set in environment; app fails startup | MEDIUM | HIGH — entire application crashes on startup | Zod validation in `api.config.ts` catches this at startup before any jobs fire |
| **O-05 — `oddsFetchQueue` not passed to EsportsOddsSnapshotWorker` | Wiring error in ingestion-dependencies.ts | LOW | Medium — no esports odds jobs fired | `npx tsc --noEmit` will catch injection errors; integration test coverage |

---

## 11. Implementation Order

The following order ensures each task produces a working TypeScript-clean state before the next begins.

| Step | Task | Files | Validates via |
|------|------|-------|---------------|
| 1 | Add `QuotaExhaustedError` to error hierarchy | `src/lib/errors/` | `tsc --noEmit` |
| 2 | Add `ODDSPAPI_API_KEY` to config | `api.config.ts`, `config.types.ts` | `tsc --noEmit`; startup validation |
| 3 | Build OddsPapi integration module | `src/integrations/oddspapi/**` | `tsc --noEmit`; ESLint |
| 4 | Add `SyncEsportsOddsJobData` + `SYNC_ESPORTS_ODDS` job name | contracts, queue-names | `tsc --noEmit` |
| 5 | Add `nearTermMatchExternalIds` to `EsportsMatchIngestionResult` + update service | `match-ingestion.service.ts`, `services/types.ts` | `tsc --noEmit` (compiler will surface all callers that need updating) |
| 6 | Add `findManyWithTeamsByExternalIds` to MatchRepository | `contracts/match.repository.ts`, `match.repository.ts` | `tsc --noEmit` |
| 7 | Build `EsportsOddsSnapshotIngestionService` | `esports-odds-ingestion.service.ts`, `services/types.ts` | `tsc --noEmit` |
| 8 | Build `EsportsOddsSnapshotWorker` | `esports-odds-snapshot.worker.ts` | `tsc --noEmit` |
| 9 | Update `MatchIngestionWorker._handleEsportsGame` to enqueue odds job | `match-ingestion.worker.ts` | `tsc --noEmit` |
| 10 | Register worker in queue-registration + bootstrap | `queue-registration.ts`, `ingestion-dependencies.ts`, `ingestion-bootstrap.ts` | `tsc --noEmit`; full wiring review |
| 11 | Run `npx tsc --noEmit` and ESLint on all modified files | All | Zero errors, zero warnings |
| 12 | Create `SPRINT5-ESPORTS-ODDS-REMEDIATION.md` audit document | docs/ | Post-implementation |

**Critical path:** Steps 1–4 have no interdependencies and can be done in parallel. Step 5 must complete before Step 9. Steps 6–8 must complete before Step 10.

---

## 12. Pre-Implementation Checklist

Before writing a single line of code, the following must be confirmed:

- [ ] **OddsPapi base URL** — confirm exact base URL from official documentation
- [ ] **OddsPapi authentication method** — Bearer header, query param, or other
- [ ] **OddsPapi endpoint path** for fetching current odds by game
- [ ] **OddsPapi game key strings** for CS2, Dota2, LoL, Valorant
- [ ] **OddsPapi response field names** for home_team, away_team, commence_time, bookmaker key
- [ ] **OddsPapi outcome format** — `"home"`/`"away"` labels vs actual team names
- [ ] **OddsPapi quota headers** — confirm whether any quota info is returned in headers
- [ ] **PandaScore ToS** — written clarification before expanding esports match data usage
- [ ] **Redis availability** — confirm Redis is accessible from the application (needed for quota counter)

Items that can be resolved via a single OddsPapi API test call during development setup:
- All of the above except PandaScore ToS and Redis availability

---

## Appendix: Parallel Traditional Odds Path (Reference)

For comparison, here is the equivalent traditional sports path that Sprint 5 mirrors:

```
sync-traditional-sport
  → MatchIngestionService.ingestTraditionalSport(sportKey, sport)
  → returns nearTermMatchExternalIds (["oa:uuid1", "oa:uuid2"])
  → oddsFetchQueue.add('sync-odds-for-sport', { sportKey, sportGroup, matchExternalIds })

sync-odds-for-sport
  → OddsSnapshotWorker.process(job)
  → OddsSnapshotIngestionService.ingestOddsForSport(sportKey, sport, matchExternalIds)
  → oddsApiClient.getOdds(sportKey, { eventIds: '...', markets: 'h2h', regions: 'eu' })
  → match lookup by "oa:"-prefixed externalId (direct, no correlation needed — same source)
  → OddsSnapshotRepository.insertMany(snapshots)
```

The esports path differs in exactly two ways:
1. **Provider:** OddsPapi instead of The Odds API (different client, different quota model)
2. **Correlation:** Match IDs cannot be used directly — team name + time matching required (different sources)

Everything else — the canonical snapshot shape, the repository, the queue pattern, the 5-second delay, the append-only snapshot model — is identical.
