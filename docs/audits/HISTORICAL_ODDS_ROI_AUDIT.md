# Historical Odds — ROI Audit

**Date:** 2026-06-10
**Question:** Should The Odds API's Historical Odds product be added to this repository, and is it likely to improve ROI?
**Stance taken:** Audit first; no assumption that historical data improves profitability. ROI is the only objective.
**Method:** Source-code inspection, prior audits (`ROI_MAXIMIZATION_AUDIT.md`, `BOOKMAKER-COVERAGE-AUDIT.md`, `FINAL_V1_AUDIT.md`), The Odds API historical-odds page and v4 API documentation, and read-only queries against the live snapshot store (reproducible via `scripts/snapshot-cadence-audit.ts`).

**Verdict up front: D — build movement analysis from existing `OddsSnapshot` data first; delay the Historical Odds API behind a defined trigger. Confidence 80%.** Reasoning follows.

---

## Part 1 — Current State

The production system today: Pinnacle-led detection (de-vigged reference, overround bounds [0.99, 1.15], outcome-count guard, odds cap 3.0), production threshold 3%, shadow tier 2–3% (`isShadow`), permanent tier-aware dedup, CLV computed at settlement against the last pre-kickoff Pinnacle batch, 63 sports on 60-min/3-h/4-h polling tiers, settlement every 4 h.

### 1.1 What information is missing that historical odds could provide?

1. **Depth.** The own snapshot store begins **2026-06-07** — three days. The Historical Odds API reaches back to **June 6, 2020** (10-minute snapshots; 5-minute from September 2022). The only thing the repo cannot manufacture by waiting is *the past*: a multi-month backtest of the Pinnacle-led model is impossible from own data today and possible immediately with the historical API.
2. **Intra-hour resolution.** Own cadence is hourly at best (measured: p50 inter-batch gap = 60 min, p95 = 180 min). Steam — coordinated sharp money moving a line in minutes — is invisible between batches. Historical data is 5-minute.
3. **True closing lines.** The CLV reference is currently the last polled batch, up to 1–4 h pre-kickoff. Historical snapshots at `commence_time − 5 min` would be a near-true close. (Note: for *future* matches the same improvement is available at 1× cost via near-kickoff live polling — already P1 #7 in `ROI_MAXIMIZATION_AUDIT.md`. The historical endpoint only wins this point for matches already played.)

### 1.2 What is already available through `OddsSnapshot` history?

The table is an append-only time series keyed by (match, bookmaker, market, outcome, capturedAt) with ~45k rows/day across ~50 books. Measured against the traditional matches in store:

- **67 of 72 matches have ≥10 distinct Pinnacle pre-match batches** (35 have ≥20) — every match carries an hourly Pinnacle price path across its observed life.
- **Pinnacle moves enough to matter at this resolution:** of 166 match-outcomes, first→last observed batch movement was ≥2% for 99 (60%), ≥3% for 69 (42%), ≥5% for 34 (20%). Hourly granularity captures the bulk of pre-match drift; what it misses is the *minutes-scale* microstructure.
- Every batch is a full cross-section of ~40–50 books, so per-batch bookmaker divergence is fully computable.

### 1.3 Is this enough to build movement-based models without the Historical Odds API?

**Mostly yes, with one hard limit.** Movement *direction and magnitude over hours* — the input to the highest-value filter (Part 5) — is fully derivable from existing data, free, today. What cannot be built from own data: minutes-scale steam detection, and any *backtest* longer than the store's age. The store grows by one day per day; the resolution gap is a scheduler problem (poll faster), not a data-purchase problem.

---

## Part 2 — Historical Odds API Analysis

Facts from the product page and v4 documentation:

- **Endpoints:** `GET /v4/historical/sports/{sport}/odds` (featured markets, all events at a timestamp), `/historical/sports/{sport}/events`, `/historical/sports/{sport}/events/{eventId}/odds` (additional markets). The `date` parameter returns the closest snapshot ≤ the requested time; responses carry `previous_timestamp`/`next_timestamp` for navigation.
- **Granularity:** 10-min intervals June 2020 – Sept 2022; 5-min from Sept 18, 2022. All sports and bookmakers in the system; H2H/spreads/totals throughout.
- **Cost: 10× the live formula — `10 × markets × regions` per request.** One H2H snapshot for one sport at `eu,us,uk` = **30 credits** (vs 3 live). Paid plans only.

### 2.1 What new data? (vs what we have)
Six years of 5–10-minute multi-book snapshots, including true closing lines, for every sport in the current config. Nothing else — same books, same markets, same structure as the live feed.

### 2.2 Quota cost (realistic scenarios)

| Backtest design | Requests | Credits |
|---|---|---|
| Targeted: 3 timestamps/match-day (T−24h, T−6h, close) × 3 soccer leagues × 180 days | ~1,620 | **~49,000** |
| Moderate: 6 timestamps/day × 5 sports × 90 days | 2,700 | **~81,000** |
| Full resolution: 5-min × 5 sports × 90 days | 129,600 | **~3.9M** — out of the question |

Context: `FINAL_V1_AUDIT.md` H4 estimates current live burn at 240–320k credits/month, ~75% avoidable. A targeted ~50–80k-credit backtest is affordable **only after** the H4 discovery fix frees headroom; before it, historical pulls would compete with the live pipeline for quota.

### 2.3 Storage impact
One sport-snapshot ≈ events × ~47 books × 2–3 outcomes ≈ 1,000–2,500 rows. The targeted design ≈ 2–4M rows total — about 1–2 months' worth of current live volume. Postgres-trivial.

### 2.4 Operational complexity
Moderate, with **one serious footgun: backfilled rows must not enter `OddsSnapshot`.** Detection selects "latest `capturedAt` batch per match" and CLV selects "last pre-kickoff batch"; mixing historical rows into the live table would corrupt both unless rigorously segregated (separate table, or the live store gains a `source` discriminator every consumer must filter). A separate `historical_odds_snapshots` table is the only safe design. Plus: a backfill orchestrator with resumability, its own quota budget/throttle, and timestamp-navigation logic.

### 2.5 Implementation complexity
The HTTP layer already exists — `OddsApiClient.getHistoricalOdds()` is typed and wired in `the-odds-api.client.ts` (currently dead code, noted in `FINAL_V1_AUDIT.md`). Remaining work: backfill orchestrator, segregated storage, and the analysis layer that actually answers questions (replaying the detector + CLV computation over historical batches). Realistic estimate: **3–5 focused days** for a clean targeted-backtest pipeline — not huge, but more than every P0/P1 item it would displace.

---

## Part 3 — ROI Impact Assessment

ROI only. The blunt framing: **historical data cannot change a single bet the live system takes.** Its only path to ROI is indirect — research that improves future selection (threshold, book classes, movement filters) or accelerates the decision to scale/kill the strategy.

### 3.1 Evidence historical odds would improve ROI?
**No direct evidence; a credible indirect mechanism.** A 6-month backtest would answer, in ~a week of elapsed time, what live collection answers in 6–8: does the 3% Pinnacle-led edge carry positive CLV-at-close, and in which leagues/books? Acting on a calibrated answer 5–7 weeks earlier is worth roughly the per-bet improvement × bets placed during the otherwise-uncalibrated window: at ~5 production bets/day and a plausible 0.5–1.5% per-bet selection improvement, on the order of **+1 to +4 units total**, one-time — real but small. The backtest does *not* and cannot validate attainability (whether the soft-book price was actually bettable), which remains the dominant unknown between paper and real ROI.

### 3.2 Evidence it would improve CLV but NOT ROI?
**Yes, two concrete channels.** (a) A movement/steam filter tuned on historical data selects for already-moving lines; measured capture-CLV rises while the realistically attainable price (seconds–minutes later, by a human reading Discord) is gone — classic CLV-up, realized-ROI-flat. (b) Replacing the stale close with a true 5-min close changes the *measured* CLV number (more accurate instrument), not the quality of any bet. Both are improvements to measurement, neither to profit.

### 3.3 Would it reduce alert volume?
Used as a filter (suppress alerts lacking confirming Pinnacle movement, or where Pinnacle moved *away*), yes — est. **−20–40%** of production alerts. Whether that *raises* ROI depends entirely on whether the suppressed class has worse CLV, which is precisely what should be measured by annotation before filtering (Part 5).

### 3.4 Would it increase signal quality?
The genuine mechanism: a single snapshot cannot distinguish *"soft book lagging a sharp move"* (the canonical +EV bet) from *"soft book outlier/ghost price"* (the canonical paper-only bet). Movement context resolves this. **But hourly own-data already provides most of that resolution** — Pinnacle's drift over the last 1–6 h is computable today for free (Part 6). The historical API adds intra-hour sharpness, a second-order refinement.

### 3.5 Realistic ROI upside (per-bet, on top of the unproven base edge)

| Component | Range | Justification |
|---|---|---|
| Movement-context filtering (lag vs outlier) | **+0.5% to +2%** | Removes the worst alert class (unconfirmed outliers ≈ ghosts/stale quotes); bounded because the base candidate pool is small and partly genuine |
| Threshold/book calibration from backtest | **+0.5% to +1.5%**, one learning-period effect | Faster convergence to the right config; bounded by how wrong the current config is |
| True-close CLV measurement | **±0%** | Instrument accuracy, not bet quality |
| If the base model has no edge | **0%** | Historical data cannot conjure an edge that isn't there — it can only reveal that faster |

Critically: **~70% of the filtering upside is available without the historical API** (Part 6), because it derives from hourly movement context the system already records.

---

## Part 4 — Candidate Models

| | Model A — current | Model B — A + Pinnacle movement filter (own data) | Model C — B + exchange movement confirmation (own data) | Model D — A + Historical API + steam detection |
|---|---|---|---|---|
| Data source | live snapshots | existing `OddsSnapshot` | existing `OddsSnapshot` (Betfair/Smarkets already stored) | Historical API (10× credits) + faster live polling |
| Complexity | — | Low (~1–2 days) | Medium (~3–4 days) | High (~1–2 weeks incl. backfill infra) |
| Maintenance burden | baseline | +small (one feature, one threshold) | +medium (commission handling, exchange liquidity caveats) | +high (backfill jobs, quota budget, second storage path) |
| Alert volume | baseline (~5/day) | −20–30% if filtering; 0% if annotating | −30–50% | −30–50% |
| Expected CLV impact | measuring | **+0.5–1.5%** (drop unconfirmed outliers) | +1–2% (if exchange moves are informative) | +1–3% (best case) |
| Expected ROI impact | baseline | **+0.5–1.5%** | +0.5–2%, wider error bars | +1–3% *only if base edge exists*; minus quota cost |
| Overfitting risk | none | **Low** — one parameter, mechanistic rationale | Medium — more parameters, zero validation data yet | **High** — tuned on history, evaluated on history, deployed on a 3-day live regime |
| Score (ROI per unit effort+risk) | 5/10 | **8/10** | 6/10 | 4/10 |

Model B dominates: most of D's mechanism at ~10% of its cost, zero quota spend, and overfitting bounded by having essentially one parameter. Model C's confirmation idea is sound but should wait until exchanges are removed as *candidates* (their current dual role as candidate-and-signal is incoherent). Model D is the classic complexity trap: its unique contribution (minutes-scale steam) needs *faster live polling* anyway — the historical endpoint cannot deliver live steam signals, only research about past steam.

---

## Part 5 — Minimal ROI Improvement

**The single highest-ROI historical signal, and the simplest: Pinnacle movement over the trailing ~6 hours, computed from existing snapshots, attached to every opportunity at detection time.**

Mechanism: for each detected opportunity, look back through the match's prior Pinnacle batches (already in `OddsSnapshot`, ~6 batches at hourly cadence) and record the change in de-vigged fair probability for the alerted outcome. Two classes emerge:

- **LAG** (Pinnacle's probability for the outcome rose ≥~1.5–2% recently; the candidate book hasn't shortened yet) → the textbook +EV bet: confirmed sharp information the soft book hasn't priced.
- **OUTLIER** (Pinnacle flat; one soft book alone is generous) → disproportionately ghost/stale/error prices — the attainability trap.

**Recommendation: annotate first, filter later.** Store the trailing movement (e.g. `pinnacleMove6hPct`) on each opportunity rather than suppressing anything. After ~4–6 weeks, CLV-by-class answers empirically whether OUTLIER alerts are worthless — then filtering is a one-line change justified by data instead of theory. Cost: ~1 day of work, zero quota, zero alert-volume risk, no overfitting surface. This single feature captures the majority of what "steam detection" would buy, at hourly resolution, free.

(Why not "Pinnacle moved >2% in 6 h" as a hard filter immediately? Because with zero settled new-model bets, every filter deletes evidence the experiment needs. Annotation buys the same future ROI and keeps the sample.)

---

## Part 6 — Existing Data Feasibility

Audited directly against the live store (`scripts/snapshot-cadence-audit.ts`):

| Capability | Feasible from `OddsSnapshot` today? | How |
|---|---|---|
| **Line movement tracking** | **Yes** | Order batches by `capturedAt` per (match, bookmaker, outcome); 67/72 traditional matches have ≥10 Pinnacle batches; index `[matchId, capturedAt]` already exists |
| **Odds velocity** | **Yes, hourly-grade** | Δ(de-vigged prob)/Δt across consecutive batches; p50 gap 60 min — sufficient for drift, blind to minutes-scale bursts |
| **Steam detection (minutes)** | **No** | p50 inter-batch gap is 60 min; true steam completes between polls. Fix is faster *live* polling (near-kickoff booster), not historical data |
| **Bookmaker divergence** | **Yes** | Every batch is a full ~40–50-book cross-section; divergence vs de-vigged Pinnacle is exactly what the detector already computes — persisting the distribution is trivial |

**Share of the Historical Odds API's decision-relevant value already obtainable free: ~60–70%.** The free portion is the part that changes live bet selection (movement context, divergence, LAG/OUTLIER classification). The paid remainder is research depth (multi-year backtests) and intra-hour resolution — second-order for ROI, first-order only for research speed.

---

## Part 7 — Timing

**Not now.** Recommended order of operations:

1. **Exchange exclusion** (P0 from `ROI_MAXIMIZATION_AUDIT.md`, not yet implemented) — removes the dominant fake-candidate class polluting both alerts and any future movement analysis.
2. **Deploy and keep running** — threshold 3% + shadow tier are live in code (today's `THRESHOLD-TUNING-IMPLEMENTATION.md`); zero CLV rows exist until settlements run.
3. **Movement annotation from own data** (Part 5) — ~1 day, free, starts accumulating LAG/OUTLIER evidence on every bet from day one.
4. **Scheduler optimization** — near-kickoff booster (also fixes the stale-close problem at 1× cost), season-gating, H4 discovery fix (frees the quota a backtest would need).
5. **Collect 150–200 production bets with CLV** (~6–8 weeks at projected volume).
6. **Then decide on historical odds** via the trigger below.

**Trigger for buying the historical backtest:** after step 4, *if* interim live CLV (≥4 weeks of data) is ambiguous — average between roughly −0.5% and +1.5%, or sharply inconsistent across leagues — a targeted ~50–80k-credit backtest (3 timestamps/match-day, the 3–4 leagues generating alerts, 6 months) is then the cheapest way to break the tie. If live CLV is clearly positive or clearly negative, the backtest answers a question that is no longer open and should be skipped.

---

## Part 8 — ROI Roadmap (ranked purely by expected ROI impact)

| Pri | Item | Status | Expected ROI contribution |
|---|---|---|---|
| P0 | Threshold tuning (3% + 2% shadow) | **✅ Done** (`THRESHOLD-TUNING-IMPLEMENTATION.md`) | 3× evidence velocity |
| P0 | Exchange exclusion | Open | Removes largest fake-edge class; immediate signal-quality gain |
| P0 | Deploy + uptime (incl. C1/C2 hygiene protecting the sample) | Open | Without it, everything else is 0 |
| P1 | **Movement annotation from existing snapshots** (Part 5) | Open | The cheapest path to the LAG/OUTLIER split — most of "steam detection" for free |
| P1 | Scheduler optimization (near-kickoff booster, season gating, H4 quota fix) | Open | Better edges + true closes + funds future options |
| P1 | Bookmaker expansion (`au`, `us2`) | Open | +candidate volume at +2 credits/call |
| P2 | **Historical Odds backtest — targeted, trigger-gated** (Part 7) | Open | One-time calibration acceleration; ~50–80k credits |
| P2 | Movement-based *filtering* (promote annotation to suppression, data-justified) | Open | +0.5–2%/bet if OUTLIER class proves bad |
| P3 | Full steam detection (5-min live polling infra) | Open | Only viable post-CLV-gate, with quota economics rebuilt |
| P3 | Full-resolution historical backfill / multi-year research store | Open | Research luxury; no live-ROI path at current scale |

---

## Part 9 — Final Verdict

**D — build movement analysis from existing `OddsSnapshot` data first** (with B as the standing posture toward the API: delay behind the Part 7 trigger, don't skip permanently). **Confidence: 80%.**

Why: the Historical Odds API's unique asset is the past at 5-minute resolution, at 10× credit cost, behind 3–5 days of segregated-storage engineering. But the decision-relevant majority of its value — does Pinnacle movement context separate real value from ghost quotes? — is computable today, free, from the hourly snapshot store the system already fills at 45k rows/day, on matches the system is actually betting. Meanwhile the live experiment (3% threshold, shadow tier, CLV) is already running and produces ground truth that no backtest can: CLV on *this* system's actual alerts. Spending quota and engineering on historical research before exchange exclusion, deployment uptime, and movement annotation would buy a more precise answer to the wrong question first.

The 20% residual: if engineering time were free and quota were not contended, the targeted backtest's "compress 8 weeks into 1" argument is genuinely strong — which is exactly why it survives as a trigger-gated P2 rather than a C (skip entirely). If live CLV comes back ambiguous in July, buy it without hesitation.

---

*Audit only — no production code modified. New read-only instrument: `scripts/snapshot-cadence-audit.ts`.*
