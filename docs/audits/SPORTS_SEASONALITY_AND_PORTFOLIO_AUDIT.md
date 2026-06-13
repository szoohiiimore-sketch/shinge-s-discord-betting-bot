# Sports Seasonality & Portfolio Audit

**Date:** 2026-06-13
**Type:** READ-ONLY AUDIT. No code, config, env, migration, branch, or commit was changed. The repository state is identical before and after this audit. All recommendations are theoretical.
**Author model:** Claude Opus 4.8 (High)

## Evidence sources (authoritative-first)

| # | Source | Cost | What it establishes |
|---|---|---|---|
| E1 | **Live `GET /v4/sports?all=true`** (The Odds API, June 13 2026) | **0 credits** (sports endpoint is free) | The complete plan catalogue: **165 keys, 46 active right now**. Ground truth for "available" and "in-season today". |
| E2 | **Live `GET /v4/sports/{key}/odds`** coverage probe, 13 candidates | **~39 credits** (31473→31512 used) | Real bookmaker depth + **Pinnacle presence** + next-event date per addition candidate. The binding constraint for alert generation. |
| E3 | Live DB queries (matches, league freshness, lifetime value-opportunities, CLV/PnL) | 0 credits | What the bot has actually ingested and which leagues have ever produced an alert. |
| E4 | `src/lib/app/app.ts` (`TRADITIONAL_SPORT_CONFIGS`) parsed programmatically | 0 | The true current config: **63 keys** (not 68 — see §0). |
| E5 | Prior measured audits: `ALERT_VOLUME_EXPANSION_AUDIT.md`, `ROI_FIRST_CONFIGURATION_AUDIT.md` | 0 | Per-league CLV/ROI behaviour from the 47-day backtest + probes. |
| E6 | `SPORTS_ACTION_PLAN.txt` (the hypothesis under test) | — | Treated as unverified; every line independently checked. |

**On the 5,000-credit research budget:** ~39 credits were spent (E2) to measure the one thing history cannot tell us about never-configured sports — *current bookmaker/Pinnacle coverage*, which the prior audits proved is the model's binding constraint ("the binding constraint is edges, not books quoting them" / Pinnacle is the de-vig reference). **No historical backtesting credits were spent, and none are justified** — see §9.

---

## §0 — Headline corrections (read this first)

1. **The bot does NOT currently monitor the FIFA World Cup.** The 2026 World Cup is live *right now* (E1: `soccer_fifa_world_cup` ACTIVE, 68 events, next June 13; E2: Pinnacle on 67/68 events, avg 38.6 books, 19.6 soft books — the deepest liquidity of any sport on the plan). It is **not** in `TRADITIONAL_SPORT_CONFIGS`. This is the single largest gap in the portfolio and dwarfs every other recommendation in this document.

2. **The current config is 63 keys, not 68.** Parsing `app.ts` (E4): Tier 1 = 25, Tier 2 = 4, Tier 3 = 34 → **63**. The earlier `ENABLED_SPORTS_LIST.txt` *totals* line (29/5/34 = 68) is arithmetically wrong (its own body lists 63). `SPORTS_ACTION_PLAN.txt` inherited the 68 figure, so its summary math ("68 → remove 35, keep 28") is built on a 5-key overcount.

3. **"FIFA Club World Cup" is a 2025 event and is INACTIVE in 2026** (E1: `soccer_fifa_club_world_cup` inactive). Both `SPORTS_ACTION_PLAN.txt` and the ChatGPT list recommend adding it as "running now". They are one year stale. **Reject.**

4. **Of 63 configured keys, only ~13 are active on the API today**, and **only 8 leagues have ever produced a live value-opportunity** (E3). The portfolio is mostly off-season placeholders.

---

## Part 1 — Current Portfolio Review (63 configured keys)

Status legend: **ACTIVE** (live h2h odds now) · **STARTING_SOON** (≤~30d) · **OFF_SEASON** (out, returns >30d) · **COMPLETED_FOR_YEAR** (done until next year) · **EVENT_BASED** · **UNKNOWN**. Status is taken from E1 (API active flag) + E3 (live odds/snapshots), which override calendar guesses.

### Active now (producing or able to produce alerts) — 13

| Key | League | Status | Evidence |
|---|---|---|---|
| `baseball_mlb` | MLB | **ACTIVE** | peak season; 66 lifetime VO, 235k snaps/7d |
| `basketball_wnba` | WNBA | **ACTIVE** | 25 VO, 67k snaps/7d |
| `soccer_sweden_superettan` | Superettan | **ACTIVE** | 34 VO, 57k snaps/7d — top live producer |
| `soccer_brazil_serie_b` | Brazil Série B | **ACTIVE** | 20 VO (but measured −ROI/−CLV, see §4) |
| `soccer_finland_veikkausliiga` | Veikkausliiga | **ACTIVE** | 11 VO |
| `soccer_chile_campeonato` | Primera Chile | **ACTIVE** | 11 VO |
| `soccer_league_of_ireland` | LoI | **ACTIVE** | 8 VO |
| `soccer_spain_segunda_division` | La Liga 2 | **ACTIVE → ending ~Jun 14** | 17 VO; playoff finishing (fut=1) |
| `soccer_sweden_allsvenskan` | Allsvenskan | **ACTIVE** | in-season, but live ingestion gap (snaps7d=0 — see §4 note) |
| `soccer_china_superleague` | CSL | **ACTIVE** | in-season; **no Pinnacle** (E2), legacy-model only |
| `soccer_norway_eliteserien` | Eliteserien | **ACTIVE** | thin; 1 future fixture visible |
| `basketball_nba` | NBA | **ACTIVE → Finals end ~Jun 19** | then OFF_SEASON to Oct |
| `icehockey_nhl` | NHL | **ACTIVE → Final ends ~Jun 17** | then OFF_SEASON to Oct |

### Off-season / completed — 50

- **Basketball:** `basketball_euroleague` OFF_SEASON (→Oct). After ~Jun 19: `basketball_nba` OFF_SEASON.
- **American football:** `americanfootball_ncaaf` — API shows ACTIVE via *futures only*; **no h2h until late Aug** (E3: 80 future fixtures seeded for Nov, snaps7d=0). Effectively OFF_SEASON for alerts.
- **Tennis (all 20 keys) — OFF_SEASON/COMPLETED for the moment.** Every configured ATP/WTA key is INACTIVE today (E1). Next reactivations: Wimbledon (~Jun 29), then Canadian (Aug), Cincinnati (Aug), US Open (late Aug). French/Indian Wells/Miami/Madrid/Italian = COMPLETED_FOR_YEAR. Aus Open = next January.
- **Soccer top:** `soccer_epl` OFF_SEASON (→~Aug 15), `soccer_uefa_champs_league` OFF_SEASON (→Sept).
- **Soccer "kept-but-currently-inactive"** (E1 inactive today): `soccer_usa_mls`, `soccer_brazil_campeonato`, `soccer_argentina_primera_division`, `soccer_japan_j_league`, `soccer_korea_kleague1`, `soccer_mexico_ligamx`, `soccer_russia_premier_league`. Several are paused for the **World Cup break** (MLS, Brazil A) or between tournaments (Liga MX Apertura starts July; Russia restarts ~mid-July). They will return — but the action plan's claim that they are "Aktív" *today* is false for all seven.
- **Soccer Tier-3 EU (summer break) — OFF_SEASON, ~20 keys:** austria, belgium, denmark, england_league2, france_ligue_two, germany_bundesliga2, germany_bundesliga_women (completed), germany_dfb_pokal (next-season futures only), germany_liga3, greece, italy_serie_b, netherlands, poland, portugal, saudi (completed), spl (Scotland), switzerland, turkey, australia_aleague (completed). All confirmed INACTIVE in E1.

**Net Part 1 finding:** ~50 of 63 keys are producing nothing right now. Polling them is low-cost-per-call but non-zero in aggregate (§ "API utilization"), and — more importantly — the config has drifted into a "set-and-forget" list that no longer reflects the season.

---

## Part 2 — Seasonality Calendar (annual map)

Approximate windows for every sport relevant to this portfolio (current keys + candidates). **"Active today" column is authoritative (E1, Jun 13 2026); month bands are conventional calendars** (cross-checked against E1/E2 edges where available, e.g. Libertadores next-event = Aug 11). Outright/futures-only markets (`*_winner`, politics) are excluded — the bot is an h2h de-vig model and cannot use multi-runner outrights.

| Sport / League | Key | Start | End | Active months | Active today? |
|---|---|---|---|---|---|
| FIFA World Cup 2026 | `soccer_fifa_world_cup` | Jun 11 | Jul 19 | Jun–Jul (quadrennial) | **YES** |
| MLB | `baseball_mlb` | late Mar | late Oct | Mar–Oct | YES |
| NPB (Japan) | `baseball_npb` | late Mar | Oct | Mar–Oct | YES |
| KBO (Korea) | `baseball_kbo` | late Mar | Oct | Mar–Oct | YES |
| MiLB | `baseball_milb` | Apr | Sep | Apr–Sep | YES |
| NCAA Baseball | `baseball_ncaa` | Feb | late Jun (CWS) | Feb–Jun | YES (ends ~Jun 22) |
| WNBA | `basketball_wnba` | May | Oct | May–Oct | YES |
| NBA | `basketball_nba` | late Oct | mid-Jun | Oct–Jun | YES→ends ~Jun 19 |
| EuroLeague | `basketball_euroleague` | Oct | May | Oct–May | no |
| NHL | `icehockey_nhl` | Oct | mid-Jun | Oct–Jun | YES→ends ~Jun 17 |
| AHL | `icehockey_ahl` | Oct | mid-Jun | Oct–Jun | YES (Calder Cup) |
| NRL (rugby league) | `rugbyleague_nrl` | Mar | Oct | Mar–Oct | YES |
| NRL State of Origin | `rugbyleague_nrl_state_of_origin` | May | Jul | May–Jul (3 games) | YES |
| AFL (Aussie rules) | `aussierules_afl` | Mar | Sep | Mar–Sep | YES |
| CFL | `americanfootball_cfl` | Jun | Nov | Jun–Nov | YES (just started) |
| NCAAF | `americanfootball_ncaaf` | late Aug | Jan | Aug–Jan | futures only |
| NFL | `americanfootball_nfl` | Sep | Feb | Sep–Feb | futures/preseason |
| Copa Libertadores | `soccer_conmebol_copa_libertadores` | Feb (groups) | Nov (final) | Feb–Nov, **gap Jun–Jul** | groups paused; R16 Aug 11 |
| Copa Sudamericana | `soccer_conmebol_copa_sudamericana` | Mar | Nov | Mar–Nov, gap now | next Jul 21 |
| MLS | `soccer_usa_mls` | late Feb | Nov | Feb–Nov (WC pause Jun) | paused |
| Brazil Série A | `soccer_brazil_campeonato` | Apr | Dec | Apr–Dec (WC pause) | paused |
| Brazil Série B | `soccer_brazil_serie_b` | Apr | Nov | Apr–Nov | YES |
| Primera Chile | `soccer_chile_campeonato` | Feb | Dec | Feb–Dec | YES |
| CSL (China) | `soccer_china_superleague` | Mar | Nov | Mar–Nov | YES |
| Veikkausliiga (FIN) | `soccer_finland_veikkausliiga` | Apr | Oct | Apr–Oct | YES |
| Allsvenskan (SWE) | `soccer_sweden_allsvenskan` | late Mar | Nov | Mar–Nov | YES |
| Superettan (SWE) | `soccer_sweden_superettan` | Apr | Nov | Apr–Nov | YES |
| Eliteserien (NOR) | `soccer_norway_eliteserien` | Mar | Dec | Mar–Dec | YES |
| League of Ireland | `soccer_league_of_ireland` | Feb | Nov | Feb–Nov | YES |
| La Liga 2 (Segunda) | `soccer_spain_segunda_division` | Aug | mid-Jun | Aug–Jun | YES→ends ~Jun 14 |
| Liga MX | `soccer_mexico_ligamx` | Jul | May (two phases) | split season | paused (Apertura Jul) |
| Argentina Primera | `soccer_argentina_primera_division` | Jan | Dec (split) | split season | between phases |
| J-League | `soccer_japan_j_league` | Feb | Dec | Feb–Dec | WC pause |
| K-League 1 | `soccer_korea_kleague1` | Mar | Dec | Mar–Dec | WC pause |
| Russia Premier | `soccer_russia_premier_league` | Jul | May | Jul–May (winter break) | OFF (restarts ~mid-Jul) |
| EPL | `soccer_epl` | mid-Aug | May | Aug–May | no (→Aug 15) |
| UEFA Champions League | `soccer_uefa_champs_league` | Sep | late May | Sep–May | no (→Sep) |
| Most EU domestic leagues | (austria, belgium, denmark, germany 2/3/women, greece, italy B, netherlands, poland, portugal, scotland, switzerland, turkey, england L2, france L2) | Aug | May | Aug–May | **no (summer break)** |
| Saudi Pro League | `soccer_saudi_arabia_pro_league` | Aug | May | Aug–May | no (completed) |
| A-League (AUS) | `soccer_australia_aleague` | Oct | May | Oct–May | no (completed) |
| Tennis ATP/WTA Grand Slams | aus(Jan), french(May–Jun), wimbledon(Jun–Jul), us(Aug–Sep) | — | — | event windows | only Wimbledon soon |
| Tennis Masters/1000 | indian wells(Mar), miami(Mar), madrid(Apr–May), italian(May), canadian(Aug), cincinnati(Aug) | — | — | event windows | none today |
| WTA grass warm-ups | `tennis_wta_queens_club_champ` etc. | Jun | Jun | grass season | YES (small) |
| PLL (lacrosse) | `lacrosse_pll` | Jun | Sep | Jun–Sep | YES (thin) |
| Cricket internationals | `cricket_international_t20`,`cricket_odi`,`cricket_test_match` | year-round | — | rolling | YES (sporadic) |
| MMA / Boxing | `mma_mixed_martial_arts`,`boxing_boxing` | year-round | — | event-based | YES (event-based) |

**Inactive-this-cycle leagues on the plan worth noting** (E1 inactive, real keys available for later): `soccer_efl_champ`, `soccer_england_league1`, `soccer_france_ligue_one`, `soccer_germany_bundesliga`, `soccer_italy_serie_a`, `soccer_spain_la_liga`, `soccer_netherlands_eredivisie`, the full UEFA suite, all major tennis events, EuroLeague, NFL, NCAAB, cricket franchise leagues (IPL/BBL/PSL/Hundred), Six Nations, etc.

---

## Part 3 — Validation of SPORTS_ACTION_PLAN.txt

Verdicts per recommendation block. Evidence = E1 (active flag) unless noted.

### Base count — **REJECTED (factual error)**
Plan asserts "68 enabled". Actual = **63** (E4). All downstream totals are off by 5.

### "KISZEDNI — 35 sports" (remove)
| Item | Verdict | Note |
|---|---|---|
| `basketball_euroleague`, `basketball_nba` | **VALIDATED** | off-season (NBA after ~Jun 19). |
| `americanfootball_ncaaf` | **VALIDATED** | no h2h until late Aug (E3). |
| Closed tennis (french, indian_wells, miami, madrid, italian — ATP+WTA) | **VALIDATED** | INACTIVE/completed (E1). Re-enable dates roughly right. |
| `soccer_epl`, `soccer_uefa_champs_league` | **VALIDATED** | off-season. |
| EU summer-break Tier-3 (austria, belgium, denmark, england_league2, france_ligue_two, germany_bundesliga2/liga3/women/dfb_pokal, greece, italy_serie_b, netherlands, poland, portugal, saudi, switzerland, turkey, australia_aleague) | **VALIDATED** | all INACTIVE (E1). |
| `soccer_scotland_spl` | **PARTIALLY** | correct intent, **wrong key** — real key is `soccer_spl`. |
| **`soccer_spain_segunda_division`** | **PARTIALLY VALIDATED — but mis-prioritised** | Plan lumps it with dead EU leagues. It is the **best-performing league in the entire backtest** (Segunda +9.0% ROI, +5.96% shadow CLV — E5) and is *still active* (17 VO, 21k snaps/7d). It only qualifies for removal because its season literally ends ~Jun 14. It must be **top of the August re-enable list**, not a throwaway. |

### "MARAD — 28 sports" (keep)
| Item | Verdict | Note |
|---|---|---|
| `baseball_mlb`, `basketball_wnba`, Nordic + Brazil-B + Chile + Finland + Ireland (active set) | **VALIDATED** | active, producing (E3). |
| `icehockey_nhl` | **PARTIALLY** | Final ends ~Jun 17, not Jun 20; then dead. |
| `soccer_usa_mls`, `soccer_brazil_campeonato`, `soccer_argentina_primera_division`, `soccer_japan_j_league`, `soccer_korea_kleague1`, `soccer_mexico_ligamx`, `soccer_russia_premier_league` | **REJECTED as "active"** | All seven are **INACTIVE today** (E1) — WC break / between-tournament / winter break. Keeping the keys is fine (they return); calling them "Aktív" now is wrong. |
| Tennis "keep" set (wimbledon, us_open, canadian, cincinnati, aus_open) | **VALIDATED (keep)** | off now but reactivate within the window. Low-value (see §5/§7). |

### "BERAKNI MOST — 26 sports" (add now)
| Item | Verdict | Evidence |
|---|---|---|
| `soccer_fifa_world_cup` | **VALIDATED — #1 priority** | E1 active, E2 elite coverage. The plan got the single most important call right. |
| **`soccer_fifa_club_world_cup`** | **REJECTED** | INACTIVE — 2025 event, not running 2026 (E1). |
| `soccer_conmebol_copa_libertadores` | **PARTIALLY → defer** | active key but **no Pinnacle (0/9)** and **no events until Aug 11** (E2). Nothing to alert on now. |
| `soccer_conmebol_copa_sudamericana` | **REJECTED now** | no Pinnacle, thin (avg 6.7 books, 3.2 soft), next Jul 21 (E2). |
| `soccer_fifa_world_cup_qualifiers_europe/south_america` | **REJECTED** | INACTIVE — qualifiers finished, the WC itself is on (E1). |
| `cricket_icc_world_cup_womens`, `cricket_t20_blast` | **REJECTED** | INACTIVE (E1). Plan's "MOST FUT" dates are wrong. |
| `cricket_test_match`, `cricket_international_t20`, `cricket_odi` | **PARTIALLY** | active but sporadic/rolling; the bot's de-vig model on cricket is unvalidated and coverage thin. Low priority. |
| `rugbyleague_nrl` | **PARTIALLY** | active, but **Pinnacle on only 1/8 events** (E2) — legacy-model-only. |
| `aussierules_afl` | **PARTIALLY** | active, good soft depth (18 books) but **Pinnacle 2/5** — legacy-leaning. |
| `baseball_kbo`, `baseball_npb` | **VALIDATED** | active, **Pinnacle on 100% of events**, 16–19 books, 10–12 soft (E2). Strong adds. |
| `americanfootball_cfl` | **PARTIALLY** | active, **Pinnacle 1/5** — legacy-only. |
| `tennis_wta_queens_club_champ` | **PARTIALLY** | active, good coverage (24 books) but tennis CLV measured poor (+0.97%, E5) and the event ends mid-June. |
| `tennis_wta_strasbourg` | **REJECTED** | INACTIVE — Strasbourg is a *May* event, already over (E1). Plan's "Jun 15–20" is wrong. |
| `golf_us_open_winner` | **REJECTED** | **outright-only** market — the h2h de-vig model cannot use it. |
| `mma_mixed_martial_arts`, `boxing_boxing` | **PARTIALLY** | active, event-based; unvalidated for this model; defer. |
| `baseball_milb` | **REJECTED now** | no Pinnacle, avg 5.9 books (E2) — too thin for de-vig. |
| `lacrosse_pll` | **REJECTED** | no Pinnacle, 5 books (E2). |
| `rugbyleague_nrl_state_of_origin` | **PARTIALLY** | only ~3 games/year; negligible volume. |
| `tennis_atp_hamburg_open`, `basketball_nba_summer_league` | **REJECTED now / STARTING_SOON** | both INACTIVE (E1); Hamburg ~mid-Jul, Summer League ~Jul. |

**Plan scorecard:** the big call (World Cup) is right; the structure (prune off-season, add in-season) is sound; but it contains **≥6 hard factual errors** (Club World Cup, WC qualifiers, Strasbourg, women's cricket WC / T20 Blast dates, "active" status of 7 kept leagues, the 68 base count) and **mis-prioritises Segunda**. It treats "exists & active on API" as "will generate alerts", ignoring Pinnacle/coverage — which E2 shows is decisive.

---

## Part 4 — Removal Candidates (theoretical)

Removal here means *de-scheduling polling+settlement* for keys that cannot produce alerts in the current window. Per-call cost is small, but 50 dead keys × multiple calls/day is the bulk of current quota (§ utilization). **None of these delete data; they pause polling.**

| Key(s) | Reason | Alerts/day lost | ROI impact | API saved (approx) | Re-enable |
|---|---|---|---|---|---|
| 20 EU summer-break Tier-3 + `soccer_epl` + `soccer_uefa_champs_league` | OFF_SEASON, INACTIVE on API | **0** (already 0) | none | ~22 keys × 8 calls/day (T3) ≈ **175/day** + settlement ≈ 130/day | per league: Jul–Aug (most ~Aug 1–15); UCL Sep |
| All 20 tennis keys except Wimbledon | COMPLETED or far off | 0 | none (tennis CLV +0.97%, marginal) | 20 × 24/day (T1) ≈ **480/day** + settlement 120/day | Wimbledon keep; others Aug / next Jan |
| `basketball_euroleague` | OFF_SEASON | 0 | none | 24/day + settlement | Oct |
| `basketball_nba`, `icehockey_nhl` (after ~Jun 19) | season ends in days | ~0 (0 lifetime VO) | none | T1+T2 calls | Oct |
| `americanfootball_ncaaf` | no h2h until late Aug | 0 | none | T2 24/day | late Aug |
| `soccer_brazil_serie_b` | **measured negative** (E5: −ROI, production-tier −0.96%; E3 lifetime −CLV) | −0.11/day (removing *negative* alerts is positive EV) | **improves** blended CLV/ROI | — (keep ingesting as shadow-only, or drop) | — |

**Highest-value removals = the 20 stranded tennis keys (~600 calls/day incl. settlement) and the 22 dead EU/UCL soccer keys (~305/day).** Together they are the majority of current ingestion quota and produce zero alerts. The honest caveat: an off-season `/odds` poll still returns `[]` cheaply, so the *dollar* saving is modest — but that freed quota is exactly what funds the World Cup + baseball adds at zero net cost.

**Important non-removal:** keep `soccer_spain_segunda_division`, `soccer_sweden_allsvenskan`, `soccer_sweden_superettan`, `soccer_finland_veikkausliiga` scheduled — Segunda/Allsvenskan/Superettan are the measured high-value core (E5). (Segunda merely pauses naturally after Jun 14.)

---

## Part 5 — Addition Candidates (theoretical)

Ranked by structural fit (Pinnacle presence × soft depth × season length × event volume), measured live in E2. "Implementation cost" is identical for all: one line in `TRADITIONAL_SPORT_CONFIGS` (no other change — the pipeline auto-enrolls scheduling + settlement, per `TRADITIONAL-SPORT-EXPANSION-AUDIT.md`).

| Key | Active | Pinnacle coverage | Soft depth | Expected volume | Expected ROI/CLV | API cost |
|---|---|---|---|---|---|---|
| **`soccer_fifa_world_cup`** | now (→Jul 19) | **67/68 events** | 19.6 soft, 38.6 total | **High** — 68 events, dense slate | Best structural case on the plan; deep liquidity = real edges *and* tight closes. CLV unproven for tournament soccer but coverage is ideal. | T1, ~24/day for ~5 weeks |
| **`baseball_npb`** | now (→Oct) | **6/6 events** | 12 soft | Med — ~6 games/day, long season | Strong: full Pinnacle ref + deep soft books; same shape as MLB (which produces the most VO). | T1, ~24/day, 4 months |
| **`baseball_kbo`** | now (→Oct) | **5/5 events** | 10 soft | Med — ~5 games/day | Strong, as NPB. | T1, ~24/day, 4 months |
| `baseball_ncaa` | now (→~Jun 22) | 4/4 | 7.5 soft | Low — College World Series only | OK coverage, **~9-day window**. Marginal effort/reward. | tiny |
| `aussierules_afl` | now (→Sep) | 2/5 | 10.6 soft | Med | Legacy-model-leaning (sparse Pinnacle). Worth a shadow trial. | T1, 3 months |
| `rugbyleague_nrl` | now (→Oct) | 1/8 | 6.1 soft | Med | Legacy-only; thinner. Shadow trial. | T1, 4 months |
| `americanfootball_cfl` | now (→Nov) | 1/5 | 7.6 soft | Low-Med | Legacy-only. Shadow trial. | T1, 5 months |
| `soccer_conmebol_copa_libertadores` | events Aug 11 | **0/9** | 7.8 soft | Med (in season) | **No Pinnacle** → Pinnacle-led model dead; legacy-only. **Defer to August.** | — |
| `soccer_conmebol_copa_sudamericana` | events Jul 21 | 0/10 | 3.2 soft | Low | No Pinnacle, thin. Reject/defer. | — |
| `baseball_milb` | now | 0/15 | 4.9 soft | High volume, thin books | No Pinnacle, shallow consensus. Reject. | — |
| `lacrosse_pll` | now | 0/3 | 5 soft | Low | No Pinnacle, thin. Reject. | — |
| `mma`, `boxing` | event-based | n/a (not probed deep) | — | Low | Event-based; unvalidated for de-vig; defer. | — |

**Do NOT add on "it exists" grounds:** Sudamericana, MiLB, PLL, golf outrights, women's cricket WC, T20 Blast, Strasbourg, Club World Cup — each fails on coverage, market type, or is simply not running (E1/E2).

---

## Part 6 — Priority Ranking

**Tier A — highest confidence, add now (Pinnacle-backed, active, deep):**
1. `soccer_fifa_world_cup` — *do this today*; it is half the value of the entire audit.
2. `baseball_npb`
3. `baseball_kbo`

**Tier B — worth monitoring / shadow-trial (active but legacy-leaning or short window):**
4. `aussierules_afl`
5. `rugbyleague_nrl`
6. `americanfootball_cfl`
7. `baseball_ncaa` (≤Jun 22 only)
8. `soccer_conmebol_copa_libertadores` — **re-evaluate Aug 11** (legacy-model only; no Pinnacle).

**Tier C — low confidence, do not add now:**
9. `tennis_wta_queens_club_champ` and tennis generally (poor CLV, E5)
10. `soccer_conmebol_copa_sudamericana`, `baseball_milb`, `lacrosse_pll`, cricket, mma/boxing — coverage/market-type failures or unvalidated.

---

## Part 7 — Validation of External (ChatGPT) Recommendations

ChatGPT suggested **removals:** NBA, EuroLeague, NCAAF, EPL, Champions League, closed ATP/WTA, EU summer-break leagues.

| Claim | Verdict | Evidence |
|---|---|---|
| Remove NBA | **PARTIALLY** | Finals through ~Jun 19, then yes. Don't cut mid-Final. |
| Remove EuroLeague | **VALIDATED** | off-season (E1). |
| Remove NCAAF | **VALIDATED** | no h2h until late Aug (E3). |
| Remove EPL | **VALIDATED** | off-season (E1). |
| Remove Champions League | **VALIDATED** | off-season (E1). |
| Remove closed ATP/WTA | **VALIDATED** | INACTIVE (E1) — keep only Wimbledon (reactivates ~Jun 29). |
| Remove EU summer-break leagues | **VALIDATED** | all INACTIVE (E1) — **but keep Segunda/Allsvenskan/Superettan/Veikkausliiga**, the measured-valuable ones (E5). |

ChatGPT suggested **additions:** FIFA Club World Cup, Copa Libertadores, Copa Sudamericana, KBO, NPB, CFL.

| Claim | Verdict | Evidence |
|---|---|---|
| **FIFA Club World Cup** | **REJECTED** | INACTIVE — 2025 event (E1). Factually wrong. |
| Copa Libertadores | **PARTIALLY / defer** | active key but **no Pinnacle** and no events to Aug 11 (E2). |
| Copa Sudamericana | **REJECTED now** | no Pinnacle, thin, next Jul 21 (E2). |
| **KBO** | **VALIDATED** | Pinnacle 5/5, deep books (E2). |
| **NPB** | **VALIDATED** | Pinnacle 6/6, deep books (E2). |
| CFL | **PARTIALLY** | active but Pinnacle 1/5 → legacy-only (E2). |

**ChatGPT's decisive miss:** it recommended the *Club* World Cup (not running) and **never mentioned the actual FIFA World Cup** (running now, the best add on the plan). Its removal list is mostly correct; its additions are half-right (KBO/NPB good, CFL marginal, the two Copas and Club WC wrong-for-now).

---

## Part 8 — Betting-Bot Context (optimise for alerts/ROI, not coverage)

The model is a **Pinnacle-led h2h de-vig detector** (with a legacy consensus fallback). Two structural filters decide whether a sport can ever generate quality alerts, both measured in E2:
1. **Pinnacle must quote the event** (it is the de-vig reference). World Cup/NPB/KBO/NCAA-baseball pass; AFL/NRL/CFL pass only partially; Libertadores/Sudamericana/MiLB/PLL/CSL fail (legacy-only at best).
2. **Enough soft books must quote it** to surface a priced edge.

Active-but-uninvestable today: golf/NBA/NFL/MLB *outright* markets (multi-runner, wrong model), women's election/politics. A sport being "active" (E1) is necessary but **not sufficient** — Libertadores is active with 9 events and still cannot feed the production model (no Pinnacle). This is the exact lesson of `ALERT_VOLUME_EXPANSION_AUDIT.md` (regions added books but **zero** new ideas because the constraint is edges, not book count).

---

## Part 9 — Backtesting Decision

**No historical-backtest credits were spent, and spending them is not justified.** Reasoning:
- `ROI_FIRST_CONFIGURATION_AUDIT.md` established that per-sport settled samples at the achievable size (n≈10–20) carry a **±25–35 pp ROI standard error** — a 5,000-credit historical buy for one new sport would yield ~10–20 settled ideas and *still could not certify the ROI sign*. That is the definition of "evidence that does not meaningfully improve confidence."
- The one thing history *cannot* tell us about never-configured sports — **current Pinnacle/soft-book coverage** — was measured directly for ~39 credits (E2) and is decisive.
- Therefore the correct instrument for the new sports is **live shadow mode** (already supported: edge 2–3% rows stored, never alerted), which generates a real, free, forward sample. Recommend any Tier-A/B add run shadow-first for ~2–3 weeks before promotion — exactly the protocol the prior audits prescribe.

**Total credits this audit: ~39 of the 5,000 budget. Remaining budget unused by design.**

---

## Final Deliverables

### 1. Sports to Remove Now (de-schedule; data retained)
- **20 stranded tennis keys** (keep Wimbledon) — biggest quota reclaim, zero alert loss.
- **22 off-season soccer keys**: EPL, UCL, and the EU summer-break Tier-3 set (austria, belgium, denmark, england_league2, france_ligue_two, germany_bundesliga2/liga3/women/dfb_pokal, greece, italy_serie_b, netherlands, poland, portugal, saudi, `soccer_spl`, switzerland, turkey, australia_aleague).
- `basketball_euroleague`, `americanfootball_ncaaf`; `basketball_nba` + `icehockey_nhl` after ~Jun 19.
- Consider `soccer_brazil_serie_b` → **shadow-only** (measured negative).
- Naturally pausing (no action, season ends): `soccer_spain_segunda_division` after ~Jun 14 — **flag for priority re-enable in August.**

### 2. Sports to Add Now
- **Tier A:** `soccer_fifa_world_cup` (today), `baseball_npb`, `baseball_kbo`.
- **Tier B shadow-trial:** `aussierules_afl`, `rugbyleague_nrl`, `americanfootball_cfl`, `baseball_ncaa` (≤Jun 22).

### 3. Sports to Revisit Later
- **Aug 11:** `soccer_conmebol_copa_libertadores` (knockouts; legacy-model only — verify Pinnacle then).
- **Aug:** re-enable Segunda, then the EU leagues as each restarts (most Aug 1–15; UCL Sept; EPL ~Aug 15).
- **late Aug:** tennis (Canadian/Cincinnati/US Open), NCAAF.
- **Oct:** EuroLeague, NBA, NHL.
- **Jan:** Australian Open.
- Defer pending evidence: Sudamericana, MiLB, PLL, cricket, MMA/boxing.

### 4. Full Seasonality Calendar — see **Part 2**.

### 5. Validation of SPORTS_ACTION_PLAN.txt — see **Part 3.** Sound skeleton, right headline (World Cup), but wrong base count (63 not 68), ≥6 factual errors (Club WC, WC qualifiers, Strasbourg, cricket dates, 7 "active" leagues that are inactive), and Segunda mis-prioritised.

### 6. Validation of ChatGPT Recommendations — see **Part 7.** Removals mostly right; additions half-right; **recommended the wrong World Cup and missed the real one.**

### 7. Expected Impact (theoretical, if recommendations applied)

- **Alert volume:** Adding the World Cup is the only change likely to *raise* sustained volume materially during Jun–Jul (68 dense, deeply-covered events) — plausibly the largest single-sport contributor the bot will have seen, though tournament-soccer CLV is unproven and must be confirmed in shadow. NPB+KBO add steady baseball volume (MLB is the current top producer, so the shape is favourable). The removals lose **zero** alerts (all dead). Realistic net: a temporary World-Cup-driven spike, then NPB/KBO sustaining a modest lift — well short of "5–7/day" (consistent with `ALERT_VOLUME_EXPANSION_AUDIT.md`'s measured ~3/day ceiling at quality).
- **ROI potential:** Improved on two fronts — pruning measured-negative `soccer_brazil_serie_b` to shadow, and adding deep-liquidity Pinnacle-backed markets (World Cup/NPB/KBO) where the de-vig model is on its strongest structural footing. Unproven until ~150–200 settled live ideas exist; **deploy paper/shadow first.**
- **API utilization:** Net **down**. Removing ~42 dead keys (tennis 20 + soccer 22) reclaims on the order of ~900 ingestion+settlement calls/day; the three Tier-A adds cost ~3×24 ≈ 72/day plus settlement. The freed quota more than funds every recommended addition — the portfolio gets *more relevant* while polling *less*.

**Brutally honest bottom line:** the portfolio is a stale, 63-key set that is ~80% off-season, is silently **missing the biggest betting event on Earth** (the World Cup, live now, with the best coverage on the plan), and carries 20 dead tennis keys burning the largest share of quota. Both advisory documents correctly sensed "prune off-season, add in-season" but both fumbled specifics — most damningly, ChatGPT chased a World Cup that ended in 2025 while ignoring the one happening today. Fix three things in priority order: **(1) add the World Cup, (2) add NPB+KBO, (3) stop polling the 42 dead keys.** Everything else is second-order.
