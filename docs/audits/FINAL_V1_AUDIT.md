# FINAL V1 AUDIT — Complete Repository Assessment

**Date:** 2026-06-10
**Scope:** Entire repository — all 70 source files (~12,000 LOC TypeScript), Prisma schema, live database, live Redis state, git history. Previous audit documents used as context only; every claim below was verified against source code or live data.
**Posture:** Principal Engineer / Quant / Product Owner / Investor review. No grade inflation.

---

## Section 1 — Executive Summary

### What the project is

A single-process TypeScript/Node.js service that:

1. Polls The Odds API for 63 traditional sport keys (matches + H2H odds from ~25 bookmakers) on 1h/3h/4h tiers via BullMQ repeatable jobs.
2. Stores append-only odds snapshots in PostgreSQL (Neon) via Prisma.
3. Runs a value-detection pass after each odds ingestion: flags outcomes where **Pinnacle's price exceeds the average implied probability of all other bookmakers by ≥5%** (capped at 100% edge, odds ≤ 3.0).
4. Posts flagged opportunities to a Discord channel, settles them against final scores every 4 hours, and reports paper-trading ROI through Discord slash commands and Rich Presence.

There is no real money, no user system in use, no AI analysis, and no bet placement. It is a **value-bet alerting and paper-tracking bot for a single private Discord server**.

The original architecture document (`ARCHITECTURE-V1.md`) describes a different product — DeepSeek-powered AI analysis, per-user bankrolls, prediction lifecycle. That product was never built. Five database tables (`users`, `user_preferences`, `bankrolls`, `analyses`, `predictions` — all 0 rows), one BullMQ queue (`ai-analysis`), and one required API key (`DEEPSEEK_API_KEY`) are fossils of it.

### What business problem it solves

In its current state: none, beyond entertainment/learning. The detected "edges" are not real edges (Section 6), the ROI numbers are not statistically meaningful and are mechanically inflated by duplicate counting (Section 5), and the project's own headline metric swung from **−53.1% to +19.3% ROI within a single day** as 27 more rows settled. A signal that volatile is noise.

### The three questions

**Would I personally deploy this?** As a hobby alerting bot on a private server — yes, after fixing the P0 items in Section 12 (one of which is that "disabled" esports ingestion is still scheduled in Redis). As anything more — no.

**Would I personally trust the results?** No. Three reasons, each individually disqualifying:
1. The ROI metric counts the same logical bet up to **5 times** (measured: 50 settled rows = 32 logical bets).
2. Settlement silently defaults unresolvable outcomes to LOSS — and I found a settled bet where the bettor's team **won** and it was recorded as a loss (Section 5).
3. n = 23 unique settled traditional bets. At these odds you need thousands of bets to distinguish a 3% edge from zero.

**Would I personally put money behind the strategy?** No. The model is structurally inverted relative to standard value betting (Section 6). It computes "fair odds" from the vig-inflated average of soft bookmakers and bets at Pinnacle — the sharpest book in the market — whenever Pinnacle's price is high. The expected long-run ROI of that strategy is negative by construction, roughly −3% to −10%. The current +19% on 23 logical bets is variance.

---

## Section 2 — Architecture Review

### Grades

| Subsystem | Grade | Summary |
|---|---|---|
| Folder structure | **B+** | Clean feature-module layout (`ingestion/`, `value-detection/`, `settlement/`, `discord/`, `integrations/`, `lib/`). Contracts separated from implementations. Marred by root-level junk (`ahhhh.txt`, `_trace-*.ts`). |
| Service boundaries | **B** | Services, repositories, mappers, workers cleanly separated. But the Discord bot service receives 7 constructor dependencies including raw Prisma — commands query the DB directly, bypassing any domain layer. |
| Dependency injection | **B+** | Consistent constructor injection, no service locator, no globals (one exception: `ENV_PREFIX` reads `process.env` directly in `match-ingestion.worker.ts:33`). Honest, simple, appropriate. |
| Scheduler design | **D** | Repeatable jobs are registered on startup but **never deregistered**. Live Redis contains 70 repeatable jobs, including **4 `sync-esports-game` cron jobs (12:00/17:00 Budapest) that the "esports disable" was supposed to remove**. The disable only deleted the registration code; the schedule survives in Redis and the worker still routes the job name. Esports is not disabled — it is scheduled and will run. Interval changes have the same problem: orphaned old-interval entries accumulate silently. |
| Queue design | **C** | Three queues, one of which (`ai-analysis`) has no producers and a placeholder processor that throws. Two parallel sets of `Queue` instances are created for the same queues (once in `app.ts:initQueues`, again in `ingestion-dependencies.ts`). Concurrency 1 everywhere means the 4-hourly settlement job (63 serial API calls) blocks all ingestion on the match-fetch queue for minutes. All ~25 hourly jobs fire at the same epoch (registered at the same instant with `every`), creating an hourly thundering herd through a concurrency-1 worker. Functional at current scale, but design-by-accident. |
| Ingestion design | **C+** | The two-phase design (match discovery → odds fetch) is reasonable, but the implementation **pays for the same data twice and throws most of it away**: phase 1 calls `/odds` with `markets=h2h,spreads,totals` × `regions=eu,us,uk` (9 quota credits), receives full odds, and discards them (`match-ingestion.service.ts:166` builds plans, only entities are used); phase 2 re-fetches H2H 5 seconds later (3 more credits). The Odds API has a **free** `/events` endpoint for match discovery. ~75–90% of quota spend is waste. Spreads/totals are paid for on every poll and never stored anywhere. |
| Discord architecture | **B−** | Notification service (REST-only) sensibly separated from the gateway bot. But commands don't `deferReply()` (except force-ingestion) while running multi-`COUNT(*)` queries over a 120k-row table — guaranteed 3-second interaction timeouts as data grows. `DiscordBotService.destroy()` exists and is never called in teardown (`app.ts:398-459` tears down 5 deps; the bot isn't one of them). Admin check relies on the member cache, which can false-negative. |
| Database architecture | **C+** | The live tables (`sports` → `matches` → `odds_snapshots`, `value_opportunities`) are well-normalized with sane indexes and source-namespaced external IDs (`oa:`/`ps:`). But ~40% of the schema is dead (5 tables, 8 enums for the never-built product), `odds_snapshots` is unbounded append-only (~48.5k rows/day at current sport set, ~1.5M/month, no retention job), and team identity is `slugify(team_name)` — two distinct teams with the same name in the same sport (a real situation across 35 soccer leagues) silently merge into one row. |
| Prisma usage | **B** | Decent: typed errors translated centrally, nested relation filters used correctly, `createMany` + `skipDuplicates` for snapshots, batched upserts with bounded concurrency for PgBouncer. Weaknesses: per-row upsert loops where `ON CONFLICT` batch SQL would do; the value-detection suppression check is an N+1 `findFirst` inside a loop; Decimal→number coercion is duck-typed (`'toNumber' in v`) and copy-pasted in 7 files. |
| Redis usage | **B−** | Correct ioredis settings for BullMQ (`maxRetriesPerRequest: null`, lazyConnect, capped retry strategy). Used appropriately for the esports odds cooldown and the OddsPapi quota counter. Loses points for the unobserved repeatable-job graveyard (see Scheduler). |
| BullMQ usage | **C** | Repeatable job IDs were eventually added (Sprint 20 fixed one bug) but lifecycle management is missing entirely: no `removeRepeatableByKey` on config change, no startup reconciliation between `TRADITIONAL_SPORT_CONFIGS` and what Redis actually contains. The worst live defect in the system (esports still scheduled) is a direct consequence. |

### Overall architecture verdict

The infrastructure shell — lifecycle state machine (`app-state.ts`), config validation with Zod, graceful teardown with error collection, typed error hierarchy, health endpoint — is genuinely better than most hobby projects. The problem is the **inverted investment ratio**: the scaffolding is built to a standard the business logic never reaches. There is a 177-line retry decorator that is never instantiated, while the actual production API calls have **zero retries**; there is a state machine for app lifecycle, while the scheduler can't tell you what jobs are actually registered.

---

## Section 3 — Code Quality Review

### What is good

- **Consistency.** Naming, file layout, logging discipline (child loggers with `service`/`worker`/`module` context), and JSDoc are uniform across all 70 files.
- **Readability.** Functions are short, control flow is flat, types are explicit. `strict: true`, `noUnusedLocals`, `noImplicitReturns` all enabled and passing.
- **Error hierarchy** (`lib/errors/`) with `retryable` flags and context objects is well-designed (even if the resilience layer that would consume it is unplugged).

### Code smells (exact locations)

| Smell | Location | Detail |
|---|---|---|
| **Zero tests** | `tests/` | Vitest fully configured (`vitest.config.ts`, coverage, setup file) — **0 test files exist** in the entire repository. The settlement money-math, the edge formula, and the outcome-matching logic have never been executed by a test. This is the single largest quality deficit. |
| Dead resilience layer | `integrations/the-odds-api/resilient-client.ts`, `retry.helper.ts`, `retry.config.ts`, `health.checker.ts`; `integrations/pandascore/pandascore.resilient-client.ts`, `pandascore.retry.helper.ts`, `pandascore.health.checker.ts` | ~700 LOC of retry/quota/health decorators. `createOddsApiClient` (`the-odds-api.factory.ts:41`) returns the bare client. Nothing in the production path retries anything. |
| Triple source of truth for sports | `lib/app/app.ts:63-140` (63 keys), `discord/commands/force-ingestion.ts:6-61` (50 keys, already drifted: missing `basketball_euroleague` and 12 tennis keys), DB `sports` table | Guaranteed drift; force-ingestion silently can't ingest 13 configured sports. |
| Dead schema + config | `prisma/schema.prisma:120-361` (User/UserPreferences/Bankroll/Analysis/Prediction + 8 enums), `config/api.config.ts` (`DEEPSEEK_API_KEY` required, never used), `config/betting.config.ts` (`defaultBankroll`, `maxConcurrentBets`, `analysisBudgetDaily` — loaded, validated, never read) | Startup fails without a DeepSeek key the system never uses. |
| Dead queue | `lib/queue/queue-types.ts` (`AI_ANALYSIS`), `worker-factory.ts` (placeholder processor that throws) | A third worker + Redis connections for a queue that can never process anything. |
| Copy-pasted Decimal coercion | `roi.ts:21`, `paper-bankroll.ts:7`, `best-sports.ts:5`, `settlement.service.ts:16`, `value-detection.service.ts:25`, `discord-notification.service.ts:37/43/50`, `value-bets.ts:6` | Seven hand-rolled `toNumber`/`toNum`/`formatOdds` variants of the same duck-typed conversion. |
| Root-level junk committed | `ahhhh.txt`, `_trace-settlement.ts`, `_trace-traditional.ts` | A scratch league list (literally named "ahhhh") and two debug scripts are tracked in git. |
| Broken package scripts | `package.json` → `db:reset`, `db:seed` | Reference `scripts/reset-db.ts` and `scripts/seed.ts`, which do not exist. |
| Magic constants in code | `value-detection.service.ts:6-11` (5% edge, 100% cap, 2 consensus books, 12h suppression), `reporting-config.ts` (baseline date) | The four most important strategy parameters are hardcoded; the only configurable one is `MAX_ALERT_ODDS`. |
| Stale doc-claims | `README.md` ("analyzes them using AI… manages user bankrolls"), `ARCHITECTURE-V1.md` ("Source of Truth") | The README describes a product that does not exist. |

### Fragile areas

1. **`settlement.service.ts:36-60` (`determineBetOutcome`)** — string matching on team names with a silent LOSS default. The most dangerous 25 lines in the repository (proof of damage in Section 5).
2. **`value-detection.service.ts:94-237`** — the entire money-relevant pipeline in one nested loop, with an N+1 query and per-row `[0]` selection (`pinnacleSnaps[0]`) that is order-dependent if duplicates exist (and duplicates have existed — 8 stored opportunities have duplicate consensus bookmaker entries).
3. **`match.repository.ts:68-89`** — the update path can regress a `FINISHED` match (settled with scores) back to `LIVE` with `result: null` if the event reappears in an odds response, because the traditional mapper always emits `result: null` and infers status from `commence_time`.

---

## Section 4 — Bug & Reliability Audit

### CRITICAL

| # | Bug | Evidence | Impact |
|---|---|---|---|
| C1 | **Esports is not actually disabled.** Four `sync-esports-game` repeatable cron jobs (0 12,17 * * *, Europe/Budapest) remain registered in Redis; the match-fetch processor still routes that job name to the full esports pipeline (`queue-registration.ts:53`). | Live Redis query during this audit: 70 repeatable jobs = 63 traditional + 4 esports + 3 system. | Every day at 12:00/17:00 Budapest (while the service runs), PandaScore + OddsPapi ingestion runs with the known fixture-correlation collision bug, inserting corrupted snapshots and value opportunities. OddsPapi quota burns. Because esports *settlement* genuinely was disabled, the resulting opportunities additionally accumulate as permanently-unsettled rows. Directly contradicts `ESPORTS-DISABLE-IMPLEMENTATION.md`. |
| C2 | **Settlement defaults unresolvable outcomes to LOSS, silently.** `settlement.service.ts:59` returns `'LOSS'` when the outcome string matches neither team; the `unresolvable` counter (line 227) is declared and **never incremented** — dead by construction. | Live DB: settled bet on "Lyon Gaming" vs match `Cloud9 – LYON`, result `AWAY_WIN` (LYON **won**), recorded `LOSS −1u`. The partial-match fallback (`"lyon".includes("lyon gaming")` → false) cannot rescue outcomes longer than the canonical name. | Money-math corruption in the system's core metric, biased toward losses, invisible in logs. 3 of 50 settled rows took the fuzzy path; 1 of those 3 (2% of all settled bets) is provably wrong. |
| C3 | **ROI counts the same logical bet up to 5×.** Detection re-inserts the same match+outcome every 12h (suppression window, `value-detection.service.ts:11`) as long as the edge persists; each row settles independently and each counts as a 1-unit bet in every reporting surface. | Live DB: 50 settled rows = **32 logical bets**; "Los Angeles Angels" LOSS counted **5×** (−5u), "IFK Norrkoping" WIN counted 4× (+6.2u), 9 of 32 logical bets duplicated. | All ROI/P&L/win-rate numbers — the product's entire output — are weighted by how long a line stayed mispriced rather than by bets made. The metric is unfixable by filtering; it is wrong at write time. |
| C4 | **A real API key is committed to git.** `.env.example` contains `ODDSPAPI_API_KEY=e8f90400-385c-4c3c-977e-6f78cf6f0cc1` — a live-looking UUID key, unlike every other placeholder in the file. | `.env.example` in repo, present in git history. | Credential leak. Anyone with repo access can drain the 10k/month OddsPapi quota. Needs rotation + history purge. |

### HIGH

| # | Bug | Impact |
|---|---|---|
| H1 | **No retries on any production API call.** The retry layer exists but is never wired (Section 3). A single transient 500/timeout fails the BullMQ job; default job options don't configure `attempts` for repeatable jobs, so the cycle's data is simply lost until the next interval. | Silent data gaps; settlement cycles skip sports on blips (caught per-sport, but never retried). |
| H2 | **Settlement lookback is 3 days** (`getScores(sportKey, 3)`, `settlement.service.ts:93`). If the service is down >3 days (it runs on a PC), finished matches never get scores, their opportunities never settle, and they sit pending forever. No CANCELLED/POSTPONED voiding exists either (12 cancelled matches already in DB; 0 affected opportunities so far — luck). | Zombie pending bets; pending-count and future ROI integrity degrade after any outage. |
| H3 | **`unhandledRejection` → immediate `process.exit(1)`** (`main.ts:24`). Any stray rejection from discord.js/ioredis under network flaps kills the entire service. No supervisor/restart artifact exists in the repo (no Dockerfile for the app, no pm2/systemd config). | Whole-system outage from a single forgotten `await`. |
| H4 | **Quota waste ~4× on every poll cycle** (Section 2, Ingestion). ~900 polls/day × 9 credits for match discovery that a free endpoint could do + 3 credits for the only data actually used. At the current 63-sport configuration this is on the order of **240–320k credits/month**, the large majority avoidable. | Direct cash cost or quota exhaustion; quota state is tracked in-process but exposed nowhere (not in `/health`, not in `/bot-status`). |
| H5 | **Match regression bug** — `match.repository.ts` update path can revert FINISHED→LIVE/`result: null` for events still present in odds feeds (mapper always sends `result: null`). Settlement would then re-mark them. Churn today; wrong-result risk if a re-settle races a reporting read. | Data instability around match end. |

### MEDIUM

- M1 — **Discord interaction timeouts**: every command except force-ingestion replies without deferring; `/bot-status` runs three sequential unfiltered `COUNT(*)` (120k+ rows and growing ~48.5k/day). Will exceed Discord's 3s window. (`discord-bot.service.ts:159-227`)
- M2 — **Reporting surfaces disagree**: `/value-bets` and `/test-value-bets` apply neither the TRADITIONAL filter nor the V2 baseline — they will happily surface corrupted esports rows with 60%+ "edges" next to the filtered surfaces. Three different ROI formulas coexist: per-row including pushes (`roi.ts:54`), wins+losses only (presence), P&L/1000 (paper-bankroll). Same data, three numbers.
- M3 — **Consensus quality**: `MIN_CONSENSUS_BOOKMAKERS = 2` counts snapshot rows, not unique books (8 stored opportunities have duplicate consensus bookmaker entries); the consensus pool mixes betting exchanges (`betfair_ex_uk/eu` — commission, not vig), regional clones of the same parent book (`unibet`, `unibet_uk`, `unibet_se`, `unibet_nl` count as four "independent" books), and `lowvig`/`betonlineag` (sharp-ish) with true softs — an unweighted average over a correlated, heteroskedastic pool.
- M4 — **Discord bot never destroyed on shutdown** — teardown ignores it; only the 30s force-exit timer ends the process.
- M5 — **Suppression depends on alert success**: `alertedAt` is set only after a successful Discord POST. If Discord is down, suppression never engages and every cycle inserts new duplicate rows (compounding C3).
- M6 — **Hourly thundering herd + serialized settlement** on a concurrency-1 worker: settlement (63 serial score calls) delays all ingestion jobs behind it every 4 hours.

### LOW

- L1 — `inferOddsApiMatchStatus` marks any started match LIVE forever until settlement catches it (`mapper.utils.ts:46`); snapshots for stuck-LIVE matches keep being collected (`isLive: false` filter protects detection — but only because *pre-match* snapshots carry `isLive: false`).
- L2 — NFL/NCAAF tie → `DRAW` → two-way H2H bets settle LOSS instead of push (`PUSH` is unreachable in `determineBetOutcome` — `calcProfitLoss` has a push branch that can never execute).
- L3 — `periodCutoff` uses local-timezone `setDate` while everything else is UTC (`roi.ts:13-19`).
- L4 — Admin gate uses the member cache; uncached admins get "admin-only" rejections (`discord-bot.service.ts:140-146`).
- L5 — `getRepeatableJobs()`-based reconciliation, alerting on `failed` queue counts: absent. Failed jobs are only visible if someone runs `/bot-status`.

---

## Section 5 — Data Quality Audit

### The five questions, answered directly

**Can the system generate false positives?** Yes — *structurally, not incidentally*. Three independent mechanisms:
1. **No de-vigging anywhere.** Consensus probability = mean of raw `1/odds` across soft books (`value-detection.service.ts:154-155`). Raw implied probabilities embed each book's margin (overround), so the "fair odds" are systematically too short, inflating every computed edge by roughly the average consensus margin (~5–7% on soccer H2H). A large share of the "≥5% edge" population is bookmaker vig, not value.
2. **Sharp/soft inversion.** Pinnacle's prices are higher than soft books' on average *because Pinnacle charges less vig*. Flagging "Pinnacle > soft average" selects the normal state of the market, filtered only by the 5% threshold.
3. **The esports correlation collision** (now confirmed still schedulable, C1): `correlateMatch` (`esports-odds-ingestion.service.ts:23`) maps multiple OddsPapi fixtures to the same DB match (first-match-wins, no fixture dedup), producing duplicate same-bookmaker snapshots in one batch and historic "edges" of 60–600% (settled esports rows average **67.6% edge** in the live DB).

**Can it generate false negatives?** Yes, but it's the lesser problem: the 3.0 odds cap excludes all underdog value; the latest-batch filter (`capturedAt` exact-equality, `value-detection.service.ts:102`) discards any bookmaker that didn't appear in the newest poll; 60-minute polling misses anything that closes faster.

**Can it miscalculate ROI?** It *currently does*, four ways at once: duplicate logical bets (C3 — 36% of settled rows are duplicates), mis-settlement (C2), partial-settlement selection bias (before the settlement-coverage fix, only 16 of 50 sports' bets ever settled — the −53% headline was computed over whichever bets happened to be settleable), and surface-formula divergence (M2).

**Can it mis-settle bets?** Proven, with a named victim: *Lyon Gaming, −1u recorded on a won bet.* The mechanism (silent LOSS default + never-incremented `unresolvable` counter) remains in the code path for every future name divergence, including traditional-sport team-name collisions created by `slugify`-based identity.

**Can it inflate edge values?** Historically yes (esports, up to the 100% cap added later; the cap merely discards >100% rows, it does not fix the computation). Structurally yes for all sports via missing de-vig.

**How serious?** For a system whose entire output is "edge found, here's our ROI": fatal until fixed. The pipeline's plumbing (ingestion, storage, scheduling) is largely sound; the *numbers it emits* are not trustworthy end-to-end.

---

## Section 6 — Betting Model Audit

### The model in one sentence

Bet (on paper) at Pinnacle whenever Pinnacle's H2H price is ≥5% above the unweighted, vig-inclusive average of every other bookmaker's price, max odds 3.0, max one alert per match+outcome per 12h.

### Strengths

- The *infrastructure* for a real model exists: time-stamped multi-book snapshot history is exactly the dataset you need.
- Using Pinnacle as a reference point is half-right — Pinnacle belongs in the model.
- Sensible guardrails were added empirically (odds cap, edge cap, suppression, min-consensus), showing the author responds to observed failure modes.

### Weaknesses / blind spots

1. **The direction is backwards.** Standard value betting: take the *sharp* book (Pinnacle), remove its vig to get true probabilities, then bet at *soft* books whose prices exceed fair. This system does the opposite — it treats the soft-book average (vig included) as truth and bets at the sharp book. When Pinnacle is 5%+ above the soft consensus, the two dominant explanations are (a) Pinnacle moved on sharp information and the softs are stale — you are betting *against* the information; or (b) soft books are shading a popular side — you are getting Pinnacle's fair-ish price minus Pinnacle's vig. Neither is +EV.
2. **No de-vigging** (Section 5) — the 5% threshold is measured against an inflated baseline, so the *effective* threshold vs true probability is roughly 0–2%, within noise.
3. **No closing-line comparison.** The paper bet is "placed" at capture time, up to 48h pre-match, at a price that may be gone minutes later. There is no CLV tracking, which is the only fast-converging measure of whether alerts beat the market.
4. **Unweighted, correlated consensus** (M3): Unibet's four regional skins get four votes; exchanges and quasi-sharps pollute the "soft" signal.
5. **One market (H2H), one candidate book, no liquidity/limit awareness, no staking model beyond flat 1u.**

### Verdict

**Does this have a realistic edge?** No. **Expected ROI: negative.** My estimate for the strategy as implemented, played at real Pinnacle prices with flat stakes: **−3% to −10% long-run** (Pinnacle's margin plus adverse selection from betting against line moves, partially offset by occasional genuine soft-side shading captures). Break-even is the optimistic tail, not the center.

**Confidence:** High on the sign (negative), moderate on the magnitude. This is the consensus mechanism of how sharp/soft books work, not a subjective opinion.

**What evidence is missing?** Everything that would prove an edge: (1) CLV — do alerted prices beat Pinnacle's closing line? Answerable in ~100–200 alerts (weeks, not years). (2) A de-vigged backtest over the snapshot history already being collected (and `getHistoricalOdds` already exists, unused, in the client). (3) ≥2,000–8,000 deduplicated settled bets for a direct ROI test at these odds (variance per 1u bet at avg odds 2.85 ≈ 1.87; detecting +3% at 95% confidence needs n ≈ 8,000). Current n: **23**.

---

## Section 7 — Profitability Audit

Assumptions as instructed: Pinnacle candidate, consensus model as implemented, flat 1-unit staking.

| Dimension | Assessment |
|---|---|
| Theoretical profitability | Negative. The selection rule is "price at the lowest-vig book exceeds the vig-inflated mean of higher-vig books" — a filter that fires on normal market structure plus steam moves. After removing the vig illusion, the true median edge of alerted bets is ≈ 0 minus Pinnacle's ~2.5% margin, minus adverse selection on steam. |
| Practical profitability (if bets were real) | Worse than theoretical: 60-min polling means alerted prices are stale; Pinnacle's line at bet time would frequently already be past the alert price (you'd get the post-move number); no limits modeling. |
| Scalability | The losing direction scales perfectly — Pinnacle welcomes this flow and won't limit a losing bettor. (The profitable inverse — beating soft books — gets accounts limited, which is the real-world constraint the roadmap must eventually face.) |
| Survivorship/selection bias | Already observed in production: the −53% era was computed over the settleable subset of sports; per-sport reporting (`/best-sports`) invites cherry-picking the lucky sport (dota-2 showed +250% on 2 bets). Duplicate-counting (C3) overweights long-lived mispricings. |
| Bookmaker bias | The consensus is dominated by correlated soft-book families and includes exchanges; "consensus probability" is not an independent estimate of truth. |
| Sample size required | ~8,000 flat-stake bets to confirm a +3% edge at 95% confidence at avg odds ~2.85. At the current ~10–25 unique alerts/week: **6–15 years**. CLV measurement shortens this to weeks — it must be built if the project continues. |

**Realistic ROI range expectation: −10% to −2% long-run; anything between −25% and +25% over any 100-bet window is indistinguishable noise.** The observed +19.3% (n=40 rows / 23 logical bets) and the prior −53.1% are both inside the noise band — the metric has already demonstrated this by flipping sign within one day.

---

## Section 8 — V1 Completion Review

### Implemented (works as coded)
- [x] 63-sport traditional ingestion on tiered repeatable schedules
- [x] Append-only multi-bookmaker H2H snapshot store with batch inserts
- [x] Value detection with edge threshold, odds cap, edge cap, min-consensus, 12h suppression
- [x] Discord alerts with alert-state tracking (`alertedAt`), length-capped messages
- [x] Settlement loop: scores fetch → match result → opportunity settlement → outcome notifications
- [x] Daily summary at 23:00 Budapest; settlement every 4h
- [x] Discord slash commands: roi, paper-bankroll, best-sports, value-bets, test-value-bets, bot-status, force-scan, force-ingestion
- [x] Rich Presence with ROI + dynamic sport count; ROI V2 baseline constant shared across 5 surfaces
- [x] Config validation (Zod, fail-fast, frozen), structured logging with redaction, typed error hierarchy
- [x] Health endpoint (DB/Redis/queues), graceful shutdown with force-exit timer, lifecycle state machine

### Partially implemented (exists but defective or unwired)
- [ ] **Esports disable** — scheduler code removed; live Redis schedule + manual backdoor + worker routing remain (C1)
- [ ] **Settlement correctness** — works for exact name matches; silent-LOSS fallback, no PUSH path, no void handling, 3-day lookback ceiling (C2/H2/L2)
- [ ] **ROI integrity** — baseline + category filters exist; duplicate logical-bet counting defeats them (C3); 2 of 7 surfaces unfiltered (M2)
- [ ] **Resilience** — retry/quota/health classes complete and dead (H1); quota visible nowhere
- [ ] **Quota management** — OddsPapi tracked in Redis with hard stop; The Odds API tracked in-memory, enforced nowhere, wasted 4× (H4)
- [ ] **Operational visibility** — health endpoint exists; nothing consumes it; no alerting on failed jobs/quota/settlement anomalies

### Missing (claimed or implied, not built)
- [ ] Any tests (unit, integration, e2e) — zero exist
- [ ] AI analysis (DeepSeek) — README headline feature; never started
- [ ] User accounts / per-user bankrolls / predictions — dead schema only
- [ ] De-vigging / closing-line value / any model validation instrument
- [ ] Backtesting (historical odds client method exists, unused)
- [ ] Repeatable-job reconciliation; retention/pruning for snapshots
- [ ] Deployment artifact (app Dockerfile/service definition), runbook, backup/restore procedure
- [ ] `db:reset` / `db:seed` scripts referenced by package.json

---

## Section 9 — Production Readiness Review

| Area | State |
|---|---|
| Deployment | No app container, no service manager config, no CI. Runs via `tsx watch` from a developer Windows machine against Neon + local Redis. A laptop reboot stops ingestion and (after 3 days, H2) silently corrupts pending-bet settlement. |
| Operations | No runbook beyond scattered audit docs. Recovery from the most common failure (stale repeatable jobs) isn't documented — the team doesn't know it's happening (C1). |
| Observability | Structured logs: good. Metrics: none. Quota: invisible. Failed-job alerting: none. The `/health` endpoint has no consumer. The only monitoring is a human running `/bot-status`. |
| Monitoring of the *product* (not the process) | None. Nothing watches "alerts/day", "settlement lag", "unsettled aging", "edge distribution drift" — the metrics that would have caught C2/C3 immediately. |
| Backups/recovery | Neon presumably provides PITR; nothing in the repo documents or tests restore. Redis state (repeatable jobs, cooldowns, quota counts) is unmanaged — flushing it would actually *fix* C1 by accident, and nobody would know why. |
| Security | Real API key in git (C4). Other secrets handled correctly (env + log redaction). Discord admin gate is adequate for a private guild. |

**Classification: Prototype, upper end.** It is not an MVP of a *betting intelligence* product because the intelligence (the one thing it claims to do) is structurally wrong and unmeasured. It is a well-plumbed prototype of an odds-data platform with a placeholder strategy on top. Calling it "V1 production" (as `SPRINT25-PRODUCTION-READINESS-REVIEW.md` leans toward) is not supported by the evidence; that review predates the discoveries above.

---

## Section 10 — Skill Level Assessment

Judging strictly from the repository: the work pattern is unmistakably **LLM-generated code under human orchestration at very high velocity** — ~12,000 LOC, 70+ polished audit documents, and 5 commits' worth of "sprints" in **four calendar days** (first commit 2026-06-06, latest 2026-06-10), with uniform style and documentation density no human team produces at that speed.

So the honest question is: what level does the *orchestrating developer* demonstrate?

- **Above junior:** insists on DI, typed config, lifecycle management; iterates on observed bugs (message limits, duplicate alerts, BullMQ jobId collision); commissions and reads audits; asks for brutally honest review.
- **Below mid/senior in the dimensions that decide outcomes:**
  - **No tests were ever demanded.** A senior does not let money-math ship untested, AI-written or not.
  - **No verification loop closed.** "Esports disabled" was accepted on the strength of a document while the live Redis schedule said otherwise; the −53% ROI was investigated, but the duplicate-counting underneath every ROI number went unnoticed.
  - **Domain fundamentals missing:** no de-vigging and the sharp/soft inversion are first-chapter errors in quantitative betting; no CLV instinct.
  - **Accretion over consolidation:** three sport-key lists, seven Decimal coercions, dead subsystems retained, junk files committed.

**Assessment: Junior+ to Mid-level effective engineering judgment, leveraging tooling that produces senior-*looking* output.** The gap between surface polish and load-bearing correctness is exactly where that judgment shows. (The fastest fix is process, not study: require tests and live-state verification for every change that touches money or schedules.)

---

## Section 11 — What Has No Value?

Delete list — each item is net-negative (carrying cost, confusion, startup friction) with zero current benefit:

1. **Dead schema**: `User`, `UserPreferences`, `Bankroll`, `Analysis`, `Prediction` models + `UserStatus`, `CurrencyCode`, `BankrollStatus`, `AnalysisStatus`, `AnalysisTrigger`, `ValueLevel`, `PredictionStatus`, `PredictionResult` enums. 0 rows, 0 code references. One migration removes ~240 schema lines.
2. **`AI_ANALYSIS` queue + its worker + its placeholder processor** (`queue-types.ts`, `worker-factory.ts`, `ingestion-dependencies.ts:131-134`). It exists to throw.
3. **`DEEPSEEK_API_KEY` requirement** and the unused betting config trio (`defaultBankroll`, `maxConcurrentBets`, `analysisBudgetDaily`).
4. **The unwired resilience layer** — decide: wire `ResilientOddsApiClient` in (1-line factory change, recommended) or delete `resilient-client.ts`, `retry.helper.ts`, `retry.config.ts`, both health checkers, `pandascore.resilient-client.ts`, `pandascore.retry.helper.ts` (~700 LOC). Keeping it unplugged is the only indefensible option, and it's the current one.
5. **`getHistoricalOdds`, `getMatch`, `getTeam`** client methods — unused (keep `getHistoricalOdds` only if the backtesting roadmap item is accepted).
6. **Root junk**: `ahhhh.txt`, `_trace-settlement.ts`, `_trace-traditional.ts`; broken `db:reset`/`db:seed` script entries; `src/scripts/validate-esports-pipeline.ts` (488 LOC validating a pipeline that's supposed to be off).
7. **`SPORT_KEY_TO_GROUP` in force-ingestion** — derive from `TRADITIONAL_SPORT_CONFIGS` (export it) instead of maintaining a drifted copy.
8. **Esports pipeline code-path** (worker routing, force-ingestion esports branch, OddsPapi service) — either fix the correlation bug and turn it on deliberately, or remove the routing so "disabled" means disabled. A backdoor into a known-corrupt pipeline has negative value.
9. **`docs/audits/` as a flat 70-file pile** — consolidate to a `docs/` index + current-state docs; the sprint-by-sprint archaeology belongs in `docs/archive/`. The audits cost real review time (this one included) because superseded claims sit next to current ones with equal authority.
10. **Spreads/totals in the phase-1 odds request** — paying 3× market cost for data discarded on arrival.

Overengineered: items 1–5 (infrastructure for products that don't exist). Underengineered: tests, settlement identity, scheduler lifecycle, model math — the actual product.

---

## Section 12 — Highest ROI Improvements (Top 20)

| # | P | Improvement | Impact | Difficulty |
|---|---|---|---|---|
| 1 | **P0** | Remove the 4 stale `sync-esports-game` repeatables from Redis (`queue.removeRepeatableByKey`) + add startup reconciliation: deregister any repeatable not derivable from current config | Stops live corruption + quota burn; makes scheduler state declarative | Low (hours) |
| 2 | **P0** | Rotate the leaked OddsPapi key; purge from git history; replace with placeholder | Closes credential leak | Low |
| 3 | **P0** | Settlement: never default to LOSS. Unresolvable → leave unsettled + increment counter + WARN log + Discord ops ping; backfix the Lyon Gaming row | Stops silent money-math corruption | Low |
| 4 | **P0** | Kill duplicate logical bets: partial unique index on (matchId, outcome) WHERE settledAt IS NULL (one open bet per outcome), or dedup to first-capture at settlement; recompute historical stats on logical bets | Makes every ROI number mean something | Medium |
| 5 | **P0** | Tests for `determineBetOutcome`, `calcProfitLoss`, edge math, suppression, and the reporting queries (the money paths) | Converts every future change from gamble to engineering | Medium |
| 6 | **P1** | De-vig the consensus (normalize each bookmaker's implied probs to sum 1 within the H2H market before averaging) | Removes the structural edge inflation; prerequisite for any honest signal | Medium |
| 7 | **P1** | Add CLV tracking: store Pinnacle's last pre-kickoff price per alerted outcome; report avg CLV in `/roi` | The only fast feedback on whether alerts beat the market — weeks instead of years | Medium |
| 8 | **P1** | Decide the model's direction (recommended: de-vigged Pinnacle = truth; alert when *soft* books exceed it; track paper bets at the soft price) | Turns a structurally −EV detector into the standard +EV pattern the data already supports | Medium (the data model barely changes) |
| 9 | **P1** | Quota fix: free `/events` (or h2h-only) for phase-1 discovery; drop spreads/totals; expose both APIs' quota in `/bot-status` + `/health` | ~4× cost reduction; visibility | Low–Medium |
| 10 | **P1** | Wire `ResilientOddsApiClient` into the factory (or set BullMQ `attempts`/backoff on repeatables) | Basic reliability for every external call | Low |
| 11 | **P1** | Settlement robustness: store the source event id on the opportunity (it's `match.externalId` already — match outcomes by The Odds API's own `home_team`/`away_team` strings captured at detection time, not by canonical Team names); raise lookback or detect gaps | Removes the name-matching fragility class entirely | Medium |
| 12 | **P1** | Unify reporting: one shared settled-bets query module + one ROI formula; apply TRADITIONAL+baseline filters to `/value-bets`, `/test-value-bets` | One truth instead of three | Low |
| 13 | **P2** | Void handling: CANCELLED/POSTPONED matches → PUSH/void pending opportunities after a grace period | No zombie pendings after outages | Low |
| 14 | **P2** | `deferReply()` on all commands; replace `COUNT(*)` trio with cheap estimates or cached counts | Commands keep working as tables grow | Low |
| 15 | **P2** | Snapshot retention job (e.g. keep raw rows 90 days, roll up older to per-match-bookmaker open/close) — but retain enough for backtesting | Caps unbounded growth (~1.5M rows/month) without losing the dataset's research value | Medium |
| 16 | **P2** | Deployment artifact: Dockerfile + compose service (or NSSM/pm2 on the PC) with restart policy; remove `process.exit` on unhandledRejection in favor of log+continue or supervised restart | Survives reboots and stray rejections | Medium |
| 17 | **P2** | Export `TRADITIONAL_SPORT_CONFIGS`; derive force-ingestion's list; delete the drifted copy | Kills the triple source of truth | Low |
| 18 | **P2** | Ops alerting: Discord ops-channel ping on failed jobs > N, quota > 80%, unsettled age > 48h, zero alerts in 24h | The product monitors itself | Medium |
| 19 | **P3** | Schema cleanup migration (Section 11 items 1–3) + repo hygiene (junk files, broken scripts, README rewrite to describe the actual product) | Lower confusion tax for every future session | Low |
| 20 | **P3** | Shared `decimal.ts` util; jitter repeatable schedules; close Discord client in teardown | Polish | Low |

---

## Section 13 — Future Roadmap

**V1.1 — "Make the numbers true" (1–2 weeks of focused work).** Items 1–5 + 9–12 above. Exit criteria: zero duplicate logical bets, zero silent LOSS defaults, retries on all API calls, one ROI formula, quota visible, tests on money paths. *Do not add features before this.*

**V1.5 — "Find out if there's anything here" (2–4 weeks).** De-vig (#6), CLV tracking (#7), model direction decision (#8), and a backtest harness over the accumulating snapshot history (the `getHistoricalOdds` client method finally earns its keep). Exit criteria: a CLV report over ≥200 alerts. **This is the go/no-go gate for the entire project.** If alerts don't beat the close, no amount of V2 features matters.

**V2 — only if V1.5 shows positive CLV.** Multi-book candidate scanning (bet where the price is, not only Pinnacle), weighted/trimmed consensus, line-movement features, proper bankroll math (fractional Kelly on de-vigged edge), spreads/totals markets (the ingestion already pays for them today and discards them), and a real deployment.

**V3 — different products, evaluate separately:**
- **Polymarket/Kalshi**: not an extension of this model — different market microstructure (order books, event contracts, fees, US-person/jurisdiction constraints for Polymarket). The *interesting* V3 play is cross-venue: de-vigged sportsbook consensus vs prediction-market prices, where genuine dislocations occur and you can actually get filled. Worth a spike only after V1.5 proves the team can measure edge honestly.
- **Arbitrage detection**: the snapshot store supports it cheaply (max price per outcome across books summing to <100% implied). Low model risk, high execution/limits risk in reality; fine as a detector feature.
- **AI analysis (the original DeepSeek vision)**: skip. LLM match commentary will not beat de-vigged market prices; it adds cost and authority-laundering to a system whose problem is statistical honesty, not narrative.
- **Multi-user/commercial**: do not consider before a 6-month verified track record. Selling picks from an unvalidated −EV model is reputational (and possibly regulatory) self-harm.

---

## Section 14 — Final Verdict

| Dimension | Score | Rationale |
|---|---|---|
| Architecture | **6/10** | Sound modular monolith and DI; dead subsystems, unmanaged scheduler state, double-fetch ingestion |
| Code Quality | **5/10** | Consistent, readable, strictly typed; zero tests, ~1,000 LOC dead, triple truths, copy-paste utilities |
| Reliability | **4/10** | Graceful lifecycle exists; no retries wired, ghost cron jobs, exit-on-rejection, 3-day settlement window, runs on a PC |
| Data Quality | **3/10** | Good raw snapshot store; duplicate bet counting, proven mis-settlement, corrupted historical edges, inconsistent surfaces |
| Profitability Potential | **2/10** | Structurally inverted model; expected negative ROI; n=23; no CLV. The 2 (not 1) is for the dataset being collected, which a correct model could use |
| Production Readiness | **3/10** | Health endpoint and logs exist; no deployment, no monitoring consumer, no backup story, leaked key |
| **Overall** | **3.5/10** | A well-plumbed prototype wearing a production costume, reporting numbers it cannot stand behind |

### Continue, shut down, pivot, or scale?

- **Continue investing time?** Yes, conditionally — the snapshot dataset, ingestion pipeline, and Discord surface are genuinely reusable assets, and the gap between this and an honest experiment is weeks (V1.1 + V1.5), not months. Condition: the next two milestones are *correctness* and *measurement*, with tests, and nothing else.
- **Continue investing money?** Only the minimum to reach the V1.5 CLV gate (API quotas, which item #9 cuts ~4×). Nothing beyond that until CLV is positive. Do not fund V2 features, more sports, or more surfaces on the current model.
- **Shut it down?** Not yet — but set the tripwire now: if after the model is corrected and 200+ alerts are measured the CLV is ≤ 0, stop, archive the dataset, and keep the pipeline as a portfolio piece. Decide with the instrument, not with the ROI slot machine.
- **Pivot?** The honest pivot is already described in V1.5/#8: flip the model to the standard sharp-reference/soft-target direction. That is a small code change and a complete strategy change. The bigger pivot (cross-venue vs prediction markets) is optional later.
- **Scale it?** No. Scaling multiplies a negative number. Nothing in this system is scale-constrained today except the quota bill, and the strategy must earn scaling first.

### Closing statement

This repository's defining trait is **asymmetry**: senior-grade scaffolding around an unvalidated, structurally backwards core, with zero tests guarding the money math and a reporting layer that has already shown both −53% and +19% for the same strategy in the same day. The previous 70 audit documents mostly graded the scaffolding — and at least one of them (`ESPORTS-DISABLE-IMPLEMENTATION.md`) certified a change the live system contradicts. The way forward is unglamorous: make the numbers true, build the one instrument that can detect an edge quickly (CLV), point the model the right way around, and let the measurement — not the dashboard — decide whether this becomes a product.
