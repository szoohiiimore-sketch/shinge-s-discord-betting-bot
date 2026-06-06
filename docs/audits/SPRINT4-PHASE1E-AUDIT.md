# Sprint 4 — Phase 1E: Repository Implementations
# Architecture & Implementation Audit

**Date:** 2026-06-06  
**Auditor:** Senior Staff Engineer Review  
**Scope:** `src/ingestion/repositories/` and `src/ingestion/repositories/contracts/`  
**Reference Documents:** `docs/designs/SPRINT4-INGESTION-ARCHITECTURE.md`, `prisma/schema.prisma`

---

## Executive Summary

**Architecture Score: 78/100**  
**Implementation Score: 71/100**

The structure is sound: constructor injection is consistent, dependencies are correctly bounded, no business logic has leaked into repositories, and Prisma field names and composite key accessors are accurate against the schema. However, the implementation contains one Critical defect that will cause a hard failure on the first `sync-reference-data` run in production, and three Major findings that undermine the idempotency guarantee the architecture depends on.

---

## Findings

---

### F-01: Concurrent creates on duplicate slugs will crash `sync-reference-data`

**Severity:** Critical  
**Location:** `sport.repository.ts:70` (`upsertMany`) / `sport.repository.ts:36-48` (`upsert`)

**Problem:**  
The Odds API `/v4/sports` response returns one record per competition, not per sport group. Multiple competitions share the same `group` field — `soccer_epl`, `soccer_bundesliga`, `soccer_champions_league` all have `group: "Soccer"`. The mapper produces identical `CanonicalSport{ slug: "soccer", ... }` for every one of them.

`upsertMany` passes all inputs to `Promise.all` with no deduplication:

```typescript
const results = await Promise.all(inputs.map(input => this.upsert(input)));
```

Each concurrent `upsert("soccer")` call follows the find-then-create path:

1. Thread A: `findUnique(slug: "soccer")` → `null`
2. Thread B: `findUnique(slug: "soccer")` → `null`
3. Thread A: `create(slug: "soccer")` → success
4. Thread B: `create(slug: "soccer")` → **P2002 unique constraint violation**

`translatePrismaError` maps P2002 to `ValidationError(retryable: false)`. `Promise.all` rejects immediately on the first rejection. The entire `sync-reference-data` job fails on its first run. BullMQ moves it to the failed queue and does not retry.

**Impact:**  
`sync-reference-data` is the foundational job — without it, Sport and League reference data never enters the database. All downstream jobs (`sync-traditional-sport`, match upserts) will fail with FK resolution errors. This is a complete failure of the ingestion pipeline on first run.

**Recommendation:**  
Replace the find-then-create pattern with Prisma's native `upsert`, which compiles to atomic `INSERT ... ON CONFLICT DO UPDATE` and serializes concurrent calls at the database level:

```typescript
const record = await this._prisma.sport.upsert({
  where: { slug: input.slug },
  create: { slug, name, category, externalApiSource, externalSportKey },
  update: { name: input.name },
});
```

Determining the `EntityWriteAction` requires comparing `createdAt` and `updatedAt`, or using a raw SQL `xmax = 0` check in the RETURNING clause. For V1, a reasonable approximation is: if `createdAt === updatedAt` within the same millisecond → 'created', else → 'updated'. Alternatively, simplify `action` to `'created' | 'skipped'` only, which avoids the need to distinguish. Additionally, `upsertMany` must deduplicate inputs by natural key before dispatching.

---

### F-02: Non-atomic find-then-create causes P2002 for concurrent team and league upserts

**Severity:** Critical  
**Location:** `team.repository.ts:39-65`, `league.repository.ts:39-68`, `match.repository.ts:33-58`

**Problem:**  
The same non-atomic pattern affects `TeamRepository` and `LeagueRepository`. In a `sync-traditional-sport` run for a sport like the EPL, a batch of 50 matches will frequently reference the same teams (e.g., Manchester City appears in multiple fixtures). `TeamRepository.upsertMany` fires concurrent upserts for all teams:

```
Promise.all([
  upsert("manchester-city"),
  upsert("arsenal"),
  upsert("manchester-city"),   ← duplicate from another fixture
  ...
])
```

Two concurrent `upsert("manchester-city")` calls both find `null`, both attempt `create`, one gets P2002. The same failure mode as F-01 — non-retryable `ValidationError` kills the job.

This is not an edge case. Any sport with 10+ matches in a batch will have teams appearing in multiple fixtures. The first run of every `sync-traditional-sport` job for every sport will trigger this.

**Impact:**  
Every `sync-traditional-sport` job fails on first run. Teams are never created. The ingestion pipeline produces no data.

**Recommendation:**  
Same fix as F-01: use Prisma's native `upsert`. Additionally, `upsertMany` must deduplicate inputs by natural key before dispatching:

```typescript
async upsertMany(inputs: readonly CanonicalTeam[]): Promise<...> {
  const unique = deduplicateBy(inputs, t => `${t.sportSlug}:${t.externalId}`);
  const results = await Promise.all(unique.map(input => this.upsert(input)));
  return { results };
}
```

Deduplication alone does not fix the race condition if callers from separate workers run concurrently. The underlying `upsert` must also be atomic.

---

### F-03: `LeagueDeduplicationKey` and `TeamDeduplicationKey` are structurally incomplete

**Severity:** Major  
**Location:** `league.repository.ts:23-33`, `team.repository.ts:23-33`; root cause in `src/ingestion/repositories/contracts/`

**Problem:**  
Both `LeagueDeduplicationKey = { externalId: string }` and `TeamDeduplicationKey = { externalId: string }` omit `sportSlug`. The schema's unique constraint is `(sportId, externalId)` — `externalId` alone is not unique in the database.

The implementation acknowledges this with a comment that calls it "safe in practice", but this assumption is incorrect for PandaScore. PandaScore assigns numeric IDs independently per entity type. There is no guarantee that `league.id = 42` in CS2 does not collide with `league.id = 42` in Valorant. The PandaScore API docs do not state that league IDs are globally unique across all videogames.

```typescript
// Returns whichever record comes first — could be wrong sport
const record = await this._prisma.league.findFirst({
  where: { externalId: key.externalId },
  select: { id: true },
});
```

If `findId` returns the wrong league's UUID, any downstream operation receiving that UUID will either silently use the wrong data or cause a FK violation referencing an unrelated sport's league.

**Impact:**  
Silent data corruption. A caller using `findId` to verify existence before writing could get a wrong ID from a different sport's league, misidentifying a non-existent league as existing. At V1 scale with CS2, Valorant, and LoL operating concurrently, PandaScore league ID collisions are realistic.

**Recommendation:**  
`LeagueDeduplicationKey` must include `sportSlug`:

```typescript
export interface LeagueDeduplicationKey {
  readonly externalId: string;
  readonly sportSlug: string;
}
```

The `findId` implementation then resolves sport first and uses the composite key. This requires amending the Phase 1D contract — which is the correct fix. The comment rationalising `findFirst` should be removed; it documents an architectural flaw, not a deliberate decision.

---

### F-04: `upsertMany` has no batch size guard — unbounded `Promise.all` exhausts connection pool

**Severity:** Major  
**Location:** `sport.repository.ts:67-72`, `league.repository.ts:74-79`, `team.repository.ts:74-79`, `match.repository.ts:124-129`, `team-league.repository.ts:72-77`

**Problem:**  
Every `upsertMany` implementation fires one `Promise.all` containing N concurrent Prisma operations, where N is unbounded. Each individual `upsert` call in `LeagueRepository`, `TeamRepository`, and `MatchRepository` internally executes multiple sequential queries (sport resolution + entity find + create/update).

For a `sync-traditional-sport` job processing 50 matches:
- `TeamRepository.upsertMany(100 teams)` → 100 concurrent `upsert` calls
- Each `upsert` executes `_resolveSportId` (1 query) + `findUnique` (1 query) + `create` (1 query)
- Total: up to 300 concurrent queries fired simultaneously

Neon's free tier operates with PgBouncer in transaction mode and a limited pool size. Saturating the pool causes P2024 (connection pool timeout). PgBouncer may queue or reject excess connections.

`TeamLeagueRepository.upsertMany` is worse: each `upsert` issues 4–5 queries (sport resolve, parallel team + league find, teamLeague find, create). Two TeamLeagues per match × 50 matches = 400–500 concurrent queries.

**Impact:**  
P2024 errors under normal operating conditions once sports have more than a handful of matches per run. These are `retryable: true`, so BullMQ retries, but if the pool is consistently exhausted, jobs will repeatedly fail until the queue is paused.

**Recommendation:**  
Implement concurrency limiting in `upsertMany`. A simple chunk-based approach:

```typescript
async upsertMany(inputs: readonly CanonicalTeam[]): Promise<...> {
  const CONCURRENCY = 10;
  const results: Array<{ id: string; action: EntityWriteAction }> = [];
  for (let i = 0; i < inputs.length; i += CONCURRENCY) {
    const batch = inputs.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(batch.map(input => this.upsert(input))));
  }
  return { results };
}
```

Alternatively, adopt a true batch-upsert strategy using Prisma's `createMany` with `skipDuplicates: true` for the create path and a single `updateMany` for the update path, dramatically reducing round trips.

---

### F-05: `_resolveSportId` duplicated verbatim in four repositories

**Severity:** Major  
**Location:** `league.repository.ts:81-93`, `team.repository.ts:81-93`, `team-league.repository.ts:79-91`, `match.repository.ts:131-143`

**Problem:**  
The `_resolveSportId` private method is copy-pasted across four repositories, 12 lines each. The implementations are byte-for-byte identical. Any change to sport resolution logic (error message, retryability, context fields) must be made in four places and will inevitably diverge.

This is not a stylistic concern. The duplication represents a divergence risk in a critical path. If the schema's sport lookup changes (e.g., sports gain an `isDeleted` soft-delete flag that should be checked during resolution), one of the four copies will be missed.

**Impact:**  
Maintenance risk. Future bug fixes or policy changes to sport resolution will require finding and updating all four copies. One will be missed, creating inconsistent resolution behaviour across entities.

**Recommendation:**  
Extract to a module-level utility:

```typescript
// src/ingestion/repositories/repository.utils.ts
export async function resolveSportId(
  prisma: PrismaClient,
  sportSlug: string,
): Promise<string> {
  const sport = await prisma.sport.findUnique({
    where: { slug: sportSlug },
    select: { id: true },
  });
  if (!sport) {
    throw new DatabaseError(`Sport not found for slug: ${sportSlug}`, {
      retryable: false,
      context: { sportSlug },
    });
  }
  return sport.id;
}
```

Import and call in each repository. Preserve constructor injection semantics — do not introduce a base class.

---

### F-06: `TeamLeagueRepository.upsert` executes 4–5 sequential and concurrent round trips per record

**Severity:** Major  
**Location:** `team-league.repository.ts:17-69`

**Problem:**  
The `upsert` execution path for a new TeamLeague record:

1. `_resolveSportId` → 1 query (sequential)
2. `Promise.all([findTeam, findLeague])` → 2 concurrent queries
3. `findUnique(teamLeague)` → 1 query (sequential, blocks on step 2)
4. `create(teamLeague)` → 1 query (if new)

That is 4–5 round trips per TeamLeague record. Two TeamLeague records are written per match. A 50-match sync run calls `TeamLeagueRepository.upsertMany` with 100 inputs (2 × 50), each executing 4–5 round trips = 400–500 total queries in `Promise.all`.

Furthermore, for a single sport's batch, all 100 concurrent `_resolveSportId` calls read the same sport row simultaneously. Neon returns the same data 100 times when a single read and a shared reference would suffice.

**Impact:**  
Compounded with F-04, TeamLeague writes become the dominant database load in any sync run. At modest scale (100 matches per sport, 3 esports games), the TeamLeague writes alone will fire thousands of concurrent queries.

**Recommendation:**  
For the immediate term, apply the concurrency limit from F-04. For the medium term, restructure TeamLeague writes as a batch:

```typescript
// Resolve all sport/team/league IDs once via batch lookups,
// then do a single createMany with skipDuplicates: true.
// Reduces a 100-record upsertMany from ~400 round trips to ~4.
```

---

### F-07: `insertMany` contract promises `ids: string[]` but always returns `ids: []`

**Severity:** Minor  
**Location:** `odds-snapshot.repository.ts:49-78`

**Problem:**  
The `OddsSnapshotRepository` interface contract declares:

```typescript
insertMany(...): Promise<{ inserted: number; ids: string[] }>;
```

The implementation always returns `ids: []` because Prisma's `createMany` does not return generated IDs. The JSDoc acknowledges this limitation, but the contract itself is a misleading promise. Any caller relying on `ids` for downstream operations will silently receive an empty array.

The comment "ids is empty since createMany does not return individual generated IDs" is a rationalisation for a contract breach, not a design decision.

**Impact:**  
Silent caller bug if any future consumer of `insertMany` uses the returned `ids`. The contract should not promise what it cannot deliver.

**Recommendation:**  
Amend the contract to reflect reality:

```typescript
insertMany(...): Promise<{ inserted: number }>;
```

If individual IDs are genuinely needed (they are not required in the current ingestion design), use individual `create` calls within a transaction, accepting the performance cost. Do not promise IDs from `createMany`.

---

### F-08: No error code distinguishes "reference data missing" from "connection failure" in `DatabaseError`

**Severity:** Minor  
**Location:** All four `_resolveSportId` implementations; `match.repository.ts:80-97`

**Problem:**  
Architecture doc §8.6 states:

> The job should detect missing reference data explicitly, log it, and move on rather than failing the entire job.

The repository throws:

```typescript
throw new DatabaseError(`Sport not found for slug: ${sportSlug}`, {
  retryable: false,
  context: { sportSlug },
});
```

The worker receiving this error sees a `DatabaseError` with `retryable: false`. It cannot distinguish "sport record is missing, skip this match and continue" from "database authentication failed, abort everything". The `DatabaseError` class carries no semantic code to differentiate these cases.

BullMQ treats a non-retryable error as terminal — the entire job moves to the failed queue, even though the correct behaviour for a missing reference is to log the skip and continue processing other matches in the batch.

**Impact:**  
A single match with a missing sport reference causes the entire `sync-traditional-sport` job to fail and not retry, even though the remaining 49 matches in the batch could be processed. This contradicts the architecture's stated failure recovery model.

**Recommendation:**  
Add a typed discriminator to the error context:

```typescript
throw new DatabaseError(`Sport not found for slug: ${sportSlug}`, {
  retryable: false,
  context: { sportSlug, type: 'MISSING_REFERENCE' },
});
```

The worker catches `DatabaseError` and inspects `context.type` to decide whether to skip the record or abort the job. Alternatively, introduce a `MissingReferenceError extends DatabaseError` subclass that the worker can `instanceof`-check.

---

### F-09: No enforcement of the terminal-match OddsSnapshot prohibition

**Severity:** Minor  
**Location:** `odds-snapshot.repository.ts:17-40`

**Problem:**  
Architecture doc §7.9 states:

> OddsSnapshot records must not be created for matches with status FINISHED, CANCELLED, or POSTPONED.

`OddsSnapshotRepository` performs no such check. `insert` and `insertMany` will write snapshots for terminal matches without error. Match `status` is not fetched during `_resolveMatchId` or `_buildMatchIdMap`.

**Impact:**  
If the odds-fetch worker has a bug or race condition where it passes snapshots for a recently-finished match, those records are silently inserted. The analysis service then queries stale odds for settled matches. Neither the contract nor the implementation documents that this check is the caller's responsibility.

**Recommendation:**  
Either:

1. Enforce at the repository level by fetching `status` alongside `id` in `_resolveMatchId`/`_buildMatchIdMap` and throwing for terminal matches.
2. Document clearly in the `OddsSnapshotRepository` contract interface that the caller is responsible for filtering by match status before calling `insert` or `insertMany`.

Option 2 is acceptable if the contract is explicit. Currently neither is documented.

---

## Finding Summary

| ID   | Severity | File(s)                                              | Area                                     |
|------|----------|------------------------------------------------------|------------------------------------------|
| F-01 | Critical | `sport.repository.ts`                               | Non-atomic upsert + duplicate inputs     |
| F-02 | Critical | `team.repository.ts`, `league.repository.ts`, `match.repository.ts` | Non-atomic upsert + duplicate inputs |
| F-03 | Major    | `league.repository.ts`, `team.repository.ts`, contracts | Incomplete deduplication key contract |
| F-04 | Major    | All repositories with `upsertMany`                  | Unbounded `Promise.all`, pool exhaustion |
| F-05 | Major    | `league`, `team`, `team-league`, `match` repositories | `_resolveSportId` copy-paste × 4       |
| F-06 | Major    | `team-league.repository.ts`                         | 4–5 round trips per TeamLeague record    |
| F-07 | Minor    | `odds-snapshot.repository.ts`                       | Contract breach: `ids` always empty      |
| F-08 | Minor    | All repositories (FK resolution paths)              | No semantic error code for missing refs  |
| F-09 | Minor    | `odds-snapshot.repository.ts`                       | No terminal-match guard                  |

---

## Final Verdict

**PASS WITH CONCERNS**

The code compiles, type-checks cleanly, follows constructor injection faithfully, and produces no business logic leakage. The Prisma query structure — composite key names, field selections, `createMany` for batch inserts — is largely correct against the schema.

However, the implementation **will fail immediately in production** on the first `sync-reference-data` run due to F-01. The non-atomic find-then-create pattern and the absence of input deduplication in `upsertMany` are not theoretical race conditions: the Odds API response structure guarantees multiple sport entries sharing the same `group` slug, triggering concurrent creates for the same slug in every sync run.

F-02 will similarly fail every `sync-traditional-sport` job on first run for any sport with more than one fixture involving the same team, which is every sport.

The architecture is well-conceived. The bugs are implementation-layer and fixable without structural changes.

---

## Readiness

**NOT READY**

F-01 and F-02 are not edge cases — they are guaranteed to occur on the first execution of any ingestion job. The pipeline produces zero data until these are resolved. F-03 introduces a silent data corruption risk that grows as the number of PandaScore videogames increases. F-04 and F-06 create operational stability concerns under normal load.

**Minimum blocking fixes before readiness:**

1. Replace find-then-create with Prisma native `upsert` in all five repositories (resolves F-01, F-02)
2. Add deduplication by natural key in all `upsertMany` implementations (resolves F-01, F-02 for in-batch duplicates)
3. Add concurrency limiting in `upsertMany` (resolves F-04, F-06 operationally)
4. Fix `LeagueDeduplicationKey` and `TeamDeduplicationKey` to include `sportSlug` (resolves F-03)

F-05 through F-09 are non-blocking for a friends-only bot at V1 scale but should be resolved before any increase in scope or user count.
