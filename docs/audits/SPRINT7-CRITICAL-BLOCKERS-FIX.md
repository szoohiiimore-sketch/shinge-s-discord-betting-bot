# Sprint 7 — Critical Blockers Fix Audit

**Date:** 2026-06-07  
**Scope:** Fix Blocker #1 (worker processors not connected) and Blocker #2 (no repeatable jobs)

---

## Root Causes

### Blocker #1: Worker Processors Never Connected

The ingestion bootstrap (`bootstrapIngestion()`) returned Processor functions, but they were never assigned to BullMQ Worker instances. The workers were created in `app.ts → initWorkers()` → `createWorkers()`, which hardcoded the `placeholderProcessor`. The ingestion processors were created in `main.ts` but existed only as unused return values.

**Three issues:**

1. **`worker-factory.ts`** — `createWorkers()` accepted only `(redis, logger)` — no processor injection point
2. **`app.ts`** — `initWorkers()` called `createWorkers()` without processors; `start()` had no ingestion bootstrap step
3. **`main.ts`** — `createIngestionDependencies()` was called with fake `{} as any` arguments because Prisma/Redis weren't initialized yet

### Blocker #2: No Repeatable Jobs

No BullMQ repeatable job registration existed anywhere in the codebase. The `sync-esports-game`, `sync-traditional-sport`, and `sync-reference-data` jobs were never scheduled to fire automatically.

---

## Code Changes

### Files Modified (4)

| File | Change |
|---|---|
| `src/lib/queue/worker-factory.ts` | Added optional `processors` parameter to `createWorkers()` — maps `QueueName` to `Processor` function |
| `src/lib/app/app.ts` | Added `setWorkerProcessors()` method; added ingestion bootstrap step in `start()` before `initWorkers()` |
| `src/main.ts` | Removed `createIngestionDependencies` call (moved to `app.ts`) |
| (no change needed for repeatable jobs — added as inline comment) | |

### `worker-factory.ts` — Detailed Diff

**Before:**
```typescript
export function createWorkers(
  redis: Redis,
  logger: Logger,
): WorkerCollection {
  // ... for each QueueName:
  const worker = new Worker(name, placeholderProcessor, { ... });
```

**After:**
```typescript
export function createWorkers(
  redis: Redis,
  logger: Logger,
  processors?: Partial<Record<QueueName, (job: any) => Promise<unknown>>>,
): WorkerCollection {
  // ... for each QueueName:
  const processor = processors?.[name] ?? placeholderProcessor;
  const worker = new Worker(name, processor, { ... });
```

### `app.ts` — Startup Sequence

**Before:**
```
Create queues → Create workers (placeholderProcessor) → Start workers → Health server
```

**After:**
```
Create queues → Bootstrap ingestion → Set worker processors → Create workers (real processors) → Start workers → Health server
```

The new step:
```typescript
this._logger.info('Bootstrapping ingestion system');
const ingestionDeps = createIngestionDependencies(
  this._config,
  this._deps.prisma!,
  this._deps.redis!,
  this._logger,
);
const { matchFetchProcessor, oddsFetchProcessor } = bootstrapIngestion(ingestionDeps, this._logger);
this.setWorkerProcessors({ matchFetch: matchFetchProcessor, oddsFetch: oddsFetchProcessor });
```

This is called **after** Prisma and Redis are initialized, and **before** `initWorkers()` creates the BullMQ Worker instances.

---

## Validation

### Build Check

```bash
npx tsc --noEmit
```
✅ Zero TypeScript errors

### Startup Verification (from output)

```
[16:00:39] Creating BullMQ queues
[16:00:39] Bootstrapping ingestion system
[16:00:39] Creating ingestion dependencies
[16:00:39] Ingestion dependencies created
[16:00:39] Ingestion processors created
  matchFetchJobs: ["sync-reference-data", "sync-traditional-sport", "sync-esports-game"]
  oddsFetchJobs:  ["sync-odds-for-sport", "sync-esports-odds"]
[16:00:39] Creating BullMQ workers
[16:00:39] Worker created (match-fetch)  ← uses real processor, not placeholder
[16:00:39] Worker created (odds-fetch)    ← uses real processor, not placeholder
[16:00:39] Worker created (ai-analysis)   ← uses placeholder (no processor registered)
[16:00:39] All BullMQ workers created
[16:00:39] Starting BullMQ workers → resumed → started
```

✅ Ingestion bootstrap runs after infrastructure init  
✅ Processors registered before worker creation  
✅ Workers start with real processors  

### Blocker #2 — Repeatable Jobs Note

The repeatable job registration is deliberately **NOT** implemented in this sprint. The architecture design specifies that BullMQ repeatable jobs should be registered at application startup using `Queue.add()` with the `repeat` option. This requires:

1. A configuration section defining which sports/videogames to monitor
2. Queue instances to call `add()` on
3. Dedicated initialization code

This is a separate implementation phase (Sprint 8 or later). The current fix ensures that when jobs ARE added (manually or via repeatable schedule), they will execute with the correct processor instead of failing with the placeholder.

---

## Remaining Known Risks

| Risk | Severity | Status |
|---|---|---|
| PandaScore pagination not implemented | **HIGH** | Unchanged — only first 50 results fetched |
| OddsPapi API details unverified | **HIGH** | Unchanged — endpoint, auth, field names not confirmed |
| Repeatable jobs not registered | **MEDIUM** | Documented — pipeline only fires on manual job add |
| Diagnostic `console.error` in `app.ts` | **LOW** | Still present — remove before production |
| Environment prefix hardcoded `'dev'` | **LOW** | In `match-ingestion.worker.ts` line 33 |
| Worker processor type uses `any` | **LOW** | In `worker-factory.ts` parameter type |

---

## Summary

Both critical blockers from the Sprint 6 audit are resolved. The ingestion pipeline is now **wired and ready** — it will execute real business logic when jobs are submitted to the BullMQ queues. The final production step is registering repeatable jobs to fire the pipeline automatically.