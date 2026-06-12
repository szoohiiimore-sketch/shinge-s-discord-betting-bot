# Historical Backtesting Engine — Implementation Audit

**Date:** 2026-06-12
**Authority:** `HISTORICAL_BACKTESTING_ENGINE_DESIGN.md` (architecture), `HISTORICAL_ODDS_ROI_AUDIT.md` (API facts, cost model), `IDEA_LEVEL_ARCHITECTURE_DESIGN.md` / `IDEA_LEVEL_IMPLEMENTATION.md` (accounting units), `EXCHANGE_EXCLUSION_IMPLEMENTATION.md` (candidacy rules). Implemented as designed; deviations are documented in §2 (Critical Review) — every one is a flaw fix, not a redesign.
**Validation:** `npx tsc --noEmit` — 0 errors; ESLint — 0 errors; 16/16 synthetic engine checks pass; live replay-parity check passes (all differences explained).

---

## 1. Architecture Implemented

```
The Odds API /v4/historical/*  ──►  Backfill Orchestrator (src/backtest/backfill.ts)
        (correct v4 contract)        hard credit budget + monthly-quota floor,
                                     resumable cursors, idempotent re-runs
                                              │
                                              ▼
              historical_events + historical_odds_snapshots   (segregated, append-only)
                                              │
                                              ▼
              REPLAY ENGINE (src/backtest/replay.ts)
                chronological cursor  ─ cadence sampler (live-cadence | full-resolution)
                                      ─ pure detector core detectFromBatch()  ◄── SAME module
                                      ─ movement annotator (prior-cursor only)     as production
                                      ─ run-scoped tier-aware dedup (live semantics)
                                      ─ in-play guard (cursor < commence_time)
                                              │
                                              ▼
              backtest_runs (config JSONB, period, cadence, git SHA)
              backtest_opportunities (detections + ML feature columns)
                                              │
                                              ▼
              SCORING (src/backtest/scoring.ts) — the ONLY closing-line reader;
                writes label columns only (closing_*, clv_*)
                                              │
                                              ▼
              REPORTING (src/backtest/reporting.ts) — idea-denominated via the
                SAME idea-aggregation functions production uses; paired run comparison
```

All entry points are offline CLIs under `scripts/backtest/`. **Nothing in `src/backtest` is imported by the live application** (verified: no import of `backtest` anywhere in the `src/main.ts` graph); the engine imports live pure functions (`detector-core`, `idea-aggregation`), never the reverse. Production safety is by construction, not by flag.

## 2. Critical Review — design flaws found and fixed (Requirement 11)

The audited architecture survived review except for five concrete issues, all of which would have produced **invalid backtests** if implemented as written:

1. **The "existing HTTP layer" does not exist.** `OddsApiClient.getHistoricalOdds()` (dead code the design planned to reuse) targets `/sports/{sport}/odds-history?dateFrom&dateTo` — an endpoint shape that does not exist in The Odds API v4. The real contract is `GET /v4/historical/sports/{sport}/odds?date=<ISO>` returning an envelope `{ timestamp, previous_timestamp, next_timestamp, data }` (plus `/historical/sports/{sport}/events`, 1 credit). **Fix:** a correct standalone client in `src/backtest/historical-api.ts`; the live integration layer is untouched. The dead method remains dead — flagged for cleanup.
2. **In-play leakage in the replay loop.** The design treated commence-time shifts as a *scoring* problem only. But a replay cursor can also land at/after kickoff (the historical feed keeps snapshotting), and live production effectively never detects post-kickoff. Without a guard, the replay would "detect" on in-play prices — fake edges, invalid CLV. **Fix:** the replay skips any (event, cursor) batch with cursor ≥ commence_time (`inPlaySkipped` is reported); the scorer additionally walks back up to 5 timestamps if the nominal close fails the pre-match overround bounds.
3. **Movement-resolution leakage under live-cadence.** Computing movement from *all* historical snapshots would give live-cadence runs 5-minute-grade movement features that production never sees — training/serving skew inside the backtest itself. **Fix:** the movement history is appended only as cursors are *processed*, so each cadence mode sees exactly the history its simulated poller would have had. (Raw reference rows are appended — including from batches the detector rejected — mirroring live exactly.)
4. **Dedup/filter ordering.** A movement-filtered candidate must NOT claim its permanent-dedup key, or it would suppress a later qualifying detection — semantics that diverge from live (where the filter doesn't exist). **Fix:** dedup keys are claimed only after every filter passes. Synthetic check covers it.
5. **Targeted backfill needs event discovery first.** "{T−24h, T−6h, T−1h, close} per match-day" requires commence times before any odds call. **Fix:** targeted mode fetches the day's event list (1 credit/day/sport), computes the deduplicated union of per-event timestamps on the API's 5-minute grid, then fetches sport-level snapshots (which cover *all* events at that moment, so overlapping matches share cost).

Verdict after review: the design is sound; no architectural change was needed. Proceeded.

## 3. Files Created / Modified

| File | Role |
|---|---|
| `src/value-detection/detector-core.ts` | **New** — pure shared detector (see `DETECTOR_CORE_EXTRACTION_IMPLEMENTATION.md`) |
| `src/value-detection/value-detection.service.ts` | Refactored to consume the core; behavior unchanged (parity-verified) |
| `src/value-detection/index.ts` | Exports core + types |
| `prisma/schema.prisma` + `prisma/migrations/20260611215151_add_backtest_engine_storage/` | 5 new tables (§4) |
| `src/backtest/types.ts` | Run config, replay row/detection/result types |
| `src/backtest/historical-api.ts` | Correct v4 historical client (fetch-based, standalone) |
| `src/backtest/backfill.ts` | Backfill orchestrator: budget, quota floor, resume, idempotency |
| `src/backtest/replay.ts` | Replay engine: cursor, cadence sampler, core, movement, dedup, guards |
| `src/backtest/run-store.ts` | Run creation (git SHA), replay-input loading (24 h movement warm-up), chunked detection inserts |
| `src/backtest/scoring.ts` | Historical CLV scorer (close walk-back, label columns only) |
| `src/backtest/reporting.ts` | Idea-denominated reports, segments, paired comparisons |
| `src/backtest/index.ts` | Public engine surface + the "never imported by live app" rule |
| `scripts/backtest/backfill.ts`, `replay-run.ts`, `score.ts`, `report.ts` | CLI entry points |
| `scripts/backtest/parity-check.ts` | Replay-parity guard (live store → engine → diff vs `ValueOpportunity`) |
| `scripts/backtest/synthetic-verify.ts` | 16 in-memory engine checks (no DB, no API) |
| `scripts/backtest/configs/*.json` | Example backfill plan + baseline run config |
| `src/settlement/settlement.worker.ts` | Unrelated one-word `prefer-const` lint-error fix |

## 4. Database Design (segregated storage — Decision B from the design)

Five tables, zero contact with live data:

- **`historical_events`** — keyed by The Odds API event id. Deliberately NOT joined to `Match`/`Team`: historical identity stays in the API's id space so backfills can never pollute live reference data. Team names as strings (sufficient for research).
- **`historical_odds_snapshots`** — append-only; unique `(event_id, bookmaker, market, outcome, snapshot_at)`; indexes `(sport_key, snapshot_at)` and `(event_id, snapshot_at)`. Cascade-deletes with its event.
- **`historical_ingestion_cursors`** — resumability per `(sport, plan)`: last fetched timestamp + credits used. Inserts use `skipDuplicates`, so re-runs are idempotent even without the cursor.
- **`backtest_runs`** — `(name, config JSONB, code_version, cadence_mode, period, status CREATED→REPLAYED→SCORED)`. Config is frozen at creation.
- **`backtest_opportunities`** — detections + the ML feature store (§8). Keyed by `run_id` with cascade delete: a run is dropped with one `DELETE`. Feature columns are replay-written; label columns (`closing_*`, `clv_*`, `bet_result`, `pl_units`) are scorer-written **only** — leakage requires deliberate effort.

`OddsSnapshot` and `ValueOpportunity` are never written and (outside the read-only parity script) never read by the engine.

## 5. Historical Data Ingestion

`runBackfill(prisma, api, plan)` with plan modes:

- **`interval`** — one snapshot per `intervalMinutes` across the period (cheap scans, scheduler-shape studies).
- **`targeted`** — per match-day: event list (1 credit), then sport-level snapshots at `targetedOffsetsHours` before each event's kickoff (default `[24, 6, 1, 0.083]` → T−24h/−6h/−1h/−5min), deduplicated on the 5-minute grid.

Safety: hard `maxCredits` budget per invocation (stop at the boundary, partial progress kept); `minRemainingCredits` floor (default 10,000) on the account's monthly quota read from response headers — a backfill can never starve the live pipeline; ~300 ms throttle; multi-sport; resumable mid-period. The API returns the snapshot at-or-before the requested time; rows are stored under the **actual** snapshot timestamp, and the unique key absorbs requests that resolve to the same stored snapshot.

Cost model (unchanged from `HISTORICAL_ODDS_ROI_AUDIT.md`): one sport-snapshot at `eu,uk` = 20 credits; the example targeted plan (3 soccer leagues × 6 months × ~4 timestamps/match-day) ≈ 50–80 k credits — to be purchased **only after the H4 quota fix frees headroom**, per the standing trigger.

## 6. Replay Methodology & Bias Prevention

- **Cursor:** distinct `snapshot_at` per sport, ascending; total deterministic ordering (time, sport, event, bookmaker, outcome) → same input, byte-identical output (verified by running over shuffled input).
- **Cadence modes:** `live-cadence` emits a cursor only when the per-sport poll interval (default + per-sport map mirroring the 60-min/3-h/4-h production tiers) has elapsed since the last emitted cursor — simulating the production poller over the 5-minute grid. **All production-facing conclusions come from this mode.** `full-resolution` replays every snapshot; the delta between modes prices the faster-polling/near-kickoff investments.
- **Look-ahead:** the detector sees only the cursor batch; movement sees only previously processed cursors; config is frozen pre-run; the close is read only by the post-replay scorer.
- **In-play:** cursor ≥ commence_time → batch skipped and counted.
- **Survivorship:** the sport universe is fixed ex ante in the run config; every detector decision is tallied (`decisionCounts`), so zero-detection matches stay in the denominator; events without a valid close are reported (`eventsWithoutClose`), never dropped.
- **Future leakage (optimization):** procedural rule carried over from the design — tune on the first ⅔ of a backfilled period, report on the held-out ⅓; the live-store period (June 2026→) is excluded from tuning. The engine enforces reproducibility (config + git SHA per run); the time-split is analyst discipline, documented here as mandatory.
- **Replay-parity guard:** `parity-check.ts` replays the live store (whose batches ARE production's polls → full-resolution mode) and diffs against actual `ValueOpportunity` rows. Current result: 6/6 current-model rows reproduced; only the 4 pre-exclusion exchange rows differ (explained). This script is the standing smoke test before trusting any run.

## 7. Research Framework & Idea-Level Accounting

Every experiment is a config field, never a code fork: thresholds (`detector.productionEdgeThresholdPct` / `shadowEdgeThresholdPct`), exchange candidacy (`detector.excludeExchanges`), movement filters (`movementFilter: { window, minMovePct, maxMovePct, dropNullMovement }`), cadence, universe. Bookmaker/league/sport scoring are post-hoc segmentations in the report (family, sport key, edge bucket, movement class, time-to-kickoff, corroboration k).

Reporting reuses `groupIdeas` / `selectHeadline` / `ideaKey` from `idea-aggregation.ts` **unmodified** — backtest ideas are the same unit as production ideas. The standard report shows: production/shadow ideas (with row counts), bookmaker-family coverage, **idea-denominated CLV** (avg / median / positive-rate / top-decile-trimmed — the gate amendment), per-segment idea CLV, and row-denominated per-family diagnostics, exactly mirroring the live accounting rules. `report.ts <runA> <runB>` produces a **paired comparison**: ideas joined on idea key, per-idea CLV deltas on the shared set plus A-only/B-only breakdowns — paired analysis over the identical snapshot stream, as designed.

ROI columns (`bet_result`, `pl_units`) exist but are written by nothing yet: The Odds API scores endpoint reaches only 3 days back, so a results feed is a deliberately decoupled Phase-2 integration. **CLV is Phase 1's complete readout and requires no results** — the close is approximable from the data itself. ROI is never imputed.

## 8. Future ML Integration Points

`backtest_opportunities` doubles as the feature store. Per detection, replay-written flat features computed by the **same shared pure functions live uses** (kills training/serving skew at the root): edge %, odds, fair probability, reference overround, movement 1h/6h/24h, corroboration k (distinct non-exchange families ≥ shadow threshold in-batch), price-gap-to-second-best (lone-outlier/ghost signal), bookmaker family, sport key, minutes-to-kickoff, tier. Scorer-written labels: `clv_percentage` (regression), `clv_positive` (classification), `bet_result`/`pl_units` (when a results feed exists).

Export is one query: `SELECT * FROM backtest_opportunities WHERE run_id = $1` → dataframe; every training set is reproducible from (run_id, config JSONB, code_version). Pipeline rules baked in: features and labels physically separated by writer; **time-based splits only** (walk-forward — random splits leak market regimes). No models built, per the design's ranking: transparent filters first.

## 9. Example Experiments (pre-registered matrix, live-cadence mode)

| Experiment | Arms | Readout |
|---|---|---|
| Threshold curve | `productionEdgeThresholdPct` 3 vs 4 vs 5 | idea volume vs idea-CLV trade-off per edge bucket |
| Movement filter | none vs `{window:'6h', maxMovePct:-1}` (steam-in only) | paired Δ idea-CLV vs volume cost |
| Exchange candidacy | `excludeExchanges` true vs false | how much fake CLV exchanges injected (validates the live decision) |
| Scheduler value | live-cadence vs full-resolution, same config | the CLV ceiling a near-kickoff booster could buy |
| League scoring | one run, sport-key segmentation | promotion/demotion evidence replacing 3-day guesswork |

Hypotheses and pass criteria go in the run name/config before execution; post-hoc segment mining is exploratory and must be labelled as such.

## 10. Performance Considerations

Replay is in-memory over a single `findMany` (period + 24 h warm-up); at the targeted backfill scale (2–4 M rows) this is seconds-to-minutes in Node against Postgres — columnar storage (Parquet/DuckDB) remains noted-not-built, becoming relevant only for full-resolution multi-year research. Detection inserts are chunked (1,000/batch). Scoring is per-event queries — fine at thousands of events; batchable later if needed. Backtest tables share no indexes with live queries: zero production impact.

## 11. Validation Summary (Requirement 9)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| ESLint (`--quiet`) | ✅ 0 errors |
| Production detection unchanged | ✅ Replay-parity: 6/6 current-model rows reproduced exactly; 4 differences all pre-exclusion exchange rows (explained) |
| Historical replay deterministic | ✅ Byte-identical output across repeated and input-shuffled runs |
| Idea accounting works | ✅ Reports derive ideas via the production `idea-aggregation` functions; synthetic + parity exercised |
| Exchange exclusion respected | ✅ Core-level (config); synthetic check confirms zero exchange detections + EXCHANGE_EXCLUDED tallies |
| Bias guards | ✅ 16/16 synthetic checks: look-ahead, in-play, warm-up, dedup ordering, cadence sampling, movement filter |

## 12. Rollback Procedure

- **Code:** revert the commit. `src/backtest` and `scripts/backtest` have zero live imports — deleting them outright is also safe.
- **Schema:** the five new tables are inert if unused; full removal = drop migration `20260611215151_add_backtest_engine_storage` tables (no live FK touches them).
- **Data:** individual runs: `DELETE FROM backtest_runs WHERE id = …` (cascades). Backfilled history: `TRUNCATE historical_odds_snapshots, historical_events, historical_ingestion_cursors` — no live consumer exists.
- **Detector core:** reverting the extraction restores the previous inline service (behavior was identical; parity-verified).

## 13. Risk Assessment

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Engine drift from production math | Low | Critical | Single shared core; parity script as standing tripwire; `code_version` per run |
| Backfill quota burn starving live pipeline | Low | High | Hard per-invocation budget + 10 k monthly-quota floor + throttle; **no credits spent until H4 fix per the standing trigger** |
| Historical rows leaking into live tables | None | Critical | Separate tables, separate id space, no live imports; only the read-only parity script touches live data |
| In-play prices contaminating detections/closes | Low | High | Replay in-play guard + scorer close walk-back with overround bounds |
| Overfitting via post-hoc mining | Medium | High | Pre-registration discipline (§9), mandatory time split (§6), paired comparisons, trimmed-mean gate stats |
| Attainability blind spot | Certain | Medium | Unfixable by any backtest — CLV-at-close is the primary readout; conclusions are bounded accordingly |
| Live-cadence phase sensitivity (sampler anchors at first snapshot) | Medium | Low | Documented; sensitivity checkable by re-running with shifted periodStart |

---

## 14. ALERT VOLUME OPTIMIZATION ROADMAP (Requirement 12)

**Context:** after Pinnacle-led detection + idea aggregation + exchange exclusion, observed volume is ~1 production idea-alert/day. That is too slow for the user *and* for the experiment: at 1/day, the 150–200-idea CLV gate takes ~6 months. Volume increases are therefore doubly valuable — but only volume that carries edge. Ranked by expected value (volume × ROI/CLV preservation ÷ complexity):

| # | Change | Expected volume | Expected ROI | Expected CLV | Complexity | Status |
|---|---|---|---|---|---|---|
| 1 | **Near-kickoff booster** — poll matches starting ≤2 h at 15–30 min | **+30–60% detections** (the final hours are where soft-book lag vs late Pinnacle moves concentrates; current tiers leave a 1–3 h blind spot exactly there) | Positive (catches LAG-class edges while attainable) | Positive twice: more LAG alerts *and* a near-true close fixing the gate instrument | Medium (scheduler) | **Recommended next implementation** |
| 2 | **Region expansion `au` + `us2`** — more candidate books per match | **+20–40%** (more independent soft books = more qualifying ideas; the model's volume is linear-ish in genuine candidate count) | Neutral-positive (new books are conventional sportsbooks; AU books known-soft on niche markets) | Neutral (exchanges in those regions are already pre-excluded: betfair_ex_au, novig, prophetx) | Low (+2 credits/call, config) | Recommended; needs quota headroom (#4) |
| 3 | **Promote active niche soccer 3 h → 60 min** — Superettan, Brazil Série B, Segunda | **+~3× sampling of the segment producing essentially all current edges** (6/8 of first-day non-esports candidates) | Positive (more batches = catching the lag window before books correct) | Neutral-positive | Low (config) | Recommended |
| 4 | **H4 quota fix** — free `/events` discovery polling | No direct volume; **funds #1–#3** (~75% of 240–320 k credits/month avoidable) | Indirect | Indirect | Low-medium | Enabler — do first or alongside |
| 5 | **Corroboration-conditional threshold** — alert k≥2 ideas from 2.5% edge | **+30–50%** of production ideas (the 2.5–3% band is large — Part 3 simulation: 2% threshold ≈ 4× the 3% volume; k≥2 selects its least-ghost-like slice) | Unknown-positive (corroborated edges are the least likely to be ghost quotes) | Slightly negative per-idea, acceptable if k-conditioning works | Low code; **evidence-gated** | **Now a one-config-line engine experiment + shadow-tier CLV will answer it free in ~4–6 weeks** |
| 6 | **Movement-conditional threshold** — steam-in ideas (move6h ≤ −1%) from 2.5% | **+15–30%** | Unknown-positive (LAG class is the textbook +EV bet) | Same caveat: measured CLV of moving lines overstates attainable price | Low code; **evidence-gated** | Same path as #5 — `movementFilter` config exists in the engine today |
| 7 | **Sport/league-specific thresholds** — lower where CLV proves strong, raise where weak | ±20% redistribution toward profitable segments | Positive | Positive | Medium | Gated on per-league CLV sample (engine accelerates from ~6 months of live waiting to ~1 week per question) |
| 8 | **Season-gate tennis/NCAAF, demote MLB** | No volume; frees ~500+ wasted polls/day toward #1/#3 | Indirect | Indirect | Low | Hygiene; recommended |

**Implemented in this task:** none of the production-config changes — correctly so. #1–#4 and #8 are scheduler/config changes belonging to a deliberate production change, not a research-engine task; #5–#7 are exactly the experiments the engine was built to validate before shipping (and #5/#6 get free live evidence from the already-running shadow tier). Shipping a threshold cut today, before the CLV evidence lands, would be the "flood with low-quality opportunities" failure mode this requirement forbids.

**The honest sequence to higher volume:** (a) H4 fix + near-kickoff booster + region expansion + niche-soccer promotion — mechanical volume from more books and better-timed polls at unchanged quality bar, realistic combined effect **~1/day → ~3–5/day**; (b) let the shadow tier + engine produce k- and movement-conditioned CLV evidence; (c) if it confirms, the conditional 2.5% tiers add another ~50% with measured, bounded quality cost. Path (a) needs no new evidence and no model risk; path (c) is one config line away once the data says yes.

---

*Engine implemented; no live behavior changed (parity-verified). No API credits were spent — backfill remains gated behind the H4 quota fix per the standing trigger from `HISTORICAL_ODDS_ROI_AUDIT.md` Part 7.*
