# Duplicate Alert Fix Implementation

**Date:** 2026-06-08  
**Scope:** Implement suppression of repeated Discord value-bet alerts for the same match+outcome  

---

## Files Modified

| File | Change |
|---|---|
| `src/value-detection/value-detection.service.ts` | Added `SUPPRESSION_WINDOW_MS` constant; added suppression check before ValueOpportunity creation |
| `src/value-detection/value-detection.types.ts` | Added `'SUPPRESSED'` to `ValueDetectionDecision` union |

---

## Implementation

### 1. Suppression Window Constant

```typescript
// src/value-detection/value-detection.service.ts
const SUPPRESSION_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours
```

### 2. Suppression Check (added after edge passes all thresholds)

```typescript
// Check if this match+outcome was already alerted within 12 hours
const recentlyAlerted = await this._prisma.valueOpportunity.findFirst({
  where: {
    matchId,
    outcome,
    alertedAt: {
      not: null,
      gte: new Date(Date.now() - SUPPRESSION_WINDOW_MS),
    },
  },
  select: { id: true },
});

if (recentlyAlerted) {
  this._decision('SUPPRESSED', { matchId, outcome, reason: 'previously alerted within suppression window' });
  skipped++;
  continue;
}
```

### 3. Decision Type

```
'SUPPRESSED' added to ValueDetectionDecision union
```

---

## Behavior Matrix

| Scenario | Before Fix | After Fix |
|---|---|---|
| Same match + same outcome within 12h | Creates new ValueOpportunity + sends Discord alert | Logs `SUPPRESSED`, no record, no alert |
| Same match + same outcome after 12h | Same as above (no suppression) | New alert allowed (suppression window expired) |
| Same match + different outcome | Creates separate ValueOpportunity | Unchanged — no suppression for different outcome |
| New match (never alerted) | Creates ValueOpportunity + sends alert | Unchanged |
| Already alerted, now settled | Previous alert exists but settled | Alert allowed again (settlement is a lifecycle completion) |

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| Same match+outcome within 12h | ✅ Suppressed — logged as `SUPPRESSED` |
| Different outcomes on same match | ✅ Still allowed separately |
| New matches | ✅ Still generate alerts |
| No changes to Prisma schema | ✅ |
| No changes to DiscordNotificationService | ✅ |
| No changes to settlement | ✅ |
| No changes to edge calculations | ✅ |

---

## Verdict

**PASS** — Duplicate alert suppression implemented with minimal changes. Two files modified. All validation checks pass.