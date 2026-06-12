# Bookmaker Coverage Audit

**Date:** 2026-06-10
**Scope:** Exact bookmaker coverage of the production system — what is requested from The Odds API, what is filtered, what is stored in `OddsSnapshot`, and which books participate in Pinnacle-led value detection.
**Method:** Source-code inspection + read-only queries against the live database (reproducible via `scripts/bookmaker-coverage-audit.ts`).

> **Data-window caveat (read first):** "Last 30 days" and "all-time" are currently the same dataset. The snapshot store begins **2026-06-07** and contains three dense days (June 8: 40,287 snaps · June 9: 46,703 · June 10: 44,509 across 61–78 matches/day). Every count below describes ~3 days of production behaviour, not a month.

---

## 1. The Odds API Integration — What Is Requested

Two call sites fetch odds; neither passes a `bookmakers` parameter, so coverage is determined entirely by the **regions** parameter.

| Call site | Endpoint | Regions | Markets | Purpose |
|---|---|---|---|---|
| `match-ingestion.service.ts:124` | `GET /v4/sports/{key}/odds` | `eu,us,uk` | `h2h,spreads,totals` | Phase-1 match discovery. **Odds in this response are discarded** — only event metadata (teams, start time) is used. (This is the ~4× quota waste documented as H4 in `FINAL_V1_AUDIT.md`.) |
| `odds-snapshot-ingestion.service.ts:92` | `GET /v4/sports/{key}/odds?eventIds=…` | `eu,us,uk` | `h2h` | Phase-2 snapshot capture. This is the only path that writes `OddsSnapshot` rows. |

**Regions requested:** `eu`, `us`, `uk`.
**Regions NOT requested:** `au`, `us2`, `us_ex`, `us_dfs` (see Section 6).
**Markets stored:** H2H only (decimal, pre-match; live snapshots are flagged `isLive` and excluded from detection).

A second, independent source also writes `OddsSnapshot`: the **OddsPapi esports pipeline** (`esports-odds-ingestion.service.ts`). It contributes exactly three bookmaker keys — `pinnacle`, `bet365`, `unibet` (generic, no regional suffix) — on esports matches only. Note that esports ingestion is *supposed* to be disabled; snapshots as recent as **June 10** confirm the stale Redis cron jobs (CRITICAL C1 in `FINAL_V1_AUDIT.md`) are still firing.

## 2. What Is Filtered Out

There is **no bookmaker filter anywhere in the pipeline.** `OddsApiEventMapper._mapOddsSnapshots` (`odds-api-event.mapper.ts:100`) iterates every bookmaker the API returns and stores every outcome. The only drops are:

1. **Unrecognised market keys** (`mapOddsMarket` returns undefined — e.g. Betfair Exchange non-standard keys). The bookmaker's H2H rows still flow through; only the odd market is skipped.
2. **Terminal matches** (FINISHED / CANCELLED / POSTPONED) — entire event skipped per Architecture §7.9.
3. **Events not in the requested `eventIds` set** — defensive guard, rarely triggers.

So: *stored coverage = whatever The Odds API returns for `eu,us,uk`* (plus the 3 OddsPapi esports keys).

## 3. What Is Actually Stored — Database Report

### 3.1 Unique bookmakers (full dataset window)

**53 unique bookmaker keys**: 50 traditional-only via The Odds API, 2 esports-only via OddsPapi (`bet365`, `unibet`), and `pinnacle` appearing via both sources.

### 3.2 Most common bookmakers (by matches covered)

| Bookmaker | Matches | Snapshots | Region |
|---|---|---|---|
| fanduel | 78 | 3,748 | us |
| paddypower | 78 | 3,735 | uk |
| unibet_uk | 75 | 3,677 | uk |
| betway | 74 | 3,539 | uk |
| sport888 | 74 | 3,490 | uk |
| betonlineag / lowvig | 74 | ~3,120 | us |
| draftkings | 71 | 3,607 | us |
| unibet_se / unibet_nl / leovegas / leovegas_se | 71 | ~3,270 | eu |
| **pinnacle** | **96** | 3,109 | eu (+ OddsPapi esports) |

Pinnacle's match count (96) is the highest because it is the only key present in **both** sources — it covers 67 traditional matches plus ~29 esports matches.

### 3.3 Least common bookmakers

| Bookmaker | Matches | Notes |
|---|---|---|
| codere_it | 9 | Italy-licensed; quoted only on select soccer |
| skybet | 12 | uk |
| pmu_fr | 17 | France |
| betfred_uk | 17 | uk |
| unibet (generic) | 30 | **OddsPapi esports only** |
| bet365 (generic) | 36 | **OddsPapi esports only** — The Odds API returns no Bet365 prices for the requested `eu,us,uk` regions on traditional sports |
| everygame | 44 | us offshore |

### 3.4 Bookmaker count by sport (window)

| Sport | Bookmakers | Matches | Snapshots | Source |
|---|---|---|---|---|
| baseball (MLB) | 47 | 45 | 77,546 | The Odds API |
| basketball (WNBA/NBA) | 47 | 14 | 18,574 | The Odds API |
| soccer | 45 | 17 | 28,818 | The Odds API |
| ice-hockey (NHL) | 42 | 2 | 6,371 | The Odds API |
| cs-go | 3 | 21 | 114 | OddsPapi (stale cron) |
| league-of-legends | 3 | 18 | 106 | OddsPapi (stale cron) |
| dota-2 | 3 | 6 | 70 | OddsPapi (stale cron) |
| valorant | 3 | 2 | 18 | OddsPapi (stale cron) |
| **tennis** | **0** | **0** | **0** | 20 tennis keys are polled hourly; all are slam/Masters keys with no active tournament June 8–10 |

### 3.5 Bookmaker count by league (traditional, window)

| League | Bookmakers | Matches |
|---|---|---|
| baseball_mlb | 47 | 45 |
| basketball_wnba | 30 | 12 |
| soccer_sweden_superettan | 40 | 8 |
| soccer_brazil_serie_b | 39 | 7 |
| basketball_nba | 47 | 2 |
| icehockey_nhl | 42 | 2 |
| soccer_spain_segunda_division | 38 | 2 |

Notable: even second-tier soccer (Superettan, Brazil Série B) carries ~40 books — niche soccer is *not* coverage-poor on this API.

## 4. Which Bookmakers Participate in Pinnacle-Led Detection

Under the new model (`value-detection.service.ts`):

- **`pinnacle` is the reference** — de-vigged into fair probabilities; never a candidate.
- **Every other stored bookmaker is automatically a candidate** on any match where it co-occurs with a valid Pinnacle reference market (overround ∈ [0.99, 1.15], same outcome count).

Pinnacle is present on **96 of 125** matches with odds (77%). The 29 Pinnacle-less matches produce zero detections by design. On the 67 traditional matches *with* Pinnacle, candidate co-occurrence is excellent: 12 books (unibet_se, draftkings, paddypower, betonlineag, betway, bovada, leovegas, fanduel, unibet_nl, betfair_ex_uk, lowvig, leovegas_se) are present on all 67; ~40 books are present on 50+.

So in practice, **~50 candidate books are evaluated per traditional match** — the model's breadth is already wide. Two caveats:

1. **Exchanges are treated as plain bookmakers.** `betfair_ex_uk`, `betfair_ex_eu`, `smarkets`, `matchbook` quote back prices that are pre-commission; their "edges" vs Pinnacle fair are systematically overstated by the commission (2–5%). In the 30-day edge simulation, exchanges produced 5 of the 8 candidates at the ≥2% level — most would evaporate after commission. They should be excluded or commission-adjusted.
2. **The esports keys leak into detection.** `bet365`/`unibet` (OddsPapi) are candidates against OddsPapi's own Pinnacle quotes on esports matches the system isn't supposed to ingest. The 2 dota-2 "edges ≥5%" in the simulation come from this 3-book micro-market. The Discord alert path filters TRADITIONAL, but rows are still inserted into `value_opportunities` and surface in `/value-bets`. Fixing C1 (remove stale crons) closes this.

**Which books have actually generated opportunities?** All 68 historical opportunities carry `bookmaker = 'pinnacle'` — they are old-model rows. **Zero new-model opportunities exist in the DB yet** (the rewritten detector has not produced a persisted detection since deployment of the code; the single 7.84% dry-run detection was read-only).

## 5. Additional Bookmakers Worth Adding

### 5.1 By adding regions (no code change beyond the `regions` string)

The Odds API prices requests at *markets × regions*, so each added region costs +1 credit per snapshot call (currently 3).

| Region | Representative books gained | Why it matters |
|---|---|---|
| **`au`** | Sportsbet, TAB, Neds, Ladbrokes AU, PointsBet AU, Betr, TopSport (and per The Odds API's bookmaker list, Bet365's AU feed) | Australian retail books are classically soft and slow on overnight European soccer and US sports — exactly the latency the Pinnacle-led model monetises. Highest expected alert-volume gain per credit. |
| **`us2`** | ESPN Bet, Hard Rock Bet, Bally Bet, Wind Creek | Newer US books; promotional pricing and slower trading teams → more ≥3% deviations vs Pinnacle. |
| **`us_ex`** | Novig, ProphetX | Low/no-vig exchanges. Less useful as *candidates* (sharp-ish), but valuable as secondary reference/sanity checks on Pinnacle. |
| `us_dfs` | PrizePicks, Underdog | DFS pick'em — not H2H comparable. Skip. |

Recommendation: add `au` and `us2` (cost: 3→5 credits per snapshot call, +67%; the H4 quota fix — free `/events` for discovery — pays for this several times over).

### 5.2 By treatment, not addition

- **Split exchanges into their own class**: either exclude `betfair_ex_*`, `smarkets`, `matchbook` from candidacy or subtract commission before edge computation. This improves signal quality immediately at zero coverage cost.
- **Per-bookmaker CLV/ROI breakdown** (extend `/clv`): with ~50 candidates, the books that systematically deliver positive-CLV alerts will identify themselves within weeks; coverage can then be *narrowed* to the soft ones, which is where real signal quality comes from.

### 5.3 What cannot be obtained from the current provider

Bet365 (traditional, non-AU), regional Hungarian/CEE books (Tippmix, Fortuna), and Asian books (SBOBET, 188bet — the other sharp reference class) are not on The Odds API at all. If the model graduates from the CLV gate, an Asian-odds provider would be the next coverage investment; until then it is premature.

---

## Summary

| Question | Answer |
|---|---|
| Bookmakers requested | All books in regions `eu,us,uk` (no `bookmakers` filter) |
| Regions requested | `eu`, `us`, `uk` — `au`, `us2`, `us_ex` unused |
| Bookmakers filtered out | None by name; only unrecognised market keys and terminal-match events |
| Stored in `OddsSnapshot` | 53 unique keys: 50 The Odds API traditional + `pinnacle`/`bet365`/`unibet` via OddsPapi esports |
| Unique books (30d = all-time) | 53 |
| Most common | fanduel, paddypower, unibet_uk (74–78 matches each) |
| Least common | codere_it (9), skybet (12), pmu_fr / betfred_uk (17) |
| Detection participants | Pinnacle = reference (96/125 matches); ~50 candidates per traditional match; exchanges and OddsPapi esports keys participate when they should not |
| Best additions | `au` + `us2` regions (alert volume), exchange exclusion/commission-adjust (signal quality), per-book CLV (long-term narrowing) |
