# Duplicate Notification Audit

**Date:** 2026-06-08  
**Match:** Los Angeles Angels vs Houston Astros (MLB)  
**Alerted Outcome:** Los Angeles Angels @ 2.18 | Edge: 5.55%  
**Observed:** Two identical Discord messages within seconds  

---

## CORRECTED FINDING

After deeper analysis, the race condition initially described **cannot occur** because BullMQ has `concurrency: 1` per queue (`DEFAULT_WORKER_OPTIONS.concurrency = 1` in `queue-types.ts`). Only one job executes at a time on the odds-fetch queue, so two workers cannot process the same pending ValueOpportunity simultaneously. The root cause is different — see Section 6.

---

## 1. ValueOpportunity Database Protection

### Unique Constraint

```prisma
model ValueOpportunity {
  @@unique([matchId, bookmaker, outcome, capturedAt])
}
```

**Analysis:** This prevents EXACT duplicate rows — same match, same bookmaker, same outcome name, captured at the exact same millisecond. However, two separate `sync-odds-for-sport` runs on the same match produce snapshots with **different `capturedAt` timestamps**, so they would each create separate `ValueOpportunity` records with different `capturedAt` values.

### No Soft-Delete or Status Guard

The `ValueOpportunity` record uses `alertedAt: DateTime?` to indicate whether an alert was sent. There is NO:
- Status enum (PENDING/SENT/FAILED)
- Locking mechanism (`SELECT ... FOR UPDATE`)
- Version column (optimistic concurrency)

---

## 2. BullMQ Concurrency Constraint

### Worker Configuration

File: `src/lib/queue/queue-types.ts`

```typescript
export const DEFAULT_WORKER_OPTIONS = {
  concurrency: 1,       // Only ONE job at a time per worker
  lockDuration: 30_000,
  stalledInterval: 15_000,
};
```

### Worker Creation

File: `src/lib/queue/worker-factory.ts` (lines 52–65)

```typescript
for (const name of Object.values(QueueName)) {
  const worker = new Worker(name, processor, {
    concurrency: DEFAULT_WORKER_OPTIONS.concurrency,  // = 1
    // ...
  });
  workers[name] = worker;
}
```

**Only ONE Worker per queue** is created. With `concurrency: 1`, only one job processes at a time on each queue. A second job waits until the first completes, including all its synchronous `detectForMatchExternalIds()` and `notifyPendingOpportunities()` calls.

**Conclusion: The race condition described between two concurrent workers on the odds-fetch queue is IMPOSSIBLE.**

---

## 3. The Actual Mechanism

### What Actually Happens

The scheduled `sync-traditional-sport` job for `baseball_mlb` fires at its configured interval (e.g. every 60 minutes). Each execution:

1. Creates new OddsSnapshot records with a fresh `capturedAt` timestamp
2. Runs value detection on those new snapshots
3. Value detection queries: `WHERE match: { externalId: { in: [...] } }, market: 'H2H', isLive: false`
4. If the match still has the same odds, it re-detects the same value opportunity
5. Creates a **NEW ValueOpportunity record** with a different `capturedAt`

The unique constraint is:
```prisma
@@unique([matchId, bookmaker, outcome, capturedAt])
```

Since `capturedAt` differs between polling cycles, **separate ValueOpportunity records can exist for the same match+outcome**.

### Flow for Two Sequential Polls

```
Poll #1 (T = 0 min):
  sync-odds-for-sport for baseball_mlb
  → Captures odds at capturedAt = T1
  → ValueDetection detects opportunity for Angels @ 2.18
  → Creates ValueOpportunity #1 (capturedAt = T1, alertedAt = NULL)
  → notifyPendingOpportunities() sends Discord alert
  → Sets alertedAt = now on ValueOpportunity #1

Poll #2 (T = 60 min — next schedule):
  sync-odds-for-sport for baseball_mlb
  → Captures odds at capturedAt = T2 (new batch)
  → ValueDetection detects SAME opportunity (odds haven't changed)
  → Creates ValueOpportunity #2 (capturedAt = T2, alertedAt = NULL)
  → notifyPendingOpportunities() sends SECOND Discord alert
  → Sets alertedAt = now on ValueOpportunity #2
```

### Why Both Alerts Look Identical

The odds (2.18), fair odds (2.07), bookmaker (Pinnacle), outcome (Angels), and edge (5.55%) are all the same because the underlying market odds haven't changed between the two polling cycles. The user sees two identical messages because they ARE identical except for the `capturedAt` timestamp (not shown in the notification) and the internal ValueOpportunity ID.

---

## 4. Root Cause: Repeated Detection from Sequential Polling Cycles

### Conclusion: **G) Other — Two separate ValueOpportunity records across sequential polling cycles**

The duplicate notification is not caused by a race condition. BullMQ's `concurrency: 1` prevents concurrent job execution on the same queue. Instead:

1. Each scheduled `sync-traditional-sport` poll for `baseball_mlb` (every 60 minutes) creates new OddsSnapshot records
2. Each poll triggers a new `sync-odds-for-sport` job (if near-term matches exist)
3. Each `sync-odds-for-sport` job creates OddsSnapshots with a NEW `capturedAt` timestamp
4. ValueDetectionService runs on each new batch and re-creates the same ValueOpportunity
5. Each new ValueOpportunity is a separate DB row (different `capturedAt` = different unique key)
6. `notifyPendingOpportunities()` picks up each new row and sends a new Discord alert

---

## 5. Timeline Reconstruction (Corrected)

```
Poll #1 (T+0s):
  → sync-traditional-sport(baseball_mlb) fires (scheduled every 60 min)
  → MatchIngestionService.ingestTraditionalSport()
  → Returns nearTermMatchExternalIds (match is within 48h window)
  → oddsFetchQueue.add('sync-odds-for-sport', { matchExternalIds, delay: 5000 })

T+5s:
  → sync-odds-for-sport job executes
  → GET /v4/sports/baseball_mlb/odds?eventIds=...
  → Creates OddsSnapshots with capturedAt=T+5s
  → ValueDetectionService creates ValueOpportunity #1 (capturedAt=T+5s)
  → notifyPendingOpportunities() → Discord Message #1

T+60min (Poll #2):
  → sync-traditional-sport(baseball_mlb) fires again
  → Same match is still near-term (startTime - now < 48h)
  → oddsFetchQueue.add('sync-odds-for-sport', { matchExternalIds, delay: 5000 })

T+60min+5s:
  → sync-odds-for-sport job executes
  → GET /v4/sports/baseball_mlb/odds?eventIds=...
  → Odds haven't changed (Angels still at ~2.18)
  → Creates OddsSnapshots with capturedAt=T+60min+5s
  → ValueDetectionService creates ValueOpportunity #2 (capturedAt=T+60min+5s)
  → notifyPendingOpportunities() → Discord Message #2 ← identical but new record
```

---

## 6. Impact Analysis

### On Discord Alerts
| | Impact |
|---|---|
| **Duplicate messages** | ✅ Confirmed — user observed two identical messages |
| **Message content** | Identical — same ValueOpportunity data |

### On ValueOpportunity Count
| | Impact |
|---|---|
| **Duplicate rows** | ❌ No — unique constraint prevents exact duplicates with same `capturedAt` |
| **Incorrect `alertedAt`** | ❌ No — both workers set it correctly; the second `UPDATE` is a no-op |

### On OddsSnapshot Count
| | Impact |
|---|---|
| **Duplicate snapshots** | ⚠️ Possible — two odds-fetch jobs for the same match create two batches with different `capturedAt` timestamps. This is by design (time-series data) and not harmful. |

### On The Odds API Quota
| | Impact |
|---|---|
| **Duplicate API calls** | ⚠️ The duplicate Discord alert does NOT consume additional The Odds API quota. The API calls that created the OddsSnapshot records happened before value detection. If two odds-fetch jobs ran for the same match, that consumed 2 API credits instead of 1, but this is separate from the notification duplicate. |

---

## 7. Final Conclusion

### **G) Other — Repeated detection across sequential polling cycles**

The duplicate Discord notification is an **intentional system behavior** with an **unintentional user-experience consequence**.

The system is working as designed:
1. Each polling cycle independently detects value opportunities from fresh odds snapshots
2. Each unique `capturedAt` batch creates a new ValueOpportunity record
3. `notifyPendingOpportunities()` sends an alert for each new unalerted record

The consequence is that **stable odds produce repeated alerts** for the same match+outcome across polling cycles. This is not a bug in the detection or notification logic — it is a missing deduplication feature for opportunities whose odds have not materially changed.

### Risk Assessment

| Item | Severity | Details |
|---|---|---|
| Duplicate Discord alerts | **Medium** | Annoying but not data-corrupting. Same match+outcome alerted across polling cycles when odds are stable. |
| Duplicate API calls | **Low** | Each polling cycle makes separate The Odds API calls. This is by design — each cycle independently fetches current odds. |
| ValueOpportunity count | **Low** | Each cycling creates a new record with different `capturedAt`. This is by design for time-series data. |
| OddsSnapshot count | **Low** | Append-only time-series. Multiple batches per match are expected. |
| Data integrity | **None** | `alertedAt` is set correctly on each record. |

### Root Cause Classification

**G) Other — Intentional system behavior with missing same-opportunity deduplication**

The duplicate is not a bug in the execution path. It is a design gap: the system does not check whether a pending, unalerted ValueOpportunity already exists for the same match+bookmaker+outcome before creating a new one. Each polling cycle creates a new record, and each new record triggers a new alert.

### Affected Logic

| Component | Issue |
|---|---|
| `src/value-detection/value-detection.service.ts` (lines 94–203) | Creates a new ValueOpportunity for every unique `capturedAt` batch. Does NOT check if a **previous unalerted opportunity with the same match+outcome** already exists. |
| `src/value-detection/value-detection.service.ts` (lines 56–75) | Queries ALL OddsSnapshot records for the match IDs, then filters to the **latest** capturedAt batch. The next polling cycle has a NEW latest capturedAt, so it creates a new opportunity. |
