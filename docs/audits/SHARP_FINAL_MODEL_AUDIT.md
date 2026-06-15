# SHARP_FINAL Model — Audit & Deployment

**Date:** 2026-06-14
**Scope:** new **additive** production models `SHARP_FINAL` + `SHARP_FINAL_LOW` (multi-source sharp consensus). The four existing models are **untouched**. Built, backtested, deployed, and validated.
**Validation:** `tsc` clean · ESLint clean · enum migration applied · live detector produces alerts (read-only check).

---

## Executive Summary

SHARP_FINAL replaces the single-Pinnacle reference with a **de-vigged median consensus of a verified sharp panel** (Pinnacle + Betfair Exchange ×2 + Matchbook + Smarkets), directly addressing the single-source-dependence flaw flagged in `HISTORICAL_REPLAY_VALIDATION_AUDIT.md` (M3). It is the production form of the C3 concept.

**Honest result up front:** the multi-sharp consensus is **more conservative than single Pinnacle** (exchanges' no-vig prices tighten the fair line), so it generates **few alerts and shows no demonstrated edge.** On the football-data backtest it is **+1.2% ROI on n=53 (statistically zero)**; live it produces ~**0.5/day**. It is the **theoretically soundest** model and the one that best "reduces dependence on a single sharp source" — but the data does **not** show it beats Pinnacle-Led. It is deployed as instructed; the evidence-based "what I'd actually run" answer is **not** SHARP_FINAL (§Most Important Question).

---

## Phase 0 — Sharp Source Audit (verified from actual API keys, not assumed)

Queried the live store: **53 distinct bookmaker keys** present in H2H responses. Classification:

| Tier | Keys (verified present) | Match coverage |
|---|---|---|
| **Tier 1 — Sharp / Exchange** | `pinnacle`, `betfair_ex_uk`, `betfair_ex_eu`, `matchbook`, `smarkets` | 247 / 201 / 198 / 175 / 150 (of ~213 matches/wk) |
| **Tier 2 — Semi-sharp** | `lowvig`, `betonlineag` (reduced-juice US) | ~210 |
| **Tier 3 — Soft (candidates)** | `bet365`, `unibet_*`, `leovegas_*`, `betsson`, `nordicbet`, `coolbet`, `williamhill`, `betvictor`, `paddypower`, `fanduel`, `draftkings`, `betmgm`, `betway`, `tipico_de`, `winamax_*`, … (the other ~45) | high |

**Selected sharp panel:** `['pinnacle','betfair_ex_uk','betfair_ex_eu','matchbook','smarkets']` (Tier 1 only). Tier-2 reduced-juice books were *not* included (they carry margin; keeping the panel to true no-/low-vig sharps maximises reference accuracy). **Coverage check (live, 7d): 201 of 213 matches have ≥2 panel sources; most have 4–5.**

---

## Phase 1 — Sharp Consensus Design

- **Weighting:** equal-weight **median** of the panel's implied probabilities per outcome (robust to one stale/odd source; no hand-tuned weights).
- **Consensus → de-vig → fair:** `consensusRaw(o)=median(panel 1/odds)`; `S=Σ_o consensusRaw`; `fairProb(o)=consensusRaw(o)/S`; overround-bounded `[0.99,1.15]`.
- **Edge → alert:** soft-book `odds × fairProb − 1 ≥ 3%` (production) / `≥2%` (shadow→low). Odds cap 3.0. **Same edge bar as Pinnacle-Led** (no tuning advantage).
- **Outlier handling:** median (not mean) + overround sanity bounds.
- **Missing-book handling:** require `≥ minSharpSources = 2`; with only one panel source the match is skipped (it would just re-derive a single-source reference). Rarely triggered (94% coverage).
- **Exchange back-price commission:** left un-adjusted — a deliberately **conservative** bias (understates exchange implied prob → higher fair odds → fewer/smaller edges).

`src/value-detection/sharp-final-detector-core.ts` (pure, shared by live + replay).

---

## Phase 2 — Two Versions

- **SHARP_FINAL** — standard, edge ≥3%, odds ≤3.0.
- **SHARP_FINAL_LOW** — shadow band (2–3%) restricted to the low-odds buckets via the existing `pinnacleLedLowOddsThresholdPct` philosophy; strongest-outcome-per-match conflict resolution (mirrors LOW_ODDS_PINNACLE_LED).

---

## Phase 3 — Historical Replay (reused the football-data CSV framework — no second engine)

Reused `scripts/backtest/csv-replay.ts` + the production detector cores; exact settlement from the result column. **Dataset limitation (stated honestly): football-data carries only TWO sharp sources (Pinnacle + Betfair Exchange), so the backtest tests a *degraded 2-source* SHARP_FINAL; live uses five.** Identical idea-level flat-1u methodology across all six models.

**All matches (101,051; exact results):**

| Model | Alerts | W–L | Win% | Avg odds | Avg edge | ROI | ~95% CI |
|---|---|---|---|---|---|---|---|
| LEGACY | 5,500 | 2,081–3,419 | 37.8% | 2.53 | 7.24% | **−6.0%** | [−8.7, −3.2] |
| **PINNACLE_LED** | 427 | 191–236 | 44.7% | 2.44 | 6.92% | **+5.4%** | [−4.6, +15.4] |
| LOW_ODDS_LEGACY | 3,276 | 1,673–1,603 | 51.1% | 1.92 | 3.76% | −3.8% | [−7.3, −0.3] |
| LOW_ODDS_PINNACLE_LED | 49 | 32–17 | 65.3% | 1.74 | 2.59% | +13.5% | [−16, +43] |
| **SHARP_FINAL** | **53** | 23–30 | 43.4% | 2.50 | 5.96% | **+1.2%** | ≈[−27, +30] |
| **SHARP_FINAL_LOW** | 12 | 6–6 | 50.0% | 1.72 | 2.56% | −13.6% | huge |

**SHARP_FINAL: 53 alerts over 101k matches, +1.2% (n=53, indistinguishable from zero), ~8× fewer alerts than Pinnacle-Led.** The consensus including exchange no-vig prices is markedly more conservative than single Pinnacle.

---

## Phase 4 — Expected Live Volume (read-only check, last 7 days, full 5-source panel)

| Model | /day | /week | /month |
|---|---|---|---|
| **SHARP_FINAL** | ~0.5–0.6 | ~4 | ~15–20 |
| **SHARP_FINAL_LOW** | ~0.1–0.2 | ~1 | ~4–6 |
| Pinnacle-Led (same window) | ~0.3–1.5 | ~2–10 | ~10–45 |
| Legacy | ~4–5 | ~30 | ~130 |
| Low-Odds Legacy | ~3 | ~20 | ~90 |

With the full 5-source live panel SHARP_FINAL is **comparable in order to Pinnacle-Led** (4 ideas vs Pinnacle-Led's 2 in the sampled week — both tiny). It is a **low-volume, high-selectivity** model.

---

## Phase 5 — API Cost Impact

**Zero additional API usage.** SHARP_FINAL is **pure post-processing of the odds snapshots already fetched** — every panel book (`pinnacle`, `betfair_ex_*`, `matchbook`, `smarkets`) is already returned in the existing `/odds` responses for the current regions. No new requests, no new polling, no new sports.

| | |
|---|---|
| Current usage | unchanged (existing per-sport polling) |
| Additional requests | **0** |
| Additional daily / monthly cost | **$0 / $0** |
| Additional polling | **none** |
| Marginal cost | one extra in-memory detector call per match batch (µs) + a few DB rows/day |

Reuse is total — by design, no unnecessary API load.

---

## Phase 6–7 — Deployment & ROI Integration

- **Schema:** `DetectionModel` enum += `SHARP_FINAL`, `SHARP_FINAL_LOW` (migration `20260614120000_add_sharp_final_models`, additive `ALTER TYPE ... ADD VALUE`, **applied to production**).
- **Detection pipeline:** `value-detection.service.ts` — additive SHARP_FINAL family block (own per-triple dedup + SHARP_FINAL_LOW strongest-per-match conflict guard). The four existing families are byte-unchanged.
- **Discord alerts:** new `MODEL_TAG` entries; alerts route to the **main #bet-alerts channel** (not the low-odds channel) via the existing dynamic per-model alerting; idea-level de-dup prevents duplicates.
- **ROI / summaries / stats:** `reporting-config` (DetectionModelValue, modelsFor, displays, `/roi model` choices), daily-summary model loop, `historical-seed` (empty seed — no in-play backtest exists), `historical-csv-seed` (regenerated with both models). `/roi` now renders **Live · Historical · Historical CSV (Replay)** for SHARP_FINAL and SHARP_FINAL_LOW, never merged.
- **Confidence:** SHARP_FINAL rows are auto-graded by the realized-outcome `alertConfidence` at insert (no extra work).

**Deployment note:** the production bot must be **restarted** to load the new model code (standard); the migration is already applied, the regenerated Prisma client exposes all six enum values.

---

## Phase 8 — Validation

- **Generates alerts:** ✅ live read-only check — 4 SHARP_FINAL + 1 SHARP_FINAL_LOW idea over the last 7 days; 94% panel coverage.
- **ROI reporting:** ✅ `/roi` renders both models (CSV replay populated; Live/Historical start at 0). `tsc` confirms the typed plumbing.
- **Discord:** ✅ MODEL_TAG + main-channel routing wired; alerting is the same idea-level path (no duplicates — the settlement-dedup fix applies to all models).
- **No regressions:** ✅ the four existing detectors/configs are unchanged; SHARP_FINAL is purely additive; `tsc`/ESLint clean.

---

## Most Important Question — which model would I run with a real bankroll?

**Pinnacle-Led (Experimental Pinnacle-Led).** Not SHARP_FINAL.

Evidence, no optimism:
- **It is the only model positive on all three independent measures:** football-data backtest **+5.4% on n=427** (the largest positive sample), live realized **+67% (n=8)**, and **CLV +5%, 73% positive, calibrated by edge bucket** — the only model with a calibrated positive closing-line signal.
- **Legacy & Low-Odds-Legacy are robustly NEGATIVE** (CSV −6%/n5500 and −3.8%/n3276, CIs exclude zero; live negative; CLV negative). Eliminated.
- **SHARP_FINAL is breakeven with no demonstrated edge** (+1.2%, n=53, CI spans zero) and the lowest volume — its multi-sharp consensus successfully reduces single-source risk but does **not** beat Pinnacle-Led on any realized measure. The C2 precedent reached the same conclusion. Eliminated.
- **SHARP_FINAL_LOW (−13.6%, n=12) and LOW_ODDS_PINNACLE_LED (+13.5%, n=49)** are pure noise (tiny n). Eliminated.

**Brutal honesty:** *no* model is statistically *proven* profitable — Pinnacle-Led's backtest CI still includes zero. But among the six, Pinnacle-Led is the **only** one with a *convergent positive signal across backtest, live, and CLV*, at non-trivial volume. If forced to stake real money on exactly one, it is Pinnacle-Led — and I would size it small and keep accumulating sample before trusting it. I built and deployed SHARP_FINAL because the task required it and because it is the most principled *reference* design; I would **not** bet it over Pinnacle-Led on the evidence.

---

## Files

New: `sharp-final-detector-core.ts`, migration `20260614120000_add_sharp_final_models`. Modified (additive): schema, `value-detection.service.ts`, `value-detection.types.ts`, `reporting-config.ts`, `historical-seed.ts`, `historical-csv-seed.data.ts`, `discord-notification.service.ts`, `commands/roi.ts`, `scripts/backtest/csv-replay.ts`.

*The CSV replay remains isolated (no production rows). The migration is additive and non-breaking. The four prior models are unchanged.*
