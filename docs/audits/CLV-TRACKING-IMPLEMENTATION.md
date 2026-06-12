# CLV Tracking Implementation

**Date:** 2026-06-10
**Authority:** `docs/audits/FINAL_V1_AUDIT.md` (P1 improvement #7; Section 6 "evidence missing"; Section 13 V1.5 gate)
**Objective:** Track Closing Line Value — the fastest-converging statistical instrument for whether alerts beat the market (~100–200 samples vs thousands for ROI).

---

## What CLV Means Here

**CLV% = (alert odds ÷ de-vigged Pinnacle closing fair odds − 1) × 100**

- *Alert odds* — the candidate bookmaker's price recorded on the opportunity (`bookmakerOdds`).
- *Pinnacle close* — Pinnacle's prices from the **last snapshot batch captured before kickoff** (`capturedAt ≤ match.startTime`, `isLive = false`), taken from the odds-snapshot history the system already collects.
- *De-vigged*: `fairOdds(o) = rawClose(o) × overround`, where `overround = Σₖ 1/rawClose(k)` across all outcomes — the same normalisation and the same sanity bounds (overround ∈ [0.99, 1.15], ≥2 outcomes) used by the Pinnacle-led detection model.

Measuring against the **de-vigged** close makes CLV zero-mean for a no-edge bettor: a strategy with no skill that takes random prices will average ≈ 0% CLV; a strategy that systematically beats the market shows persistently positive CLV. (Raw-close CLV would be biased positive by roughly half the overround.) The **raw** Pinnacle closing price is stored alongside, as required, for transparency and re-derivation.

When no usable close exists (no pre-kickoff Pinnacle batch, fewer than 2 outcomes, overround out of bounds, or outcome not quoted), all three CLV fields remain `null` — never guessed.

---

## Files Modified / Created

| File | Change |
|---|---|
| `prisma/schema.prisma` | Three nullable columns on `ValueOpportunity`: `closingPinnacleOdds Decimal?`, `clvPercentage Decimal?`, `clvPositive Boolean?` |
| `prisma/migrations/20260610172704_add_clv_tracking/` | **New migration — applied to the database.** Additive nullable columns; zero risk to existing rows. |
| `src/settlement/settlement.service.ts` | CLV computed inside `_settleUnsettled` for every newly settled opportunity: new private helper `_closingPinnacleQuotes(matchId, startTime)` loads the last pre-kickoff Pinnacle batch and returns per-outcome `{raw, fair}` quotes (one DB lookup per match per run, cached). The settlement `update` now writes `closingPinnacleOdds`, `clvPercentage`, `clvPositive` when a usable close exists. Unsettled query select extended with `matchId` + `match.startTime`. |
| `src/discord/commands/clv.ts` | **New** `/clv` command — reports average CLV, median CLV, positive-CLV %, and sample size (plus coverage: settled bets with CLV vs all settled). Applies the same reporting filters as every other surface: `settledAt ≥ ROI_V2_BASELINE` + TRADITIONAL-only. |
| `src/discord/discord-bot.service.ts` | `/clv` registered in `SLASH_COMMANDS` and routed in `_handleCommand`. |
| `src/discord/discord-notification.service.ts` | Daily summary now appends a CLV line — `avg | median | positive % | n` — whenever at least one settled bet in the 24h window carries CLV data. Window query select extended with the two CLV fields. |

**Untouched:** detection model, scheduler, sports config, esports state, ROI formulas, all other commands. The lint-only change of `let unresolvable` → `const` in settlement has no behavioral effect (the counter was already never incremented — known audit finding C2, unchanged in scope here).

---

## Requirement Mapping

| Requirement | Implementation |
|---|---|
| 1. Store alert odds | Already stored as `bookmakerOdds` (the alert price); no new column needed |
| 1. Store closing Pinnacle odds | `closing_pinnacle_odds` (raw price, last pre-kickoff batch) |
| 1. Store CLV % | `clv_percentage` (vs de-vigged close) |
| 1. Store positive/negative flag | `clv_positive` (`clvPercentage > 0`) |
| 2. Calculate at settlement | `_settleUnsettled` computes CLV in the same update that writes `settledAt`/`betResult`/`profitLossUnits` |
| 3. `/clv` command | `src/discord/commands/clv.ts`, registered guild slash command |
| 3. Daily summary CLV section | Appended to `notifyDailySummary` output |
| 4. Average / median / positive % / sample size | All four in both `/clv` and the daily summary (median is even-length-aware) |

---

## Worked Example (real data)

IFK Norrkoping, alerted at 2.56. Pinnacle's last pre-kickoff batch quoted the outcome at 2.49 raw; market overround 1.048 → closing fair odds = 2.49 × 1.048 = **2.61**.

```
CLV% = (2.56 / 2.61 − 1) × 100 = −1.91%   → clvPositive = false
Stored: closingPinnacleOdds = 2.49, clvPercentage = −1.91, clvPositive = false
```

The bet *won* (+1.56u) but carried negative CLV — exactly the distinction CLV exists to make: the result was luck, the price was worse than the market's final estimate.

---

## Validation

### `npx tsc --noEmit`
**0 errors.** ESLint on all changed files: clean. Migration `20260610172704_add_clv_tracking` applied successfully; Prisma client types regenerated (the only generate warning was a Windows file-lock on the unchanged query-engine DLL — types verified present).

### Read-only dry run over all 50 historical settled bets
The settlement-time CLV logic was replicated read-only against the live database (no writes):

| Metric | Result |
|---|---|
| CLV computable | **45 / 50 (90%)** — 5 lacked a usable pre-kickoff Pinnacle close |
| Average CLV | **−2.57%** |
| Median CLV | **−2.79%** |
| Positive CLV | **24.4%** |

This is itself a research result: the historical bets are almost all **old-model (Pinnacle-candidate) bets**, and their CLV profile — average −2.6%, only a quarter beating the close — empirically confirms FINAL_V1_AUDIT Section 6's verdict that the old model was betting against the closing line (predicted −3% to −10% expectancy). The instrument works, and its first reading validates the model migration. Note these historical rows were *not* backfilled — the dry run wrote nothing; CLV populates at settlement going forward.

### Surface behavior
- `/clv` with no data returns a clear "No CLV data yet" message (CLV requires post-deployment settlements).
- Daily summary omits the CLV line entirely when no settled bet in the window has CLV — no noise.
- Pending legacy bets (18 old-model opportunities) will receive CLV when they settle; since `/clv` filters `settledAt ≥ ROI_V2_BASELINE`, those legacy bets **will appear** in the early `/clv` sample — same short-lived mixed-model caveat already documented in `PINNACLE_LED_MODEL_IMPLEMENTATION.md`. Their expected negative CLV will drag the early average; interpret the first weeks accordingly (or add `bookmaker: { not: 'pinnacle' }` for a pure new-model view — one-line follow-up, not applied).

---

## Interpretation Guide (for the V1.5 go/no-go gate)

- **avg CLV > +1% over 100–200 new-model bets** → alerts genuinely beat the market; the strategy has a measurable edge worth developing.
- **avg CLV ≈ 0%** → alerts match the market; paper "edges" are noise/stale quotes.
- **avg CLV < 0%** → alerts are adversely selected; stop and rethink before adding anything.
- Positive-CLV % is the robustness check: a high average driven by a few outliers with positive-rate < 50% is suspect.

---

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| "Closing" price isn't the true close | Medium | Low | The last pre-kickoff snapshot can be up to one polling interval (1–4h) before kickoff. This adds noise, not bias — line moves in the final hour are missed in both directions. Documented; tighter pre-kickoff polling is a possible later refinement. |
| No usable close → null CLV shrinks sample | Low | Low | 90% coverage on historical data; coverage is reported in `/clv` so shrinkage is visible. |
| Extra DB load at settlement | Low | Low | One indexed snapshot query per match per settlement run (`@@index([matchId, capturedAt])`), cached across that match's opportunities. |
| Legacy bets contaminate early CLV sample | Certain, short-lived | Low | 18 pending old-model bets; documented above with the one-line filter remedy if wanted. |
| Outcome name mismatch vs Pinnacle close | Low | Low | Outcome strings are byte-identical across bookmakers within a The Odds API event; mismatches yield null CLV (never a wrong value). |

## Rollback

1. Revert the code commit — settlement stops writing CLV, `/clv` disappears from registration on next startup, daily summary loses the section.
2. Columns are nullable and additive; they can stay harmlessly, or be dropped with a down migration (`ALTER TABLE value_opportunities DROP COLUMN closing_pinnacle_odds, DROP COLUMN clv_percentage, DROP COLUMN clv_positive;`).
3. No Redis or scheduler state involved.
