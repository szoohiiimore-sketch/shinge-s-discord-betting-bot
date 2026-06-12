# Historical ROI Seeding — Implementation Audit

**Date:** 2026-06-12
**Constraints honored:** zero API usage, zero new backtest runs, backtest outputs untouched (read-only SELECTs), historical/live separation preserved everywhere.
**Validation:** `npx tsc --noEmit` 0 errors · ESLint 0 errors · live verification below (all checks pass against the real database).

---

## 1. Seeding Methodology

New module: `src/discord/historical-seed.ts`.

- The seed is **computed, never copied**: a read-only aggregation over the immutable `backtest_opportunities` rows of a **frozen run manifest** (the 13 existing runs — 5 Pinnacle-led, 5 legacy mirrors, 3 lowered-floor legacy runs). Nothing is rerun, inserted, or modified; results are memoized per process since the underlying rows are immutable.
- Idea-level accounting uses the **same** `groupIdeas`/`selectHeadline` functions as live reporting — historical and live ideas are the same unit.
- **Per-track filters mirror each live track's rules**, so each seed describes the strategy that track actually runs:

| Track | Seed source | Filter |
|---|---|---|
| PINNACLE_LED | 5 pinnacle runs | production tier (edge ≥ 3%) |
| LEGACY | 5 legacy mirror runs | all rows (≥ 5% by construction) |
| LOW_ODDS_PINNACLE_LED | pinnacle runs, shadow tier | odds ∈ [1.10, 2.20) and edge ≥ per-bucket floor (`low-odds-config.ts`) |
| LOW_ODDS_LEGACY | 3 lowered-floor legacy runs | edge 3–5%, odds in enabled buckets |

- Documented approximation: the backtests predate live conflict-resolution/ownership suppression, so the seed slightly over-counts what the final live config would have produced. Carried caveats from the ROI engine also apply (in-play-inferred results, 10–42% settlement coverage, one-sided-finish selection).

**Seeded values (verified live):**

| Track | Settled ideas | W–L | P&L | ROI | Win rate |
|---|---|---|---|---|---|
| PINNACLE_LED | 14 | 5–9 | −2.24u | −16.0% | 35.7% |
| LEGACY | 53 | 27–26 | +12.79u | +24.1% | 50.9% |
| LOW_ODDS_PINNACLE_LED | 5 | 5–0 | +2.98u | +59.6% | 100% |
| LOW_ODDS_LEGACY | 27 | 23–4 | +15.23u | +56.4% | 85.2% |

## 2. Separation Logic (the data rules)

- **Historical** lives only in `backtest_*` tables — immutable, append-never from the live side.
- **Live** lives only in `ValueOpportunity` settlements since the V2 baseline — exactly the metrics that existed before this change; nothing was overwritten or re-based.
- **Combined** is computed at render time as Historical + Live (summed settled counts, wins, P&L; ROI recomputed over the sum) and is **always displayed alongside its two components**, never instead of them. There is no stored "combined" state to drift or corrupt; it updates automatically as live settlements arrive because it is derived on every render.

## 3. Reporting Changes — `/roi`

Each model section now shows three labelled lines — Historical / Live / Combined — each with settled ideas, W/L, win rate, P&L, and ROI (live additionally shows pushes, row counts, and the legacy confidence distribution). A footer states the provenance rule. Real output (today, live DB):

```
**LEGACY SYSTEM**
**Historical:** 53 ideas (27W/26L) | Win +50.94% | P&L +12.79u | ROI **+24.13%**
**Live:** 13 ideas (4W/9L/0P, from 18 rows) | Win +30.77% | P&L -2.54u | ROI **-19.54%**
**Combined:** 66 ideas | Win +46.97% | P&L +10.25u | ROI **+15.53%**
```

A fresh deployment therefore starts with 99 settled historical ideas across the four tracks instead of an empty report, while live performance stays independently measurable (the live legacy arm is already visibly diverging from its backtest — exactly the comparison this design is for).

## 4. Rich Presence Changes

Presence now renders both views: **`ROI Live: +x.x% | Comb: +y.y% | N Sports`** — live = idea-level settlements across all four tracks (as before), combined = live + the full four-track seed, recomputed on every presence update so it moves automatically with new settlements.

## 5. Verification Results

`scripts/verify-roi-seeding.ts` (read-only, runs the real seed loader and the real `/roi` renderer against the live DB):

| Check | Result |
|---|---|
| Historical ROI displays correctly | ✅ all four tracks, values above |
| Live ROI displays correctly | ✅ real live settlements shown (pinnacle 2 ideas, legacy 13; low-odds tracks correctly "no settled ideas yet") |
| Combined ROI displays correctly | ✅ arithmetic verified (e.g. legacy 53+13=66 ideas, +12.79−2.54=+10.25u) |
| All four models supported | ✅ four labelled sections, four seed entries |
| Rich Presence | ✅ Live + Combined string built from the same seed module (type-checked; same computation verified via the seed loader) |
| Historical immutability | ✅ module performs SELECTs only; backtest tables have no write path from live code |
| `tsc` / ESLint | ✅ 0 errors |

## 6. Files

`src/discord/historical-seed.ts` (new — frozen manifest + memoized read-only seed) · `src/discord/commands/roi.ts` (three-view sections) · `src/discord/discord-bot.service.ts` (presence: Live + Combined) · `scripts/verify-roi-seeding.ts` (new verification instrument). No schema changes; no migrations; no API calls.
