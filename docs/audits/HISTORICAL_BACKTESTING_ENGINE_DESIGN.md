# Historical Odds Backtesting Engine — Design Audit

**Date:** 2026-06-11
**Authority:** `HISTORICAL_ODDS_ROI_AUDIT.md` (API facts, cost model, trigger-gated P2 verdict), `IDEA_LEVEL_ARCHITECTURE_DESIGN.md` + `IDEA_LEVEL_IMPLEMENTATION.md` (the accounting units the engine must speak).
**Scope:** Design only — no code. The engine is a research instrument: feature validation, strategy testing, ROI optimization. It never replaces or touches live detection.

---

## 1. Integration with the Current Architecture

| Live component | Integration rule | Why |
|---|---|---|
| `OddsSnapshot` | **Never written, never read by the engine.** Historical data lives in its own table (§3). | Detection's "latest batch per match" logic, settlement's closing-quote lookup, and movement annotation all assume the live table contains only live polls — one backfilled row corrupts all three (footgun documented in `HISTORICAL_ODDS_ROI_AUDIT.md` §2.4). |
| `ValueOpportunity` | **Never written.** Backtest detections go to `backtest_opportunities`. | `ValueOpportunity` feeds the alert layer, dedup state, and every reporting surface. A backtest run inserting rows would generate Discord alerts for 2023 matches and poison the CLV gate sample. |
| CLV tracking | **Reimplemented inside the replay scorer against the historical close** — same de-vig math, same overround bounds, better reference (≤5-min-old close vs live's 1–4 h-stale close). | Live CLV code reads live tables; the formulas, not the code paths, are shared. |
| Movement annotation | **Recomputed by the replay engine from historical snapshots strictly before the cursor.** | Same definition (`(latest/oldest − 1) × 100` over 1/6/24 h windows); the engine additionally gets 5-min resolution — flagged for comparability (§4, cadence modes). |
| Idea-level accounting | **Reused directly.** `idea-aggregation.ts` is pure functions over an `IdeaMemberRow` shape — deliberately storage-agnostic. `groupIdeas`, `selectHeadline`, `corroborationCount`, `bookmakerFamily` run unmodified over backtest rows. | This is the payoff of the derived-layer design: live and backtest score ideas with **identical code**, eliminating unit mismatch between research and production. |

**One production-code prerequisite (the only one):** the detection math (de-vig, overround bounds, structure guard, edge formula, threshold/tier classification) currently lives inline in `ValueDetectionService.detectForMatchExternalIds`. It must be extracted into a pure module — `detectFromBatch(batchSnapshots, config) → candidates` — that both the live service and the replay engine call. Without this, the replay engine is a *reimplementation* of the detector, and every future tweak drifts the two apart; backtest conclusions would describe a model that isn't the one in production. The extraction is mechanical (~1 day), independently valuable (it makes the money-math finally unit-testable — open P2), and should land *before* any backfill is bought.

---

## 2. Complete Architecture

```
┌─────────────────────────┐
│  The Odds API           │   /v4/historical/sports/{sport}/odds
│  Historical endpoints   │   (date param; prev/next navigation; 10× credits)
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐   resumable cursor per (sport, timestamp-plan)
│  Backfill Orchestrator  │   quota budget + hard stop; idempotent re-runs;
│  (one-off CLI jobs)     │   targeted plans: {T−24h, T−6h, T−1h, close} per match-day
└───────────┬─────────────┘
            ▼
┌──────────────────────────────────────────────────────────────┐
│  historical_odds_snapshots          (segregated, append-only)│
│  (sport_key, event_id, commence_time, bookmaker, outcome,    │
│   price, snapshot_at)  + historical_events (teams, league)   │
└───────────┬──────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────┐
│  REPLAY ENGINE                                               │
│  chronological cursor over snapshot_at                       │
│  ├─ cadence sampler  (live-cadence mode | full-res mode)     │
│  ├─ pure detector core  detectFromBatch(batch, config)       │
│  │    └─ SAME module as production (§1 prerequisite)         │
│  ├─ movement annotator  (prior-cursor snapshots only)        │
│  └─ run-scoped permanent dedup  (mirrors live semantics)     │
└───────────┬──────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────┐
│  backtest_runs        (run_id, config JSONB, period, cadence,│
│                        code_version, created_at)             │
│  backtest_opportunities (run_id, event, bookmaker, outcome,  │
│                        odds, fair, edge, tier, movement1/6/24,│
│                        k, family, detected_at, feature cols) │
└───────────┬──────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────┐
│  SCORING LAYER                                               │
│  ├─ CLV scorer: de-vigged close from last pre-kickoff        │
│  │   historical snapshot (no results needed)                 │
│  └─ ROI scorer: optional, requires external results feed     │
└───────────┬──────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────┐
│  REPORTING  (idea-denominated, per run, via idea-aggregation)│
│  ROI · CLV avg/median/positive% · volume · k-distribution    │
│  segmented by: edge bucket, movement class, book family,     │
│  league, sport, time-to-kickoff  |  paired run comparisons   │
└──────────────────────────────────────────────────────────────┘
```

All engine components are offline CLI tools (`scripts/backtest/*`), never registered with BullMQ, never imported by the live app — production safety by construction, not by flag.

---

## 3. Historical Data Storage

**Decision: B — a separate `historical_odds_snapshots` table** (plus `historical_events`, `backtest_runs`, `backtest_opportunities`).

**A) Reuse `OddsSnapshot` — rejected, and it must stay rejected.** Brutally: this is the single most dangerous shortcut available in this repo. Three live consumers select from that table with "latest = now" assumptions (detector's latest-batch, settlement's last-pre-kickoff close, movement's trailing windows). Backfilled 2023 rows would (a) become some match's "latest batch" if IDs ever collide, (b) bloat the hot `[matchId, capturedAt]` index that every detection run hits, and (c) make `Match`/`Team` upserts ambiguous between live and historical identity spaces. The failure mode isn't a slow query — it's Discord alerts for matches that finished two years ago and a corrupted CLV gate. No amount of `source` flag discipline is worth it when every existing consumer would need a correctly-remembered filter forever.

**C) Columnar files (Parquet + DuckDB) — genuinely attractive, deferred.** Replay is an analytical scan workload; columnar storage is 5–10× faster and ~10× cheaper per TB than Postgres for it. But at the **targeted** backfill scale (3–4 timestamps/match-day × 3–4 leagues × 6 months ≈ 2–4 M rows) Postgres replays in seconds-to-minutes anyway, and staying in one database keeps the idea-aggregation/reporting joins trivial. Verdict: B now; C becomes the right answer only if full-resolution (5-min × multi-year) research ever happens — note it, don't build it.

Performance/safety details for B: separate tables share nothing with live indexes (zero production query impact); `historical_events` keyed by The Odds API event id — **no joins into live `Match`/`Team`** (avoids identity pollution; team-name strings suffice for research); `backtest_opportunities` keyed by `run_id` so runs are cheap to create and drop (`DELETE WHERE run_id`); storage ≈ a few hundred MB — irrelevant.

---

## 4. Replay Engine & Bias Prevention

**Core loop:** advance a cursor over distinct `snapshot_at` timestamps (per sport); at each step, assemble the batch visible *at that moment*, run the **production pure detector core** with the run's config, annotate movement from snapshots strictly before the cursor, apply run-scoped permanent dedup (one row per match+bookmaker+outcome per tier, shadow→production progression allowed — mirroring live semantics exactly), and append detections to `backtest_opportunities`.

**Cadence modes (the most important methodological control):** historical data is 5-minute; the live system polls hourly/3-hourly. Replaying at full resolution measures the *ceiling* (what a faster scheduler could catch), not production. Two modes, both first-class:
- **`live-cadence`** — the sampler exposes only snapshots aligned to the current scheduler tiers (60 min / 3 h / 4 h per sport). This mode predicts what production would have done. **All production-facing conclusions come from this mode.**
- **`full-resolution`** — every snapshot. The *difference* between modes is itself a deliverable: it prices the near-kickoff-booster and faster-polling investments in expected CLV terms.

**Look-ahead bias:** the detector receives only `snapshot_at ≤ cursor`; movement windows end at the cursor; the closing snapshot is read **only** by the scoring layer, which runs after the replay completes and writes only score columns. Config is frozen per run before replay starts.

**Future leakage (the subtler kind):** tuning thresholds on a period and reporting results on the same period is leakage by optimization. Mandatory **time split**: tune on the first ~⅔ of the backfilled period, report only on the held-out final ⅓; any config chosen by search must show rank-stability on the holdout. Additionally, the period overlapping the live store (June 2026 onward) is excluded from tuning — it's the live experiment's sample.

**Survivorship bias:** the league/sport universe is fixed *ex ante* from the scheduler config (all 63 keys, or an explicit documented subset) — never "the leagues that produced live alerts" (that conditions on the outcome). Matches without a valid Pinnacle reference stay in the denominator as zero-detection matches. Cancelled/postponed events (no close, no result) are reported as voids, not dropped. Rejected candidates are counted (per-decision tallies), so detection rates are unconditioned on success.

**Replay-parity guard:** every run records `code_version` (git SHA) and the config JSONB; a standing smoke test replays the live store's own 3 days through the engine in live-cadence mode and asserts the output matches the actual `ValueOpportunity` rows — if that diff is ever non-empty, the engine is lying about production and all runs are suspect.

---

## 5. Feature Validation (without touching production)

Every candidate feature is a **config flag interpreted by the replay engine**, never a code fork:

| Feature | Config expression | Validation readout |
|---|---|---|
| Movement filter | `movementFilter: { window: '6h', maxMove: -1.0 }` (require steam-in) etc. | Δ idea-CLV and Δ volume vs same-period baseline run |
| Exchange exclusion | `excludeExchanges: true/false` (candidacy level — the live system today excludes only at headline/alert level) | Δ idea-CLV; how many headlines shift to genuine books |
| Bookmaker scoring | post-hoc segmentation: idea/row CLV per `bookmakerFamily` with shrinkage toward the global mean for small n | family allow/deny list candidates |
| League / sport scoring | same segmentation by league/sport key | scheduler promotion/demotion evidence (replaces the 3-day guesswork in `ROI_MAXIMIZATION_AUDIT.md` Part 5) |
| Threshold changes | `productionThreshold: 3.0 → 4.0`, `shadowThreshold` | volume/CLV trade-off curve per bucket |

Production is unaffected by construction: the engine shares only pure functions with the live path, writes only `backtest_*` tables, and runs as offline CLI. A validated feature graduates by being implemented in the live config — a separate, deliberate code change.

## 6. ROI Research Framework

**Run = (config, period, cadence mode, code_version).** Experiments are paired: both arms replay the identical snapshot stream, so per-idea outcomes can be compared idea-by-idea (paired analysis slashes variance vs comparing aggregate means). Standard report per run and per pair:

| Metric | Definition |
|---|---|
| Opportunity count | rows (bookmaker-level) and **ideas** (headline unit) per tier |
| Alert volume | production-tier ideas with a non-exchange headline (live alert rule) |
| CLV | idea-level avg / median / positive-rate, with bootstrap CIs; plus trimmed mean (top-decile outliers excluded — the gate amendment from `ROI_MAXIMIZATION_AUDIT.md` §2.4) |
| ROI | idea-level flat-stake P&L — **only when a results feed exists** (§7 note); otherwise omitted, never imputed |
| Segments | edge bucket × movement class × family × league × time-to-kickoff |

Initial pre-registered experiment matrix (each vs the production-config baseline, live-cadence mode): 3% vs 4% vs 5% threshold; movement filter on/off; exchange candidacy on/off; full-resolution vs live-cadence (scheduler-value run). **Pre-registration matters:** hypotheses and pass criteria are written into the run config before execution; post-hoc segment-mining is exploratory and labelled as such — with ~10 configs × ~10 segments, something will look great by chance.

**The honest caveat that bounds everything:** ROI in this framework is *paper at recorded prices*. The backtest inherits the attainability blind spot — it cannot know whether a 2023 soft-book outlier was bettable. CLV-at-close remains the primary readout; ROI is the slower, noisier confirmation.

## 7. Historical CLV

**Yes — approximable, and better than live CLV.** Method: for each event, the close is the last historical snapshot with `snapshot_at ≤ commence_time` (≤5 min stale post-Sept-2022, vs the live system's 1–4 h); de-vig Pinnacle's prices from that snapshot with the same overround bounds [0.99, 1.15]; `CLV% = (detected odds / closing fair odds − 1) × 100`. **No match results are required** — this is why Phase 1 of the engine needs no results integration at all.

Limitations, stated plainly: (1) 5-minute granularity still misses the literal final tick, and pre-Sept-2022 data is 10-minute; (2) `commence_time` occasionally shifts (delays) — snapshots after the true start would leak in-play prices into the "close"; mitigate by requiring the close snapshot's prices to pass the pre-match overround bounds and by taking the *last snapshot before the original scheduled time*; (3) Pinnacle may be absent at the close for some events → null CLV, reported as coverage like live; (4) the recurring structural caveat — niche-league Pinnacle closes are weak references, and positive CLV against them proves less; (5) **a separate results feed is needed for ROI** (The Odds API's scores endpoint only reaches 3 days back) — an external free results source is a Phase-2 integration, deliberately decoupled.

## 8. Future ML Readiness (pipeline only)

`backtest_opportunities` doubles as the **feature store**. Per detected candidate, flat columns computed *at detection time* by the same shared pure functions the live system uses (this kills training/serving skew at the root): edge %, odds, fair prob, overround, movement 1h/6h/24h, corroboration k, price-gap to second-best book, bookmaker family, league, sport, time-to-kickoff, snapshot age, tier. Label columns written only by the scoring layer: `clv_pct` (regression target), `clv_positive` (classification), `bet_result`/`pl_units` (when results exist).

Pipeline rules baked into the design now: labels and features physically separated (scorer-written vs replay-written columns) so leakage requires deliberate effort; **time-based splits only** (walk-forward), never random — random splits leak market regimes; export is one `SELECT … WHERE run_id` to a dataframe; every training set is reproducible from (run_id, code_version, config). When LogReg/RF/XGBoost arrive in V2/V3 they consume this table as-is; nothing about the engine changes. No models are designed here — at current volumes the honest order remains transparent filters first (`ALERT_STRATEGY_REVIEW.md` ranking), and the strongest argument for this pipeline is that it will eventually provide the *thousands* of labelled ideas that make ML defensible instead of decorative.

## 9. Prioritization (expected ROI impact, highest first)

| Rank | Item | Justification |
|---|---|---|
| 1 | **Exchange exclusion** (at candidacy) | Free, immediate, removes the proven dominant fake-candidate class; live data showed exchange rows were 5/8 of the new model's first day. Everything downstream measures cleaner with it done first. |
| 2 | **Movement filtering** | Annotation already live and accruing evidence at zero cost; promotion to a filter is one config line once CLV-by-class confirms; mechanistic rationale (LAG vs ghost) independent of any backtest. |
| 3 | **Historical Backtesting Engine** | Highest *research* leverage but indirect ROI: it accelerates and de-risks decisions (thresholds, league scoring, scheduler value) rather than improving any bet directly. Rises to #2 if the live CLV verdict comes back ambiguous (the standing trigger from `HISTORICAL_ODDS_ROI_AUDIT.md` Part 7). |
| 4 | **Kelly staking** | Sizing an unvalidated edge optimizes noise; flat 1u is the correct measurement stake until the gate passes. Post-gate, fractional Kelly is a genuine compounding improvement — its rank is conditional on a future state. |
| 5 | **ML ranking** | ~2 settled ideas exist today; even the backtest will yield only hundreds-to-thousands of labelled ideas. The transparent features ML would learn are exactly ranks 1–2. Build the pipeline (§8) inside the engine; build models when the labels exist. |

## 10. Final Verdict

**Wait — but shorten the wait by doing the prerequisite now.** If this were my platform: I would extract the pure detector core this week (1 day, independently justified — it makes the money-math testable and freezes replay parity), ship exchange exclusion, and let the live CLV experiment run. I would build the engine **when the trigger fires or ~4 weeks pass**, whichever first: either live CLV is ambiguous (engine becomes the tiebreaker and is worth its ~50–80 k credits + ~1 week immediately) or live CLV is decisive (and the engine's first job becomes league/scheduler scoring instead of model validation — still worth building, with calmer urgency). Building it *today* would consume the exact engineering week that exchange exclusion, deployment hygiene, and the C1/C2/C4 criticals need — and those protect the live experiment that no backtest can replace, because only live data carries real alert timing and the system's own attainability profile.

| Dimension | Score | Honest rationale |
|---|---|---|
| Expected ROI value | **4 / 10** | Indirect by nature: it buys better *decisions* (threshold, leagues, scheduler), worth perhaps +0.5–1.5%/bet once-off; it cannot create edge or fix attainability. |
| Expected research value | **8 / 10** | Compresses 6–8 weeks of live waiting into ~a week per question, prices the scheduler ceiling, and is the only path to ML-scale labelled data. Docked 2: conclusions are capped by the attainability blind spot and niche-league close weakness. |
| Implementation complexity | **6 / 10** | ~1 week + prerequisite refactor: backfill orchestrator with quota budget, segregated storage, cursor replay with cadence sampling, scoring, reporting. None of it is hard; all of it must be *careful* (bias prevention is design discipline, not code volume). |
| Long-term importance | **7 / 10** | If the platform survives its gate, every future strategy change will be expected to pass through this engine first — it becomes the standard of evidence. If the gate fails, the engine is the autopsy tool. Either way it outlives most of the current code. |

---

*Design audit only — no code modified. Prerequisite flagged for implementation approval: extraction of the pure detector core shared by live detection and replay.*
