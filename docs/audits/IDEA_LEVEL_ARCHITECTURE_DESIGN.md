# Idea-Level Alerting & Accounting — Architecture Design Audit

**Date:** 2026-06-11
**Authority:** `docs/audits/ALERT_STRATEGY_REVIEW.md` (verified: 8 rows → 5 alerts → 2 unique betting ideas; alert layer is a 1:1 mirror of storage rows; row-level accounting re-creates C3-style correlated pseudo-replication at the bookmaker level)
**Scope:** Design only — no code. Storage design is explicitly frozen: `ValueOpportunity` per-bookmaker rows, per-bookmaker CLV, tier-aware permanent dedup all stay exactly as they are.

---

## 1. Architecture Overview — Aggregation as a Derived Layer

**Principle: the idea is a *view*, not a *table*.** Everything idea-level is computed by grouping existing rows at read time. No new tables, no synchronization problem, no backfill, no second source of truth.

```
                    STORAGE (unchanged)
  ValueOpportunity: one row per (match, bookmaker, outcome)
  ├─ tier-aware permanent dedup        (as today)
  ├─ per-row CLV at settlement         (as today)
  └─ per-row movement annotation       (as today)
                         │
                         ▼  GROUP BY (matchId, outcome [, market])
                    DERIVED IDEA LAYER
  ├─ idea tier        = production if ANY member row is production
  ├─ headline row     = best-odds production row, exchanges excluded
  ├─ corroboration k  = COUNT(DISTINCT bookmaker family)
  └─ idea CLV/P&L     = headline row's CLV / P&L
                         │
          ┌──────────────┼──────────────────┐
          ▼              ▼                  ▼
   ALERTS (1/idea)  GATE METRICS       DIAGNOSTICS
   best price +     /roi /clv          per-book CLV,
   alternatives     idea-denominated   per-book ROI,
                                       family softness
```

Why derived beats materialized (`BettingIdea` table + FK):
- At current volume (~5 ideas/day) the grouping query is trivial; a table buys nothing but a consistency liability (every insert path must maintain it; the tier-aware dedup already has subtle shadow→production transitions a materialized idea would have to track).
- The headline row can *change* (a better book qualifies later); a derived layer re-derives it for free, a table needs update logic.
- Rollback is deleting queries, not migrating data.

One optional additive column is acceptable without violating the storage freeze — see §3 (alert bookkeeping) — but the core design needs zero schema change.

---

## 2. Betting Idea — Definition and Edge Cases

> **Betting Idea := (matchId, outcome, market)** — today effectively `(matchId, outcome)` since only H2H exists, but the key should include `market` from day one so totals/spreads (P3 roadmap) don't force a redefinition.

A bettor's decision is "stake on this outcome of this match at the best price I can access." Bookmaker is *where*, not *what*.

**Edge cases, decided:**

| Case | Ruling |
|---|---|
| Mixed tiers in one idea (observed live: Wings had 3 shadow + 2 production rows) | Idea tier = **max member tier**. Any production row → production idea (alertable). Shadow-only idea → shadow idea: stored, never alerted, reported only in shadow analytics. |
| Shadow→production progression across batches | Already handled by tier-aware dedup at row level; at idea level it's invisible — the idea simply gains production status when its first production row lands. No double alert (idea was never alerted while shadow-only). |
| Opposite outcomes of the same match both qualifying (book X generous on Home, book Y on Away) | **Two distinct ideas** — correct, they are different bets. Rare and noteworthy (it implies books disagree by more than 2× the threshold); worth a ⚠ flag in the alert as a data-quality hint, since one side is likely a ghost. |
| Outcome string identity | Within a The Odds API event, outcome strings are byte-identical across books — safe grouping key. OddsPapi esports rows are excluded from alerting anyway (TRADITIONAL filter) and disappear entirely once C1 is fixed. |
| Bookmaker families (betfair_ex_uk≡betfair_ex_eu; unibet_*; leovegas*; winamax_*; betsson/nordicbet; ladbrokes/coral; betonlineag/lowvig) | Families do **not** define the idea (idea is book-free). They define **corroboration k**: `k = COUNT(DISTINCT family(bookmaker))`, via a static family map in config. Observed Helsingborgs idea: 3 rows → k=2 genuine (kambi-family + coolbet). Wings: 5 rows → k=2 (betfair-family + williamhill_us), and after exchange exclusion → k=1. |
| Idea lifetime | Permanent per key, consistent with row-level permanent dedup. A match ends; its ideas end. |
| Exchanges | Excluded from headline-row selection *and* from k immediately (design-level); excluded from candidacy entirely once the standing P0 lands. |

---

## 3. Idea-Level Discord Alerts

**Recommendation: B — best bookmaker + alternatives**, with two refinements: the headline must be the best **non-exchange** book, and the alert carries the corroboration count and the already-stored movement annotation. (Option A discards the "which of my accounts can take this" decision the user actually faces; pure-C variants add nothing over B.)

**Exact recommended format:**

```
🎯 VALUE BET — Landskrona BoIS
⚽ Soccer | Helsingborgs IF vs Landskrona BoIS | Superettan
🕐 2026-06-11 17:00 UTC (19:00 Budapest)

💰 Best: 2.95 @ Coolbet  (edge +4.6%, fair 2.82)
📋 Also: 2.88 @ Unibet (+3.6%) · 2.88 @ LeoVegas (+3.6%)

📊 Books agreeing: 2 families | Pinnacle 6h: −2.4% (moving toward outcome)
```

Line-by-line rationale: headline = the actionable claim; alternatives = fallback for whatever account the user holds (regional skins listed once per family, best skin shown); `Books agreeing` = the free corroboration/ghost-guard signal; movement line = the LAG/OUTLIER context already computed and stored per row — surfacing it costs nothing and trains the user's judgment while the filter evidence accrues.

**Alert lifecycle policy:**
1. **One alert per idea**, sent when the idea first gains a production row. All member rows (current and shadow) get `alertedAt` stamped in the same transaction — the stamp's meaning shifts from "message sent for this row" to "row consumed by the idea-level alert layer" (documented, no schema change).
2. **Late-qualifying rows** for an already-alerted idea are stamped silently — no new message — **unless the upgrade rule fires**: new best non-exchange odds ≥ 2% better than the alerted headline, or edge ≥ +1.5 pp higher. Then exactly one `⬆ UPGRADE` follow-up, max one per idea.
3. Optional (additive, not required): a nullable `alertRole` column (`HEADLINE` / `LISTED` / `SILENT`) for a perfect audit trail of what each row's role was. Nice-to-have; the design functions without it since the headline is re-derivable.

---

## 4. Idea-Level ROI

**Answer: C — both, with idea-level as the only *headline* and row-level demoted to diagnostics.**

**Idea P&L accounting rule:** the idea's recorded bet is its **headline row** — best-odds non-exchange production row at alert time (tie-break: earliest `createdAt`). One flat unit per idea. This is exactly the bet a user acting on the alert would place, which is the honest definition of paper trading.

| | Row-level (current) | Idea-level (headline row) |
|---|---|---|
| What it measures | "What if I bet every qualifying book simultaneously" — a strategy nobody runs | "What if I took each alert once at the best listed price" — the actual product claim |
| Sample independence | Violated: the 5 Wings/Helsingborgs production rows are 2 outcomes wearing 5 hats; variance understated by ~√(rows/ideas) | One observation per real-world event — the n in every significance statement is true |
| Per-book softness signal | Present | Preserved anyway — rows still settle individually with per-book P&L/CLV; `/best-sports`-style per-book breakdowns read rows |
| Failure mode | A single won 3-book idea prints 3 wins → win-rate and ROI swings amplified by exactly the duplication factor | Headline-row selection slightly favors ghost prices (max-order-statistic) — mitigated by exchange exclusion, k display, movement context |

Surfaces: `/roi`, `/paper-bankroll`, daily summary, Rich Presence → **idea-denominated**. Per-book and per-family tables (the instrument for deciding which books are genuinely soft) → row-denominated, clearly labelled.

---

## 5. Idea-Level CLV Reporting

**Gate metric: ideas. Diagnostics: rows. Both reported, never interchangeably.**

- The V1.5 go/no-go gate ("avg CLV > +1% over **150–200 bets**") must be denominated in **ideas** (headline-row CLV). Row counting would let the Wings idea contribute 5 correlated CLV observations — at the observed 2.5:1 inflation, "200 settled" could be ~80 independent ideas, and the gate's confidence interval would be a fiction. This is the single most consequential consequence of this design: **the gate's statistics become real.**
- Row-level CLV remains the tuning instrument: per-bookmaker CLV (which books are soft), per-family CLV, movement-class CLV (`/clv` section from `MOVEMENT_ANNOTATION_IMPLEMENTATION.md` — should also become idea-denominated for its headline numbers, row-denominated for per-book splits).
- The previously documented gate amendment (`ROI_MAXIMIZATION_AUDIT.md` Part 2.4 — exclude top-decile outliers, require per-class consistency) composes cleanly: apply it to the idea-level sample.

---

## 6. Migration Risk

**Headline finding: the switch is nearly free *today* and gets more expensive every day.**

| Surface | Impact of switching to idea-level | Recompute needed? |
|---|---|---|
| Historical ROI (pre-baseline) | None — already excluded by `ROI_V2_BASELINE` everywhere | No |
| Post-baseline settled metrics | **Zero rows have settled post-baseline yet.** The V2 baseline reset (2026-06-10T20:00Z) means every number the idea-level layer would ever display starts from an empty set — no visible jump, no restated history | No |
| 18 pending old-model rows | Old model had a single candidate book (pinnacle) → row ≈ idea already; any residual time-window duplicates *collapse correctly* under idea grouping — the change improves them | No — derived grouping handles it |
| 8 new-model rows / 2 ideas | Grouped on read; the 5 already-sent alerts can't be unsent, but all rows are already `alertedAt`-stamped so no duplicate messages on cutover | No |
| Historical CLV | 0/50 populated; nothing to restate | No |
| Paper bankroll | Denominator becomes ideas; with 0 post-baseline settlements the displayed number is identical at cutover | No |
| Daily summary | Same — empty post-baseline window at cutover | No |

**No database recomputation is required at all** — aggregation is read-time, rows are untouched, and the baseline already isolated the past. The only "migration" is query-layer and formatter changes plus the documented semantic shift of `alertedAt`. Risk class: low. The real risk is *delay*: every settled multi-book idea that lands before cutover becomes a permanently inflated entry in the gate sample (or a special case to explain).

---

## 7. Historical Odds Integration

**Would idea-level accounting improve future backtesting quality? Yes, materially.** The backtest methodology already designed (`ALERT_STRATEGY_REVIEW.md` Part X) scores *ideas* under three accounting modes — idea-level live accounting makes the production system and the backtest speak the same unit, so backtest conclusions (k-thresholds, ghost-price gaps, league rankings) transfer directly into production configuration without a translation layer.

**Would bookmaker-level accounting distort backtests? Yes, in three specific ways:**
1. **n-inflation:** historical replay over 6 months would produce thousands of row-bets representing far fewer ideas; every confidence interval would be overstated by ~√(inflation ratio).
2. **Liquidity-weighting bias:** mainstream matches are quoted by ~47 books, niche soccer by ~38–40, and the inflation factor varies with coverage — row-level ROI systematically overweights exactly the efficient, well-covered markets where the model finds nothing, and *underweights* the niche leagues where the edges live. League-ranking conclusions drawn from row-level backtests would be wrong in the direction that matters most.
3. **Family double-counting:** historical Betfair/Kindred/skin duplicates would replicate the live 2.5:1 inflation across the entire backtest, compounding 1 and 2.

---

## 8. Final Recommendation

| Rating | Score | Rationale |
|---|---|---|
| **Current architecture** | **5 / 10** | Storage layer is genuinely good (correct granularity, permanent tier-aware dedup, per-row CLV + movement — 8/10 on its own). The accounting/alert layer drags it down: row-mirrored alerts (2.5:1 inflation observed on day one), correlated rows counted as independent bets in every headline metric, and a CLV gate whose sample size is quietly fictional. |
| **Recommended architecture** | **8.5 / 10** | Derived idea layer over frozen storage: honest n, −60% alert volume at zero information loss, best-price headline accounting, free corroboration signal, backtest-compatible units. Withheld 1.5: headline selection's ghost-price tilt (needs exchange exclusion + movement evidence to close) and the unavoidable residual that no accounting fixes attainability. |
| **Implementation complexity** | **3 / 10** | ~2–3 days: one grouping helper (idea key + headline-row + k via static family map), one alert formatter, `where`/aggregation changes in 5 reporting surfaces, semantic doc for `alertedAt`. No migration, no backfill, no new tables; optional `alertRole` column is a one-liner if wanted. The hard parts (dedup, CLV, movement) are already built and unchanged. |

**Expected impacts:**
- **ROI:** headline paper ROI per bet improves mechanically by the best-vs-mean price gap (~+1–3% of odds on multi-book ideas); more importantly the number becomes *interpretable* — one unit per real decision.
- **CLV:** gate sample becomes independent observations; at observed inflation this is the difference between "gate fires at 200 rows ≈ 80 ideas (underpowered, false confidence)" and "gate fires at 150–200 true ideas (the statistics it was designed for)."
- **User experience:** 5 messages → 2; every message becomes strictly more useful (best price + fallbacks + corroboration + movement). The only user's trust in the only product surface stops eroding; coverage expansion starts *improving* alerts instead of multiplying spam.
- **Statistical integrity:** the largest single improvement available in the repo right now — it protects the one experiment (the CLV gate) that the entire project's go/no-go decision rests on.

**If this were my own betting platform**, I would run exactly this in production: per-bookmaker append-only storage with permanent tier-aware dedup (already built); exchanges excluded from candidacy; a derived idea layer keyed (match, outcome, market) with a static family map; one alert per idea — best genuine book headlined, family-deduped alternatives, k count, movement context, single upgrade message on material improvement; all headline metrics and the CLV gate denominated in ideas; all per-book/per-family softness diagnostics denominated in rows; and I would cut over **now**, in the zero-cost window before the first post-baseline settlements land — because the moment correlated rows start settling, every day of delay writes permanent noise into the only sample that will ever decide whether this platform deserves to exist.

---

*Design audit only — no code modified. Companion evidence: `scripts/alert-strategy-audit.ts` (live inflation data), `ALERT_STRATEGY_REVIEW.md` (strategy verdict).*
