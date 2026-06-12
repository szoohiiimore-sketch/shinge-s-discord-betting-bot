# Legacy vs Pinnacle-Led Model — Side-by-Side Historical Audit

**Date:** 2026-06-12
**Credit usage: 0** — both models replayed over the already-imported historical store; results from the local in-play inference engine.
**Production safety:** the Pinnacle-led model is untouched. The legacy model exists only as `src/backtest/legacy-detector-core.ts`, hosted by the replay engine via an additive `model: 'legacy'` config flag. Nothing live imports it.

---

## 1. Legacy Baseline — Identified From Repository History, Not Guessed

The Pinnacle-led rewrite is **entirely uncommitted**: `git log --follow src/value-detection/value-detection.service.ts` shows the detection logic last committed in `bb625ca` ("fix(discord): prevent message length limit errors"), contained unchanged in **HEAD = `f1563fa` ("Expand traditional sports and disable esports")**. The legacy model is therefore not a reconstruction from memory — it is a **transcription of `git show HEAD:src/value-detection/value-detection.service.ts`**, verbatim semantics:

| Aspect | Legacy (HEAD, committed) | Pinnacle-led (working tree, current) |
|---|---|---|
| Bet placed on | **Pinnacle's own price** | Best soft-book price above fair |
| "Fair" probability | Arithmetic mean of **vig-inflated** implied probs of all non-Pinnacle books (no de-vig; exchanges included; min 2 books) | De-vigged Pinnacle (overround bounds [0.99, 1.15]) |
| Threshold | 5% (no shadow tier) | 3% production + 2% shadow |
| Guards | None (no structure guard, no overround bounds, no conflict check, no exchange exclusion) | All of the above |
| Dedup | 12-hour suppression per (match, outcome) → the same idea re-alerts every 12 h | Permanent tier-aware per (match, book, outcome) |
| Odds cap | 3.0 on Pinnacle's price | 3.0 on candidate price |

**Documented assumptions in the reconstruction:** (a) replay feeds batches in deterministic sorted order vs the DB return order of live — material only on conflicting duplicate Pinnacle rows, where both take the first seen; (b) legacy suppression keyed on `alertedAt`, approximated by detection time (in legacy every detection was alerted); (c) live polling cadence is simulated by the same cadence sampler both models share.

## 2. Methodology

Five legacy runs mirror the five current-model runs exactly — same datasets, periods, cadence modes: core 47d full-grid, Nordic 37d full-grid, tennis 13d, soccer5 21d, US majors 21d. Both models scored CLV against the identical de-vigged Pinnacle close, settled by the identical winner-only in-play inference (102 resolved events), idea-aggregated by the identical functions. Every difference in the tables is the model, nothing else.

## 3. Head-to-Head

### 3.1 Headline comparison (all datasets combined; in-season rates)

| Metric | **Legacy** | **Pinnacle-led (≥3%)** |
|---|---|---|
| Ideas/day | **11.18** | 3.13 |
| Alerts/day (legacy re-alerts per 12 h: 547 rows) | **~12–18** | 3.13 |
| Settled ideas (same 102-event resolution) | **53** | 14 |
| W–L | 27–26 (51% at avg odds 2.58; breakeven 38.8%) | 5–9 (36% at 2.53) |
| **P&L** | **+12.79u** | −2.24u |
| **ROI / Yield** | **+24.1% (SE ≈ ±18pp)** | −16.0% (SE ≈ ±34pp) |
| Calibration (realized vs expected wins) | 27 vs 22.6 — beats its own vig-consensus prediction | 5 vs 6.1 — matches fair-prob prediction |
| **Trimmed CLV** | **−3.94%** | **+1.29% settled subset / +3.92% full population** |
| Tier structure | None (everything ≥5% alerts) | Production + shadow |

### 3.2 League distribution (ideas/day · settled ROI)
Legacy spreads volume everywhere the current model found deserts: J-League 2.10/d (+74%, n=3), tennis 2.69/d (**−26%**, n=12), Brazil-B 1.02/d (+81%, n=4), Superettan 0.94/d (+41%, n=4), Segunda 0.91/d (+16%, **n=16** — the largest settled cell in the entire program), Eliteserien 0.62/d (+3.5%, n=6), MLS 0.43/d (−15%, n=3). Pinnacle-led concentrates: Superettan 0.53/d, Segunda 0.40/d, Allsvenskan 0.45/d, WNBA 0.17/d — CLV-positive everywhere it bets, absent everywhere else.

### 3.3 Bookmaker distribution
Legacy: 100% Pinnacle — **the one book that doesn't ban winners**. Pinnacle-led: unibet/coolbet/leovegas families ≈ 84% — precisely the books that limit winners within weeks. This is the most under-appreciated structural difference: legacy's paper ROI is far closer to *attainable* ROI than the current model's.

### 3.4 Movement distribution (legacy, settled)
steam-out 3.63/d (+33.5%, n=21) · no-history 6.41/d (+11.6%, n=25) · flat 0.95/d (−15.6%, n=5) · steam-in 0.20/d (+181%, n=2). Legacy concentrates in steam-out — Pinnacle prices drifting away from the consensus — consistent with its negative CLV (it buys prices that keep drifting) and, in this window, with positive realized ROI anyway.

## 4. Statistical Limitations — Read Before the Verdict

- Settled coverage is 15–17% of ideas, selected toward one-sided finishes (documented engine bias; identical for both models, so the *comparison* is fairer than either absolute number).
- Legacy ROI +24.1% is **1.3–1.4σ from zero** — suggestive, not proof. The W–L difference between models (51% vs 36%) is ~1.5σ. One window, one spring, 53 vs 14 settles.
- Legacy's "edge ≥5% vs vig-mean" can flag *both sides* of a high-vig market; opposite-outcome idea pairs were not de-duplicated (a structural artifact the live legacy system also had).
- CLV is measured against the de-vigged Pinnacle close — a measuring stick that *assumes Pinnacle is truth*. The legacy model is, definitionally, a bet against that assumption; judging it by Pinnacle-close CLV partially begs the question. (The live legacy system's measured −2.57% CLV on 45 real bets matches the backtest's −3.94% — the reconstruction reproduces reality.)

## 5. The Six Questions

1. **More alerts:** Legacy, by ~4× in ideas and ~5× in messages. Not close.
2. **More profit (historical, settled):** Legacy: +12.8u vs −2.2u.
3. **Better ROI:** Legacy point estimate (+24% vs −16%), neither statistically secure; legacy's sample is 4× larger and its win rate sits 12pp above breakeven (1.75σ).
4. **Better CLV:** Pinnacle-led, decisively (+1.3/+3.9 vs −3.9). Confirmed against live data from both eras.
5. **Better sample generation:** Legacy — 4× settles per calendar day; at live volume the 200-idea ROI sample arrives in ~3 weeks instead of ~10.
6. **Better long-term potential:** Genuinely contested — see below.

## 6. Verdict — Mixed, With Structure

The clean story ("new model good, old model bad") does not survive this audit intact:

- **The case for Pinnacle-led** is the standard one and remains strong: positive CLV against the sharpest available reference, calibrated win rates, every guard against phantom edges, and a theoretical mechanism (soft books lag the sharp book) with decades of evidence behind it. Its negative settled ROI (−16%, n=14) is statistically empty.
- **The case for legacy is better than anyone in this repo believed yesterday:** +24% ROI on a 4× larger settled sample, a win rate 12pp above breakeven, **bets placed at the one bookmaker where winning is actually sustainable**, and 4× the sample velocity. Its negative CLV may partly be the measuring stick assuming the conclusion: "Pinnacle drifts away from soft consensus and the bet still wins" is only *necessarily* bad if Pinnacle's close is always right — in low-limit niche leagues, the soft-book aggregate plausibly carries real information.
- **The honest synthesis:** the models are near-orthogonal — they bet different books, different directions of disagreement, different volume regimes, and their idea sets barely overlap. One spring of partially-resolved data cannot crown either. What it *can* say: the legacy model was killed on CLV evidence alone, and this audit shows that evidence was never sufficient to conclude it loses money.

## 7. "If I were running this project today"

**C) Run both simultaneously** — with unambiguous roles.

- **Pinnacle-led stays the primary alerting model.** It has the positive CLV, the calibration, the guards, and the cleaner theory; its alerts remain the product.
- **Legacy runs as a full paper arm** — same snapshots (zero marginal API cost), detections stored with a model tag, settled by the same engine, **no Discord alerts initially** (or a separate muted channel). It is not restored to primacy on one suggestive window; it is also not left dead on a CLV argument this audit just showed to be incomplete.
- Why not B (restore legacy): +24% ± 18 on one spring window, against negative CLV and zero guards, is not a basis for demotion of a calibrated model — it is a basis for *measurement*.
- Why not D (hybrid single model): blending opposite priors (Pinnacle-is-right vs consensus-is-right) into one detector before either is validated would manufacture an untestable chimera. Hybridize after live data picks a winner per league — e.g. if legacy keeps winning specifically in J-League/Brazil where Pinnacle limits are thin, *that* becomes a league-routed hybrid worth building.
- The deciding experiment is already affordable: both arms live, ~11 + ~3 ideas/day, settled by real results (the live settlement pipeline, not in-play inference). In **4–6 weeks** the legacy arm alone produces a larger clean ROI sample than this entire backtest. Then the data — not the architecture's elegance, not CLV doctrine — decides which model survives.

The brutal version: **this project deleted its highest-volume, most-attainable, possibly-profitable model on the strength of a metric that presupposed the replacement's worldview.** Running both costs nothing and settles the argument with money-shaped evidence. That is what I would do today.

## 8. Run Ledger

Legacy: core `98ce37e9` · Nordic `13038965` · tennis `fa22fc28` · soccer5 `605e30e2` · US majors `d20de6a4`. Current-model counterparts: `24eabcd2` · `e0c38b46` · `3c6b62b1` · `601a4233` · `35c6f9fd`. Reconstruction: `src/backtest/legacy-detector-core.ts`; replay flag `model: 'legacy'`; configs `scripts/backtest/configs/legacy-*.json`. Validation: `npx tsc --noEmit` 0 errors, ESLint clean.
