# Sprint 5 — Pre-Implementation Audit

**Date:** 2026-06-07
**Auditing:** `docs/audits/SPRINT5-ESPORTS-ODDS-IMPLEMENTATION-PLAN.md`
**Method:** Full codebase inspection of every file referenced in the plan, plus independent analysis of each design claim.
**Files inspected:** `match-ingestion.service.ts`, `match-ingestion.worker.ts`, `odds-snapshot.worker.ts`, `odds-snapshot-ingestion.service.ts`, `odds-snapshot.repository.ts`, `match.repository.ts`, `ingestion-dependencies.ts`, `ingestion-bootstrap.ts`, `queue-registration.ts`, `queue-names.ts`, `queue-payload.types.ts`, `sync-result.types.ts`, `source.types.ts`, `services/types.ts`, `canonical.types.ts`, `the-odds-api.client.ts`, `pandascore.client.ts`, `queue-types.ts` (DEFAULT_JOB_OPTIONS), `schema.prisma`.

---

## Verdict: REJECTED

**Reason:** One critical architectural error (`C-01`) makes the plan unshippable. If implemented as written, OddsPapi's 250 req/month free tier would be exhausted within the first day of any active CS2/Dota2/LoL/Valorant tournament, permanently disabling esports odds ingestion for the remainder of the month. This is not a minor calibration issue — it is a fundamental mismatch between the plan's cost model and its proposed trigger mechanism that renders §9 (Monthly Request Estimates) wrong by a factor of 25–100×.

A second critical error (`C-02`) creates a concurrent race condition that would allow quota to be exceeded even with a corrected frequency model.

Both issues have clear fixes. The remainder of the plan's architecture (OddsPapi client design, match correlation algorithm, queue placement, service/worker structure, database reuse) is sound and does not require redesign.

**Remediation required before implementation begins:** Fix `C-01` and `C-02` as specified below. Re-submit for approval.

---

## Critical Issues

---

### C-01 — Quota overconsumption: 48h near-term window × 30-min polling = 25–100× estimated usage

**Severity:** CRITICAL — plan-blocking
**Likelihood:** CERTAIN — not a risk, a mathematical inevitability

#### The problem

The plan's §9 estimates 50 requests/month (expected case) and 160 (absolute worst). These numbers appear to assume **1 OddsPapi call per active tournament day per game**. But the actual trigger mechanism makes this impossible.

The mechanism as designed:

1. `sync-esports-game` fires every **30 minutes** for each game
2. If `nearTermMatchExternalIds.length > 0`, enqueue `sync-esports-odds`
3. `NEAR_TERM_WINDOW_MS = 48 * 60 * 60 * 1000` (48 hours — same constant as traditional sports, shared module)
4. Therefore: any match with a start time within the next **48 hours** is "near-term"
5. A match visible 48h in advance triggers an odds job every 30 minutes for those 48 hours = **96 consecutive odds jobs per match**

All 96 jobs for one match consume exactly 96 OddsPapi requests (each job makes exactly 1 call to `getOddsForGame`).

#### Actual monthly usage calculation

**CS2 scenario (12 tournament days/month):**
- Each match is "near-term" for 48h before it starts
- Tournament days run ~8h → near-term window active for 48 + 8 = 56h per tournament day
- 56h × 2 syncs/h = **112 OddsPapi calls per tournament day for CS2**
- 12 tournament days × 112 = **1,344 calls/month for CS2 alone**

**All 4 games combined (conservative estimate):**
- CS2: 1,344 | Dota2: 1,120 | LoL: 1,680 | Valorant: 1,120
- **Total: ~5,264 calls/month**

The 250/month free tier would be exhausted within the **first two CS2 tournament days** of the month. The quota hard stop at 225 would trigger in the first active day.

#### Why the plan's estimate is wrong

The plan states:
> "Event-driven minimum: 20–30 requests/month"
> "Event-driven expected: 50–80 requests/month"

These estimates imply 1 OddsPapi call per active-day-per-game. That would require the trigger to fire **once per active day**, not once per 30-minute cycle when near-term matches exist. The plan conflates "event-driven" (triggers only when data exists) with "low-frequency" (triggers only once per event), but those are not the same. The current architecture is event-driven in the sense that it only fires when near-term matches exist — but it is NOT low-frequency because it inherits the 30-minute polling rate.

#### Fix: Per-game Redis cooldown

Add a per-game Redis cooldown key to the odds-enqueue decision in `MatchIngestionWorker._handleEsportsGame`. Only enqueue a `sync-esports-odds` job if sufficient time has passed since the last enqueue for that game.

**Proposed cooldown: 4 hours**

```typescript
// In MatchIngestionWorker._handleEsportsGame, after getting result:
const ESPORTS_ODDS_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

if (
  result.nearTermMatchExternalIds.length > 0 &&
  ODDSPAPI_SUPPORTED_GAMES.has(videogame)
) {
  const cooldownKey = `esports-odds-cooldown:${videogame}`;
  const lastEnqueuedRaw = await this._redis.get(cooldownKey);
  const lastEnqueuedAt = lastEnqueuedRaw ? parseInt(lastEnqueuedRaw, 10) : 0;

  if (Date.now() - lastEnqueuedAt >= ESPORTS_ODDS_COOLDOWN_MS) {
    await this._oddsFetchQueue.add(ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS, oddsPayload, jobOptions);
    await this._redis.set(cooldownKey, Date.now().toString(), 'EX', Math.ceil(ESPORTS_ODDS_COOLDOWN_MS / 1000));
    this._logger.info({ jobId, videogame, nearTermCount: ... }, 'Enqueued sync-esports-odds job');
  } else {
    this._logger.debug({ jobId, videogame, cooldownRemainingMs: ... }, 'Esports odds cooldown active — skipping enqueue');
  }
}
```

**Revised monthly usage with 4-hour cooldown:**

| Scenario | CS2 | Dota2 | LoL | Valorant | Total | Free tier % |
|----------|-----|-------|-----|----------|-------|------------|
| Minimum | 5 | 5 | 8 | 5 | **23** | 9% |
| Expected | 18 | 15 | 24 | 15 | **72** | 29% |
| Worst-case | 42 | 36 | 52 | 36 | **166** | 66% |

All scenarios remain within the 250/month free tier. ✓

**Additional implications of this fix:**
- `MatchIngestionWorker` needs access to `redis` — it currently does NOT have it. The constructor must accept `Redis` as a new parameter, and `ingestion-dependencies.ts` must pass it.
- The cooldown key should include an environment prefix (e.g., `${env}:esports-odds-cooldown:${videogame}`) to prevent dev/prod contamination.
- The 4-hour cooldown is a separate Redis concern from the quota tracker's monthly counter — both must be present.

---

### C-02 — TOCTOU race condition on quota tracker: concurrent jobs can exceed the 250/month limit

**Severity:** CRITICAL
**Likelihood:** MEDIUM (occurs whenever 2+ games fire odds jobs within milliseconds of each other)

#### The problem

The plan's quota lifecycle is:
1. `checkQuota()` → read Redis counter → return 'allowed' / 'warned' / 'exhausted'
2. If allowed/warned: call OddsPapi API
3. `increment()` → INCR Redis counter

This is a **check-then-act** pattern with no atomicity guarantee. All 4 games' `sync-esports-odds` jobs may be processed concurrently (BullMQ `concurrency: 1` applies per-worker, not per-queue — and even with `concurrency: 1`, the 5-second delay means CS2 and Dota2 can reach step 1 before either increments).

If the counter is at 248:
1. CS2 job calls `checkQuota()` → reads 248 < 250 → 'allowed'
2. Dota2 job calls `checkQuota()` → reads 248 < 250 → 'allowed'  
3. Both make API calls (counter still at 248)
4. CS2 job calls `increment()` → counter = 249
5. Dota2 job calls `increment()` → counter = 250
6. Counter reached 250 but 2 calls were made beyond what the check-time count suggested was safe

Worse: with `attempts: 2`, a job that fails after incrementing to 251 would retry and push to 252.

#### Fix: Atomic INCR-before-call pattern

Use Redis `INCR` as the gate, not a read. Increment before calling the API; if the result exceeds the hard limit, decrement and throw.

```typescript
// In ResilientOddspapiClient, replacing the checkQuota() → call → increment() flow:
async getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]> {
  const newCount = await this._quotaTracker.incrementAndCheck();
  // incrementAndCheck: INCR key, set TTL on first use, return new count
  
  if (newCount > ODDSPAPI_DEFAULTS.QUOTA_HARD_LIMIT) {
    await this._quotaTracker.decrement(); // undo the pre-increment
    throw new QuotaExhaustedError('OddsPapi', ODDSPAPI_DEFAULTS.QUOTA_HARD_LIMIT, newCount - 1);
  }
  
  if (newCount >= ODDSPAPI_DEFAULTS.QUOTA_SOFT_LIMIT) {
    this._logger.warn({ used: newCount, limit: ODDSPAPI_DEFAULTS.QUOTA_HARD_LIMIT }, 'OddsPapi quota warning');
  }
  
  return this._inner.getOddsForGame(videogame);
  // On 429 from API: call quotaTracker.forceExhaust() to set counter to HARD_LIMIT
}
```

The `incrementAndCheck()` method uses a Redis pipeline: `INCR key` + `EXPIRE key 2678400` (31 days). This is two commands but the INCR is atomic — only one caller can get a specific count value. If two jobs both increment from 248, one gets 249 and one gets 250. The one getting 250 would still proceed (it's at the hard limit), but the 250th call is the last allowed one, not the 251st. This is acceptable behavior.

If truly atomic increment-with-limit is required, a Lua script achieves it:
```lua
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return current
```

---

## High Severity Issues

---

### H-01 — Plan pseudocode uses non-existent variable `writtenMatches`

**Severity:** HIGH — implementation error
**Likelihood:** CERTAIN if plan is followed literally

#### The problem

The plan (§4.6.1) proposes:
```typescript
const nearTermMatchExternalIds = writtenMatches
  .filter(m => m.startTime.getTime() - now <= NEAR_TERM_WINDOW_MS ...)
  .map(m => m.externalId);
```

No variable `writtenMatches` exists in `ingestEsportsGame`. The actual code stores matched plans in the `plans: PandascoreIngestionPlan[]` array. The write results from `this._matchRepository.upsertMany(matchInputs)` return `{ results: Array<{ id: string; action: EntityWriteAction }> }` — they contain internal UUIDs and actions, NOT `startTime` or `externalId`.

The correct implementation mirrors the existing `ingestTraditionalSport`:
```typescript
// Uses 'plans', not 'writtenMatches':
const capturedAt = new Date();
const cutoff = new Date(capturedAt.getTime() + NEAR_TERM_WINDOW_MS);
const nearTermMatchExternalIds = plans
  .filter(p => p.match.startTime <= cutoff)
  .map(p => p.match.externalId);
```

#### Impact

An implementer following the plan literally would either fail to compile (`writtenMatches` is undeclared) or attempt to derive a `writtenMatches` variable from `matchesResult.results` — which contains no `startTime`, causing a runtime error.

#### Fix

Replace the `writtenMatches` pseudocode in §4.6.1 with the `plans`-based pattern identical to `ingestTraditionalSport`. Note that the plan proposes filtering `startTime >= now` (to exclude running matches) — this is inconsistent with the traditional path, which has no lower bound. This inconsistency must be an explicit documented choice, not a copy-paste artifact.

---

### H-02 — `MatchIngestionWorker` does not have Redis access; cooldown fix requires constructor injection

**Severity:** HIGH (prerequisite for C-01 fix)
**Likelihood:** CERTAIN — this is a concrete wiring gap

#### The problem

The C-01 fix requires `MatchIngestionWorker` to write a per-game cooldown key to Redis. The current worker constructor is:
```typescript
constructor(
  service: MatchIngestionService,
  oddsFetchQueue: Queue,
  logger: Logger,
)
```

There is no `redis` parameter. Adding the cooldown requires:
1. Add `redis: Redis` to `MatchIngestionWorker` constructor
2. Update `ingestion-dependencies.ts` to pass `redis` (already available in that scope)
3. Update `queue-registration.ts` if the worker instance is referenced there (it is not — only the processor is)

This is a straightforward 3-file change but it was not identified in the plan's file manifest.

---

### H-03 — BullMQ job retry makes a second OddsPapi call, consuming quota on failure

**Severity:** HIGH
**Likelihood:** MEDIUM (occurs on any transient OddsPapi error)

#### The problem

The plan specifies `attempts: 2` for `sync-esports-odds` jobs. The `EsportsOddsSnapshotWorker` catches `QuotaExhaustedError` gracefully (returns a zero-work result) but re-throws all other errors, which triggers BullMQ retry.

On a transient failure (5xx, timeout), BullMQ automatically retries the job. The retry invocation calls `ingestOddsForGame` again, which calls `getOddsForGame` again — consuming another OddsPapi request.

With C-02's atomic INCR fix, this is tolerable: the retry simply increments the counter and proceeds if quota allows. However, combined with C-01 (if the cooldown mechanism is not applied), a timeout-triggered retry storm on 4 simultaneous games could consume 8 requests in rapid succession (2 attempts × 4 games = 8), which destroys the monthly budget.

#### Fix

With C-01's cooldown fix in place, retry impact is bounded: the cooldown prevents immediate re-triggers from `sync-esports-game` cycles, so the 2-attempt retry is the only duplicate consumption path. This is acceptable.

**However:** the retry itself also needs a cooldown-awareness check. If the quota tracker shows usage >= SOFT_LIMIT at retry time, the retry should abort rather than making another API call. The easiest way: the retry also goes through `ResilientOddspapiClient` which checks quota first (with the C-02 atomic INCR fix in place).

---

### H-04 — No `sync-esports-odds` job deduplication: stacked jobs on tournament days

**Severity:** HIGH
**Likelihood:** MEDIUM

#### The problem

The `sync-esports-game` job runs every 30 minutes. Each run with near-term matches enqueues a `sync-esports-odds` job (even after applying the C-01 cooldown fix — since the cooldown prevents *new* enqueues within the cooldown window, but does not prevent the case where the cooldown key expires while a previously-enqueued job is still waiting in the queue).

More concretely: if two `sync-esports-game` cycles fire before the `sync-esports-odds` job processes, and the cooldown key has expired between them, two jobs are queued. Both will consume OddsPapi quota.

Additionally, on BullMQ worker restart, delayed jobs in the queue are re-evaluated. If the `sync-esports-game` enqueues a delayed job and the worker restarts, the existing job may be joined by a duplicate.

#### Fix

Add a `jobId` to the `sync-esports-odds` enqueue call to enable BullMQ's built-in deduplication:

```typescript
await this._oddsFetchQueue.add(
  ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS,
  oddsPayload,
  {
    jobId: `sync-esports-odds:${videogame}`,  // ← deduplication key
    delay: 5000,
    // ... other options
  },
);
```

BullMQ deduplicates jobs with the same `jobId` within the same queue: if `sync-esports-odds:cs2` is already in the queue (waiting or delayed), a second `add` with the same jobId is a no-op. This prevents duplicate quota consumption from stacking jobs.

**Note:** A `jobId` without a timestamp means that once the job processes and completes, the ID is cleared and the next enqueue creates a fresh job. This is the correct behavior.

---

## Medium Severity Issues

---

### M-01 — Redis INCR + EXPIRE non-atomic; quota key can persist without TTL

**Severity:** MEDIUM
**Likelihood:** LOW (requires server crash between two Redis commands)

#### The problem

The plan's `OddspapiQuotaTracker.increment()`:
> "Sets TTL to 31 days if the key is new (prevents stale keys)"

The standard implementation of this pattern is:
```typescript
const newCount = await redis.incr(key);
if (newCount === 1) {
  await redis.expire(key, 31 * 86400); // TTL set only if this is the first increment
}
```

Between `INCR` and `EXPIRE`, if Redis crashes or the process dies, the key has value `1` with no TTL. It will persist indefinitely. On the next month, the counter never resets.

#### Fix

Use a Redis pipeline or Lua script to atomically combine the INCR and conditional EXPIRE:

```typescript
// Option A: pipeline (near-atomic, still two round trips but one pipeline flush)
const pipeline = redis.pipeline();
pipeline.incr(key);
pipeline.expire(key, 31 * 86400);
const [[, newCount]] = await pipeline.exec();
```

Note: the EXPIRE always resets the TTL here (not just on first increment), which is acceptable since we're incrementing into a monthly key that doesn't need to survive past 31 days.

For true atomicity, use the Lua script from the C-02 fix section.

---

### M-02 — Correlation substring match has false-positive risk for short team abbreviations

**Severity:** MEDIUM
**Likelihood:** LOW-MEDIUM (depends on OddsPapi's actual team name format)

#### The problem

The plan's correlation algorithm (§5.2) uses:
```typescript
const homeMatch = dbHome.includes(oddsHome) || oddsHome.includes(dbHome);
```

After normalization (`/[^a-z0-9]/g` removal, lowercase), short strings become substrings of longer ones:

| Normalized OddsPapi | Normalized PandaScore | `includes()` result | Is correct? |
|--------------------|-----------------------|---------------------|-------------|
| `"t1"` | `"t10esports"` | `"t10esports".includes("t1")` = **TRUE** | ❌ False positive |
| `"g2"` | `"g2esports"` | `"g2esports".includes("g2")` = **TRUE** | ✅ Correct |
| `"navi"` | `"natusvincere"` | `"natusvincere".includes("navi")` = FALSE | ✅ Correct (no match, but NaVi ↔ Natus Vincere still unresolved) |
| `"sp"` | `"spirit"` | `"spirit".includes("sp")` = **TRUE** | ❌ If OddsPapi abbreviates "Spirit" as "SP" |

T1 (Korea) and T10 Esports are both real esports organizations. If OddsPapi uses "T1" and PandaScore uses "T10 Esports" (normalized: "t10esports"), the substring match would incorrectly correlate a T1 match to whatever match has "t10esports" as a team.

#### Fix

Add minimum length requirements to the substring match path. Only use substring matching when both the needle AND haystack are above a minimum length (e.g., ≥ 4 characters normalized):

```typescript
// Only attempt substring match if both strings are long enough to reduce false positives
if (timeDiff <= CORRELATION_TIME_TOLERANCE_MS) {
  const MIN_LEN = 4;
  const homeMatch =
    (dbHome.length >= MIN_LEN && oddsHome.length >= MIN_LEN) &&
    (dbHome.includes(oddsHome) || oddsHome.includes(dbHome));
  const awayMatch =
    (dbAway.length >= MIN_LEN && oddsAway.length >= MIN_LEN) &&
    (dbAway.includes(oddsAway) || oddsAway.includes(dbAway));
  if (homeMatch && awayMatch) return dbMatch;
}
```

Additionally, the documented alias risks in §5.4 confirm that `"NaVi" ↔ "Natus Vincere"` is HIGH risk. The substring algorithm does NOT solve this — `"navi"` is not a substring of `"natusvincere"`. An alias lookup table is required for this case, not just substring matching. This should be a pre-implementation blocker for LoL, CS2, and Dota2 where NaVi is an active team.

---

### M-03 — `QUOTA_SOFT_LIMIT` config comment contradicts implemented behavior

**Severity:** MEDIUM (documentation error that will mislead implementers)

#### The problem

Plan §4.1.3:
```typescript
QUOTA_SOFT_LIMIT: 225,   // 90% — stop making calls, log warning
QUOTA_HARD_LIMIT: 250,   // 100% — reject unconditionally
```

But §4.1.5 defines the `checkQuota()` return values:
```
- 'warned'     — between soft and hard limit, proceed but log warning
- 'exhausted'  — at or above hard limit, do NOT proceed
```

The comment says "stop making calls" at the soft limit, but the behavior is to proceed (with warning). An implementer reading the config comment would implement the wrong behavior (stopping at 225 instead of 250), cutting effective quota in half.

#### Fix

Change the comment to match the behavior:
```typescript
QUOTA_SOFT_LIMIT: 225,   // 90% — log warning, continue making calls
QUOTA_HARD_LIMIT: 250,   // 100% — reject unconditionally
```

---

### M-04 — `ingestion-bootstrap.ts` was not read before the plan's change description was written

**Severity:** MEDIUM (vague specification for a concrete change)

#### The problem

The plan §4.8.3 says:
> "The exact change depends on the bootstrap file structure, but it will be a one-argument addition to the `createOddsFetchProcessor` call."

The file `src/ingestion/bootstrap/ingestion-bootstrap.ts` was available and readable. After inspecting it:

```typescript
const oddsFetchProcessor = createOddsFetchProcessor(
  deps.oddsSnapshotWorker,
  logger,
);
```

The full change is:
1. `createOddsFetchProcessor` must accept `esportsOddsSnapshotWorker` as second parameter (before `logger`)
2. `bootstrapIngestion` must pass `deps.esportsOddsSnapshotWorker` as that argument
3. The log message at the bottom must be updated:
   ```typescript
   oddsFetchJobs: ['sync-odds-for-sport', 'sync-esports-odds'],  // ← add second entry
   ```

None of these three changes are in the plan's file manifest. The plan's file manifest does list `ingestion-bootstrap.ts` as modified but provides no detail on what changes. This is an incomplete specification.

#### Fix

Update §4.8.3 with the three concrete changes listed above.

---

### M-05 — Near-term filter inconsistency: esports proposes excluding running matches, traditional does not

**Severity:** MEDIUM (behavioral difference, undocumented intent)

#### The problem

The plan (§4.6.1) proposes for esports:
```typescript
.filter(m => m.startTime.getTime() - now <= NEAR_TERM_WINDOW_MS
            && m.startTime.getTime() >= now)   // exclude matches that already started
```

The actual `ingestTraditionalSport` implementation:
```typescript
const cutoff = new Date(capturedAt.getTime() + NEAR_TERM_WINDOW_MS);
const nearTermMatchExternalIds = plans
  .filter(p => p.match.startTime <= cutoff)
  .map(p => p.match.externalId);
```

The traditional path has **no lower bound** — it includes currently-running matches. PandaScore already fetches `getRunningMatches` so running esports matches exist in the DB. If they are excluded from near-term, no odds snapshots are taken for in-progress matches. This is arguably correct (since `isLive = false` for OddsPapi in V1), but it is a behavioral difference that must be explicitly documented, not implied.

**Key implication:** If the plan's filter is used for esports and the traditional filter is used for traditional, the same `NEAR_TERM_WINDOW_MS` constant produces different behavior. This is a gotcha for future maintainers.

#### Fix

Either:
- Document the intentional difference and add a comment in the code
- OR align with the traditional behavior (no lower bound) since `isLive = false` means in-progress esports matches won't produce live snapshots regardless

---

## Low Severity Issues

---

### L-01 — Double match lookup: service pre-loads matches; repository resolves same IDs again

**Severity:** LOW (performance, not correctness)

#### The problem

`EsportsOddsSnapshotIngestionService`:
1. Calls `matchRepository.findManyWithTeamsByExternalIds(psIds)` to get team names for correlation
2. After correlation, passes `matchExternalId = dbMatch.externalId` to `CanonicalOddsSnapshot`

`OddsSnapshotRepository.insertMany`:
1. Calls `_buildMatchIdMap(inputs)` — another `findMany({ where: { externalId: { in: [...] } } })`
2. This resolves the same match externalIds to internal UUIDs again

The service already has the match UUID (`dbMatch.id`) from step 1 but cannot pass it directly because `CanonicalOddsSnapshot.matchExternalId` is a string — the repository owns the ID resolution.

This is an intentional architectural decision (repositories own ID resolution), not a bug. The redundant query is cheap (indexed lookup on a small set of IDs) and the design is consistent with how the traditional odds path works.

**Note:** The traditional path does NOT pre-load matches in the service — it only passes externalIds. The esports path pre-loads because it needs team names for correlation. This creates the double-lookup as a side effect.

**No fix required** — the architecture is consistent. Noted for awareness only.

---

### L-02 — `EsportsGameSyncResult` contract comment will become misleading after Sprint 5

**Severity:** LOW (documentation)

#### The problem

`src/ingestion/contracts/sync-result.types.ts`:
```typescript
/**
 * No oddsSnapshots: PandaScore has no bookmaker odds endpoints (V1 structural constraint).
 */
export interface EsportsGameSyncResult { ... }
```

After Sprint 5, this claim is partially inaccurate. PandaScore still has no odds endpoints, but Sprint 5 adds esports odds via OddsPapi. A reader could be confused: "wait, doesn't Sprint 5 add esports odds?" The answer is that `EsportsGameSyncResult` is the match-fetch result, not the odds-fetch result — but the comment implies no esports odds exist anywhere.

#### Fix

Update the comment to distinguish match-fetch from odds-fetch concerns:
```typescript
/**
 * No oddsSnapshots: this type covers only the match-fetch pipeline (PandaScore).
 * Esports odds are written by EsportsOddsSnapshotIngestionService via a separate job.
 */
```

---

### L-03 — `ingestion-bootstrap.ts` log message will be stale

**Severity:** LOW

#### The problem

```typescript
bootLogger.info(
  {
    matchFetchJobs: ['sync-reference-data', 'sync-traditional-sport', 'sync-esports-game'],
    oddsFetchJobs: ['sync-odds-for-sport'],   // ← missing 'sync-esports-odds' after Sprint 5
  },
  'Ingestion processors created',
);
```

This log fires on every application startup. After Sprint 5, it will not log that `sync-esports-odds` is registered, which could cause confusion during debugging.

#### Fix

Add `'sync-esports-odds'` to the `oddsFetchJobs` array.

---

### L-04 — `DEFAULT_JOB_OPTIONS` compatibility with per-job `attempts: 2` — VERIFIED SAFE

**Status:** Verified safe. No issue.

`DEFAULT_JOB_OPTIONS` (from `src/lib/queue/queue-types.ts`) contains only:
```typescript
export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86_400 },
} as const;
```

No `attempts` field. The plan's job-level `attempts: 2` is additive and does not conflict. BullMQ merges job-level options with queue defaults, giving job-level priority. ✓

---

### L-05 — `OddsFetchJobPayload` discriminated union is unenforceable in the current dispatch architecture

**Severity:** LOW (pre-existing architectural limitation)

#### The problem

The plan adds:
```typescript
export type OddsFetchJobPayload =
  | { readonly name: 'sync-odds-for-sport'; readonly data: SyncOddsForSportJobData }
  | { readonly name: 'sync-esports-odds'; readonly data: SyncEsportsOddsJobData };
```

But `createOddsFetchProcessor` dispatches via `switch (job.name)` where `job.name` is typed as `string`, not `OddsFetchJobName`. TypeScript will not enforce exhaustive case coverage. Adding a third job type to the odds queue in the future would not produce a compile error.

This is a pre-existing limitation of the queue architecture, not a Sprint 5 defect. The union type is documentation, not enforcement.

No fix required for Sprint 5. A future improvement would be to type the processor's `job` parameter with the discriminated union.

---

## Verified Correct Items

The following plan claims were independently verified against the codebase:

| Claim | Verdict |
|-------|---------|
| OddsSnapshot Prisma model reusable without migration | ✅ Confirmed — no source-specific fields; `matchId` FK is provider-agnostic |
| `OddsSnapshotRepository.insertMany` reusable for esports | ✅ Confirmed — resolves matchExternalId via externalId unique index; works for `ps:` prefix |
| Same odds-fetch queue for `sync-esports-odds` | ✅ Confirmed — volume is low enough; `createOddsFetchProcessor` uses a switch; adding a case is trivial |
| `_oddsFetchQueue` already exists in `MatchIngestionWorker` | ✅ Confirmed — added in Sprint 4 Phase 2E |
| `NEAR_TERM_WINDOW_MS = 48h` constant exists in `MatchIngestionService` | ✅ Confirmed at line 21 of `match-ingestion.service.ts` |
| `EsportsGameSyncResult` does not need modification | ✅ Confirmed — it is the worker output type; `nearTermMatchExternalIds` is internal to the worker |
| No schema migration required | ✅ Confirmed — `OddsSnapshot` has no source-specific fields; `matchId` accepts any valid Match UUID |
| `DEFAULT_JOB_OPTIONS` does not conflict with `attempts: 2` | ✅ Confirmed — only `removeOnComplete` and `removeOnFail` in defaults |
| `ingestion-bootstrap.ts` change is a single-line `createOddsFetchProcessor` argument addition | ✅ Confirmed — the structure is exactly `createOddsFetchProcessor(deps.oddsSnapshotWorker, logger)` |
| `EsportsMatchIngestionResult` must gain `nearTermMatchExternalIds` | ✅ Confirmed — currently missing from `services/types.ts` |
| `ingestEsportsGame` must calculate near-term IDs from `plans` array | ✅ Confirmed — `plans` is the available array with `p.match.startTime` and `p.match.externalId` |

---

## Required Changes Before Approval

The following changes must be incorporated into the plan before implementation begins:

### Mandatory (unblocking critical issues)

1. **C-01 Cooldown fix:** Add per-game Redis cooldown (4-hour recommended) to `MatchIngestionWorker._handleEsportsGame`. Update file manifest to include `Redis` injection into `MatchIngestionWorker`. Update §9 monthly estimates with corrected formula.

2. **C-02 Atomic quota fix:** Replace check-then-call-then-increment with atomic INCR-before-call pattern in `ResilientOddspapiClient`. Use Redis pipeline or Lua script for atomic TTL setting.

3. **H-01 Pseudocode fix:** Replace `writtenMatches` pseudocode in §4.6.1 with `plans`-based filter matching the existing `ingestTraditionalSport` pattern. Explicitly document the intent of the `startTime >= now` lower bound (or remove it to match traditional behavior).

4. **H-02 Redis injection:** Add `Redis` parameter to `MatchIngestionWorker` constructor. Add to file manifest.

5. **H-04 Job deduplication:** Add `jobId: 'sync-esports-odds:{videogame}'` to the `sync-esports-odds` job enqueue call.

### Recommended (significant risk reduction)

6. **M-02 Alias table:** The plan acknowledges "NaVi ↔ Natus Vincere" as HIGH risk but defers the alias table to V2. Given this is the most prominent esports team globally in CS2, ship a minimal alias file (`src/integrations/oddspapi/team-aliases.ts`) with the known high-risk pairs as part of Sprint 5. The correlation algorithm should check the alias table before/after normalization.

7. **M-03 Comment fix:** Correct the `QUOTA_SOFT_LIMIT` comment from "stop making calls" to "proceed with warning."

8. **M-04 Bootstrap spec:** Fully specify the 3-line `ingestion-bootstrap.ts` change in the plan.

### Minor (documentation improvements)

9. L-02, L-03: Update `EsportsGameSyncResult` comment and bootstrap log message as specified.
10. M-05: Explicitly document the near-term lower-bound choice for esports.

---

## Revised Monthly Estimates (Post-Fix)

With C-01 (4-hour cooldown) and C-02 (atomic INCR) applied:

| Scenario | Mechanism | CS2 | Dota2 | LoL | Valorant | Total | Free tier % |
|----------|-----------|-----|-------|-----|----------|-------|------------|
| Minimum | Tournament-free month | 0 | 0 | 0 | 0 | **0** | 0% |
| Expected | 12 active tournament days/game, 4h cooldown | 18 | 15 | 24 | 15 | **72** | 29% |
| Worst-case | Simultaneous majors all games | 42 | 36 | 52 | 36 | **166** | 66% |
| Absolute worst | Daily coverage all games all month | 180 | 180 | 180 | 180 | **720** | — |

The absolute worst case (daily active coverage) exceeds 250/month if all 4 games are in daily tournaments simultaneously. At that point, the quota hard stop at 225 would activate and odds would be skipped for the rest of the month. This is an acceptable V1 constraint — that scenario requires simultaneous major events for 4 games over an extended period.

**The plan's stated "QUOTA_HARD_LIMIT: 250 prevents exceeding free tier" claim is contingent on the C-01 cooldown fix being implemented. Without it, the hard limit is irrelevant because the volume of incoming jobs overwhelms the per-call gate.**

---

## Path to Approval

**Required actions (must complete before coding begins):**

1. Incorporate the 5 mandatory changes above into the implementation plan
2. Confirm OddsPapi API documentation (base URL, auth, game keys, response format) — this remains a pre-implementation blocker regardless of quota issues
3. Add `Redis` parameter to `MatchIngestionWorker` in the file manifest
4. Update §9 Monthly Request Estimates with the corrected cooldown-based formula
5. Decide and document the esports near-term lower-bound behavior (M-05)

**After those changes:** re-run this audit against the revised plan. If C-01 and C-02 are addressed, the revised plan is expected to pass at APPROVED WITH MINOR CHANGES.

---

## Appendix: Issue Summary

| ID | Severity | Component | Title | Fixable Without Redesign |
|----|----------|-----------|-------|--------------------------|
| C-01 | CRITICAL | Architecture | 48h window × 30-min polling = 25-100× quota overconsumption | ✅ Yes — add Redis cooldown |
| C-02 | CRITICAL | Quota Tracker | TOCTOU race: concurrent jobs can exceed 250/month | ✅ Yes — atomic INCR before call |
| H-01 | HIGH | Service | `writtenMatches` pseudocode is wrong variable | ✅ Yes — use `plans` |
| H-02 | HIGH | Worker | `MatchIngestionWorker` has no Redis access for cooldown | ✅ Yes — add constructor param |
| H-03 | HIGH | Queue | Retry consumes quota on failure | ✅ Yes — mitigated by C-02 fix |
| H-04 | HIGH | Queue | No job deduplication | ✅ Yes — add `jobId` |
| M-01 | MEDIUM | Quota Tracker | Redis INCR + EXPIRE not atomic | ✅ Yes — pipeline or Lua |
| M-02 | MEDIUM | Correlation | Substring match false positives on short names | ✅ Yes — minimum length guard |
| M-03 | MEDIUM | Config | Soft limit comment contradicts behavior | ✅ Yes — fix comment |
| M-04 | MEDIUM | Bootstrap | `ingestion-bootstrap.ts` changes underspecified | ✅ Yes — add 3 lines |
| M-05 | MEDIUM | Service | Near-term lower bound undocumented | ✅ Yes — document intent |
| L-01 | LOW | Repository | Double match lookup (design choice, not bug) | N/A — accepted |
| L-02 | LOW | Contracts | `EsportsGameSyncResult` comment stale | ✅ Yes — update comment |
| L-03 | LOW | Bootstrap | Startup log missing `sync-esports-odds` | ✅ Yes — add to array |
| L-04 | LOW | Queue | `DEFAULT_JOB_OPTIONS` conflict | ✅ N/A — verified safe |
| L-05 | LOW | Contracts | `OddsFetchJobPayload` union unenforceable | Pre-existing — out of scope |
