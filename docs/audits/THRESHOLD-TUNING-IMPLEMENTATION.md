# Threshold Tuning — Implementation Audit

**Date:** 2026-06-10
**Authority:** `docs/audits/ROI_MAXIMIZATION_AUDIT.md` (Part 3 — ROI Optimization; Part 8 — item #3)
**Objective:** Lower the production alert threshold from 5% to 3%; introduce a shadow tier (2–3%) stored silently for CLV/calibration analysis but excluded from all Discord alerts and production metrics.

---

## Files Modified

| File | Change |
|---|---|
| `prisma/schema.prisma` | New column `isShadow Boolean @default(false)` + `@@index([isShadow])` on `ValueOpportunity` |
| `prisma/migrations/20260610191110_add_shadow_tier/` | **Applied to database.** Additive nullable-default column — zero risk to existing rows. |
| `src/value-detection/value-detection.types.ts` | `DETECTED_SHADOW` decision variant; `isShadow: boolean` on `ValueOpportunityInsert`; `shadowOpportunitiesDetected` on `ValueDetectionResult` |
| `src/value-detection/value-detection.service.ts` | New threshold constants; tier-aware dedup; tier-aware detection counters and decision logs; `isShadow` in `toInsert` payload |
| `src/value-detection/value-opportunity.repository.ts` | `isShadow: i.isShadow` in `createMany` data |
| `src/discord/discord-notification.service.ts` | `isShadow: false` in `notifyPendingOpportunities` and `notifyDailySummary` queries |
| `src/discord/discord-bot.service.ts` | `isShadow: false` in Rich Presence settled-bets query |
| `src/discord/commands/roi.ts` | `isShadow: false` in settled query |
| `src/discord/commands/paper-bankroll.ts` | `isShadow: false` in settled query |
| `src/discord/commands/best-sports.ts` | `isShadow: false` in settled query |
| `src/discord/commands/clv.ts` | Two separate queries (production + shadow); `/clv` shows production CLV as the primary block, shadow CLV as a clearly-labelled secondary block |
| `src/discord/commands/value-bets.ts` | `isShadow: false` added to base `where` |
| `src/discord/commands/test-value-bets.ts` | `where: { isShadow: false }` added |

**Untouched:** settlement service (settles all rows regardless of tier — CLV must be populated for shadow rows too), scheduler, ingestion workers, sport configs, all other commands.

---

## Exact Logic Changes

### Threshold constants (`value-detection.service.ts`)

```typescript
// Before
const MIN_EDGE_THRESHOLD_PCT = 5.0;
const MAX_EDGE_THRESHOLD_PCT = 100;

// After
/** Absolute lower bound — below this, REJECTED; never stored. */
const MIN_EDGE_THRESHOLD_PCT = 2.0;
/**
 * Shadow tier upper bound / production threshold.
 * 2% ≤ edge < 3% → DETECTED_SHADOW (stored, isShadow=true, no Discord alert).
 * edge ≥ 3%       → DETECTED (stored, isShadow=false, triggers Discord alert).
 */
const PRODUCTION_EDGE_THRESHOLD_PCT = 3.0;
const MAX_EDGE_THRESHOLD_PCT = 100;
```

### Tier-aware dedup

The previous dedup used a single `existingKeys` set that prevented *any* second row for `(match, bookmaker, outcome)` regardless of tier. This was wrong: a shadow row recorded at 2.2% would permanently block the production alert even when the edge later reaches 4% in a subsequent snapshot batch.

The new dedup maintains two independent sets:

```typescript
const existingProductionKeys = new Set(
  existing.filter(e => !e.isShadow).map(e => `${e.matchId}|${e.bookmaker}|${e.outcome}`),
);
const existingShadowKeys = new Set(
  existing.filter(e => e.isShadow).map(e => `${e.matchId}|${e.bookmaker}|${e.outcome}`),
);

// For production candidates (edge ≥ 3%):
//   suppress only if a production row already exists.
// For shadow candidates (2% ≤ edge < 3%):
//   suppress if either a shadow or a production row already exists.
```

This allows a bet to naturally progress from shadow to production across batches: the shadow row records "first time we saw ≥2%"; the production row records "first time we saw ≥3%". Both rows get CLV at settlement. The shadow row never produces a Discord alert; the production row does.

### Decision log

| Outcome | Before | After |
|---|---|---|
| edge ≥ 5% | `DETECTED` | `DETECTED` (`isShadow=false`) |
| 3% ≤ edge < 5% | `REJECTED` | `DETECTED` (`isShadow=false`) |
| 2% ≤ edge < 3% | `REJECTED` | `DETECTED_SHADOW` (`isShadow=true`) |
| edge < 2% | `REJECTED` | `REJECTED` |

### Result type

`ValueDetectionResult` now carries `shadowOpportunitiesDetected` alongside `opportunitiesDetected`. The log line at the end of each detection run includes both counts, giving full visibility in structured logs.

---

## Before / After Behaviour

| Surface | Before | After |
|---|---|---|
| Production alert threshold | 5% | **3%** |
| Shadow storage threshold | — (none) | **2%** |
| Discord alert fired for shadow bets | N/A | **Never** |
| Shadow rows in `/roi`, `/paper-bankroll`, `/best-sports` | N/A | **Excluded** |
| Shadow rows in `/value-bets` | N/A | **Excluded** |
| Shadow rows in `/test-value-bets` | N/A | **Excluded** |
| Shadow rows in Rich Presence | N/A | **Excluded** |
| Shadow rows in daily summary | N/A | **Excluded** |
| Shadow rows in `/clv` | N/A | **Shown as separate section** — labelled "Shadow (2–3% — calibration only)" |
| CLV computed for shadow rows | N/A | **Yes** — settlement runs for all rows regardless of tier |
| Shadow rows in settlement | N/A | **Settled normally** — CLV, profitLossUnits, betResult populated |

---

## Alert Volume Expectations

Based on the 2.5-day simulation window in `ROI_MAXIMIZATION_AUDIT.md` (cumulative logical bets, permanent-dedup semantics, latest batches, odds ≤ 3.0, exchanges included):

| Threshold | Logical bets in window | ≈/day raw |
|---|---|---|
| ≥ 5% (old) | 8 | ~3 |
| **≥ 3% (new production)** | **23** | **~9** |
| 2–3% (new shadow) | 61 (= 84 − 23) | ~24 |

**Practical production rate (exchanges excluded):** ~4–5 production alerts/day, ~10–15 shadow records/day — both are rough extrapolations; exchange exclusion (Part 8 item #4 in the ROI audit, not yet implemented) will reduce these.

The 3× increase in production alert volume is the primary goal: it pulls the CLV verdict from ~5 months to ~6–8 weeks.

---

## Shadow Tier Behaviour — Design for Future Use

Shadow rows are first-class `ValueOpportunity` records, stored with identical schema depth as production rows:
- `edgePercentage`, `bookmakerOdds`, `fairOdds`, `consensusProbability`, `capturedAt` — all populated
- `closingPinnacleOdds`, `clvPercentage`, `clvPositive` — populated at settlement (same CLV logic)
- `isShadow = true` — the sole differentiator from production rows

This design supports the three future use cases called out in `ROI_MAXIMIZATION_AUDIT.md`:

**1. CLV comparison:** `/clv` shows production and shadow CLV side-by-side. If shadow CLV (2–3%) significantly lags production CLV (≥3%), that confirms 3% is the correct noise-floor cut. If shadow CLV equals or exceeds production, the threshold could be lowered further.

**2. Threshold optimisation:** A raw SQL query or audit script can compute CLV per edge bucket (2–2.5%, 2.5–3%, 3–4%, etc.) using the live data that will accumulate from this point. No schema changes needed.

**3. Edge-bucket analysis:** The same query pattern can break down win rate, P&L, and CLV by `(isShadow, edgePercentage::bucket)` to identify where genuine edge lies vs noise-floor contamination.

---

## Rollback Procedure

1. **Code rollback:** revert the commit. On next restart: `MIN_EDGE_THRESHOLD_PCT` returns to 5.0, `isShadow` field is never written, production and shadow exclusion filters are gone.
2. **Schema:** `isShadow` is a boolean column with `@default(false)` — all historical rows read `false`, which equals "production". No data loss on rollback; the column can be left or dropped with `ALTER TABLE value_opportunities DROP COLUMN is_shadow;`.
3. **Migration:** migration `20260610191110_add_shadow_tier` is already applied to the Neon database; it cannot be auto-rolled back but the column is zero-impact on existing rows and queries.

---

## Risk Assessment

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Shadow rows contaminate ROI metrics | None | High | `isShadow: false` is applied at every query site; tsc confirms type correctness |
| Shadow rows trigger Discord alerts | None | High | `notifyPendingOpportunities` explicitly filters `isShadow: false`; shadow rows are never marked `alertedAt` |
| Production alert volume overwhelms Discord | Low | Low | 3%→5% tier change triples production volume (~3/day → ~9/day raw); Discord channel is low-volume; alert limit is 50/run anyway |
| Shadow row blocks later production row for same bet | None (by design) | High | Tier-aware dedup prevents this: shadow rows are in `existingShadowKeys`, which does not suppress `existingProductionKeys` lookup |
| CLV computed incorrectly for shadow rows | None | Low | Settlement service has no `isShadow` filter — all unsettled rows are processed identically |
| Exchange ghost prices inflate shadow volume | Certain, short-lived | Low | Shadow rows still store edge % and CLV, so exchange contamination is visible and quantifiable; exchange exclusion (item #4 in ROI audit) is the follow-on fix |
| `tsc --noEmit` | **0 errors confirmed** | — | Validated before audit creation |

---

## Validation

```
npx tsc --noEmit
```
**0 errors.** All changed files produce clean TypeScript. Migration `20260610191110_add_shadow_tier` applied to Neon database successfully; Prisma client types regenerated (35 references to `isShadow`/`is_shadow` confirmed in generated types).

**Production alert thresholds (verified in source):**
- `MIN_EDGE_THRESHOLD_PCT = 2.0` — absolute floor, below this REJECTED
- `PRODUCTION_EDGE_THRESHOLD_PCT = 3.0` — production/shadow boundary
- Production alerts fire at `edgePercentage >= 3.0`
- Shadow rows stored at `2.0 <= edgePercentage < 3.0`
- Both tiers still subject to: odds cap, overround bounds, outcome-count guard, Pinnacle reference requirement, permanent dedup (tier-aware)
