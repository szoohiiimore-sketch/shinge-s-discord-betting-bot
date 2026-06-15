# Historical CSV Replay System (football-data.co.uk)

**Date:** 2026-06-14
**Goal:** massively increase the historical sample by replaying the four production models over football-data.co.uk CSVs, integrated into the existing `/roi` reporting, fully isolated from production data.
**Result:** **101,051 matches replayed** (vs n≈106 live) with **exact settlement** — a ~950× sample increase, and the most trustworthy evidence the project has on these models.
**Validation:** `tsc` clean · ESLint clean · replay imports **no** Prisma/Redis/repository/settlement (verified).

---

## Executive Summary (brutally honest)

At scale, with **exact results** (football-data's result column, not in-play inference), the picture is clear and sobering:

| Model | Alerts | W–L | Win% | Avg odds | ROI | ~95% CI | Verdict |
|---|---|---|---|---|---|---|---|
| **LEGACY** | 5,500 | 2,081–3,419 | 37.8% | 2.53 | **−6.0%** | **[−8.7, −3.2]** | **Robustly NEGATIVE** |
| **Experimental Pinnacle-Led** | 427 | 191–236 | 44.7% | 2.44 | +5.4% | [−4.6, +15.4] | Leans positive, not significant |
| **Low-Odds Legacy** | 3,276 | 1,673–1,603 | 51.1% | 1.92 | **−3.8%** | **[−7.3, −0.3]** | **Negative** |
| **Low-Odds Experimental** | 49 | 32–17 | 65.3% | 1.74 | +13.5% | [−16, +43] | Positive, tiny n |

**The headline finding:** the **legacy family — which is 95% of all alert volume (8,776 of 9,252) — loses money at scale** (CIs exclude zero), while the **Pinnacle-led family — the positive-leaning one — is only 5% of volume** and lacks the sample for significance. This **directly contradicts** the earlier `LEGACY_VS_PINNACLE_MODEL_AUDIT.md` claim of legacy +24% ROI, which rested on **n=53 with biased in-play-inferred settlement**. This replay has **~100× the sample and exact results** — it is far more trustworthy, and it says legacy is a structural loser on soccer.

**Why legacy loses:** it bets Pinnacle when Pinnacle exceeds a **vig-inflated** soft consensus. Much of that "edge" is just the soft books' margin, not real value — and against the true result over 5,500 bets it bleeds ~6%. The Pinnacle-led model (de-vigged reference, bet soft) is the only family that leans positive, consistent with the live read (+67% on n=8) in direction if not magnitude.

These numbers are now visible in `/roi` as a third, clearly-separated section: **Live · Historical (seed) · Historical CSV (Replay)**.

---

## Phase 1 — Feasibility Audit (answers)

1. **CSV files:** 149 (`historicalcsv/`, processed recursively).
2. **Matches:** 108,375 parsed (deduped by league|date|home|away); **101,051 had a usable Pinnacle reference** and were detected on.
3. **Leagues:** 38 (E0/E1/E2/E3/EC England, D1/D2 Germany, SP1/SP2 Spain, I1/I2 Italy, F1/F2 France, B1 Belgium, N1 Netherlands, P1 Portugal, T1 Turkey, G1 Greece, SC0-3 Scotland, plus extra-league files: Argentina, Brazil, China, Japan, Mexico, USA/MLS, Nordics, Poland, Romania, Russia, Austria, Switzerland, Denmark, Finland, Sweden, Norway, Ireland).
4. **Seasons:** 15 (2012 → 2026), date range **2012-03-02 → 2026-06-13**.
5. **Models replayable ACCURATELY (detection + settlement):** all four. The detectors are single-batch pure functions; a football-data row is a single pre-match snapshot — exactly their input. Settlement is **exact** from the result column (better than the existing engine's biased in-play inference).
6. **Models only APPROXIMATED:** the **time-series-dependent layers** — 6h Pinnacle movement (no time series in CSV → the new confidence grade's flat-line flag cannot be computed), near-kickoff dynamics, the 12h re-alert dedup, and cross-track ownership nuance. These are annotation/secondary, **not** detection.
7. **Existing replay engine fit?** The time-series `replaySnapshots` engine (cadence sampler over snapshot streams) is **not** the right tool for single-snapshot CSV rows — but its **core is reused directly**: `detectFromBatch` / `legacyDetectFromBatch` + idea aggregation.
8. **CSV adapter sufficient?** **Yes.** A thin CSV parser → per-match odds batch → the production detector cores. No new engine.
9. **New engine required?** **No.**

---

## Architecture

```
historicalcsv/*.csv (149 files, recursive)
        │  scripts/backtest/csv-replay.ts  (in-memory, disposable, NO DB/Redis)
        ▼
  CSV adapter: header classification → per-match H/D/A odds batch
   · Pinnacle (PS pre-match / PSC closing) → reference 'pinnacle'
   · soft books (B365, BW, BV, LB, CL, BFD, BMGM, WH, VC, IW, …) → candidates
   · Betfair Exchange (BFE/BFEC) → 'betfair_ex_uk' (legacy-incl., pinnacle-excl.)
        ▼
  PRODUCTION detector cores (identical to live):
   · detectFromBatch(batch, {…PRODUCTION_DETECTOR_CONFIG, maxOdds 3.0})  → PINNACLE_LED / LOW_ODDS_PINNACLE_LED
   · legacyDetectFromBatch(batch, {…LEGACY_DETECTOR_CONFIG, minEdge 3.0}) → LEGACY (≥5%) / LOW_ODDS_LEGACY (3–5%)
        ▼
  idea aggregation (groupIdeas/selectHeadline) + EXACT settlement (result column)
        ▼
  ONLY survivor: src/discord/historical-csv-seed.data.ts  (aggregate metrics)
        ▼
  /roi renders Live · Historical (seed) · Historical CSV (Replay)  — never merged
```

**Files:** `scripts/backtest/csv-replay.ts` (adapter+replay, generates the data module) · `src/discord/historical-csv-seed.ts` (types + re-export) · `src/discord/historical-csv-seed.data.ts` (**generated, aggregate-only**) · `src/discord/commands/roi.ts` (third section).

---

## Replay Methodology

- **Exact production configs:** pinnacle-led = `PRODUCTION_DETECTOR_CONFIG` (edge ≥3% prod / ≥2% shadow, odds ≤3.0, exchanges excluded, structure guard, de-vigged Pinnacle); legacy run at min 3% with the production split (LEGACY ≥5%, LOW_ODDS_LEGACY 3–5% in enabled buckets), bet Pinnacle vs vig-inflated soft mean (exchanges included). Low-odds buckets via `low-odds-config.ts`.
- **Idea-level ROI, identical methodology** to live/seed: `groupIdeas`/`selectHeadline` → one flat 1u on the headline (best non-exchange) row; WIN = odds−1, LOSS = −1; ROI = ΣP&L / settled × 100.
- **Settlement = exact** from `FTR`/`Res` (H/D/A → Home/Draw/Away). No inference, no bias. Every replayed match has a known result → 0 pending, 0 pushes (1X2 always resolves).
- **Tier preference:** pre-match Pinnacle (`PS*`) used when present; closing (`PSC*`) only as fallback. Fidelity split tracked.
- **Legacy family conflict:** one strongest-edge legacy-family outcome per match (mirrors production); cross-track ownership otherwise approximated (same caveat as the existing seed).

---

## Dataset Coverage & Fidelity

| | Matches | Note |
|---|---|---|
| Total parsed | 108,375 | deduped |
| With Pinnacle reference | 101,051 | evaluated |
| **Pre-match (high fidelity)** | **41,493** | main-league files; ~10 books incl. pre-match Pinnacle |
| Closing-only (approximation) | 59,558 | extra-league files; closing odds, ~2 books |

**Critical honesty point:** the 59,558 closing-only matches **produced almost no alerts** (e.g. LEGACY 5,468 of 5,500 alerts come from the pre-match subset). Closing lines are sharper and these files carry only ~2 books, so few edges survive. **Therefore the ROI is driven essentially entirely by the high-fidelity pre-match data, and the headline ≈ pre-match-only:**

| Model | ROI (all) | ROI (pre-match only) |
|---|---|---|
| LEGACY | −6.0% (n5500) | −5.9% (n5468) |
| PINNACLE_LED | +5.4% (n427) | +4.8% (n419) |
| LOW_ODDS_LEGACY | −3.8% (n3276) | −4.0% (n3260) |
| LOW_ODDS_PINNACLE_LED | +13.5% (n49) | +13.5% (n49) |

Both views are stored (`models`, `modelsPrematch`). The approximation tier inflates "matches processed" but **not** the ROI.

---

## Model Limitations & Approximation Assumptions (no silent faking)

1. **Soccer 1X2 only.** football-data is football. This does **not** cover baseball/basketball/hockey, which are large in live production. The replay tests the models specifically on soccer (their main hunting ground), not the full live universe.
2. **Single snapshot, no time series.** No 6h movement → the **new confidence grade's flat-line flag cannot be computed** for CSV ideas (movement = null = not flagged); near-kickoff dynamics and 12h re-alert dedup don't apply. Detection itself is unaffected (single-batch is the detectors' native input).
3. **Pre-match timing differs.** football-data's pre-match odds were collected at varying times before kickoff (often the day before), not production's 1–4h polling window. A timing approximation, not a faked value.
4. **Book set differs** from the live OddsAPI book set → the soft consensus composition differs slightly (football-data: B365, BW, BV, LB, CL, BFD, BMGM, WH, VC, IW…; exchange = Betfair).
5. **Conflict/ownership** resolution is approximated (legacy-family one-per-match enforced; pinnacle cross-track ownership simplified) — same fidelity level as the existing historical seed.
6. **CLV not computed** (and not needed — exact ROI is available; the task explicitly optimizes for realized outcomes).

None of these inflate results; if anything (3)/(4) and the closing tier are conservative.

---

## Required Metrics (per model — see Executive Summary table)

Matches processed (101,051), alerts, wins, losses, pushes (0), win rate, average odds, average edge, ROI, and P&L units are computed for every model with the **exact same idea-level flat-1u methodology** as the live/seed reporting. Full numbers in `src/discord/historical-csv-seed.data.ts` (`models` = all; `modelsPrematch` = high-fidelity subset).

---

## ROI Integration

The existing `/roi` already renders **Live** + **Historical** (immutable backtest seed) + **Combined** per model. This task adds a fourth line per model — **Historical CSV (Replay)** — sourced from the aggregate data module, plus a dataset footer. It is **never merged** into Live, Historical, or Combined. Example rendered line:

```
LEGACY SYSTEM
Historical: … | Live: … | Combined: …
Historical CSV (Replay): 5500 ideas (2081W/3419L) | Win +37.84% | P&L -329.82u | ROI -6.00% (101,051 matches)
```

No separate `/roi` command was created (per the requirement).

---

## Validation

- **Files processed:** 149. **Matches processed:** 108,375 parsed / 101,051 detected. **Leagues:** 38. **Seasons:** 15 (2012–2026).
- **No production ValueOpportunity rows written** — the replay imports no repository.
- **No production settlement rows written** — settlement is in-memory from the CSV result column.
- **No Supabase / no Postgres writes** — the replay imports no Prisma client.
- **No Redis pollution** — the replay imports no ioredis.
- **Only survivor:** one committed aggregate data module (`historical-csv-seed.data.ts`). The per-match alerts are in-memory, temporary, and discarded.
- `tsc` clean; ESLint clean.

---

## Final Verdict (follow the data)

The football-data replay is the largest, cleanest evidence this project has, and it is unkind to the high-volume models: **Legacy and Low-Odds-Legacy lose money on soccer at scale with statistical confidence** (CIs exclude zero), and they are 95% of alert volume. The **Pinnacle-led family is the only positive-leaning one** but generates a fraction of the alerts and isn't yet significant. The earlier "+24% legacy" was a small-sample, biased-settlement mirage; with 100× the data and exact results, legacy is **−6%**. If these models are to be trusted with money, the evidence points away from the legacy family and toward growing the Pinnacle-led sample — exactly the opposite of optimizing for the volume the legacy family provides.

**Reproduce:** `npx tsx scripts/backtest/csv-replay.ts` (regenerates the aggregate module; 0 credits, no DB).

---

*Replay is isolated, in-memory, and disposable; only aggregate metrics survive. No production tables, queues, or live statistics were touched.*
