# ROI Maximization Audit

**Date:** 2026-06-10
**Objective:** ROI maximization as the only objective. Conventional wisdom, elegance, and CLV-as-religion are weighted only insofar as they improve expected long-run profit and bankroll growth.
**Method:** Source-code inspection, all prior audits as context (source code as authority), and read-only queries against the live database. Every number below is reproducible via `scripts/roi-maximization-audit.ts` and `scripts/bookmaker-coverage-audit.ts`.

**Evidence base and its limits, stated up front:** the snapshot store contains **~3 dense days** (June 8–10; 131k snapshots, 125 matches). All "volume per day" figures are extrapolations from ~2.5 effective days. The settled-bet sample is 50 rows ≈ 32 logical bets, all from the *old* model. Zero new-model opportunities have been persisted yet, and the CLV columns are still empty (0/50) because no settlement has run since the CLV code landed. Anyone selling you confident ROI numbers from this dataset is lying; what follows is the most honest read the data permits.

---

## Part 1 — Current Model Assessment

The production model as it exists today: Pinnacle de-vigged into fair probabilities (overround bounds [0.99, 1.15]); every non-Pinnacle book evaluated per outcome; market-structure guard (outcome-count match); edge threshold **5%**, edge cap 100%, odds cap **3.0**; permanent dedup per (match, bookmaker, outcome); 63 configured sports on 60-min/3-h/4-h tiers; detection runs after each ingestion batch.

### 1.1 Is there evidence this model should outperform the previous model?

**Yes — three pieces, one strong, two structural:**

1. **The CLV dry run is direct empirical evidence against the old model.** The old model's 45 measurable historical bets averaged **−2.57% CLV with only 24.4% beating the close**. It systematically bought prices worse than the market's final estimate. The new model, *by construction*, only fires when a candidate price is ≥5% above de-vigged Pinnacle **at capture time** — every alert starts with positive line value against the current sharp line. The old model started negative; the new one starts positive. That is the entire game.
2. **Direction of information flow.** Pinnacle's de-vigged price is the best publicly available probability estimator (decades of academic and industry evidence). Betting soft books above it is the standard, repeatedly validated +EV pattern. The old model bet the sharp book against a vig-inflated soft average — the documented anti-pattern.
3. **The phantom-edge classes are gone.** Market-structure guard killed the 3-way-vs-2-way NHL comparison that produced 22%-median fake edges; overround bounds and the reference-conflict check kill the duplicated-row corruption documented in `CONSENSUS-DUPLICATION-EVIDENCE-AUDIT.md`.

### 1.2 Is there evidence it could underperform the previous model?

**On real long-run ROI: no.** Nothing in the data suggests the old model had genuine positive expectancy — its +18% logical-bet paper ROI (n=23, well inside the ±25% noise band computed in `FINAL_V1_AUDIT.md` §7) coexisted with −2.6% CLV, which is exactly what a lucky negative-EV strategy looks like.

**On observed paper ROI over the next months: yes, easily — and this must be understood.** The new model produces **~3 raw alerts/day at the 5% threshold** (8 logical bets in 2.5 days), and after removing exchange back prices and the OddsPapi esports micro-market, more like **~1/day**. The old model produced more rows. A 30-bet sample of the new model can absolutely show −20% while the old model's lucky streak showed +18%. If you judge the migration by the paper ROI column before ~200 settled bets, you will be reading dice rolls.

### 1.3 What assumptions are still unproven?

1. **Alert-time edge survives to close.** The +5% vs Pinnacle-now may decay: if soft outliers mostly reflect Pinnacle having just moved (steam), Pinnacle may keep moving and the closing fair odds will sit *above* the alert price. CLV will measure exactly this. Untested.
2. **The outlier prices are real.** A 5%+ deviation at one soft book is, with meaningful frequency, a stale/ghost/error price that a real bettor couldn't get down on (or would get voided as a palp). Paper settlement at recorded odds assumes 100% bettability. Untested and untestable from inside this system.
3. **Pinnacle is a valid reference in the niche leagues that generate the alerts.** Superettan and Brazil Série B closes at Pinnacle carry small limits; the "fair" probability there is weaker than in NBA/MLB. The model is least trustworthy exactly where it finds the most edges.
4. **The 5% threshold sits above the noise floor** — Pinnacle fair-prob estimation error plus polling staleness (60-min/3-h gaps) is plausibly 1–2%; whether 3% or 5% is the right cut is unknown.

### 1.4 What data would prove superiority?

- **100–200 settled new-model bets with CLV populated** → average CLV with a confidence interval. CLV > +1% with positive rate > 50% proves the alerts beat the market; that is sufficient to claim superiority over a model that measured −2.6%.
- **Per-edge-bucket CLV** (3–4%, 4–5%, ≥5%) → proves where the noise floor actually is (feeds Part 3).
- **Per-bookmaker CLV** → separates real soft-book lag from stale-quote artifacts.
- Settled ROI itself will not be probative for years at this volume (≈8,000 bets needed at these odds for a +3% edge at 95% confidence); it is the trailing indicator, not the test.

---

## Part 2 — CLV vs ROI

The concern is legitimate and deserves a straight answer: the previous model had acceptable *observed* ROI and negative CLV; the new model promises better CLV on fewer bets.

### 2.1 When can higher CLV produce lower ROI?

1. **Unbettable CLV.** Stale or error quotes have spectacular CLV and zero real-world ROI — you couldn't have placed the bet, or it gets voided/limited. A system that selects the most extreme soft-book outliers is *adversely selected toward exactly these.* This is the single biggest gap between this repo's paper ROI and reality.
2. **Wrong reference.** CLV vs de-vigged Pinnacle assumes proportional de-vigging recovers truth. Proportional de-vig slightly overstates longshot probabilities (favorite–longshot bias); a strategy concentrated on the longer side of markets can show positive measured CLV with ~0 true EV. The odds-3.0 cap mitigates but does not eliminate this.
3. **Weak closes.** In low-limit leagues, the Pinnacle "close" is not an efficient-market estimate; beating it proves less.
4. **Variance, trivially.** Over any sample this project will accumulate in a year, a +2% CLV strategy can lose money. CLV converging faster than ROI is precisely *why* the two can disagree for a long time.

### 2.2 When can lower CLV produce higher ROI?

1. **Luck.** That is the answer for this repository: +18% ROI on 23 logical bets with −2.6% CLV is a coin-flip streak, nothing more. The same metric printed −53% one reporting era earlier — it has already demonstrated it carries no information at this n.
2. **Genuinely, structurally:** only via channels CLV doesn't price — promo/boost capture, settlement-rule arbitrage, or true model edge over the closing line itself (you know something the close doesn't). None of these exist in this system. There is no mechanism in this repo by which the old model's negative CLV could coexist with positive long-run ROI.

### 2.3 How much confidence should CLV get in THIS repository?

**Medium-high as a gate, with three repo-specific discounts:**

- The stored "close" is the last polled snapshot, up to 1–4 *hours* pre-kickoff (polling tiers), not the true close. This adds noise both ways and systematically misses final-hour steam — the period with the most information. Confidence in any single bet's CLV: low. In a 150-bet average: decent.
- Niche-league closes are weak references (above).
- The early CLV sample will be contaminated by 18 still-pending **old-model** bets that settle after the baseline (documented in `CLV-TRACKING-IMPLEMENTATION.md`); their expected negative CLV will drag the first weeks' average.

### 2.4 Is CLV being overweighted?

**As a measurement: no — at ~1–9 bets/day it is the only instrument that converges before the heat death of the project's motivation.** ROI at this volume needs 8,000 bets ≈ multiple years. CLV needs ~2–4 months. There is no third option.

**As a target: it is at risk of being overweighted, in one specific way.** Positive average CLV is **necessary but not sufficient** for real ROI: it proves alerts beat the market *on paper prices*. It does not prove the prices were attainable (stale-quote problem), and the strategy's selection process actively hunts the least-attainable prices. The prior audits' V1.5 gate ("avg CLV > +1% over 100–200 bets → strategy has edge") should be amended: **the gate should require positive CLV *excluding* the top-decile outliers and *per bookmaker class*** — a +1% average driven by three +30% ghost quotes is a fail, not a pass. That is the honest correction to the previous audit conclusions.

---

## Part 3 — ROI Optimization: Edge Threshold

Simulation over the full snapshot window (latest-batch evaluation, exact production rules: H2H pre-match, overround bounds, structure guard, odds ≤ 3.0):

**Edge distribution per evaluation (latest batch only):** <0%: 4,804 · 0–1%: 97 · 1–2%: 31 · 2–3%: 4 · 3–4%: 3 · 4–5%: 0 · ≥5%: 3. The market is overwhelmingly efficient against this model — 97% of candidate prices sit *below* Pinnacle fair (the soft books' margin), as theory predicts.

**Cumulative logical bets, permanent-dedup semantics (any batch crossed, ~2.5 effective days):**

| Threshold | Logical bets (window) | ≈/day raw | ≈/day clean¹ | Expected character |
|---|---|---|---|---|
| A) 5% | 8 | ~3 | ~1 | High nominal edge; heavily contaminated by exchange back prices, the OddsPapi dota-2 micro-market, and stale-quote suspects. Validation sample (150 bets) takes ~5 months. |
| B) 4% | 15 | ~6 | ~2–3 | Same contamination classes, slightly diluted. |
| C) 3% | 23 | ~9 | ~4–5 | Above the plausible noise floor (Pinnacle estimation error + polling staleness ≈ 1–2%). Validation sample in ~6–8 weeks. |
| D) 2% | 84 | ~33 | ~20+ | At/below the noise floor. Most "edges" are soft-book update latency on prices a real bettor couldn't beat the move on. Alert channel becomes noise. |

¹ excluding exchanges (`betfair_ex_*`, `smarkets`, `matchbook` — pre-commission back prices; 5 of the 8 ≥2% candidates in the latest-batch view) and OddsPapi esports keys.

**Expected ROI impact, honestly framed:** if edges are real, total EV/day is *maximized at 2%* (33 × ~2.5% ≈ 0.8u/day vs 3 × ~6.5% ≈ 0.2u/day at 5%) — volume beats per-bet edge. But the probability that a 2% measured edge is real, given polling staleness and reference noise, is materially lower than at 3–5%, and this is a *paper* system whose actual product is **information**, not units.

**Recommendation: alert at 3%; shadow-record from 2% (insert with a flag, no Discord alert); exclude exchanges from candidacy.**
- 3% roughly triples validated alert volume vs 5%, pulling the CLV verdict from ~5 months to ~6–8 weeks — the single highest-ROI change available, because the project's binding constraint is *time to knowing whether the edge is real*.
- The 2% shadow tier costs nothing, doesn't spam the channel, and in 60 days yields per-bucket CLV that answers the threshold question *empirically* instead of by my estimate. Re-tune then.
- Confidence in 3% as the final optimum: low-moderate. Confidence in "3% + shadow tier beats staying at 5%": high.

---

## Part 4 — Scheduler Optimization

Current configuration (`app.ts:63`, 63 sports): 25 keys at 60 min (NHL, MLB, WNBA, EuroLeague, MLS + **20 tennis tournament keys**), 4 at 4 h (NBA, EPL, UCL, NCAAF), 34 niche-soccer keys at 3 h. Settlement every 4 h; daily summary 23:00 Budapest. Plus the 4 **stale esports crons still firing in Redis** (C1, still unfixed, still producing snapshots as of June 10).

### 4.1 Under-polled

- **Everything in its final 2 hours before kickoff.** This is the only window that matters twice over: (a) soft-book lag vs late Pinnacle moves is the model's best hunting ground, and (b) the CLV "close" is currently up to 1–4 h stale, degrading the project's primary instrument. No near-kickoff densification exists.
- **Active niche soccer at 3 h** — Superettan/Brazil Série B/Segunda produced essentially all real traditional edge candidates (soccer: 6 of 8 non-esports ≥2% in latest batch) yet get the slowest tier.

### 4.2 Over-polled

- **20 tennis keys at 60 min with zero matches in the entire window** — between French Open (ended June 7) and Wimbledon, every configured slam/Masters key is idle. ~480 polls/day for nothing.
- **NCAAF at 4 h in June** — season starts late August. Pure waste.
- **MLB at 60 min: 3,362 evaluations, zero edges ≥2%.** The most efficiently priced market in the dataset. From a pure ROI lens this is the most expensive nothing in the system (45 of 125 matches, ~60% of all snapshots).
- **Esports crons** — not even configured; firing anyway (C1).

### 4.3–4.5 Recommended schedules

**Max-ROI configuration (recommended):**

| Group | Keys | Interval |
|---|---|---|
| Active niche soccer (matches in next 48 h) | ~34 soccer keys | 60 min |
| WNBA, NBA (finals), NHL (finals), MLS, EuroLeague | 5 | 60 min |
| MLB | 1 | 3 h (demote — zero detected edge, keep for CLV breadth) |
| Tennis keys | 20 | **Season-gated**: 0 polls when key inactive; 60 min during tournaments (Wimbledon from ~June 29) |
| NCAAF | 1 | Disabled until August |
| Esports | — | Remove stale Redis repeatables (P0) |
| **Near-kickoff booster (new)** | any match starting ≤ 2 h | every 15–30 min |

The near-kickoff booster is the only structurally new piece and the highest-value one: it sharpens both detection (late soft lag) and the CLV reference (true close). Quota headroom for it comes free from the H4 fix (use the free `/events` endpoint for discovery instead of 9-credit odds calls — prior audit P1 #9) plus the tennis/NCAAF/MLB cuts: roughly −60% spend, redeployed where the edges live.

**Max-opportunity configuration** (if volume were the goal): everything at 30 min + `au`,`us2` regions + 2% threshold → est. 50–100 alerts/day, mostly noise; quota cost ~3–4×. Not recommended.

**Best tradeoff:** the max-ROI table above with the 3% threshold — it maximizes *validated* opportunities per credit, which is the quantity that actually compounds into ROI knowledge.

---

## Part 5 — Sport ROI Ranking

Settled history is old-model and tiny (soccer +14.63u/27, baseball −4.90u/11, dota-2 +5.0u/2 — none of it predictive). Ranking below is by **new-model edge candidate density** and market structure, which is the only forward-looking evidence available:

| Rank | Sport | Evidence | Verdict |
|---|---|---|---|
| 1 | **Niche soccer** (Superettan, Brazil B, Segunda, + the 31 sibling leagues) | 6 of 8 clean ≥2% candidates from only 17 matches; 38–40 books each; soft books demonstrably lag | **Promote to 60 min when matches upcoming** |
| 2 | **WNBA** | 2 ≥2% from 451 evals; in-season volume; US books uneven on women's sports | Keep 60 min |
| 3 | **NBA / NHL** (finals) | Few matches, tight pricing, season ends this month | Keep, low priority |
| 4 | **Top soccer (EPL/UCL)** | Off-season; revisit August | Idle until season |
| 5 | **Tennis** | Zero data — keys idle between tournaments; tennis is *theoretically* attractive (retirement-rule discrepancies, fast-moving lines) | Season-gate; evaluate at Wimbledon |
| 6 | **MLB** | 3,362 evals, **zero** edges ≥2% — the single most efficient market in the dataset | **Demote to 3 h**; remove if quota-pressed |
| — | **Esports** | 3-book OddsPapi micro-market, fixture-collision bug, supposed to be disabled, still leaking rows | **Remove** (execute C1 fix) |
| — | **NCAAF** | Off-season until late August | Disable until then |

---

## Part 6 — Bookmaker Optimization

Full detail in `BOOKMAKER-COVERAGE-AUDIT.md`; the ROI-relevant summary:

1. **Current coverage:** 53 keys stored; ~50 candidates per traditional match; Pinnacle present on 77% of matches. Coverage breadth is already good — breadth is not the constraint.
2. **Missing:** `au` region (Sportsbet, TAB, Neds, PointsBet AU…), `us2` (ESPN Bet, Hard Rock, Bally), `us_ex` (Novig, ProphetX). No Asian books or Bet365-traditional on this provider at all.
3. **Most likely to increase ROI:** *subtraction*, not addition — **exclude exchanges from candidacy** (`betfair_ex_uk/eu`, `smarkets`, `matchbook`): their pre-commission back prices created 5 of 8 ≥2% candidates and most would evaporate after 2–5% commission. This is fake volume polluting the signal today.
4. **Most likely to increase alert volume:** add `au` + `us2` regions (+2 credits/call, +67% snapshot cost, covered several times over by the H4 discovery fix). AU retail books on overnight European soccer are the classic soft-lag profile this model hunts.
5. **Priority:** (1) exchange exclusion — immediate, free, quality; (2) `au`+`us2` — cheap, volume; (3) per-bookmaker CLV in `/clv` — identifies the genuinely soft books within weeks and lets coverage *narrow* to where ROI lives; (4) Asian-odds provider — only after the CLV gate passes.

---

## Part 7 — Strategy Alternatives

**Keep the Pinnacle-led model. Do not revert. Do not build a third model yet. Add one hybrid element.**

- **Revert?** No. The old model is the documented anti-pattern; its −2.6% CLV is the closest thing to ground truth this project has produced. Its +18% paper ROI on 23 bets is noise, and reverting to chase it would be the single most expensive decision available.
- **Run both in parallel?** The old model's code is gone; resurrecting it to A/B against a known-negative-CLV strategy buys information of near-zero value at real engineering cost. The 18 pending old-model bets will deliver a free final CLV reading anyway. No.
- **Entirely different model?** Everything genuinely different (originating probabilities from data, betting-exchange market making, Asian-line arbitrage) is an order of magnitude harder and unjustified before this model's cheap validation completes.
- **Hybrid element worth adding (cheap, ROI-positive): a second-book corroboration filter as a stale-quote guard.** Require that at least one *other* non-exchange candidate book's price be within ~2% of the alerting book's price, or that the alerting book's snapshot batch be the freshest for the match. Pure outliers no other book echoes are disproportionately ghosts/palps. This sacrifices a little volume for a large attainability improvement — and attainability is the gap between paper ROI and real ROI (Part 2.4).

---

## Part 8 — Top 20 ROI Improvements

| # | Pri | Improvement | Expected ROI impact | Difficulty | Risk |
|---|---|---|---|---|---|
| 1 | P0 | **Deploy and keep running the current build** — CLV/new-model code earns nothing while not running; 0/50 CLV rows populated | Enables all measurement | Trivial | None |
| 2 | P0 | Remove 4 stale esports repeatables from Redis + startup reconciliation (C1) | Stops data pollution + quota burn | Low | None |
| 3 | P0 | Lower alert threshold to 3% + shadow-record ≥2% | 3× validated volume → CLV verdict in weeks not months | Low | Alert noise (modest) |
| 4 | P0 | Exclude exchanges from candidacy (or commission-adjust) | Removes ~60% of current fake candidates | Low | None |
| 5 | P0 | Fix silent-LOSS settlement default (C2): leave unresolvable unsettled + warn; backfix Lyon Gaming row | ROI numbers become true | Low | None |
| 6 | P0 | Rotate leaked OddsPapi key, purge history (C4) | Protects quota = uptime | Low | None |
| 7 | P1 | Near-kickoff booster: poll matches starting ≤2 h every 15–30 min | Better edges + true closes — sharpens both product and instrument | Medium | Quota (covered by #8) |
| 8 | P1 | H4 quota fix: free `/events` for discovery, drop spreads/totals | ~60% cost cut funds #7/#9 | Low–Med | Low |
| 9 | P1 | Add `au` + `us2` regions | More soft candidates, esp. overnight soccer | Trivial | +2 credits/call |
| 10 | P1 | Per-bookmaker + per-edge-bucket CLV breakdown in `/clv` | Turns CLV from a number into a tuning instrument | Low | None |
| 11 | P1 | Season-gate tennis keys; disable NCAAF until August; demote MLB to 3 h | −~50% wasted polls, zero edge loss | Low | None |
| 12 | P1 | Second-book corroboration / freshness guard (Part 7) | Closes the paper-vs-real attainability gap | Medium | Some volume loss |
| 13 | P1 | Promote active niche soccer to 60 min | Faster capture where edges actually are | Low | Quota (small) |
| 14 | P2 | Tests on money math (edge calc, de-vig, calcProfitLoss, determineBetOutcome, CLV) | Protects every number above | Medium | None |
| 15 | P2 | Ops alerting (failed jobs, quota >80%, unsettled >48 h, zero alerts in 24 h) | Uptime = sample accumulation | Medium | None |
| 16 | P2 | Wire retries (resilient client or BullMQ attempts/backoff) | Fewer lost polls | Low–Med | None |
| 17 | P2 | Settlement lookback >3 days + CANCELLED/POSTPONED voiding (H2) | No zombie pendings corrupting ROI | Medium | None |
| 18 | P2 | Apply TRADITIONAL + baseline filters to `/value-bets`, `/test-value-bets`; single ROI formula (M2) | One truth across surfaces | Low | None |
| 19 | P3 | Totals/spreads markets through the same Pinnacle-led engine | 2–3× opportunity surface | High | Settlement complexity |
| 20 | P3 | Record fractional-Kelly stake suggestion per alert (paper) | Bankroll-growth realism; prepares real staking | Low | None |

---

## Part 9 — Final Recommendation

**Option 2 — tune the current model.** Specifically: items #1–6 this week, #7–13 over the following two weeks, then *stop building and let it run* until 150–200 new-model bets have settled with CLV.

Why not the alternatives: keeping it unchanged (option 1) leaves a 5% threshold that needs ~5 months to produce a verdict and a candidate pool diluted by exchange ghosts; reverting (option 3) returns to a measured −2.6%-CLV strategy on the strength of 23 lucky bets; parallel models (option 4) and a third model (option 5) spend engineering on questions the CLV instrument will answer for free.

The one-sentence thesis: **this project's ROI is currently maximized by minimizing the time to a trustworthy CLV verdict** — every recommendation above either accelerates that verdict, cleans its inputs, or protects the system that produces it.

**Confidence: 70%.** The 30% covers: CLV verdict comes back ≈0 (model finds only noise/stale quotes — a real possibility given the thin ≥3% volume), and the niche-league reference-quality concern.

---

## Part 10 — Repository Rating (current state, today)

| Dimension | Score | Why |
|---|---|---|
| Architecture | **6/10** | Sound modular monolith, clean DI, queue separation. Unchanged deductions: dead subsystems (User/Bankroll/Prediction schema, AI queue, ~700 LOC resilience layer never wired), double-fetch ingestion, scheduler state not declarative (C1 is the proof). |
| Code Quality | **5/10** | Consistent, strictly typed, readable; the detection rewrite is the cleanest module in the repo. Still zero tests, ~1,000 LOC dead code, copy-pasted `toNumber` helpers, three coexisting ROI formulas. |
| Maintainability | **5/10** | Excellent audit-trail documentation (80+ docs) and clear module boundaries; but no tests means every change is a leap of faith, and the docs/ folder increasingly substitutes for executable verification. |
| Reliability | **4/10** | Graceful lifecycle, health endpoint; but no retries in the production path, ghost cron jobs in Redis, silent-LOSS settlement default, 3-day settlement window, runs on a PC. |
| Data Quality | **5/10** | Forward-looking: genuinely good — append-only snapshots, permanent dedup, structure guard, overround bounds, conflict detection. Held back by: historical rows still polluted (proven mis-settlement uncorrected), esports leakage ongoing, "close" up to hours stale. Was 3/10; the migration earned the improvement. |
| Value Detection Model | **7/10** | The standard sharp-reference model, correctly de-vigged, with real guards — this is now a defensible design. Missing for higher: stale-quote/attainability handling, exchange treatment, per-book calibration, near-close capture. Was 2/10. |
| ROI Potential | **4/10** | Direction is right and measurement exists — but observed clean volume at 5% is ~1 bet/day, the edges concentrate in the leagues where the reference is weakest, and the paper-vs-real gap is unaddressed. Honest range: real edge possible, not yet probable. |
| Production Readiness | **3/10** | Unchanged: no deployment story, no monitoring consumer, no backups documented, leaked API key still in git history, admin-only Discord as the only interface. |
| Scalability | **5/10** | Postgres/BullMQ/append-only design scales far beyond current needs; quota economics (H4 unfixed) is the actual ceiling, and it's an efficiency bug, not an architecture limit. |
| **Overall** | **4.5/10** | Up from 3.5: the model inversion — the single worst defect — is fixed, and the instrument to prove it (CLV) is built. The remaining gap to 6+ is operational truth: C1/C2/C4 fixes, tests on money paths, and a deployment that actually runs. |

---

## Part 11 — Investor Verdict

- **Invest time?** Yes, modestly — the next ~3 weeks of P0/P1 work, then mostly waiting. The expensive intellectual problem (model direction) is solved; what remains is cheap hygiene plus patience.
- **Invest money?** No, beyond API quota (~tens of $/month, and the H4 fix cuts that). Zero spend on infrastructure, marketing, or features until the CLV gate reads.
- **Continue development?** Yes — but development now means *finishing the experiment*, not adding capability. The repo's entire enterprise value today is one unanswered question: "does avg CLV exceed +1% over 150 clean bets?" Everything that doesn't shorten the path to that answer is spending.
- **Pause?** Only after items #1–13; pausing now would freeze a system whose measurement instrument has never run in production (0/50 CLV rows).
- **Pivot?** Premature. The pivot decision tree is: CLV ≳ +1.5% → invest in execution realism (availability, AU books, maybe real micro-stakes); CLV ≈ 0–1% → pivot to selling the *data/tooling* or to exchange-based strategies; CLV < 0 → see below.
- **Abandon?** Not yet — abandoning two months before a cheap, decisive experiment concludes is the only move strictly worse than over-investing. If the clean-sample CLV verdict is ≤0, abandon the *strategy* without sentimentality (the snapshot dataset and pipeline retain residual value).

---

## Part 12 — Brutally Honest Conclusion

**1. Is the project better today than before the Pinnacle-led migration?**
Yes, unambiguously. Before: a structurally inverted model with provably negative CLV, duplicate-counted ROI, and no instrument capable of detecting any of that. After: the textbook-correct model, permanent dedup, and a working CLV instrument whose very first reading (−2.57% on the old model's bets) demonstrated both that the instrument works and that the migration was necessary. This is the difference between a system that couldn't know it was wrong and one that can.

**2. Is the current strategy more likely to be profitable than the previous one?**
Yes. The previous strategy bought prices the market's final estimate said were ~2.6% bad; the current one only fires on prices ≥5% better than the sharp line's current estimate. On any honest prior, P(profit | new) > P(profit | old). But "more likely than the old one" is a floor-height compliment — the absolute probability remains modest (see Q4), and the new strategy's *observed paper ROI* over small samples may well look worse than the old model's lucky +18%. Expect that; don't act on it.

**3. Next 30-day plan if I owned this repository:**
- **Week 1:** Deploy. Fix C1 (Redis repeatables + reconciliation), C2 (no silent LOSS, backfix Lyon Gaming), C4 (rotate key). Threshold to 3% + 2% shadow tier. Exchange exclusion. *Nothing else.*
- **Week 2:** H4 quota fix (free `/events` discovery); season-gate tennis/NCAAF; demote MLB; promote active niche soccer; add `au`+`us2`; per-bookmaker + per-bucket CLV in `/clv`.
- **Week 3:** Near-kickoff booster (15–30 min final-2 h polling — also fixes the stale-close problem). Corroboration/freshness guard. Tests on the five money-math functions. Ops alert on zero-alerts-24 h and unsettled-age.
- **Week 4 → day 60+:** Touch nothing. Let it accumulate. Read `/clv` weekly, segmented by edge bucket and bookmaker, ignoring the ROI column entirely. Decision at 150–200 clean settled bets per the Part 11 tree.

**4. Probability this becomes a genuinely profitable betting signal platform?**
**20%.** Decomposition: P(clean new-model CLV > +1% over 150+ bets) ≈ 40–50% — the model class is sound, but the thin ≥3% volume suggests these books mostly aren't asleep, and part of the measured edge will prove to be stale quotes and weak niche-league references. Then P(positive CLV translates into a *platform* someone can profit from | positive CLV) ≈ 40–50% — attainability, account limits on soft books, alert latency to a human bettor, and the step from "signal exists" to "product works" all attrite. 0.45 × 0.45 ≈ 0.20. The honest framing: 20% is a *good* number for a solo project at this stage — most never get a falsifiable experiment this cheap — but it is a minority outcome, and the system is now correctly built to find that out rather than to hide it.

**5. Score a strong senior engineer would most likely give it today?**
**4.5–5/10.** They would respect the documentation discipline, the typed config/error/lifecycle plumbing, and a detection module that now reads like someone who understands the domain. They would then ask "where are the tests?", find the answer is "nowhere, on a system whose entire output is numbers," notice the ghost cron jobs and the key in git history, and cap the score there. The same engineer would also likely say the most important sentence in this audit: *the code is no longer the problem — discipline about what not to build next is.*

---

*Audit only — no production code was modified. Query instruments retained at `scripts/bookmaker-coverage-audit.ts` and `scripts/roi-maximization-audit.ts` for re-runs as data accumulates.*
