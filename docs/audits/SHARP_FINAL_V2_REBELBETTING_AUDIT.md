# SHARP_FINAL_V2 — RebelBetting Audit, Redesign & Deployment

**Date:** 2026-06-14
**Scope:** additive `SHARP_FINAL_V2` + `SHARP_FINAL_LOW_V2`. The six existing models are untouched.
**Validation:** `tsc` clean · ESLint clean · enum migration applied · live detector verified.
**Mandate:** brutally honest, evidence over excitement.

---

## Executive Summary — the honest diagnosis

The premise ("SHARP_FINAL is a highly restrictive filter — 53 alerts / 101k matches") is **true only of the football-data backtest, not of live production.** Two facts resolve it:

1. **The "53 alerts" is a dataset artifact.** football-data carries only **two** sharp sources (Pinnacle + Betfair Exchange). SHARP_FINAL required `minSharpSources = 2`, so it **skipped every match lacking Betfair** — a large fraction. Lowering that single knob to `1` (= SHARP_FINAL_V2) takes the *same* backtest from **53 → 414 alerts** and **+1.2% → +5.9% ROI**, landing right on top of Pinnacle-Led (427, +5.4%).
2. **Live, the restriction barely bites.** Production has **five** sharp sources; **94% of live matches already have ≥2**. So on real data SHARP_FINAL (v1) and SHARP_FINAL_V2 produce the **same volume** (4 alerts / 7 days each), and both ≈ Pinnacle-Led (3 / 7 days).

**Therefore:** SHARP_FINAL **already is** a RebelBetting-style value engine (sharp fair → all soft books → best price → value). V2 is the cleaner, fully-faithful form and makes the *backtest* representative, but **live it is functionally identical to v1 and to Pinnacle-Led.** None of the three is a volume breakthrough — and the unglamorous truth is that **a true RebelBetting model on our coverage, at a 3% value bar, tops out at ~0.5 alerts/day.** Commercial RebelBetting's "dozens/day" comes from *breadth* (hundreds of leagues × markets × global books), not a different model.

---

## Part 1 — RebelBetting Architecture Audit

A RebelBetting / professional value-betting engine: (a) builds a **sharp fair line** (Pinnacle-anchored, sometimes a sharp consensus), de-vigged; (b) scans **all** soft books; (c) takes the **best price per outcome**; (d) alerts when best soft price > fair by a **value %** threshold.

| Component | RebelBetting | SHARP_FINAL (v1) | Match? |
|---|---|---|---|
| Sharp fair line | Pinnacle / sharp consensus, de-vigged | de-vigged **median** of 5-sharp panel | ✅ (stronger: a consensus) |
| Scan all soft books | yes | **yes** — every non-sharp, non-exchange book is a candidate | ✅ |
| Best price per outcome | yes | yes — idea aggregation picks the best soft price | ✅ |
| Value % = best soft / fair − 1 | yes | yes — `edge% = odds × fairProb − 1` | ✅ |
| Coverage requirement | ≥1 sharp (Pinnacle) | **≥2 sharps** (the one real difference) | ⚠️ over-restrictive on thin-panel data |

**Similarities:** the pipeline is the RebelBetting pipeline. **Difference:** `minSharpSources=2` + the panel including no-vig exchange prices makes the v1 fair line slightly *tighter and coverage-gated* — a quality-filter bias. **Missing components:** none structurally; the only gap was full coverage (fixed in V2) and, arguably, breadth (more sports/leagues/books — a coverage problem, not a model problem).

---

## Part 2 — SHARP_FINAL_V2 design (true RebelBetting)

Identical pipeline, **one change: `minSharpSources = 2 → 1`.**

- **STEP 1 — Sharp fair:** de-vigged **median** of the panel present (Pinnacle + Betfair_ex_uk/eu + Matchbook + Smarkets). With ≥1 source it runs (degrading to single-Pinnacle, exactly like Pinnacle-Led); with more it tightens to a robust consensus.
- **STEP 2 — All soft books:** every non-sharp, non-exchange book is a candidate (already the case).
- **STEP 3 — Best price per outcome** (Home/Draw/Away): idea aggregation selects the best soft price.
- **STEP 4 — Value alert:** best soft × fairProb − 1 ≥ 3% (production) / low-odds buckets for `SHARP_FINAL_LOW_V2`. Same bar as Pinnacle-Led (no tuning advantage).

`SHARP_FINAL_V2_CONFIG = { ...SHARP_FINAL_CONFIG, minSharpSources: 1 }` — no new detector core; the existing `sharpFinalDetectFromBatch` is run with the V2 config.

---

## Part 3 — Bookmaker Classification (verified from 53 live keys)

| Tier | Books | Role |
|---|---|---|
| **Tier 1 — Sharp** | `pinnacle`, `betfair_ex_uk`, `betfair_ex_eu`, `matchbook`, `smarkets` | **Reference Sources** (the fair-line panel; never bet) |
| **Tier 2 — Semi-sharp** | `lowvig`, `betonlineag` (reduced-juice) | excluded from the panel (carry margin); excluded from candidacy too (near-sharp) |
| **Tier 3 — Soft** | `bet365`, `unibet_*`, `leovegas_*`, `betsson`, `nordicbet`, `coolbet`, `williamhill`, `betvictor`, `paddypower`, `fanduel`, `draftkings`, `betmgm`, `betway`, `tipico_de`, `winamax_*`, `betclic_fr`, `pmu_fr`, `boylesports`, … (~45 books) | **Target Sources** (candidates — the books we bet) |

Reference = Tier 1 panel. Targets = all Tier-3 soft books. Exchanges (incl. `novig`/`prophetx`) are never candidates (commission).

---

## Part 4 — Historical Replay (reused the CSV framework; football-data 2-sharp panel)

All 101,051 matches, idea-level, exact settlement:

| Model | Alerts | W–L | Push | Win% | Avg odds | Avg edge | ROI | ~95% CI |
|---|---|---|---|---|---|---|---|---|
| **SHARP_FINAL** (v1) | 53 | 23–30 | 0 | 43.4% | 2.50 | 5.96% | +1.2% | ≈[−27,+30] |
| **SHARP_FINAL_LOW** | 12 | 6–6 | 0 | 50.0% | 1.72 | 2.56% | −13.6% | huge |
| **SHARP_FINAL_V2** | **414** | 188–226 | 0 | 45.4% | 2.43 | 6.81% | **+5.9%** | [−4.6, +16.4] |
| **SHARP_FINAL_LOW_V2** | 53 | 33–20 | 0 | 62.3% | 1.73 | 2.59% | +7.6% | ≈[−18,+33] |
| *(ref) PINNACLE_LED* | 427 | 191–236 | 0 | 44.7% | 2.44 | 6.92% | +5.4% | [−4.6, +15.4] |

**SHARP_FINAL_V2 ≈ Pinnacle-Led** on every axis (414 vs 427 alerts, +5.9% vs +5.4%, win 45.4% vs 44.7%). The lone knob (`minSharpSources`) explains the 8× volume jump from v1. **Caveat:** football-data exposes only 2 sharps, so the backtest tests a degraded panel; CIs include zero (no model is *proven* profitable).

---

## Part 5 — Alert Volume (live, last 7 days, full 5-source panel)

| Model | Daily | Weekly | Monthly |
|---|---|---|---|
| **SHARP_FINAL** | ~0.57 | ~4 | ~17 |
| **SHARP_FINAL_LOW** | ~0.14 | ~1 | ~4 |
| **SHARP_FINAL_V2** | ~0.57 | ~4 | ~17 |
| **SHARP_FINAL_LOW_V2** | ~0.14 | ~1 | ~4 |
| *(ref) Pinnacle-Led* | ~0.43 | ~3 | ~13 |

**Live, V2 == v1 == Pinnacle-Led in volume** — the `minSharpSources` change is inert live (94% of matches already have ≥2 sharps). The three are functionally the same engine on real data.

---

## Part 6 — API Cost: **$0 additional (proven)**

SHARP_FINAL_V2 is **pure post-processing of snapshots already fetched** — every panel book (`pinnacle`, `betfair_ex_*`, `matchbook`, `smarkets`) and every soft target is already in the existing `/odds` responses. **Proof:** the Part-5 live volume check ran end-to-end on *already-stored* snapshots, issuing **zero** API calls. V2 adds one extra in-memory `sharpFinalDetectFromBatch` call per match batch (µs) and a few DB rows/day.

| | |
|---|---|
| Additional requests | **0** · Additional polling | **none** |
| Additional monthly / daily cost | **$0 / $0** |

---

## Part 7 — Deployment

- **Schema:** enum += `SHARP_FINAL_V2`, `SHARP_FINAL_LOW_V2` (migration `20260614130000_add_sharp_final_v2_models`, additive, **applied to production**; client regenerated — 8 enum values verified).
- **Detection pipeline:** the v1 SHARP block was refactored into a parameterized local helper run twice (v1 + V2) with independent dedup state — V2 is fully additive; the six prior models are byte-unchanged.
- **Discord / ROI / stats / daily summary:** `MODEL_TAG`, `reporting-config` (DetectionModelValue, modelsFor, displays, `/roi model` choices), daily-summary loop, `historical-seed` (empty), `historical-csv-seed` (regenerated, 8 models). Alerts route to the **main #bet-alerts channel**; idea-level dedup prevents intra-model duplicates.
- **Restart required** to load the new code (migration already applied).

---

## Part 8 — Direct Answers (evidence only)

1. **Was the original SHARP_FINAL too restrictive?** In the **backtest, yes** (53 alerts) — a football-data artifact (only 2 sharp sources + `minSharpSources=2`). In **live production, no** — ~0.57/day, comparable to Pinnacle-Led. The 53 figure does not describe live behaviour.
2. **Does SHARP_FINAL behave like RebelBetting?** **Yes.** Sharp consensus fair → all soft candidates → best price per outcome → value alert *is* the RebelBetting pipeline. The "restrictive" appearance was a dataset artifact, not a model property.
3. **If not, why not?** It does. The only deviation was `minSharpSources=2`, which over-restricted on the 2-sharp backtest dataset.
4. **Does SHARP_FINAL_V2 better match RebelBetting?** **Marginally yes** — V2 (`minSharpSources=1`) is the textbook "≥1 sharp → fair → all softs → best price" engine and makes the *backtest* representative (414 alerts, +5.9%, ≈ Pinnacle-Led). **Live it is identical to v1** (both 0.57/day), so the improvement is conceptual/backtest, not operational.
5. **How many alerts/day?** **~0.5–0.6/day** (SHARP_FINAL_V2), ~0.1/day for the LOW variant — the same order as Pinnacle-Led. **Not** the dozens/day of commercial RebelBetting; that gap is *coverage breadth*, not the model.
6. **Which would I personally run?** **Pinnacle-Led.** It is the only one with **convergent evidence**: backtest **+5.4% (n=427)**, live realized **+67% (n=8)**, and **CLV +5%, 73% positive (calibrated)**. SHARP_FINAL_V2 **backtests equal to it** (+5.9%, n=414) and is mechanically *more robust* (multi-sharp consensus reduces the single-Pinnacle dependence flagged in `HISTORICAL_REPLAY_VALIDATION_AUDIT.md`) — but it has **no live or CLV track record yet**, so on *today's* evidence Pinnacle-Led wins on corroboration. SHARP_FINAL v1 is eliminated (over-restrictive on thin panels, no advantage live). **SHARP_FINAL_V2 is the natural successor to Pinnacle-Led once it accumulates live confirmation** — they are the same edge with a free robustness layer.

**Brutally honest operational warning:** Pinnacle-Led, SHARP_FINAL, and SHARP_FINAL_V2 now all run live, all bet soft-vs-sharp, all to #bet-alerts — and they **overlap ~95%**. The user will receive **2–3 near-identical alerts per value bet.** I deployed V2 as instructed, but the correct end state is to run **exactly one** of {Pinnacle-Led, SHARP_FINAL_V2} (I recommend V2 for the robustness, once it has a few weeks of live data) and **retire SHARP_FINAL v1 and the redundant twin**. No model is statistically proven profitable; size small, keep accumulating sample.

---

*Files: `sharp-final-detector-core.ts` (V2 config added), migration `20260614130000_add_sharp_final_v2_models`, and additive edits to the service, reporting-config, historical-seed, discord-notification, csv-replay, csv seed. CSV replay isolated; six prior models unchanged; $0 API.*
