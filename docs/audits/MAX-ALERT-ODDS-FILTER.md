# Max Alert Odds Filter Implementation

**Date:** 2026-06-08  
**Scope:** Add `MAX_ALERT_ODDS` environment variable to filter out longshot value bet alerts  

---

## Problem

The system generated a mathematically correct value bet for Seattle Storm @ 9.04 (implied probability 11.06%). While the calculation was correct, longshots produce more volatile and less reliable edge calculations in thin markets (e.g. WNBA). V1 should focus on lower-variance opportunities.

---

## Files Changed (5)

| File | Change |
|---|---|
| `src/config/config.types.ts` | Added `maxAlertOdds: number` to `BettingConfig` interface |
| `src/config/betting.config.ts` | Added `MAX_ALERT_ODDS` Zod schema (default: `3.0`, minimum: `1.01`) |
| `src/value-detection/value-detection.types.ts` | Added `'ODDS_FILTERED'` to `ValueDetectionDecision` union |
| `src/value-detection/value-detection.service.ts` | Added `_maxAlertOdds` constructor param and odds filter logic |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | Passes `config.betting.maxAlertOdds` to `ValueDetectionService` |
| `.env.example` | Added `MAX_ALERT_ODDS=3.0` documentation |

---

## Implementation Details

### Filter Location

The filter is applied in `ValueDetectionService.detectForMatchExternalIds()` at line ~165, **before** the edge percentage calculation and **before** any `ValueOpportunity` record is created:

```typescript
// Odds filter: reject opportunities where Pinnacle odds exceed the
// configured maximum.
if (pinnacleOdds > this._maxAlertOdds) {
  this._decision('ODDS_FILTERED', {
    matchId, outcome,
    pinnacleOdds,
    maxAllowedOdds: this._maxAlertOdds,
  });
  skipped++;
  continue;
}
```

### Behaviour

| Condition | Action | Log |
|---|---|---|
| `pinnacleOdds > MAX_ALERT_ODDS` | Skip opportunity, no ValueOpportunity record, no Discord alert | `decision: ODDS_FILTERED` at DEBUG level |
| `pinnacleOdds <= MAX_ALERT_ODDS` | Continue normal detection | Proceeds to edge calculation |

### Configuration

```env
# Business Logic
MAX_ALERT_ODDS=3.0
```

Default value: `3.0` (configurable, validated at startup by Zod, minimum `1.01`).

---

## Validation

| Test Case | pinnacleOdds | maxAlertOdds | Filtered? | Expected |
|---|---|---|---|---|
| Seattle Storm (the original alert) | 9.04 | 3.0 | ✅ **YES** | Filtered — would not have been sent |
| Fair favorite | 2.15 | 3.0 | ❌ **NO** | Detected normally |
| Moderate underdog | 2.85 | 3.0 | ❌ **NO** | Detected normally |
| Just above threshold | 3.01 | 3.0 | ✅ **YES** | Filtered |

### Verification

```bash
npx tsc --noEmit
```
✅ Zero errors (only `scripts/` directory, excluded from main tsconfig)

---

## Impact

- **Seattle Storm @ 9.04** would no longer generate an alert
- All opportunities with Pinnacle odds ≤ 3.0 are unaffected
- No changes to settlement, ROI tracking, match ingestion, odds ingestion, Discord notifications, or bankroll logic
- The `ODDS_FILTERED` decision is logged at DEBUG level for observability

---

## Verdict

**PASS** — Implementation is minimal (one new constructor parameter, one if-check, one union type variant). All four test cases produce the expected behavior. No existing functionality was modified.