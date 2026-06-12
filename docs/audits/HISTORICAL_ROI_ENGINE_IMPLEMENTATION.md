# Historical ROI Engine — Implementation Audit

**Date:** 2026-06-12
**Constraint honored:** **zero additional API credits.** No downloads, no probes, no new imports — the engine works entirely from the historical data already stored locally.
**Validation:** `npx tsc --noEmit` 0 errors · ESLint 0 errors · calibration check below.

---

## 1. The Core Idea — Results Without a Results Feed

The Odds API offers no historical scores beyond 3 days, and the credit budget was zero. The results came from inside the data we already own: **the stored sport-level snapshots captured other events while they were in-play** (the replay engine had counted 1,000+ in-play batches it refused to detect on). A match whose median in-play price has collapsed to ≤1.03 late in the game has, with ~97–99% certainty, been decided. That is a result, inferable locally.

**Inference rule (`src/backtest/results.ts`):**
- Only in-play batches at least `minElapsedMinutes` after commence qualify (soccer 70, basketball 100, hockey 80, tennis 90) — early in-play prices are not results.
- Per outcome, the **median price across all books** in the latest qualifying batch (robust to stale quotes).
- **Winner inferred** only when exactly one outcome is at ≤ 1.03. Persisted to `historical_events.result_outcome` (`result_method = INPLAY_PRICE`, plus the evidence timestamp). Everything else stays NULL — never imputed.

**Settlement rule (`settleRun`)** — and the bias this implementation caught and fixed:
- Only events with an inferred winner settle; every opportunity row of such an event then settles symmetrically (WIN if its outcome is the winner, else LOSS). Flat 1u: WIN = odds−1, LOSS = −1. Written to the existing scorer-owned label columns (`bet_result`, `profit_loss_units`).
- **The first implementation also settled rows from one-sided row-level evidence ("our outcome drifted to ≥15 → LOSS"). This was caught and removed before any reporting: loss evidence is structurally easier to observe than win evidence, so the mixed rule loss-skews the settled subset** (first pass: 19W–68L; corrected winner-only pass: 19W–55L). All labels were cleared and re-settled under the unbiased rule (`scripts/backtest/roi-resettle.ts`).

## 2. What Was Reused (per requirement, no duplicated logic)

| Existing component | Role in the ROI engine |
|---|---|
| `detector-core` / replay engine | Untouched — all 9 existing runs' stored detections are the bet population |
| `idea-aggregation` (`groupIdeas`/`selectHeadline`) | ROI is idea-denominated: one flat unit on the headline row, identical to live accounting |
| Movement annotations (`pinnacleMove6h`) | ROI-by-movement-class segmentation |
| `backtest_opportunities` label columns | Settlement writes the pre-existing `bet_result`/`profit_loss_units` — the scorer/replay column separation was already designed for this |
| CLV scores | Carried as the supporting diagnostic column in every ROI line |

**New files:** `src/backtest/results.ts` (inference + settlement), `src/backtest/roi-reporting.ts` (idea/sport/league/bookmaker/tier/threshold/movement ROI), `scripts/backtest/roi-settle.ts`, `roi-resettle.ts`, `roi-report.ts`. **New migration:** `20260612073430_add_historical_results` (3 nullable columns on `historical_events`).

## 3. Coverage and Validity

- **700 stored events checked → 102 winners inferred (15%).** Coverage is bounded by the targeted backfill grid: in-play observations exist only when an event happened to be live during *another* event's snapshot timestamps. 377 stored opportunity rows → 74 settled (19W–55L); **25 settled ideas at threshold 2.0%, 14 at 3.0%.**
- **The calibration check (the engine's built-in honesty meter):** every ROI line reports `expW` = the sum of de-vigged fair win probabilities of the settled bets. Across the board, realized wins match it: 11 vs 11.3 (2.0%), 8 vs 8.2 (2.5%), 5 vs 6.1 (3.0%). Interpretation: (a) the settlement subset shows **no detectable selection bias** after the fix, and (b) the bets win at the rate Pinnacle's fair probabilities predict — the precondition for the detected edges being real cash flow.
- **Residual biases, stated:** resolved events skew toward one-sided finishes (winner must hit ≤1.03 while we happened to be watching); a ≤1.03 side still loses ~1–3% of the time; close finishes are systematically unresolved. The expW calibration bounds the practical impact, but ROI from this engine is a *noisy, partially-selected estimate*, not ground truth.
- **Statistical power, bluntly:** at n=14–25 settled ideas with avg odds ~2.5, the standard error of ROI is ±25–35 percentage points. This engine, on this dataset, can detect a catastrophe (−50%) or a miracle (+50%); it cannot distinguish −10% from +10%. Every consumer of these numbers must read them with that band attached.

## 4. Usage

```
npx tsx --env-file=.env scripts/backtest/roi-settle.ts <runId> [...runIds]   # infer + settle
npx tsx --env-file=.env scripts/backtest/roi-report.ts <runId:days> [...]    # ROI report (disjoint runs only)
```

Settled this session (all five disjoint-event runs): core full-grid `24eabcd2`, Nordic full-grid `e0c38b46`, tennis `3c6b62b1`, soccer5 probe `601a4233`, NBA/NHL probe `35c6f9fd`.

## 5. Credit Usage Report

**0 credits.** All inference and settlement is local database computation over previously imported snapshots.
