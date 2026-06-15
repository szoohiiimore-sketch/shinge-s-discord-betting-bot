# Portfolio Restructure & LEGACY_QUALITY — Implementation

**Date:** 2026-06-15
**Type:** production implementation (routing + new model). Validated, deployed-ready, committed.
**Validation:** `tsc` clean · ESLint clean · 21/21 routing/label/split checks pass · enum migration applied (9 values).
**Constraints honored:** no sport changes, no edge-threshold changes, no settlement-logic changes, no SHARP_FINAL_V2 logic change, no shadow-tracking removal, no data deletion.

---

## Executive Summary

Three production changes, all **routing-layer** (detection/storage/settlement untouched):

1. **Shadow the redundant & weak alerters.** `PINNACLE_LED`, `LOW_ODDS_PINNACLE_LED`, the redundant `SHARP_FINAL`/`SHARP_FINAL_LOW` (v1, ~95% overlap with V2), and raw `LEGACY` now **collect data + show ROI but send NO production betting alerts.**
2. **SHARP_FINAL_V2 family becomes the primary sharp production model:** `SHARP_FINAL_V2 → #bet-alerts`, `SHARP_FINAL_LOW_V2 → #bet-alerts-lower-odds`.
3. **LEGACY_QUALITY** (new model) = Legacy minus its single realized-worst class (flat 6h Pinnacle movement, which realized **−43.9%, CI [−82.6, −5.2]** — the only legacy class whose CI excludes zero). Non-flat legacy main-tier alerts → `LEGACY_QUALITY` (active); flat ones → `LEGACY` (shadow). `LOW_ODDS_LEGACY` stays active.

**Net effect:** alert overlap collapses (the old main channel fired LEGACY + PINNACLE_LED + SHARP_FINAL + SHARP_FINAL_V2 — up to 4 near-duplicate alerts per value bet; now only V2 + LEGACY_QUALITY). Expected active volume **~10/day** total. **Honest caveat:** LEGACY_QUALITY's quality gain is live-evidenced only — football-data has no time-series, so the movement filter is inert in the backtest (LEGACY_QUALITY ROI = LEGACY ROI there), and the filter removes the worst slice but does **not** make Legacy +EV.

---

## Production Portfolio — Before → After

| | **Before** | **After** |
|---|---|---|
| **#bet-alerts (main)** | LEGACY, PINNACLE_LED, SHARP_FINAL, SHARP_FINAL_LOW, SHARP_FINAL_V2, SHARP_FINAL_LOW_V2 (6 — heavy overlap) | **SHARP_FINAL_V2, LEGACY_QUALITY** (2) |
| **#bet-alerts-lower-odds** | LOW_ODDS_LEGACY, LOW_ODDS_PINNACLE_LED (2) | **SHARP_FINAL_LOW_V2, LOW_ODDS_LEGACY** (2) |
| **Shadow (no alerts, data+ROI kept)** | — | **PINNACLE_LED, LOW_ODDS_PINNACLE_LED, SHARP_FINAL, SHARP_FINAL_LOW, LEGACY** (5) |

**Active models (4):** SHARP_FINAL_V2, SHARP_FINAL_LOW_V2, LEGACY_QUALITY, LOW_ODDS_LEGACY.
**Shadow models (5):** PINNACLE_LED, LOW_ODDS_PINNACLE_LED, SHARP_FINAL, SHARP_FINAL_LOW, LEGACY.

---

## Routing Changes (implementation)

A single source of truth — `MODEL_ROUTE: Record<DetectionModelValue, 'main'|'low-odds'|'shadow'>` in `reporting-config.ts` with `alertRouteForModel()` / `isShadowModel()`. The alert layer (`notifyPendingOpportunities`) was changed from the old binary `isLowOddsModel()` to the 3-way route:

```
main     → #bet-alerts            (SHARP_FINAL_V2, LEGACY_QUALITY)
low-odds → #bet-alerts-lower-odds (SHARP_FINAL_LOW_V2, LOW_ODDS_LEGACY)
shadow   → row stamped alertedAt, content = null → NEVER posted
```

Shadow rows are still inserted, settled, and aggregated in `/roi` — only the Discord POST is skipped. **No duplicate routing:** every model maps to exactly one route (validated: 9 models, 4 active / 5 shadow, set size == count).

`/roi` now labels each model: `🟢 ACTIVE → #channel` or `🌑 SHADOW (data + ROI only, no alerts)`. All 9 models remain visible (active + shadow); historical tracking is preserved.

---

## LEGACY_QUALITY Logic

Detection-time split inside the existing legacy family block (no new detector — same `legacyDetectFromBatch`, same edge thresholds, same 12h dedup & ownership):

```
legacy main-tier candidate (edge ≥ 5%):
  isFlatLine(move6h)  →  model = LEGACY          (shadow: the −44% class, kept for tracking)
  not flat / no move  →  model = LEGACY_QUALITY  (active → #bet-alerts)
low-odds-tier (3–5%)  →  LOW_ODDS_LEGACY (unchanged, active → lower-odds)
```

`isFlatLine(m) = m !== null && |m| < 1.0` (the realized-worst class; `null`/no-history is **not** flat → realized neutral-positive, so it's kept). Evidence basis: `PORTFOLIO_POSTMORTEM_AND_ALERT_QUALITY_AUDIT.md` / `EDGE_AND_CONFIDENCE_SYSTEM_AUDIT.md` — flat 6h-movement legacy realized −43.9% (n=20), the only legacy class with a CI excluding zero; edge, confidence-grade, and books-agreeing were non-predictive/inverse and were **not** used.

---

## Replay / Backtest Results (football-data CSV, exact settlement, idea-level)

| Model | Status | Alerts | W–L | Win% | Avg odds | Avg edge | ROI | ~95% CI |
|---|---|---|---|---|---|---|---|---|
| **SHARP_FINAL_V2** | 🟢 main | 414 | 188–226 | 45.4% | 2.43 | 6.81% | **+5.9%** | [−4.6, +16.4] |
| **SHARP_FINAL_LOW_V2** | 🟢 lower | 53 | 33–20 | 62.3% | 1.73 | 2.59% | +7.6% | wide |
| **LEGACY_QUALITY** | 🟢 main | 5,500 | 2,081–3,419 | 37.8% | 2.53 | 7.24% | **−6.0%¹** | [−8.7, −3.2] |
| **LOW_ODDS_LEGACY** | 🟢 lower | 3,276 | 1,673–1,603 | 51.1% | 1.92 | 3.76% | −3.8% | [−7.3, −0.3] |
| PINNACLE_LED | 🌑 shadow | 427 | 191–236 | 44.7% | 2.44 | 6.92% | +5.4% | [−4.6, +15.4] |
| SHARP_FINAL (v1) | 🌑 shadow | 53 | 23–30 | 43.4% | 2.50 | 5.96% | +1.2% | wide |
| LEGACY (raw) | 🌑 shadow | 5,500 | 2,081–3,419 | 37.8% | 2.53 | 7.24% | −6.0% | [−8.7, −3.2] |

¹ **LEGACY_QUALITY == LEGACY in the CSV.** football-data has no time-series, so `move6h` is always null → never flat → the movement filter is **inert in the backtest**. LEGACY_QUALITY's expected improvement (removing the live −43.9% flat class) is **evidenced on live data only** and cannot be demonstrated in this backtest.

---

## Expected Alert Volume (live, measured)

| Model | Channel | Daily | Weekly | Monthly |
|---|---|---|---|---|
| SHARP_FINAL_V2 | #bet-alerts | ~0.6 | ~4 | ~17 |
| LEGACY_QUALITY | #bet-alerts | **~4.9** | ~34 | ~145 |
| SHARP_FINAL_LOW_V2 | #bet-alerts-lower-odds | ~0.14 | ~1 | ~4 |
| LOW_ODDS_LEGACY | #bet-alerts-lower-odds | ~4.9 | ~34 | ~145 |
| **Active total** | | **~10–11/day** | ~73 | ~310 |

Measured (14d live): LEGACY raw ≈ 5.9 ideas/day, **flat share ≈ 17%** → LEGACY_QUALITY ≈ **4.9/day** (a ~17% quality-driven trim). This lands in the user's "~8–10/day acceptable" band for the main channel and removes the redundant duplicate alerts entirely.

---

## API Cost

**$0 additional.** This is a routing/labelling change plus a model split on already-computed legacy candidates — no new fetches, no new polling, no new sports. SHARP_FINAL_V2 was already deployed (reuses existing snapshots). Shadow models still run the same detection they already ran; only their Discord POST is suppressed.

---

## Risks & Limitations (brutally honest)

1. **LEGACY_QUALITY is not +EV.** Removing the flat class lifts Legacy's expected ROI but does not cross into positive — Legacy is robustly −EV at scale (CSV −6%, n5500). This is a quality *trim*, not a fix. If the goal is positive ROI, the honest move is to shadow Legacy entirely (the documented fallback); it is kept active per the explicit "improve quality, accept lower volume" instruction.
2. **The movement filter is live-evidenced only** (n=20 flat, with a multiple-comparisons caveat) and **untestable in the football-data backtest** (no time-series). Monitor LEGACY vs LEGACY_QUALITY realized ROI in `/roi` as live data accrues; if the gap doesn't materialise, shadow Legacy entirely.
3. **SHARP_FINAL_V2 ≈ Pinnacle-Led** (backtest +5.9% vs +5.4%, n≈420 each) — neither is statistically proven profitable (CIs include zero). V2 is the primary sharp model on its convergent-with-Pinnacle backtest + multi-source robustness, but has **no live/CLV track record yet**; size small.
4. **Mixed history in the `model` column:** pre-deploy legacy rows remain `LEGACY`; post-deploy non-flat legacy rows are `LEGACY_QUALITY`. Historical tracking is intact; the split only affects new detections. No backfill (presentational).
5. **Deployment requires a bot restart** to load the new routing/model code (the enum migration is already applied to production).

---

## Validation Results

- **Routing table:** all 9 models map to the expected route (validated). Channels: SHARP_FINAL_V2 → #bet-alerts ✅, SHARP_FINAL_LOW_V2 → #bet-alerts-lower-odds ✅.
- **Shadow models never post:** the 5 shadow models route to `shadow` → `content = null` → no Discord POST ✅; they still insert/settle/appear in `/roi` ✅.
- **No duplicate routing:** 9 models, 4 active / 5 shadow, each routed exactly once ✅.
- **LEGACY_QUALITY split:** flat (`|0.3|<1`) → LEGACY ✅; moving (`−2.5`) → LEGACY_QUALITY ✅; null → LEGACY_QUALITY ✅.
- **`/roi` labels:** ACTIVE/SHADOW header renders correctly for all 9 ✅.
- **Build:** `tsc` clean, ESLint clean, enum migration applied (9 values verified in client).

---

*Routing/labelling + LEGACY_QUALITY split only. Detection math, edge thresholds, settlement, SHARP_FINAL_V2 logic, sports, and shadow data tracking are unchanged. $0 API. Restart required to load new code.*
