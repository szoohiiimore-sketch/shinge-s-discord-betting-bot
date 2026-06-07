# Sprint 20 — BullMQ Custom ID Fix

**Date:** 2026-06-07  
**Scope:** Fix "Custom Id cannot contain :" BullMQ validation error  

---

## Root Cause

BullMQ uses the colon character (`:`) as a Redis key delimiter in its internal key structure (`bull:queueName:jobId`). Passing a `jobId` containing `:` to `Queue.add()` corrupts this structure and causes BullMQ to reject the job with:

```
Error: Custom Id cannot contain :
```

### Affected Code

**File:** `src/ingestion/workers/match-ingestion.worker.ts`  
**Line:** 162 (in `_handleEsportsGame`)

```typescript
// BEFORE (BUG):
jobId: `sync-esports-odds:${videogame}`,
```

The template literal produced values like:
- `sync-esports-odds:cs2`
- `sync-esports-odds:dota2`
- `sync-esports-odds:lol`
- `sync-esports-odds:valorant`

Each of these contains a `:` and is rejected by BullMQ.

### Impact

Every time a `sync-esports-game` job processes near-term esports matches (the most common ingestion path), it fails when trying to enqueue `sync-esports-odds` for OddsPapi odds ingestion. The esports odds pipeline is completely broken by this single-character bug.

### Why This Previously Worked

The `sync-esports-game` job uses the 4-hour Redis cooldown mechanism — it only fires the first time after a cooldown reset. During early development, the cooldown was not yet in effect or the esports path was never exercised with live data. When the cooldown expires and the path actually fires, BullMQ immediately rejects the job.

---

## Fix

### Change

```diff
- jobId: `sync-esports-odds:${videogame}`,
+ // BullMQ jobId must not contain ':' — it is reserved as a Redis key delimiter.
+ jobId: `sync-esports-odds-${videogame}`,
```

### Files Modified

| File | Line | Change |
|---|---|---|
| `src/ingestion/workers/match-ingestion.worker.ts` | 162 | `:` → `-` in jobId |

### Deduplication Preserved

The jobId `sync-esports-odds-{videogame}` remains **globally unique per game** — identically named jobs are deduplicated by BullMQ. Changing the delimiter from `:` to `-` does not affect deduplication behavior.

---

## All BullMQ `Queue.add()` Calls (Verified)

| File | Line | jobId | Contains `:`? |
|---|---|---|---|
| `match-ingestion.worker.ts` | 162 | `sync-esports-odds-{game}` | ✅ **FIXED** |
| `match-ingestion.worker.ts` | 107 | *(no jobId — auto-generated)* | ✅ |
| `force-ingestion.ts` | 60 | *(no jobId — auto-generated)* | ✅ |
| `force-ingestion.ts` | 91 | *(no jobId — auto-generated)* | ✅ |

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| BullMQ jobId no longer contains `:` | ✅ `sync-esports-odds-cs2` (valid) |
| Deduplication preserved | ✅ Same jobId format per game |
| Esports odds pipeline functional | ✅ Jobs can now be enqueued |

---

## Verdict

**PASS** — Single-character fix resolves the critical BullMQ validation error. Esports odds ingestion jobs can now be enqueued without BullMQ rejection. No deduplication behavior was changed.