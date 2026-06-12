# Alert Strategy Review

**Date:** 2026-06-11
**Trigger:** Production observation — multiple alerts for the same match and outcome (Helsingborgs IF vs Landskrona BoIS ×3 books; Dallas Wings vs Phoenix Mercury ×2 books). User experience: 5 alerts ≈ 2–3 betting ideas.
**Scope:** Critical review of the one-alert-per-bookmaker model vs idea-level alternatives, with live-data verification, plus Part X on whether Historical Odds backtesting can adjudicate alert strategy.
**Method:** Read-only queries against the live database (`scripts/alert-strategy-audit.ts`); no code modified.

---

## 0. The Observation, Verified

Every new-model row in the database as of this audit:

| Match | Outcome | Bookmaker | Edge | Odds | Tier | Alerted |
|---|---|---|---|---|---|---|
| Helsingborgs IF vs Landskrona BoIS | Landskrona BoIS | unibet_se | 3.63% | 2.88 | prod | ✅ |
| Helsingborgs IF vs Landskrona BoIS | Landskrona BoIS | leovegas_se | 3.63% | 2.88 | prod | ✅ |
| Helsingborgs IF vs Landskrona BoIS | Landskrona BoIS | coolbet | 4.62% | 2.95 | prod | ✅ |
| Dallas Wings vs Phoenix Mercury | Phoenix Mercury | williamhill_us | 2.34% | 3.15 | shadow | — |
| Dallas Wings vs Phoenix Mercury | Phoenix Mercury | betfair_ex_eu | 2.11% | 3.30 | shadow | — |
| Dallas Wings vs Phoenix Mercury | Phoenix Mercury | betfair_ex_uk | 2.11% | 3.30 | shadow | — |
| Dallas Wings vs Phoenix Mercury | Phoenix Mercury | betfair_ex_uk | 3.51% | 3.40 | prod | ✅ |
| Dallas Wings vs Phoenix Mercury | Phoenix Mercury | betfair_ex_eu | 3.51% | 3.40 | prod | ✅ |

**8 rows. 5 Discord alerts. 2 unique betting ideas. Alert-to-idea ratio: 2.5 : 1.** The user's perception is exactly correct, and the very first hours of new-model production reproduced both pollution classes predicted in `BOOKMAKER-COVERAGE-AUDIT.md` and `ROI_MAXIMIZATION_AUDIT.md`:

- **betfair_ex_uk / betfair_ex_eu are the same exchange order book.** Identical prices in both batches (3.30/3.30, then 3.40/3.40) because they *are* one liquidity pool behind two regional labels. Two alerts for one price that, being an exchange back price, loses 2–5% commission and probably shouldn't be a candidate at all (open P0).
- **unibet_se and leovegas_se quoted identical 2.88** — both run on shared B2B sportsbook feeds (Kambi lineage). "Three bookmakers agree" here is closer to "one pricing engine plus Coolbet."

(One thing the data shows working *as designed*: the Wings idea progressed shadow (2.11%) → production (3.51%) across batches — the tier-aware dedup from `THRESHOLD-TUNING-IMPLEMENTATION.md` did its job. The problem is not the storage; it is what the alert layer does with it.)

---

## 1. The Four Approaches

**A. One alert per bookmaker row (current).**
**B. One alert per outcome** (idea-level, no book detail beyond implied).
**C. One alert per outcome, best bookmaker only.**
**D. One alert per outcome containing all qualifying bookmakers** (best price headlined, alternatives listed).

| Dimension | A (current) | B (per outcome) | C (best book only) | D (aggregated, all books) |
|---|---|---|---|---|
| Expected ROI impact | Worst measured ROI: every inferior price is logged as its own full bet; settled stats average in the worst books | Neutral — depends which price is recorded | Best *paper* per-bet ROI (max price) but max-order-statistic adverse selection: the best price across 50 books is the *most likely to be a ghost/stale quote* | = C's headline price for action, with alternatives as fallback — best real-world expected ROI |
| Expected CLV impact | Mixed sample; per-book CLV measurable (good) but headline CLV diluted by inferior prices | Single CLV per idea; loses per-book attribution | Highest measured CLV; same ghost-price inflation risk | Headline CLV = best book; per-book CLV preserved if storage stays per-row |
| Alert volume | 2.5× ideas (observed); grows with bookmaker count — adding `au`/`us2` regions would make it worse | = ideas | = ideas | = ideas |
| User experience | Poor — same idea repeated; user must mentally dedupe; trust erodes ("the bot spams") | Clean but thin — user doesn't know where to bet | Clean; user may not have an account at the named book | **Best** — one message, one decision, best price first, alternatives for whatever book the user can access |
| Information loss | None in DB; high in *channel* (signal buried in repetition) | High — book identities gone | Medium — alternatives invisible | **None** — everything in one message |
| Bookmaker diversity | Visible but as spam | Invisible | Hidden | Visible as a *feature*: the qualifying-book count is itself the corroboration signal (`HISTORICAL_ODDS_ROI_AUDIT.md` Part 5 logic — k independent books agreeing ≈ less likely a ghost) |
| Scalability | Inversely scalable: every coverage improvement (more regions, more books) *degrades* the channel | Scales | Scales | Scales — message grows by one line per extra book |

---

## 2. Investigation — Direct Answers

**1. Are betfair_ex_uk and betfair_ex_eu effectively duplicate opportunities?**
Not "effectively" — **literally**. Same exchange, same order book, two regional API labels. 100% of their co-appearances in the data carry identical prices. They are one opportunity double-counted, and as exchange back prices, arguably zero opportunities after commission.

**2. Are regional bookmaker variants inflating alert counts?**
Yes. The store carries four Unibet skins (`unibet_uk/se/nl/fr`), two LeoVegas, two Winamax, two Betfair-exchange labels, plus Ladbrokes/Coral (one group), Betsson/Nordicbet (one group), betonlineag/lowvig (one group). The observed Helsingborgs alert demonstrated it: unibet_se and leovegas_se at identical 2.88 are not independent confirmations, and had the other Unibet skins quoted this match they would all have alerted too. **Candidate "diversity" is overstated by a factor of roughly 1.5–2× by shared-engine families.**

**3. What percentage of current alerts are unique betting ideas?**
**40%** (2 ideas / 5 alerts) in the live sample. Small n, but the mechanism is structural, not statistical: it will persist and worsen with coverage expansion.

**4. What percentage are alternative bookmakers for the same idea?**
**60%** — and of those, two-thirds (betfair_ex pair, unibet_se/leovegas_se pair) are not even genuine alternatives but the same price relabeled.

**5. Is the system optimizing for database purity rather than user value?**
**Half-yes, and the half matters.** The *storage* design — one row per (match, bookmaker, outcome) with tier-aware permanent dedup — is correct and should not change: per-book CLV attribution (the instrument that will eventually identify which books are genuinely soft) requires exactly this granularity. The failure is that the alert layer was never designed at all: it is a 1:1 mirror of storage rows (`notifyPendingOpportunities` iterates rows → messages). Nobody decided "one alert per bookmaker"; it fell out of the schema. That is the brutal truth: **the alert UX is an accident of the data model**, and the user noticed within hours of the new model going live.

---

## 3. Direct Answer: A or B?

**B — one alert per betting idea — without hesitation, implemented as variant D (aggregated message), with storage unchanged.**

The defensible idea-level alert:

```
🎯 VALUE BET — Landskrona BoIS @ Helsingborgs IF
Best price: 2.95 (Coolbet) | edge +4.6% | fair 2.82
Also qualifying: Unibet 2.88, LeoVegas 2.88 (+3.6%)
Books agreeing: 3
```

Why B/D wins on every axis that matters:
- **User value:** a bettor acts on ideas, not on rows. One decision, best price first, fallbacks listed for whatever account they hold.
- **Profitability:** the headline price is the best available → the recorded paper bet is the strongest claim; the per-bet ROI sample stops being diluted by inferior duplicates of itself.
- **Statistics:** the current model quietly re-creates audit finding C3 *at the bookmaker level* — when the 5 production rows above settle, `/roi` will count 5 perfectly correlated outcomes as 5 independent bets. Effective sample size is inflated, variance understated, and the CLV-gate arithmetic ("150–200 bets") gets silently degraded: 200 rows might be 90 ideas. Idea-level alerting plus idea-level *accounting* fixes the metric before it has time to mislead anyone.
- **Bonus signal:** "k books qualifying" becomes a free corroboration feature (after family collapse, so the betfair pair counts as 1) — the cheap stale-quote guard `ROI_MAXIMIZATION_AUDIT.md` Part 7 asked for.

What must NOT change: per-row storage, tier-aware dedup, per-book CLV computation. Aggregation belongs in the alert/reporting layer only.

---

## 4. Ratings

**Current strategy (one alert per bookmaker row): 4 / 10.**
The underlying data pipeline is sound (correct rows, correct dedup, correct CLV per row) — that is worth the 4. The packaging loses the rest: 2.5× alert inflation observed on day one, literal same-order-book duplicates alerted twice, idea-level correlation silently inflating every settled-bet statistic, and a UX that erodes the only user's trust in the only product surface. It also anti-scales: every planned improvement (au/us2 regions, niche-league promotion) makes the spam worse.

**Best alternative (D: idea-level alerts, best non-exchange price headlined, family-collapsed corroboration count, per-row storage unchanged): 8 / 10.**
Expected impact: alert volume −60% at identical information content; headline paper ROI/CLV improved by construction (best price); settled statistics become idea-denominated and honest; corroboration count appears for free; scaling coverage now *improves* alerts (better best-price, higher k) instead of degrading them. The missing 2 points: it doesn't fix attainability (no alert format can), and the best-price headline slightly *increases* ghost-quote exposure unless paired with exchange exclusion and the movement/corroboration context — which is why those remain prerequisites, not afterthoughts.

---

## Part X — Historical Odds & Backtesting Validation

### Setup

Per `HISTORICAL_ODDS_ROI_AUDIT.md`: the Historical Odds API offers 5-minute multi-book snapshots back to 2020 at 10× credit cost (~30 credits per sport-timestamp); the client method exists unused; backfill must be segregated from live `OddsSnapshot`. The question here: can it adjudicate between alert strategies?

**Models under test:**
- **Model A** — current production: one alert per qualifying (match, bookmaker, outcome) row.
- **Model B** — one alert per outcome, best bookmaker only.
- **Model C** — one alert per outcome, best book headlined + all qualifying alternatives listed.

### What a backtest would estimate (and what it doesn't need to)

First, the structural point that bounds this whole exercise: **A, B, and C select the identical set of underlying betting ideas.** They differ in packaging and in *which price gets recorded as "the bet."* Therefore:

| Metric | Backtest needed? | Expected finding |
|---|---|---|
| Alert volume | No — arithmetic | A ≈ 2–2.5× B = C (B and C are identical in volume; observed live ratio 2.5×) |
| Unique betting ideas | No — identical across all three by construction | — |
| Expected paper ROI per bet | **No — mathematical identity** | C = B ≥ A always: the best price on an outcome weakly dominates every other price on it. A backtest can only quantify the gap (observed live: +2.4% better odds on Helsingborgs best-vs-worst; +7.9% on Wings but exchange-fake) |
| Expected CLV | Partially | Same identity at capture; the backtest's real contribution is measuring how much of the "best price" advantage **survives to the close** — i.e., quantifying max-order-statistic adverse selection (is the best price disproportionately a ghost?) |
| Signal-to-noise | No — definitional | A's channel SNR is B/C's divided by the inflation ratio |

### The five determinations

1. **Would aggregation improve profitability?** Modestly and mechanically, yes — recording the best price improves per-bet paper EV by the best-vs-mean price gap (~1–3% of odds on multi-book ideas). The larger profitability effect is indirect: honest idea-denominated statistics prevent a correlated-sample false positive/negative at the CLV gate, which is where the real money decision gets made.
2. **Would it only improve user experience?** No — UX is the visible benefit, but the statistical integrity fix (decorrelating the settled sample) is the more consequential one.
3. **Would the current bookmaker-level model produce materially better ROI?** No. It produces strictly worse measured per-bet ROI (inferior prices counted as full bets) and noisier aggregates. Its one genuine advantage — per-book attribution — lives in storage, which aggregation does not touch.
4. **Is the current model creating artificial alert inflation?** Yes — proven, 2.5:1 live, with two-thirds of the "alternatives" being relabeled identical prices.
5. **Can Historical Odds backtesting objectively determine which strategy is superior?** **Only partially — and for this specific question it is mostly unnecessary.** Volume, idea counts, and per-bet ROI ordering are arithmetic identities computable from live data already collected. What a backtest genuinely adds: (a) the ghost-price decay measurement (best-price capture edge vs close, at 5-min resolution, over hundreds of historical ideas), and (b) corroboration-count calibration (does CLV rise with family-collapsed k?). Those are research questions about *filters*, not about alert packaging.

### Recommended backtesting methodology (if/when the Part 7 trigger fires)

1. Backfill targeted snapshots (T−24h, T−6h, T−1h, close) for the 3–4 alert-generating leagues over ~6 months into a **segregated** `historical_odds_snapshots` table (~50–80k credits).
2. Replay the exact production detector (same de-vig, guards, 3%/2% thresholds) per timestamp; group detections into ideas by (event, outcome); collapse bookmaker families via a static family map (kindred/unibet*, betfair_ex_*, leovegas*, winamax_*, betsson/nordicbet, ladbrokes/coral, betonlineag/lowvig).
3. Score each idea three ways — every-book accounting (A), best-book (B/C), best-non-exchange-book (C′) — against the de-vigged 5-minute close.
4. Segment CLV by family-collapsed corroboration count k and by best-price-vs-second-price gap (the ghost-quote proxy).
5. Outputs: CLV decay curve per accounting mode; the k-threshold (if any) where CLV becomes reliably positive; the price-gap threshold above which "best price" is statistically a mirage.

### Direct answer: A / B / C / D?

**D — hybrid**, even if backtesting existed today: exclude exchanges as candidates (they are commission-distorted and produced the literal duplicate pair), collapse regional/family duplicates for corroboration counting, and emit **one alert per idea with the best genuine bookmaker headlined and all qualifying alternatives listed** (Model C′). Backtesting would refine the corroboration and ghost-price thresholds inside D; it would not change the choice of D, because A's deficiencies are arithmetic and observed, not hypotheses needing historical validation.

### Priority ranking (highest ROI first)

| Rank | Investment | Justification |
|---|---|---|
| 1 | **Exchange exclusion** | Free, immediate, removes proven duplicate-and-commission-distorted candidates that constituted 2 of 5 live alerts and 5 of 8 rows; prerequisite for every other measurement being clean |
| 2 | **Movement filtering** (annotation already live → promote to filter when CLV-by-class confirms) | Near-free, mechanistic rationale, directly attacks the ghost-price problem that caps the best-price strategy; data to justify it accrues automatically from yesterday's implementation |
| 3 | **Historical Odds backtesting** | Real but conditional value (trigger-gated per `HISTORICAL_ODDS_ROI_AUDIT.md` Part 7); ~50–80k credits + 3–5 days; answers filter-calibration questions, not the already-settled packaging question |
| 4 | **Kelly staking** | Pointless before a validated edge exists: Kelly sizes a *known* edge; sizing an unproven, noisy 3% paper edge optimizes the variance of a number that is currently all variance. Flat 1u is the correct measurement stake. Revisit only after the CLV gate passes |
| 5 | **ML ranking** | Last by a wide margin: ~90 idea-level samples exist; any model trained now memorizes noise. The features ML would want (movement, corroboration k, price gap, book family) are exactly what the simple transparent filters above use — build those first, and ML may never be needed |

(Idea-level alert aggregation itself — the subject of this review — would slot between ranks 1 and 2: it is a P0/P1 boundary item, cheaper than everything below rank 1 and the only item on the list the end user directly feels.)

---

*Audit only — no code modified. Verification instrument: `scripts/alert-strategy-audit.ts`.*
