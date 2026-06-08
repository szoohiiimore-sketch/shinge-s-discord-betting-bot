# Alert Probability Display Enhancement

**Date:** 2026-06-08  
**Scope:** Add Market Probability and Consensus Probability to Discord value-bet notifications  

---

## Changes Made

### File Modified

**`src/discord/discord-notification.service.ts`** — Two changes:

1. **New helper function** `displayProbability()` (line 48-55):

```typescript
function displayProbability(odds: unknown): string {
  const n = typeof odds === 'object' && odds !== null && 'toNumber' in odds
    ? (odds as { toNumber(): number }).toNumber()
    : Number(odds);
  if (n <= 0) return '0.0%';
  return `${((1 / n) * 100).toFixed(1)}%`;
}
```

2. **Updated `formatAlert()`** to accept `consensusProbability: unknown` in its parameter type and to display two new lines:

```diff
+ `**Market Probability:** ${displayProbability(opp.bookmakerOdds)}`,
+ `**Consensus Probability:** ${displayProbability(opp.fairOdds)}`,
  `**Odds:** ${displayOdds(opp.bookmakerOdds)}`,
  `**Fair Odds:** ${displayOdds(opp.fairOdds)}`,
```

The `consensusProbability` field was added to the parameter type for type safety, though it is not separately rendered — the consensus probability is derived from `fairOdds` using the same `displayProbability()` function.

---

## Data Sources

| Displayed Field | Source Value | Formula |
|---|---|---|
| **Market Probability** | `bookmakerOdds` (Pinnacle decimal odds) | `(1 / bookmakerOdds) × 100` |
| **Consensus Probability** | `fairOdds` (calculated fair odds) | `(1 / fairOdds) × 100` |

Both values are already produced by `ValueDetectionService` and stored in the `ValueOpportunity` database record. The notification layer reads them from the database via the Prisma query and passes them to `formatAlert()`. No new calculations or database queries were added.

---

## Example Discord Output (Before → After)

### Before
```
🎯 VALUE BET DETECTED

Sport: Baseball
Match: Los Angeles Angels vs Houston Astros

Outcome: Los Angeles Angels
Bookmaker: Pinnacle

Odds: 2.18
Fair Odds: 2.07
Edge: +5.5%

Captured: 2026-06-08 14:30 UTC
```

### After
```
🎯 VALUE BET DETECTED

Sport: Baseball
Match: Los Angeles Angels vs Houston Astros

Outcome: Los Angeles Angels
Bookmaker: Pinnacle

Market Probability: 45.9%
Consensus Probability: 48.3%
Odds: 2.18
Fair Odds: 2.07
Edge: +5.5%

Captured: 2026-06-08 14:30 UTC
```

**Verification:**
- `Market Probability = (1 / 2.18) × 100 = 45.9%`
- `Consensus Probability = (1 / 2.07) × 100 = 48.3%`

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| `displayProbability(2.18)` = `45.9%` | ✅ (1 / 2.18) × 100 = 45.871... → `45.9%` |
| `displayProbability(2.07)` = `48.3%` | ✅ (1 / 2.07) × 100 = 48.309... → `48.3%` |
| `displayProbability(0)` = `0.0%` | ✅ Guard for zero/negative |
| `displayProbability(9.04)` = `11.1%` | ✅ (1 / 9.04) × 100 = 11.061... → `11.1%` |
| No new business logic | ✅ Only formatting — reuses existing `bookmakerOdds` and `fairOdds` |
| No schema changes | ✅ Only notification formatting |

---

## Verdict

**PASS** — Both Market Probability and Consensus Probability are now displayed in Discord value-bet notification messages. No business logic, database schema, or value detection code was modified.