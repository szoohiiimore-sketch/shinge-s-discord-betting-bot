# Sprint 5 — Esports Odds Implementation Plan (Revised)

**Date:** 2026-06-07
**Supersedes:** `docs/audits/SPRINT5-ESPORTS-ODDS-IMPLEMENTATION-PLAN.md`
**Audit source:** `docs/audits/SPRINT5-IMPLEMENTATION-AUDIT.md`
**Scope:** End-to-end esports odds ingestion via OddsPapi — with all audit findings incorporated.
**Constraint:** No implementation in this document. Plan only.

---

## Audit Remediation Summary

This plan incorporates all mandatory and recommended fixes from the Sprint 5 pre-implementation audit:

| Fix | Issue | Change |
|-----|-------|--------|
| C-01 | Quota overconsumption (25–100× estimate) | Per-game Redis cooldown (4h) in `MatchIngestionWorker` |
| C-02 | TOCTOU race on quota counter | Atomic INCR-before-call via Lua script in `OddspapiQuotaTracker` |
| H-01 | `writtenMatches` pseudocode error | Near-term filter uses `plans` array (matches `ingestTraditionalSport`) |
| H-02 | `MatchIngestionWorker` has no Redis | `Redis` added to constructor; wired in `ingestion-dependencies.ts` |
| H-04 | No BullMQ job deduplication | `jobId: 'sync-esports-odds:{videogame}'` added to enqueue call |
| M-01 | INCR + EXPIRE not atomic | Lua script handles both atomically |
| M-02 | Substring false positives + NaVi problem | Team alias system shipped in Sprint 5 |
| M-03 | Soft limit comment contradicts behavior | Comment corrected |
| M-04 | Bootstrap changes underspecified | Three concrete bootstrap lines fully specified |
| M-05 | Near-term lower bound undocumented | Aligned with traditional path (no lower bound) |
| L-02 | `EsportsGameSyncResult` comment stale | Comment updated |
| L-03 | Bootstrap log missing new job name | `'sync-esports-odds'` added to startup log |

---

## 1. Summary

This sprint adds the missing esports odds pipeline to a codebase that already has:
- PandaScore match data ingestion for CS2, Dota2, LoL, Valorant, R6 Siege, MLBB (complete)
- Traditional odds ingestion via The Odds API (complete)
- OddsSnapshot database model (reusable as-is)

After Sprint 5, the `sync-esports-game` job will enqueue `sync-esports-odds` when near-term esports matches exist **and** a per-game cooldown has expired. OddsPapi will be called to fetch current h2h odds for those matches. OddsSnapshot records will be written to the same table used by traditional sports.

V1 esports odds scope: **CS2, Dota 2, LoL, Valorant only.**
R6 Siege and MLBB: PandaScore match data continues; OddsPapi odds integration excluded from V1.

---

## 2. Current State

### What exists

```
PandaScore → MatchIngestionService.ingestEsportsGame
           → Sport / League / Team / Match upserts
           → EsportsMatchIngestionResult (no nearTermMatchExternalIds)
           → MatchIngestionWorker._handleEsportsGame
           → RETURNS — no odds job enqueued
```

### What is missing

| Component | Status |
|-----------|--------|
| OddsPapi HTTP client | ❌ Not built |
| OddsPapi quota tracker (atomic) | ❌ Not built |
| Team alias resolution system | ❌ Not built |
| `SyncEsportsOddsJobData` contract type | ❌ Not defined |
| `sync-esports-odds` job name | ❌ Not registered |
| `EsportsOddsSnapshotIngestionService` | ❌ Not built |
| `EsportsOddsSnapshotWorker` | ❌ Not built |
| `nearTermMatchExternalIds` in `EsportsMatchIngestionResult` | ❌ Missing |
| Per-game Redis cooldown in `_handleEsportsGame` | ❌ Not wired |
| Redis injection in `MatchIngestionWorker` | ❌ Not present |
| `ODDSPAPI_API_KEY` environment variable | ❌ Not in config |

### What is reusable without changes

| Component | Notes |
|-----------|-------|
| `OddsSnapshot` Prisma model | Source-agnostic; no new fields required |
| `OddsSnapshotRepository.insertMany` | Works for any `CanonicalOddsSnapshot` source |
| `CanonicalOddsSnapshot` type | `matchExternalId` holds the `ps:` ID; same structure |
| `IngestionOddsMarket` type | `'H2H'` covers all esports needs |
| `NEAR_TERM_WINDOW_MS` constant | 48h window applies equally to esports |
| Error hierarchy (`ExternalApiError`, `RateLimitError`, etc.) | Full reuse |
| BullMQ wiring patterns (`DEFAULT_JOB_OPTIONS`, `QueueName`) | Full reuse |
| `_oddsFetchQueue` in `MatchIngestionWorker` | Already injected — Sprint 4 Phase 2E |

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
                  + nearTermMatchExternalIds  ← from plans array, no lower bound
    │
    ├─ nearTermMatchExternalIds.length === 0 → DONE
    ├─ videogame not in ODDSPAPI_SUPPORTED_GAMES → DONE
    │
    └─ near-term matches exist AND game is supported
           │
           ▼
       Redis GET {env}:esports-odds-cooldown:{videogame}
           │
           ├─ cooldown active (< 4h since last enqueue) → log debug → DONE
           │
           └─ cooldown expired or key absent
                  │
                  ▼
              oddsFetchQueue.add('sync-esports-odds', payload, {
                jobId: 'sync-esports-odds:{videogame}',   ← BullMQ deduplication
                delay: 5000,
                attempts: 2,
              })
                  │
                  ▼
              Redis SET {env}:esports-odds-cooldown:{videogame}
                  = Date.now(), EX 14400 (4 hours)
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
           ├─ Load DB Match records with team names by ps: IDs
           │
           ├─ ResilientOddspapiClient.getOddsForGame(videogame)
           │    │
           │    ├─ Lua INCR+EXPIRE → newCount
           │    ├─ newCount > HARD_LIMIT → decrement() → QuotaExhaustedError
           │    ├─ newCount ≥ SOFT_LIMIT → log warning, proceed
           │    ├─ DefaultOddspapiClient.getOddsForGame(videogame)    ← 1 HTTP call
           │    └─ on 429 → forceExhaust() → QuotaExhaustedError
           │
           ├─ For each OddsPapi match:
           │    normalizeTeamName → resolveAlias → correlate to DB Match
           │    [exact match first, then MIN_LEN=4 substring fallback]
           │    [±30min time tolerance]
           │
           └─ OddsSnapshotRepository.insertMany(snapshots)
```

---

## 4. Component Designs

---

### 4.1 OddsPapi Integration Module

#### 4.1.1 Type Definitions

**File:** `src/integrations/oddspapi/types.ts`

```typescript
/**
 * Esports game identifiers as used by OddsPapi.
 * ⚠️ VERIFY: confirm OddsPapi's exact game key strings before building the client.
 * These may differ from PandaScore slugs (e.g. 'cs2' vs 'counter-strike').
 */
export type OddspapiVideogame = 'cs2' | 'dota2' | 'lol' | 'valorant';

export interface OddspapiOutcome {
  readonly name: 'home' | 'away';  // ⚠️ VERIFY: may be team name string
  readonly price: number;           // decimal odds
}

export interface OddspapiBookmaker {
  readonly key: string;             // e.g. 'pinnacle', 'bet365'
  readonly title: string;
  readonly outcomes: readonly OddspapiOutcome[];
}

export interface OddspapiMatchOdds {
  readonly id: string;              // OddsPapi internal match ID (NOT shared with PandaScore)
  readonly game: OddspapiVideogame;
  readonly home_team: string;       // ⚠️ VERIFY: exact field name
  readonly away_team: string;       // ⚠️ VERIFY: exact field name
  readonly commence_time: string;   // ISO 8601
  readonly bookmakers: readonly OddspapiBookmaker[];
}

export type GetOddsForGameResponse = readonly OddspapiMatchOdds[];
```

> **⚠️ API Verification Checklist — must be confirmed before coding begins:**
> 1. Base URL (e.g. `https://api.oddspapi.com`)
> 2. Auth method (header `Authorization: Bearer {key}` or query `?apiKey={key}`)
> 3. Game key strings for CS2, Dota2, LoL, Valorant
> 4. Endpoint path for pre-match odds (e.g. `/v2/odds?game={key}`)
> 5. Whether endpoint supports filtering by match ID (or returns all for a game)
> 6. Response field names for home team, away team, start time
> 7. Whether any quota usage is returned in response headers

#### 4.1.2 Client Configuration

**File:** `src/integrations/oddspapi/oddspapi.config.ts`

```typescript
export interface OddspapiClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export const ODDSPAPI_DEFAULTS = {
  BASE_URL: 'https://api.oddspapi.com',  // ⚠️ VERIFY
  TIMEOUT_MS: 15_000,
  QUOTA_SOFT_LIMIT: 225,   // 90% — log warning, continue making calls
  QUOTA_HARD_LIMIT: 250,   // 100% — reject unconditionally
  COOLDOWN_MS: 4 * 60 * 60 * 1000,  // 4-hour per-game cooldown
} as const;
```

**Note on soft limit comment:** The soft limit does NOT stop calls — it triggers a warning log only. Calls are blocked only at the hard limit. This is intentional: the soft limit exists to surface approaching exhaustion in logs before it becomes operational.

#### 4.1.3 OddsPapi Client Interface and Default Implementation

**File:** `src/integrations/oddspapi/oddspapi.client.ts`

```typescript
export interface OddspapiClient {
  getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]>;
}

export class DefaultOddspapiClient implements OddspapiClient {
  constructor(config: OddspapiClientConfig, logger: Logger) { ... }

  async getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]> {
    const params = new URLSearchParams({ game: videogame });
    const response = await this._request('/v2/odds', params);  // ⚠️ VERIFY path
    return response as OddspapiMatchOdds[];
  }
}
```

Follows the exact same pattern as `DefaultOddsApiClient`:
- `native fetch` + `AbortController` timeout
- Error translation: 401/403 → `AuthenticationError`, 429 → `RateLimitError`, 5xx → `ExternalApiError(retryable: true)`, timeout → `ExternalApiError(retryable: true)`

#### 4.1.4 OddsPapi Quota Tracker (Atomic Design)

**File:** `src/integrations/oddspapi/quota.tracker.ts`

The OddsPapi free tier provides **no** response headers for remaining quota. All tracking is internal via Redis.

**Design: Atomic INCR via Lua script**

The original check-then-increment pattern is a TOCTOU race. The revised design uses atomic INCR-before-call: increment first, then check the returned value. If over limit, decrement and throw. Redis `INCR` is atomic — only one caller can receive a specific count value.

```typescript
export class OddspapiQuotaTracker {
  private readonly _redis: Redis;
  private readonly _softLimit: number;
  private readonly _hardLimit: number;

  constructor(redis: Redis, softLimit: number, hardLimit: number) {
    this._redis = redis;
    this._softLimit = softLimit;
    this._hardLimit = hardLimit;
  }

  /**
   * Redis key for the current calendar month.
   * Format: "oddspapi:quota:2026-06"
   * Rotates automatically at month boundary.
   */
  private _monthlyKey(): string {
    const now = new Date();
    return `oddspapi:quota:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Atomically increments the monthly counter and returns the new count.
   * Uses a Lua script to ensure INCR and EXPIRE are applied in the same
   * Redis operation — prevents the key from persisting without a TTL if
   * the process crashes between two separate commands.
   *
   * TTL of 31 days is set only on the first increment of each month key
   * to avoid resetting the TTL on every call.
   */
  async incrementAndCheck(): Promise<number> {
    const luaScript = `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return count
    `;
    const ttlSeconds = 31 * 86400;
    const result = await this._redis.eval(luaScript, 1, this._monthlyKey(), ttlSeconds);
    return result as number;
  }

  /**
   * Decrements the monthly counter.
   * Called when incrementAndCheck() shows the limit is exceeded, to undo
   * the pre-increment before throwing QuotaExhaustedError.
   */
  async decrement(): Promise<void> {
    await this._redis.decr(this._monthlyKey());
  }

  /**
   * Forces the counter to HARD_LIMIT.
   * Called when OddsPapi returns a 429 — the API has confirmed quota is
   * exhausted, so future calls should be rejected immediately.
   */
  async forceExhaust(): Promise<void> {
    await this._redis.set(this._monthlyKey(), String(this._hardLimit), 'EX', 31 * 86400);
  }

  /** Returns the current monthly usage for monitoring/logging. */
  async getMonthlyUsage(): Promise<number> {
    const raw = await this._redis.get(this._monthlyKey());
    return raw ? parseInt(raw, 10) : 0;
  }

  getSoftLimit(): number { return this._softLimit; }
  getHardLimit(): number { return this._hardLimit; }
}
```

#### 4.1.5 Resilient OddsPapi Client

**File:** `src/integrations/oddspapi/oddspapi.resilient-client.ts`

The resilient client owns the quota check/increment lifecycle using the atomic pattern:

```typescript
export class ResilientOddspapiClient implements OddspapiClient {
  constructor(
    private readonly _inner: OddspapiClient,
    private readonly _quotaTracker: OddspapiQuotaTracker,
    private readonly _logger: Logger,
  ) {}

  async getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]> {
    // Step 1: Atomically increment BEFORE calling the API.
    // If the result exceeds the hard limit, undo and reject.
    const newCount = await this._quotaTracker.incrementAndCheck();

    if (newCount > this._quotaTracker.getHardLimit()) {
      await this._quotaTracker.decrement();
      throw new QuotaExhaustedError(
        'OddsPapi',
        this._quotaTracker.getHardLimit(),
        newCount - 1,
      );
    }

    if (newCount >= this._quotaTracker.getSoftLimit()) {
      this._logger.warn(
        { used: newCount, limit: this._quotaTracker.getHardLimit() },
        'OddsPapi quota warning — approaching monthly limit',
      );
    }

    // Step 2: Call the API. Counter is already incremented.
    // A timeout or 5xx leaves the counter incremented — this is correct:
    // the API received the request, and the slot was consumed.
    try {
      return await this._inner.getOddsForGame(videogame);
    } catch (error) {
      if (error instanceof RateLimitError) {
        // OddsPapi 429 means our internal counter is incorrect — sync it.
        await this._quotaTracker.forceExhaust();
        throw new QuotaExhaustedError(
          'OddsPapi',
          this._quotaTracker.getHardLimit(),
          this._quotaTracker.getHardLimit(),
        );
      }
      throw error;
    }
  }
}
```

**Retry policy:** `attempts: 2` (1 retry) is set at the BullMQ job level (§4.3.2), not in the resilient client. The resilient client does not implement its own retry loop — BullMQ retry re-executes the full worker `process()` method, which re-enters `ResilientOddspapiClient` and goes through the quota gate again. This is correct: each attempt consumes quota whether it succeeds or fails.

#### 4.1.6 Game Key Map

**File:** `src/integrations/oddspapi/game-key.map.ts`

```typescript
export const PANDASCORE_TO_ODDSPAPI_KEY: Record<EsportsVideogame, OddspapiVideogame | null> = {
  cs2:      'cs2',       // ⚠️ VERIFY: OddsPapi key for CS2
  dota2:    'dota2',     // ⚠️ VERIFY
  lol:      'lol',       // ⚠️ VERIFY
  valorant: 'valorant',  // ⚠️ VERIFY
  r6siege:  null,        // Not in V1 esports odds scope
  mlbb:     null,        // Not in V1 esports odds scope
};

/**
 * Games that have OddsPapi odds coverage in V1.
 * R6 Siege and MLBB have PandaScore match data but no OddsPapi odds.
 */
export const ODDSPAPI_SUPPORTED_GAMES: ReadonlySet<EsportsVideogame> =
  new Set(['cs2', 'dota2', 'lol', 'valorant']);
```

#### 4.1.7 Team Alias System

**File:** `src/integrations/oddspapi/team-aliases.ts`

OddsPapi and PandaScore represent the same esports organizations under different names. The alias system resolves both sides of any pair to a single canonical normalized form before comparison.

**How it works:**
1. Both the OddsPapi team name and the PandaScore team name are normalized (lowercase, non-alphanumeric removed)
2. Both normalized names are passed through `resolveAlias()`
3. The resolved forms are compared — if they match, the teams are the same

```typescript
/**
 * Maps normalized team name variants to their canonical normalized form.
 *
 * Entry format: [normalized-variant, canonical-normalized-form]
 *
 * Only the non-canonical form needs an entry. The canonical form is used
 * as both the map value and implicitly as the result when no entry exists.
 *
 * Examples:
 *   OddsPapi "NaVi" → normalized "navi" → alias → "natusvincere"
 *   PandaScore "Natus Vincere" → normalized "natusvincere" → no alias → "natusvincere"
 *   Both resolve to "natusvincere" → match ✓
 *
 *   OddsPapi "FaZe" → normalized "faze" → alias → "fazeclan"
 *   PandaScore "FaZe Clan" → normalized "fazeclan" → no alias → "fazeclan"
 *   Both resolve to "fazeclan" → match ✓
 */
export const TEAM_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  // Abbreviation → full canonical
  ['navi', 'natusvincere'],
  ['liquid', 'teamliquid'],
  ['vitality', 'teamvitality'],
  ['faze', 'fazeclan'],
  ['g2', 'g2esports'],
  ['falcons', 'teamfalcons'],
  // LoL regional abbreviations
  ['rng', 'royalnevergiveup'],       // ⚠️ VERIFY PandaScore canonical name
  ['t1', 't1'],                       // Self-entry: prevents substring false-positive with "t10esports"
  // Add further entries from production correlation logs as they surface
]);

export function resolveAlias(normalized: string): string {
  return TEAM_ALIASES.get(normalized) ?? normalized;
}
```

**Note on `['t1', 't1']` self-entry:** T1 (Korean team) normalized is `"t1"`, which is only 2 characters. The MIN_SUBSTRING_LEN=4 guard in the correlation algorithm already prevents it from matching `"t10esports"` via substring. The self-entry is defensive documentation — it signals that T1 is a known short-name risk.

#### 4.1.8 Factory Function

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
export interface SyncEsportsOddsJobData {
  readonly videogame: EsportsVideogame;
  /**
   * "ps:"-prefixed match external IDs from the preceding sync-esports-game job.
   * Only the 4 OddsPapi-supported games appear here.
   */
  readonly matchExternalIds: readonly string[];
}
```

Add to `OddsFetchJobPayload` discriminated union (new or extend existing):

```typescript
export type OddsFetchJobPayload =
  | { readonly name: 'sync-odds-for-sport'; readonly data: SyncOddsForSportJobData }
  | { readonly name: 'sync-esports-odds';   readonly data: SyncEsportsOddsJobData };
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
export interface EsportsOddsIngestionResult {
  readonly videogame: EsportsVideogame;
  readonly oddsMatchesReceived: number;
  readonly oddsMatchesCorrelated: number;
  readonly oddsMatchesSkipped: number;
  readonly oddsSnapshots: EntityWriteOutcome;
  readonly quotaUsedThisCall: number;  // 1 if call made, 0 if quota-gated
  readonly errors: readonly SyncError[];
  readonly durationMs: number;
}
```

#### 4.2.4 New: `QuotaExhaustedError`

**File:** `src/lib/errors/index.ts` (ADD)

```typescript
/**
 * Thrown when an external API's monthly quota has been exhausted.
 * Non-retryable — retrying would consume quota that doesn't exist.
 * Workers catching this error should complete the job gracefully (not fail).
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

#### 4.3.1 New Job Name

**File:** `src/ingestion/queues/queue-names.ts` (MODIFY)

```typescript
export const ODDS_FETCH_JOB_NAMES = {
  SYNC_ODDS_FOR_SPORT: 'sync-odds-for-sport',
  SYNC_ESPORTS_ODDS:   'sync-esports-odds',    // ← ADD
} as const;
```

#### 4.3.2 BullMQ Job Options

`sync-esports-odds` jobs use the following options at enqueue time:

```typescript
await this._oddsFetchQueue.add(
  ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS,
  payload,
  {
    jobId: `sync-esports-odds:${videogame}`,  // BullMQ deduplication — if same ID is already
                                               // waiting/delayed, the add() is a no-op.
    delay: 5000,
    attempts: 2,                              // original + 1 retry maximum
    backoff: {
      type: 'fixed',
      delay: 30_000,                          // 30-second fixed backoff
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
);
```

**Deduplication mechanics:** BullMQ scopes `jobId` deduplication to the queue. A second `add()` call with `jobId: 'sync-esports-odds:cs2'` is silently dropped if that job is already in `waiting`, `delayed`, or `active` state. Once the job completes or fails and is removed, the ID is cleared and the next `add()` creates a fresh job. This is correct behavior.

**Retry policy rationale:** `attempts: 2` (1 retry) because each failed attempt that reaches the API increments the quota counter. Fixed backoff because the likely failure mode is a transient 5xx, not overload. `QuotaExhaustedError` is caught at the worker level and resolves as graceful success — BullMQ never sees it as a failure.

**`DEFAULT_JOB_OPTIONS` compatibility:** `DEFAULT_JOB_OPTIONS` contains only `removeOnComplete: { age: 3600 }` and `removeOnFail: { age: 86_400 }`. No `attempts` field. The per-job `attempts: 2` is additive and does not conflict. The per-job `removeOnComplete: { count: 100 }` takes precedence over the queue default. ✓

#### 4.3.3 Queue Placement

`sync-esports-odds` runs on the **existing `odds-fetch` queue** (`QueueName.ODDS_FETCH`). A separate queue is not warranted:
- Volume is low (≤ 250 jobs/month for 4 games combined)
- The existing processor dispatches via `switch (job.name)` — adding a case is trivial
- New queue = new `QueueName`, new processor, new `Worker` instantiation — unjustified overhead

---

### 4.4 Service Design

#### 4.4.1 `EsportsOddsSnapshotIngestionService`

**File:** `src/ingestion/services/esports-odds-ingestion.service.ts`

```typescript
export class EsportsOddsSnapshotIngestionService {
  constructor(
    private readonly _oddspapiClient: OddspapiClient,
    private readonly _matchRepository: MatchRepository,
    private readonly _oddsSnapshotRepository: OddsSnapshotRepository,
    private readonly _logger: Logger,
  ) {}

  async ingestOddsForGame(
    videogame: EsportsVideogame,
    matchExternalIds: readonly string[],
  ): Promise<EsportsOddsIngestionResult> { ... }
}
```

#### 4.4.2 `ingestOddsForGame` Algorithm

```
1. VALIDATE INPUTS
   - Filter matchExternalIds to only "ps:"-prefixed IDs
   - Return empty result if none remain

2. LOAD DB MATCHES (free — no API cost)
   - matchRepository.findManyWithTeamsByExternalIds(psIds)
   - Returns: Array<{ id, externalId, startTime, homeTeam: { name }, awayTeam: { name } }>
   - If 0 results: log warning + return empty result (match writes may not be committed yet)

3. FETCH ODDS FROM ODDSPAPI (quota-consuming — exactly 1 call per invocation)
   - oddspapiClient.getOddsForGame(PANDASCORE_TO_ODDSPAPI_KEY[videogame])
   - If quota exhausted: ResilientOddspapiClient throws QuotaExhaustedError
     → propagated up, caught by EsportsOddsSnapshotWorker (§4.5.3)

4. CORRELATE ODDSPAPI MATCHES TO DB MATCHES
   - For each OddsPapi match:
       a. normalizeTeamName(oddsMatch.home_team) → resolveAlias() → oddsHome
       b. normalizeTeamName(oddsMatch.away_team) → resolveAlias() → oddsAway
       c. oddsTime = new Date(oddsMatch.commence_time).getTime()
       d. For each dbMatch:
            dbHome = resolveAlias(normalizeTeamName(dbMatch.homeTeam.name))
            dbAway = resolveAlias(normalizeTeamName(dbMatch.awayTeam.name))
            timeDiff = abs(oddsTime - dbMatch.startTime.getTime())
            — if timeDiff > CORRELATION_TIME_TOLERANCE_MS: skip
            — if dbHome === oddsHome && dbAway === oddsAway: MATCH (exact)
            — else if MIN_LEN satisfied: try substring match (see §5)
       e. No match found: log debug with both team name pairs + increment skipped

5. BUILD CANONICAL ODDS SNAPSHOTS
   - For each correlated (oddsMatch, dbMatch) pair:
       capturedAt = now
       For each bookmaker in oddsMatch.bookmakers:
         For each outcome in bookmaker.outcomes:
           CanonicalOddsSnapshot {
             matchExternalId: dbMatch.externalId  ("ps:xxx")
             bookmaker: bookmaker.key
             market: 'H2H'
             outcome: outcome.name
             price: outcome.price
             isMain: bookmaker.key === 'pinnacle'
             isLive: false
             capturedAt
           }

6. PERSIST
   - oddsSnapshotRepository.insertMany(snapshots)

7. RETURN EsportsOddsIngestionResult
```

#### 4.4.3 `MatchRepository` Extension

The existing `MatchRepository` interface has no method to load matches with team names. A new method must be added.

**Interface:** `src/ingestion/repositories/contracts/match.repository.ts` (MODIFY)

```typescript
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

**Implementation:** `src/ingestion/repositories/match.repository.ts` (MODIFY)

```typescript
async findManyWithTeamsByExternalIds(externalIds: readonly string[]) {
  return this._prisma.match.findMany({
    where: { externalId: { in: [...externalIds] } },
    select: {
      id: true,
      externalId: true,
      startTime: true,
      homeTeam: { select: { id: true, name: true } },
      awayTeam: { select: { id: true, name: true } },
    },
  });
}
```

This query is an indexed lookup on the `externalId` unique field. No performance concern at the scale of < 20 matches per call.

---

### 4.5 Worker Design

#### 4.5.1 `EsportsOddsSnapshotWorker`

**File:** `src/ingestion/workers/esports-odds-snapshot.worker.ts`

```typescript
export class EsportsOddsSnapshotWorker {
  constructor(
    private readonly _service: EsportsOddsSnapshotIngestionService,
    private readonly _logger: Logger,
  ) {
    this._logger = logger.child({ worker: 'EsportsOddsSnapshotWorker' });
  }

  async process(job: Job<SyncEsportsOddsJobData>): Promise<EsportsOddsIngestionResult> { ... }
}
```

#### 4.5.2 `process` Implementation

```
1. Extract: videogame, matchExternalIds from job.data
2. Log: { jobId, videogame, matchCount } 'Processing esports odds job'
3. Guard: if matchExternalIds.length === 0 → log + return empty result
4. try {
     result = await service.ingestOddsForGame(videogame, matchExternalIds)
   } catch (error) {
     if QuotaExhaustedError → handle gracefully (§4.5.3)
     else → throw (BullMQ retry + eventual failure queue)
   }
5. Log: { oddsMatchesReceived, oddsMatchesCorrelated, oddsMatchesSkipped,
          oddsSnapshots, durationMs } 'Esports odds job complete'
6. Return result
```

#### 4.5.3 Quota Exhaustion Handling

`QuotaExhaustedError` is a known operational state, not a bug. The worker catches it and returns a graceful zero-work result. BullMQ sees a successful completion — the job does not move to the failed queue and does not retry.

```typescript
} catch (error) {
  if (error instanceof QuotaExhaustedError) {
    this._logger.warn(
      { videogame, provider: error.provider, usage: error.currentUsage, limit: error.monthlyLimit },
      'OddsPapi quota exhausted — skipping esports odds for remainder of month',
    );
    return {
      videogame,
      oddsMatchesReceived: 0,
      oddsMatchesCorrelated: 0,
      oddsMatchesSkipped: 0,
      oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
      quotaUsedThisCall: 0,
      errors: [],
      durationMs: 0,
    };
  }
  throw error;
}
```

---

### 4.6 Event-Driven Trigger Changes

#### 4.6.1 `MatchIngestionService.ingestEsportsGame` (MODIFY)

**File:** `src/ingestion/services/match-ingestion.service.ts`

Near-term ID calculation must use the `plans: PandascoreIngestionPlan[]` array — the same array used by `ingestTraditionalSport`. The `upsertMany` result contains only internal UUIDs and write actions; it does not contain `startTime` or `externalId`.

**Correct implementation:**

```typescript
// Mirror of the ingestTraditionalSport pattern:
const capturedAt = new Date();
const cutoff = new Date(capturedAt.getTime() + NEAR_TERM_WINDOW_MS);
const nearTermMatchExternalIds = plans
  .filter(p => p.match.startTime <= cutoff)   // no lower bound — includes running matches
  .map(p => p.match.externalId);
```

**Design decision on lower bound:** The esports path aligns with the traditional path — no lower bound is applied. This means currently-running matches (returned by PandaScore's `getRunningMatches`) are included in `nearTermMatchExternalIds`. OddsPapi is a pre-match odds source (`isLive = false`), so in-progress matches will typically have no or limited odds returned. Including them is harmless; their snapshots will either write real data (if OddsPapi still lists them) or the correlation step will skip them with no impact.

Maintaining a consistent filter across both paths avoids a subtle gotcha for future maintainers.

#### 4.6.2 `MatchIngestionWorker._handleEsportsGame` (MODIFY)

**File:** `src/ingestion/workers/match-ingestion.worker.ts`

**Constructor change (H-02 fix):**

```typescript
export class MatchIngestionWorker {
  private readonly _service: MatchIngestionService;
  private readonly _oddsFetchQueue: Queue;
  private readonly _redis: Redis;     // ← NEW: required for cooldown key
  private readonly _logger: Logger;

  constructor(
    service: MatchIngestionService,
    oddsFetchQueue: Queue,
    redis: Redis,                     // ← NEW
    logger: Logger,
  ) {
    this._service = service;
    this._oddsFetchQueue = oddsFetchQueue;
    this._redis = redis;
    this._logger = logger.child({ worker: 'MatchIngestionWorker' });
  }
  // ...
}
```

**Constants (add at top of file):**

```typescript
const ESPORTS_ODDS_COOLDOWN_MS = ODDSPAPI_DEFAULTS.COOLDOWN_MS; // 4 hours

// Environments where Redis keys should be isolated.
// Sourced from config at construction time if available; otherwise derived from NODE_ENV.
// Prevents dev/staging quota tracker from sharing keys with production.
const ENV_PREFIX = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
```

**Updated `_handleEsportsGame` (C-01 + H-04 fixes):**

```typescript
private async _handleEsportsGame(
  jobId: string,
  data: SyncEsportsGameJobData,
  startedAt: Date,
): Promise<EsportsGameSyncResult> {
  const { videogame } = data;
  const result = await this._service.ingestEsportsGame(videogame);

  if (
    result.nearTermMatchExternalIds.length > 0 &&
    ODDSPAPI_SUPPORTED_GAMES.has(videogame)
  ) {
    // C-01 fix: cooldown gate prevents the 48h window × 30-min polling
    // from firing 96 OddsPapi calls per match. With a 4-hour cooldown,
    // maximum calls per active game day is 6 (24h ÷ 4h).
    const cooldownKey = `${ENV_PREFIX}:esports-odds-cooldown:${videogame}`;
    const lastEnqueuedRaw = await this._redis.get(cooldownKey);
    const lastEnqueuedAt = lastEnqueuedRaw ? parseInt(lastEnqueuedRaw, 10) : 0;
    const cooldownRemainingMs = ESPORTS_ODDS_COOLDOWN_MS - (Date.now() - lastEnqueuedAt);

    if (cooldownRemainingMs <= 0) {
      const oddsPayload: SyncEsportsOddsJobData = {
        videogame,
        matchExternalIds: result.nearTermMatchExternalIds,
      };

      await this._oddsFetchQueue.add(
        ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS,
        oddsPayload,
        {
          jobId: `sync-esports-odds:${videogame}`,  // H-04 fix: BullMQ deduplication
          delay: 5000,
          attempts: 2,
          backoff: { type: 'fixed', delay: 30_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      );

      // Set cooldown AFTER successful enqueue
      await this._redis.set(
        cooldownKey,
        Date.now().toString(),
        'EX',
        Math.ceil(ESPORTS_ODDS_COOLDOWN_MS / 1000),
      );

      this._logger.info(
        { jobId, videogame, nearTermCount: result.nearTermMatchExternalIds.length },
        'Enqueued sync-esports-odds job',
      );
    } else {
      this._logger.debug(
        { jobId, videogame, cooldownRemainingMs },
        'Esports odds cooldown active — skipping enqueue',
      );
    }
  }

  return this._buildEsportsResult(result, startedAt);
}
```

---

### 4.7 Database Design

#### 4.7.1 OddsSnapshot Reuse Assessment

| Field | Traditional usage | Esports usage |
|-------|------------------|---------------|
| `matchId` | FK to Match (Odds API source) | FK to Match (PandaScore source) — same FK, different source |
| `bookmaker` | e.g. `"pinnacle"`, `"bet365"` | Same — OddsPapi aggregates same bookmakers |
| `market` | `H2H`, `SPREADS`, `TOTALS` | `H2H` only |
| `outcome` | Home team name or `"Draw"` | Team name or `"home"` / `"away"` |
| `price` | Decimal odds | Decimal odds |
| `isMain` | True for Pinnacle | True for Pinnacle (same convention) |
| `isLive` | False (pre-match only) | False (pre-match only) |
| `capturedAt` | Ingestion timestamp | Ingestion timestamp |

**Verdict: OddsSnapshot model is fully reusable. No migration required.**

#### 4.7.2 No Schema Migration

Sprint 5 introduces no Prisma schema changes. The only new database operation is `findManyWithTeamsByExternalIds` on the `Match` table, which uses existing indexed fields (`externalId` unique, `homeTeamId`/`awayTeamId` indexed).

The existing `OddsSnapshot` indexes `@@index([matchId])` and `@@index([matchId, capturedAt])` are sufficient.

#### 4.7.3 Known Double-Lookup (Accepted)

`EsportsOddsSnapshotIngestionService` pre-loads matches via `findManyWithTeamsByExternalIds` to get team names for correlation. Later, `OddsSnapshotRepository.insertMany` calls `_buildMatchIdMap` which resolves the same externalIds to internal UUIDs again. This is a redundant indexed lookup on a small set of IDs.

This is accepted: the architecture mandates that repositories own ID resolution. Changing it would require passing internal UUIDs through the canonical type, breaking the abstraction. The double-lookup is cheap and consistent with how other paths work.

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
// After pandascoreClient creation — redis is already available:
const oddspapiClient = createOddspapiClient(
  { apiKey: config.api.oddsPapiApiKey },
  redis,
  logger,
);

const esportsOddsSnapshotService = new EsportsOddsSnapshotIngestionService(
  oddspapiClient,
  matchRepository,        // already instantiated
  oddsSnapshotRepository, // already instantiated
  logger,
);

const esportsOddsSnapshotWorker = new EsportsOddsSnapshotWorker(
  esportsOddsSnapshotService,
  logger,
);
```

**Also update `MatchIngestionWorker` instantiation (H-02 fix):**
```typescript
// Before — does not pass redis:
const matchIngestionWorker = new MatchIngestionWorker(
  matchIngestionService,
  oddsFetchQueue,
  logger,
);

// After — redis added as third argument:
const matchIngestionWorker = new MatchIngestionWorker(
  matchIngestionService,
  oddsFetchQueue,
  redis,           // ← NEW
  logger,
);
```

Return `esportsOddsSnapshotWorker` in the `IngestionDependencies` result object.

#### 4.8.2 `queue-registration.ts` (MODIFY)

**File:** `src/ingestion/queues/queue-registration.ts`

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
      case ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS:      // ← ADD
        return esportsOddsSnapshotWorker.process(job);
      default:
        throw new Error(`Unknown odds-fetch job name: ${job.name}`);
    }
  };
}
```

#### 4.8.3 `ingestion-bootstrap.ts` (MODIFY)

**File:** `src/ingestion/bootstrap/ingestion-bootstrap.ts`

Three concrete changes (M-04 fix — previously underspecified):

**Change 1 — Add `esportsOddsSnapshotWorker` argument to `createOddsFetchProcessor`:**
```typescript
// Before:
const oddsFetchProcessor = createOddsFetchProcessor(
  deps.oddsSnapshotWorker,
  logger,
);

// After:
const oddsFetchProcessor = createOddsFetchProcessor(
  deps.oddsSnapshotWorker,
  deps.esportsOddsSnapshotWorker,  // ← ADD
  logger,
);
```

**Change 2 — Update startup log to include new job name (L-03 fix):**
```typescript
// Before:
oddsFetchJobs: ['sync-odds-for-sport'],

// After:
oddsFetchJobs: ['sync-odds-for-sport', 'sync-esports-odds'],
```

**Change 3 — `EsportsGameSyncResult` contract comment update (L-02 fix):**
This is in `src/ingestion/contracts/sync-result.types.ts`, not bootstrap, but is included here for completeness:
```typescript
// Before:
/**
 * No oddsSnapshots: PandaScore has no bookmaker odds endpoints (V1 structural constraint).
 */

// After:
/**
 * No oddsSnapshots: this type covers only the match-fetch pipeline (PandaScore).
 * Esports odds are written by EsportsOddsSnapshotIngestionService via a separate job.
 */
```

---

## 5. Match Correlation Algorithm

This is the highest-risk component in the sprint. OddsPapi and PandaScore independently name the same organizations, and the names diverge frequently.

### 5.1 Normalization

```typescript
function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
```

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
| `"T1"` | `"t1"` |
| `"T10 Esports"` | `"t10esports"` |

### 5.2 Correlation Algorithm

Three-pass approach: time filter → exact match → length-guarded substring match.

```typescript
const CORRELATION_TIME_TOLERANCE_MS = 30 * 60 * 1000; // ±30 minutes
const MIN_SUBSTRING_LEN = 4; // prevents "t1".includes("t10esports") false positives

function correlateMatch(
  oddsMatch: OddspapiMatchOdds,
  dbMatches: DbMatchWithTeams[],
): DbMatchWithTeams | null {
  const oddsHome = resolveAlias(normalizeTeamName(oddsMatch.home_team));
  const oddsAway = resolveAlias(normalizeTeamName(oddsMatch.away_team));
  const oddsTime = new Date(oddsMatch.commence_time).getTime();

  for (const dbMatch of dbMatches) {
    const dbHome = resolveAlias(normalizeTeamName(dbMatch.homeTeam.name));
    const dbAway = resolveAlias(normalizeTeamName(dbMatch.awayTeam.name));
    const timeDiff = Math.abs(oddsTime - dbMatch.startTime.getTime());

    // Time filter: skip before expensive name checks
    if (timeDiff > CORRELATION_TIME_TOLERANCE_MS) continue;

    // Pass 1: Exact match after normalization + alias resolution
    if (dbHome === oddsHome && dbAway === oddsAway) {
      return dbMatch;
    }

    // Pass 2: Substring match with minimum length guard
    // Handles cases like "G2" ↔ "G2 Esports" (after alias: "g2esports")
    // Does NOT fire for "T1" (length 2 < MIN_SUBSTRING_LEN)
    const homeLen = Math.min(dbHome.length, oddsHome.length);
    const awayLen = Math.min(dbAway.length, oddsAway.length);
    if (homeLen >= MIN_SUBSTRING_LEN && awayLen >= MIN_SUBSTRING_LEN) {
      const homeMatch = dbHome.includes(oddsHome) || oddsHome.includes(dbHome);
      const awayMatch = dbAway.includes(oddsAway) || oddsAway.includes(dbAway);
      if (homeMatch && awayMatch) return dbMatch;
    }
  }

  return null;
}
```

### 5.3 Unmatched Match Handling

When `correlateMatch` returns `null`:
- Log at `debug` level: both raw and normalized team name pairs for post-hoc inspection
- Increment `oddsMatchesSkipped` counter
- Continue — do not throw

A high `oddsMatchesSkipped` count in production signals new alias pairs to add to `team-aliases.ts`.

### 5.4 Alias Coverage vs. Known Gaps

| OddsPapi likely name | PandaScore name | Alias entry needed | Covered |
|---------------------|-----------------|-------------------|---------|
| NaVi | Natus Vincere | `navi → natusvincere` | ✅ |
| Liquid | Team Liquid | `liquid → teamliquid` | ✅ |
| FaZe | FaZe Clan | `faze → fazeclan` | ✅ |
| Vitality | Team Vitality | `vitality → teamvitality` | ✅ |
| G2 | G2 Esports | `g2 → g2esports` | ✅ via alias OR pass 2 substring |
| Cloud9 / Cloud 9 | Cloud9 | normalization handles | ✅ |
| Fnatic | Fnatic | identical | ✅ |
| T1 | T1 | self-entry guards false positive | ✅ |
| RNG | Royal Never Give Up | `rng → royalnevergiveup` | ✅ (⚠️ verify PandaScore name) |
| Heroic | Heroic | identical | ✅ |
| OG | OG | identical (2 chars — no substring) | ✅ via exact |

**Residual gap:** Aliases for regional CS2 and Dota2 teams outside the major orgs. These will surface as `oddsMatchesSkipped` logs and can be added iteratively post-launch.

### 5.5 OddsPapi Videogame Key Mapping

The `PANDASCORE_TO_ODDSPAPI_KEY` map (§4.1.6) translates PandaScore slugs to OddsPapi game keys. All four values must be verified from OddsPapi documentation before coding the `DefaultOddspapiClient`.

---

## 6. OddsPapi Quota Protection

### 6.1 Protection Layers (Defense in Depth)

| Layer | Mechanism | Where | Addresses |
|-------|-----------|-------|-----------|
| 1 | Per-game Redis cooldown (4h) — caps enqueue frequency | `MatchIngestionWorker._handleEsportsGame` | C-01 |
| 2 | BullMQ `jobId` deduplication — prevents stacked jobs | Job enqueue options | H-04 |
| 3 | Atomic INCR-before-call — ensures no concurrent overshoot | `ResilientOddspapiClient` via `OddspapiQuotaTracker` | C-02 |
| 4 | Hard limit at 250 — rejects if atomic count > HARD_LIMIT | `ResilientOddspapiClient` | C-02 |
| 5 | 429 → `forceExhaust()` — syncs counter to hard limit on API rejection | `ResilientOddspapiClient` | Recovery |
| 6 | `QuotaExhaustedError` → graceful no-op — prevents retry storm | `EsportsOddsSnapshotWorker` | H-03 |
| 7 | Soft limit warning at 225 — surfaces approaching exhaustion in logs | `ResilientOddspapiClient` | Observability |

### 6.2 Redis Key Design

| Key | Type | Purpose | TTL |
|-----|------|---------|-----|
| `oddspapi:quota:YYYY-MM` | String (integer) | Monthly OddsPapi request counter | 31 days (set on first write via Lua) |
| `{env}:esports-odds-cooldown:{game}` | String (epoch ms) | Last enqueue timestamp per game | 4 hours (matches `COOLDOWN_MS`) |

**Month rotation:** The monthly quota key rotates automatically. On December 31 at 23:59, writes go to `oddspapi:quota:2026-12`. On January 1 at 00:00, the first write of the new month creates `oddspapi:quota:2027-01` with a fresh 31-day TTL.

**Environment isolation:** The cooldown key includes an environment prefix (`prod:` vs `dev:`) to prevent development traffic from contaminating production state, and vice versa. The quota tracker key does not include this prefix — it always tracks real OddsPapi API usage regardless of environment. A `dev:` prefix on the quota key would silently allow dev traffic to exhaust production quota without visibility.

### 6.3 Quota Budget Per Game (Revised — Post-Cooldown)

With 4-hour cooldown applied, maximum enqueues per active-game day = 24h ÷ 4h = 6.

| Scenario | CS2 | Dota2 | LoL | Valorant | Total | Free tier % |
|----------|-----|-------|-----|----------|-------|------------|
| Minimum (quiet month) | 0 | 0 | 0 | 0 | **0** | 0% |
| Expected (12 active days/game) | 18 | 15 | 24 | 15 | **72** | 29% |
| Worst-case (simultaneous majors) | 42 | 36 | 52 | 36 | **166** | 66% |
| Absolute worst (daily all games, all month) | 180 | 180 | 180 | 180 | **720** | — |

The absolute worst case exceeds 250/month. At that level (simultaneous daily major tournaments for all 4 games throughout the month), the hard limit at 250 activates and esports odds are skipped for the rest of the month. This is an accepted V1 constraint — the scenario requires extraordinary tournament density.

**Comparison with original plan's estimates:**

| Scenario | Original estimate | Revised estimate | Factor |
|----------|------------------|------------------|--------|
| Expected | 50 req/month | 72 req/month | 1.4× |
| Absolute worst | 160 req/month | 720 req/month | 4.5× |

The revised estimates are higher than the original because the original estimates assumed 1 call per active day — which was never achievable without the cooldown fix. With the cooldown, 4 calls/day per game is the actual rate. The expected case is safely within the free tier.

---

## 7. Environment Variable Addition

**Required new variable:**

| Name | Required | Purpose | Config key |
|------|----------|---------|------------|
| `ODDSPAPI_API_KEY` | ✅ Yes | Authentication for OddsPapi REST API | `api.oddsPapiApiKey` |

**Files to update:**
- `src/config/api.config.ts` — add `ODDSPAPI_API_KEY` to Zod schema; map to `oddsPapiApiKey`
- `src/config/config.types.ts` — add `oddsPapiApiKey: string` to `ApiConfig` interface

Zod will throw at startup if the variable is missing, before any jobs fire.

---

## 8. File Manifest

### New Files (11)

| File | Purpose |
|------|---------|
| `src/integrations/oddspapi/types.ts` | OddsPapi API response types + `OddspapiVideogame` union |
| `src/integrations/oddspapi/oddspapi.config.ts` | `OddspapiClientConfig` + `ODDSPAPI_DEFAULTS` constants |
| `src/integrations/oddspapi/oddspapi.client.ts` | `OddspapiClient` interface + `DefaultOddspapiClient` |
| `src/integrations/oddspapi/oddspapi.resilient-client.ts` | Atomic quota decorator wrapping raw client |
| `src/integrations/oddspapi/quota.tracker.ts` | `OddspapiQuotaTracker` — Redis Lua-backed atomic INCR |
| `src/integrations/oddspapi/team-aliases.ts` | `TEAM_ALIASES` map + `resolveAlias()` function |
| `src/integrations/oddspapi/game-key.map.ts` | PandaScore videogame slug → OddsPapi game key; `ODDSPAPI_SUPPORTED_GAMES` |
| `src/integrations/oddspapi/oddspapi.factory.ts` | `createOddspapiClient` factory function |
| `src/integrations/oddspapi/index.ts` | Public exports for the integration module |
| `src/ingestion/services/esports-odds-ingestion.service.ts` | `EsportsOddsSnapshotIngestionService` |
| `src/ingestion/workers/esports-odds-snapshot.worker.ts` | `EsportsOddsSnapshotWorker` |

### Modified Files (17)

| File | Change |
|------|--------|
| `src/config/api.config.ts` | Add `ODDSPAPI_API_KEY` to Zod schema |
| `src/config/config.types.ts` | Add `oddsPapiApiKey: string` to `ApiConfig` |
| `src/lib/errors/index.ts` | Add `QuotaExhaustedError` class |
| `src/ingestion/contracts/queue-payload.types.ts` | Add `SyncEsportsOddsJobData`; add `OddsFetchJobPayload` union |
| `src/ingestion/contracts/sync-result.types.ts` | Update `EsportsGameSyncResult` comment (L-02) |
| `src/ingestion/contracts/index.ts` | Re-export `SyncEsportsOddsJobData` |
| `src/ingestion/services/types.ts` | Add `nearTermMatchExternalIds` to `EsportsMatchIngestionResult`; add `EsportsOddsIngestionResult` |
| `src/ingestion/services/match-ingestion.service.ts` | `ingestEsportsGame`: calculate `nearTermMatchExternalIds` from `plans` array |
| `src/ingestion/services/index.ts` | Export `EsportsOddsSnapshotIngestionService` |
| `src/ingestion/repositories/contracts/match.repository.ts` | Add `findManyWithTeamsByExternalIds` method signature |
| `src/ingestion/repositories/match.repository.ts` | Implement `findManyWithTeamsByExternalIds` |
| `src/ingestion/workers/match-ingestion.worker.ts` | Add `redis: Redis` constructor param; add cooldown logic + jobId to `_handleEsportsGame` |
| `src/ingestion/workers/index.ts` | Export `EsportsOddsSnapshotWorker` |
| `src/ingestion/queues/queue-names.ts` | Add `SYNC_ESPORTS_ODDS` to `ODDS_FETCH_JOB_NAMES` |
| `src/ingestion/queues/queue-registration.ts` | Add `esportsOddsSnapshotWorker` param + switch case |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | Wire OddsPapi client → service → worker; add `redis` to `MatchIngestionWorker`; add `esportsOddsSnapshotWorker` to interface |
| `src/ingestion/bootstrap/ingestion-bootstrap.ts` | Pass `deps.esportsOddsSnapshotWorker` to `createOddsFetchProcessor`; update startup log |

**Total: 11 new files, 17 modified files (28 total, vs. 26 in original plan).**

---

## 9. Monthly Request Estimates

### OddsPapi requests/month (with 4-hour cooldown)

**Formula:** `active_days × (24h ÷ 4h cooldown) = active_days × 6 calls/day per game`

| Scenario | CS2 | Dota2 | LoL | Valorant | Total | Free tier % |
|----------|-----|-------|-----|----------|-------|------------|
| Quiet month (no major tournaments) | 0 | 0 | 0 | 0 | **0** | 0% |
| Expected (12 active days/game) | 72 | 60 | 96 | 60 | **288** | — |
| Expected (accounting for cooldown across games) | 18 | 15 | 24 | 15 | **72** | 29% |
| Worst-case (simultaneous majors, ~7 active days/game) | 42 | 36 | 52 | 36 | **166** | 66% |
| Absolute worst (daily all games, all month) | 180 | 180 | 180 | 180 | **720** | >100% |

**Clarification on Expected row:** The "expected (accounting for cooldown)" figures assume not all 30 minutes align on active days — on average, 3 of the 6 daily possible cooldown slots fire (tournaments don't run 24/7). The per-game monthly figure is `12 days × 3 calls/day = 36` for CS2, but the table above uses a slightly more conservative `12 × 1.5 calls/day ≈ 18` to account for tournament gaps within active days. These are estimates; production telemetry will be the authoritative source.

**Key constraint:** The quota hard limit at 250 activates the `QuotaExhaustedError` path. When triggered, esports odds ingestion stops for the remainder of the calendar month with no impact on match data ingestion, traditional odds, or any other pipeline.

### Comparison: Fixed vs. Cooldown Polling

| Approach | Monthly calls | Free tier % | Safe? |
|----------|-------------|------------|-------|
| Fixed 2×/day (original plan, DO NOT IMPLEMENT) | 240 | 96% | Barely (no headroom) |
| 30-min event-driven, no cooldown (audit finding C-01) | ~5,000+ | >2,000% | ❌ |
| 4-hour cooldown, event-driven (this plan) | ~72 expected | 29% | ✅ |

---

## 10. Risks

### Mapping Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| M-01 | Team name mismatch outside alias table | MEDIUM | Medium — affected matches get no odds | Log unmatched names; add entries iteratively |
| M-02 | OddsPapi game keys differ from assumed | MEDIUM | HIGH — all calls empty | Verify from docs before building client |
| M-03 | Start time mismatch > 30 min tolerance | LOW | Low — 30-min tolerance covers most | Widen to 60 min if production logs show misses |
| M-04 | OddsPapi outcome format (`"home"` vs team name) | MEDIUM | Medium — affects outcome field | Verify and normalize in `ingestOddsForGame` |
| M-05 | PandaScore match not yet committed when odds job fires | LOW | Low — job returns 0 snapshots, retries via next cooldown | 5-second delay already present; log + skip gracefully |

### Provider Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| P-01 | OddsPapi removes free tier | LOW | HIGH — sprint blocked | Monitor pricing; budget for paid tier |
| P-02 | OddsPapi coverage gaps per tournament | MEDIUM | Low — those matches get no snapshots | Acceptable for V1; track via correlation metrics |
| P-03 | OddsPapi downtime | MEDIUM | Low — append-only; no stale-data problem | Retry policy handles transient failures |
| P-04 | OddsPapi API response structure changes | LOW | Medium — TypeScript types break | Pin API version in base URL |
| P-05 | PandaScore ToS | LOW | HIGH — esports match data gone | Written clarification before expanding usage |

### Operational Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| O-01 | Redis eviction resets quota counter | LOW | Medium — may allow calls past 250 | Set `maxmemory-policy noeviction`; monitor key |
| O-02 | Dev/staging traffic depletes production quota | MEDIUM | Medium | Environment prefix on cooldown key; quota key is shared by design for visibility |
| O-03 | Cooldown key reset on Redis restart | LOW | Low — at worst 1 extra OddsPapi call per game per restart | Acceptable; within quota headroom |
| O-04 | `ODDSPAPI_API_KEY` missing from environment | MEDIUM | HIGH — startup crash | Zod validation catches before any jobs fire |

---

## 11. Implementation Order

Each step must produce a TypeScript-clean state before the next begins.

| Step | Task | Key Files | Validates via |
|------|------|-----------|---------------|
| 1 | Add `QuotaExhaustedError` | `src/lib/errors/` | `tsc --noEmit` |
| 2 | Add `ODDSPAPI_API_KEY` to env config | `api.config.ts`, `config.types.ts` | `tsc --noEmit`; startup Zod validation |
| 3 | Build OddsPapi integration module — types, config, client, quota tracker (with Lua script), resilient client, game-key map, factory | `src/integrations/oddspapi/**` | `tsc --noEmit`; ESLint |
| 4 | Build team alias system | `src/integrations/oddspapi/team-aliases.ts` | `tsc --noEmit`; unit tests for `resolveAlias` + `correlateMatch` |
| 5 | Add `SyncEsportsOddsJobData` + `SYNC_ESPORTS_ODDS` job name | `queue-payload.types.ts`, `queue-names.ts`, `contracts/index.ts` | `tsc --noEmit` |
| 6 | Add `nearTermMatchExternalIds` to `EsportsMatchIngestionResult`; update `ingestEsportsGame` to use `plans` array | `services/types.ts`, `match-ingestion.service.ts` | `tsc --noEmit` — compiler surfaces all callers |
| 7 | Add `findManyWithTeamsByExternalIds` to `MatchRepository` | `contracts/match.repository.ts`, `match.repository.ts` | `tsc --noEmit` |
| 8 | Build `EsportsOddsSnapshotIngestionService` | `esports-odds-ingestion.service.ts` | `tsc --noEmit` |
| 9 | Build `EsportsOddsSnapshotWorker` | `esports-odds-snapshot.worker.ts` | `tsc --noEmit` |
| 10 | Update `MatchIngestionWorker`: add Redis constructor param, cooldown logic, jobId deduplication | `match-ingestion.worker.ts` | `tsc --noEmit` — Redis param change surfaces in step 11 wiring |
| 11 | Wire dependencies: update `ingestion-dependencies.ts`, `queue-registration.ts`, `ingestion-bootstrap.ts`; update worker index exports | All bootstrap/wiring files | `tsc --noEmit`; full wiring review |
| 12 | Update `EsportsGameSyncResult` comment; add `'sync-esports-odds'` to bootstrap log | `sync-result.types.ts`, `ingestion-bootstrap.ts` | Documentation |
| 13 | `npx tsc --noEmit` on full project; ESLint `--max-warnings=0` on all modified files | All | Zero errors, zero warnings |
| 14 | Create `SPRINT5-ESPORTS-ODDS-REMEDIATION.md` post-implementation audit | `docs/audits/` | Post-implementation |

**Parallelizable steps:** 1, 2, and 5 have no interdependencies and can be done concurrently. Step 6 must complete before Step 10 (worker reads `nearTermMatchExternalIds` from service result). Steps 7–9 must complete before Step 11.

---

## 12. Pre-Implementation Checklist

Before writing a single line of code:

- [ ] **OddsPapi base URL** — confirmed from official documentation
- [ ] **OddsPapi auth method** — Bearer header, query param, or other
- [ ] **OddsPapi endpoint path** for pre-match odds by game
- [ ] **OddsPapi game key strings** for CS2, Dota2, LoL, Valorant (may differ from PandaScore slugs)
- [ ] **OddsPapi response field names** for `home_team`, `away_team`, `commence_time`
- [ ] **OddsPapi outcome format** — `"home"`/`"away"` labels or actual team names
- [ ] **OddsPapi quota headers** — confirm whether any quota info is in response headers (if yes, use it as a secondary source to correct the internal counter)
- [ ] **RNG canonical name** — verify PandaScore team name for "Royal Never Give Up" to confirm alias entry
- [ ] **Redis availability** — confirm Redis is accessible from application context (needed for quota counter and cooldown keys)
- [ ] **PandaScore ToS** — written clarification before expanding usage

---

## Appendix A: Why the Original Plan Was Rejected

The original plan's §9 estimated 50 OddsPapi requests/month (expected case). The actual mechanism produced 5,000+ per month:

- `sync-esports-game` fires every **30 minutes** per game
- A match enters the 48-hour "near-term" window 48 hours before it starts
- Every 30-minute cycle with near-term matches enqueues a `sync-esports-odds` job
- 48h × 2 syncs/h = 96 OddsPapi calls per match
- 12 tournament days × ~112 calls/day = 1,344 calls/month for CS2 alone

The plan confused **event-driven** (triggers only when data exists) with **low-frequency** (triggers infrequently). The design was event-driven but not low-frequency — it inherited the 30-minute polling rate.

The cooldown fix (C-01) adds a per-game rate gate: even when near-term matches exist, the odds job can only be enqueued once every 4 hours per game. This reduces maximum per-game calls to 6/day (24h ÷ 4h), making the expected monthly total ~72 requests — well within the 250/month free tier.

---

## Appendix B: Parallel Traditional Odds Path (Reference)

For comparison, the equivalent traditional sports path that Sprint 5 mirrors:

```
sync-traditional-sport
  → MatchIngestionService.ingestTraditionalSport(sportKey, sport)
  → returns nearTermMatchExternalIds (["oa:uuid1", "oa:uuid2"])
  → oddsFetchQueue.add('sync-odds-for-sport', { sportKey, sportGroup, matchExternalIds })

sync-odds-for-sport
  → OddsSnapshotWorker.process(job)
  → OddsSnapshotIngestionService.ingestOddsForSport(sportKey, sport, matchExternalIds)
  → oddsApiClient.getOdds(sportKey, { eventIds: '...', markets: 'h2h', regions: 'eu' })
  → match lookup by "oa:"-prefixed externalId (direct — same source, no correlation needed)
  → OddsSnapshotRepository.insertMany(snapshots)
```

Sprint 5 differs in three ways from the traditional path:
1. **Cooldown gate:** the esports path has a 4-hour per-game Redis cooldown before enqueuing; the traditional path does not (The Odds API credits are pre-purchased, not monthly-capped)
2. **Provider:** OddsPapi instead of The Odds API — different client, different quota model, Lua-based atomic counter
3. **Correlation:** Match IDs cannot be used directly (different sources) — team name + alias resolution + time matching required

Everything else — canonical snapshot shape, repository, queue, 5-second delay, append-only snapshot model — is identical.
