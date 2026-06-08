# Duplicate Alert Fix Plan

**Date:** 2026-06-08  
**Scope:** Design the safest fix for repeated Discord value-bet alerts  

---

## 1. Complete Lifecycle Trace

```
Poll cycle N:
  sync-odds-for-sport(baseball_mlb)
  → Creates OddsSnapshot batch at capturedAt=T1
  → ValueDetectionService.detectForMatchExternalIds()
    → Queries ALL OddsSnapshots for these match IDs (H2H, non-live)
    → Filters to latest capturedAt batch ONLY (capturedAt === T1)
    → For each outcome:
      → Pinnacle odds = 2.18
      → Consensus = [bet365@2.05, DraftKings@2.00]
      → consensusProbability = (1/2.05 + 1/2.00) / 2 = 0.4939
      → fairOdds = 1 / 0.4939 = 2.0246
      → edge = ((2.18 / 2.0246) - 1) × 100 = 7.67%
      → Passes filters (MAX_ALERT_ODDS=3.0, edge >= 5%)
      → **Creates new ValueOpportunity** with capturedAt=T1
        (New row: matchId + bookmaker(pinnacle) + outcome(Angels) + capturedAt(T1))
  → DiscordNotificationService.notifyPendingOpportunities()
    → Queries: SELECT * FROM value_opportunities WHERE alertedAt IS NULL
    → Finds the new row
    → Sends Discord alert
    → UPDATE value_opportunities SET alertedAt=now() WHERE id = X

Poll cycle N+1 (60 min later):
  sync-odds-for-sport(baseball_mlb)
  → Creates OddsSnapshot batch at capturedAt=T2
  → ValueDetectionService.detectForMatchExternalIds()
    → Queries ALL OddsSnapshots → capturedAt T1 AND T2 batches exist
    → Filters to latest capturedAt batch ONLY (capturedAt === T2)
    → Odds are identical (2.18, consensus unchanged)
    → **Creates a NEW ValueOpportunity** with capturedAt=T2
      (Different row: matchId + pinnacle + Angels + capturedAt(T2))
      ← No check: "Has this same match+outcome already been alerted?"
  → notifyPendingOpportunities()
    → Finds the NEW row (alertedAt IS NULL)
    → Sends SECOND Discord alert ← THE BUG
```

### Key Insight

The system creates a new `ValueOpportunity` row on every polling cycle, even when the odds and edge are identical to the previous cycle. The `@@unique([matchId, bookmaker, outcome, capturedAt])` constraint treats different `capturedAt` timestamps as different records, so each cycle gets its own row. Each unalerted row triggers a new Discord notification.

---

## 2. Deduplication Key Evaluation

### Option A: `matchId` only

Suppress any new alert for the same match, regardless of outcome.

```sql
-- Pseudo-query: has this match been alerted before?
SELECT 1 FROM value_opportunities
WHERE matchId = X AND alertedAt IS NOT NULL
AND alertedAt > NOW() - INTERVAL '24 hours'
```

| Pros | Cons |
|---|---|
| Simple, unambiguous | Could suppress alerts for MULTIPLE value opportunities on the same match (e.g., both Team A and Team B could have value at different odds) |
| Single indexed column | Worst case: if Team A was alerted at 5% edge and Team B later develops a 15% edge, Team B is suppressed |

**Verdict:** Too aggressive. Matches can have multiple value-generating outcomes.

### Option B: `matchId + outcome`

Suppress alerts for the same match+outcome combination.

```sql
SELECT 1 FROM value_opportunities
WHERE matchId = X AND outcome = 'Los Angeles Angels'
AND alertedAt IS NOT NULL
AND alertedAt > NOW() - INTERVAL '24 hours'
```

| Pros | Cons |
|---|---|
| Targets the exact duplicate scenario | None significant |
| `ValueOpportunity` already has `matchId` indexed and `outcome` indexed | |
| A single composite query on existing indexes | |

**Verdict:** Best combination of specificity and simplicity.

### Option C: `matchId + outcome + bookmaker`

Suppress alerts for the same match+outcome from the same bookmaker.

| Pros | Cons |
|---|---|
| Most specific | Redundant in V1 — `bookmaker` is always `pinnacle` for value detection. May be useful if multi-bookmaker alerts are added later. |

**Verdict:** Over-engineered for V1. Option B is sufficient.

### Recommended: **B — `matchId + outcome`**

---

## 3. Suppression Window

### Candidates

| Window | Rationale | Risk |
|---|---|---|
| **6 hours** | Covers the shortest-polling sports (60 min tier gets ~6 cycles) | May miss genuine edge improvements within 6h |
| **12 hours** | Covers most active session | Reasonable for V1 |
| **24 hours** | Full day — match status often changes within 24h | Too long for live events; match may finish before re-alert is allowed |
| **Match duration** (dynamic) | Only re-alert after the match settles | Best theoretically, but adds complexity |

### Recommended: **12 hours**

Rationale:
- A 12-hour suppression window allows at most 2 alerts per match+outcome per day (at most 1 per 12h cycle)
- Most V1 matches are scheduled >12h in advance, so the first alert is sent well before match start
- If the match hasn't settled within 12h, a re-alert with potentially changed odds is valuable
- If the match settles within 12h, no re-alert is needed (settlement notification covers the outcome)

---

## 4. Conditions to Send a NEW Alert (Override Suppression)

Even within the suppression window, a new alert SHOULD be sent if:

| Condition | Priority | Rationale |
|---|---|---|
| **Edge improved ≥ 50%** | High | e.g., edge went from 6% to 9% — significantly better value |
| **Odds improved ≥ 20%** | High | e.g., odds went from 2.18 to 2.62 — materially better price |
| **Previous opportunity was settled** | High | Settlement creates a clean slate — the old alert's lifecycle is complete |
| **Outcome direction changed** | Medium | e.g., now favoring Team A instead of Team B |
| **Edge dropped below threshold** | Low | Don't send a "no longer value" alert |

**Recommended override condition for V1:** None — keep it simple. If the match+outcome was alerted within the last 12 hours, skip. Overrides add complexity with minimal benefit for V1.

---

## 5. Recommended Implementation

### Location: `ValueDetectionService.detectForMatchExternalIds()`

Add a check **before inserting a new ValueOpportunity** (after the edge passes all filters, but before `toInsert.push()`):

```typescript
// Pseudo-code — add near line 165 (before odds filter, or after edge passes)
// to minimize unnecessary query load when detection fails early.

// After consensus probability is valid and edge passes all thresholds,
// check if this match+outcome was recently alerted.

const recentlyAlerted = await this._prisma.valueOpportunity.findFirst({
  where: {
    matchId,
    outcome,
    alertedAt: { not: null },
    alertedAt: { gte: new Date(Date.now() - SUPPRESSION_WINDOW_MS) },
  },
  select: { id: true },
});

if (recentlyAlerted) {
  this._decision('SUPPRESSED', { matchId, outcome, reason: 'recently alerted within suppression window' });
  rejected++;
  continue;
}
```

### Suppression Window Constant

```typescript
// src/value-detection/value-detection.service.ts
const SUPPRESSION_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours
```

### Changes Required

| File | Change |
|---|---|
| `src/value-detection/value-detection.service.ts` | Add `findFirst` check before insertion; add `SUPPRESSION_WINDOW_MS` constant; add `'SUPPRESSED'` to decision type |
| `src/value-detection/value-detection.types.ts` | Add `'SUPPRESSED'` to `ValueDetectionDecision` union |

No changes to:
- `DiscordNotificationService` (still sends alerts for any `alertedAt IS NULL` record)
- `OddsSnapshotWorker` / `EsportsOddsSnapshotWorker` (still calls detection + notification)
- Prisma schema
- Configuration

### Why This Location

Putting the check in `ValueDetectionService` rather than `DiscordNotificationService` is safer because:

1. The suppression check happens **once per detection**, not once per notification
2. It prevents ValueOpportunity creation entirely — no wasted DB space
3. The detection decision log (`'SUPPRESSED'`) is visible in logs for debugging
4. The notification layer doesn't need to know about deduplication — it just sends alerts for whatever rows exist

---

## 6. Implementation Risk Classification

### **LOW**

| Risk | Mitigation |
|---|---|
| Missed alerts when edge changes within window | Low impact — edge changes are unlikely within 12h for stable markets. Override conditions can be added in V2. |
| Query performance | Single `findFirst` with indexed columns (`matchId` indexed, `alertedAt` indexed). Will be under 5ms even at 10k rows. |
| Race condition between detection and notification | Not applicable — detection runs before notification in the same worker. Single-threaded by BullMQ `concurrency: 1`. |
| Undetected real value creation | The 12h window is wide enough that significant market moves would be captured. The worst case is missing one alert cycle (1h for fast sports). |

---

## 7. Summary

| Decision | Recommendation |
|---|---|
| **Dedup key** | `matchId + outcome` |
| **Suppression window** | **12 hours** |
| **Override conditions** | None in V1 |
| **Implementation location** | `ValueDetectionService.detectForMatchExternalIds()` |
| **Files changed** | `value-detection.service.ts` + `value-detection.types.ts` |
| **New decision type** | `'SUPPRESSED'` |
| **Risk** | **LOW** |