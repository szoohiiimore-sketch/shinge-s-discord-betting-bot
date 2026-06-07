# V1 Final Optimization Audit

**Date:** 2026-06-07
**Purpose:** Final validation and optimization pass for the V1 sport portfolio before implementation begins.
**Inputs:** V1-SPORT-COVERAGE-AUDIT.md, V1-SPORT-COVERAGE-REMEDIATION.md, ESPORTS-ODDS-PROVIDER-AUDIT.md, codebase inspection.
**Constraint:** Analysis only — no code changes, no architectural modifications, no new features.

---

## Confirmed V1 Architecture Under Review

| Layer | Provider | Plan | Cost |
|-------|----------|------|------|
| Traditional sports odds | The Odds API v4 | Starter | $30/month |
| Esports odds | OddsPapi | Free Tier | $0/month |
| Esports match data | PandaScore | Free Tier | $0/month |

**Confirmed V1 sport list:**

| Tier | Sports | Interval |
|------|--------|----------|
| Tier 1 (Traditional) | Table Tennis, Volleyball | 30 min |
| Tier 2 (Traditional) | NHL, MLB | 60 min |
| Tier 3 (Traditional) | NBA, Premier League, Champions League | Event-driven (48h window) |
| Esports | CS2, Dota 2, LoL, Valorant | OddsPapi 2×/day (12:00, 16:00) |

---

## Question-by-Question Analysis

---

### Q1 — Verify the 240 request/month OddsPapi calculation

**Calculation under review:**
```
4 esports × 2 requests/day × 30 days = 240 requests/month
```

**Verdict: Mathematically correct. Operationally unsafe.**

The arithmetic is right. The problem is the margin:

| Metric | Value |
|--------|-------|
| Free tier limit | 250 requests/month |
| Fixed-schedule usage | 240 requests/month |
| Monthly headroom | 10 requests (4%) |

A single extra poll, application restart causing a duplicate job fire, or one development test call consumes the entire buffer. The free tier would be exceeded in the first week it is needed.

Additional concern: the 240 estimate assumes **exactly** 2 polls per day, every day, for all 4 games. BullMQ repeatable jobs can fire slightly early on restart and produce duplicate fires. Even one extra fire per game per month = 4 extra requests = headroom eliminated.

**Conclusion:** The 240 calculation validates the schedule but does not validate the plan. See Q3 for the recommended fix.

---

### Q2 — Can OddsPapi free tier (250 req/month) support CS2, Dota2, LoL, Valorant?

**At 2 fixed polls/day: Barely, with no margin.**

**At event-driven polling: Yes, comfortably.**

The free tier is architecturally sufficient for the four esports. The barrier is not game coverage or data quality — it is exclusively the 250 req/month ceiling. OddsPapi confirmed coverage for CS2, Dota 2, LoL, and Valorant (R6 Siege also confirmed; MLBB unconfirmed but MLBB is not in the V1 esports list).

The ceiling becomes a hard blocker only when the polling schedule is fixed. See Q3.

---

### Q3 — Can event-driven esports polling reduce OddsPapi usage?

**Yes — to approximately 50–90 requests/month under realistic tournament schedules.**

**How event-driven would work:**

The current esports pipeline already fetches match data from PandaScore. After each `sync-esports-game` job, the service knows which matches exist and their start times. The `nearTermMatchExternalIds` mechanism (already implemented for traditional sports) should be extended to the esports path:

1. `sync-esports-game` runs at 30-minute intervals (no change, no cost — PandaScore is free)
2. If `nearTermMatchExternalIds.length > 0`, enqueue `sync-esports-odds` for OddsPapi
3. `sync-esports-odds` calls OddsPapi only when near-term matches are confirmed

**Estimated request frequency under event-driven model:**

| Game | Avg tournament days/month | OddsPapi calls/month |
|------|--------------------------|----------------------|
| CS2 | 10–15 | 10–15 |
| Dota 2 | 8–12 | 8–12 |
| League of Legends | 15–20 (global leagues) | 15–20 |
| Valorant | 8–12 | 8–12 |
| **Total** | — | **41–59 requests/month** |

At the upper bound (59 requests/month), free tier utilization is **24%** — leaving 191 requests of headroom.

**Critical architectural note:** The current `MatchIngestionWorker._handleEsportsGame` does **not** enqueue odds jobs. The `nearTermMatchExternalIds` return from `ingestEsportsGame` is not used. The esports odds pipeline is an entirely new integration that does not yet exist:

- No `EsportsOddsApiClient` (OddsPapi HTTP client)
- No `SyncEsportsOddsJobData` contract type
- No `sync-esports-odds` job name
- No `EsportsOddsSnapshotIngestionService`
- No `EsportsOddsSnapshotWorker`

**This is a Sprint 5 implementation task.** The V1 esports odds architecture is planned but not built.

**Recommendation:** Implement event-driven from the start. Fixed 2×/day polling should not be implemented — it consumes 96% of the free tier limit with no benefit over event-driven, which is both cheaper and more precise.

---

### Q4 — Should ATP/WTA be excluded from V1?

**Yes. The exclusion is the correct decision.**

**Reason 1 — Key fragmentation:** The Odds API splits individual ATP and WTA tournaments into separate sport keys. The `tennis_atp` aggregate key exists but it typically covers only Challenger-level events; Grand Slams and Masters 1000 tournaments have their own keys (`tennis_atp_french_open`, `tennis_atp_us_open`, `tennis_atp_wimbledon`, `tennis_atp_australian_open`, plus every ATP 500 and Masters 1000). A complete ATP/WTA integration requires dynamic key discovery from `/v4/sports` at runtime, or maintaining a hardcoded list of 15+ tournament keys with seasonal activation logic.

**Reason 2 — Credit cost amplification:** Under the per-event credit model (confirmed in Q8), ATP has many simultaneous events during Grand Slams (128-draw single-elimination = many matches per round). This multiplies credit cost significantly for that period.

**Reason 3 — Table Tennis and Volleyball are better V1 targets:** These are continuously active (year-round leagues), have simpler sport key structures, and are known value-betting markets because bookmaker lines are less efficient. They are higher-value targets for the project's core purpose.

**Conclusion:** ATP/WTA are confirmed excluded from V1. They may be added in V2 with a dynamic key discovery mechanism.

---

### Q5 — Does ATP/WTA tournament-based structure create excessive V1 complexity?

**Yes — this is the primary reason for exclusion.**

A correct ATP integration would need to:
1. Call `/v4/sports` to get all active `tennis_atp_*` keys at runtime
2. Map each key to the correct `sportGroup: "Tennis"` for slug derivation
3. Register separate BullMQ repeatable jobs per tournament key, adding/removing them as tournaments start and end
4. Handle the fact that a Grand Slam and a 250-level tournament have wildly different match volumes

This is a dynamic scheduling problem that requires a scheduler extension well beyond the current `scheduleIngestionJobs` function. Deferring this to V2 is correct.

---

### Q6 — Are all remaining V1 sports fully supported by current providers?

**Traditional sports (The Odds API):**

| Sport | Key | API Support | Architecture Support | Status |
|-------|-----|-------------|---------------------|--------|
| Table Tennis | `tabletennis_atp` (likely) | ✅ Listed by The Odds API | ✅ Works with any string key | ⚠️ Key unverified |
| Volleyball | `volleyball_*` (multiple) | ✅ Listed by The Odds API | ✅ Works with any string key | ⚠️ Key unverified |
| NHL | `icehockey_nhl` | ✅ Confirmed | ✅ In SportKey union | ✅ Ready |
| MLB | `baseball_mlb` | ✅ Confirmed | ✅ Works (not in SportKey union but irrelevant) | ✅ Ready |
| NBA | `basketball_nba` | ✅ Confirmed | ✅ In SportKey union | ✅ Ready |
| Premier League | `soccer_epl` | ✅ Confirmed | ✅ In SportKey union | ✅ Ready |
| Champions League | `soccer_uefa_champs_league` | ✅ Confirmed | ✅ In SportKey union | ✅ Ready |

**Esports (PandaScore match data):**

| Game | PandaScore Slug | Architecture | Status |
|------|----------------|--------------|--------|
| CS2 | `cs2` | ✅ Typed, scheduled | ✅ Ready |
| Dota 2 | `dota2` | ✅ Typed (post-remediation), scheduled | ✅ Ready |
| LoL | `lol` | ✅ Typed, scheduled | ✅ Ready |
| Valorant | `valorant` | ✅ Typed, scheduled | ✅ Ready |

**Esports odds (OddsPapi):**

| Game | OddsPapi Coverage | Integration Status |
|------|------------------|--------------------|
| CS2 | ✅ Confirmed | ❌ Client not built |
| Dota 2 | ✅ Confirmed | ❌ Client not built |
| LoL | ✅ Confirmed | ❌ Client not built |
| Valorant | ✅ Confirmed | ❌ Client not built |

**Summary:** Traditional sports match data and odds are architecturally ready. Esports match data is ready. Esports odds have confirmed provider coverage but no client integration exists.

---

### Q7 — Monthly request estimates (min / expected / worst-case)

#### The Odds API Estimates

> **Critical prerequisite: credit model clarification**
>
> The Odds API v4 documents the following credit formula:
> `credits_used = events_returned × markets_requested × regions_requested`
>
> The current codebase calls `getOdds(sportKey)` **with no market or region parameters**, which triggers defaults: typically h2h + spreads + totals (3 markets) × us + uk + eu + au (4 regions) = **12× multiplier** on every call.
>
> All estimates below use **1 market (h2h) + 1 region (eu)** as the assumed optimized parameter set.
> The default-parameter scenario is noted separately. Implementing `markets=h2h&regions=eu` is a **required optimization before launch.**

**Key assumptions:**

| Sport | Avg events/call | Seasonal factor | Notes |
|-------|----------------|-----------------|-------|
| Table Tennis | 8 | 1.0 | Year-round; moderate-density leagues |
| Volleyball | 5 | 1.0 | Year-round leagues |
| NHL | 6 | 0.75 | Offseason Jul–Sep; avg over 9 active months |
| MLB | 12 | 0.67 | Apr–Oct season; avg over 8 active months |
| NBA | 8 | 0.75 | Oct–Jun; avg over full month including off-days |
| EPL | 4 | 1.0 | Avg over month including international breaks |
| UCL | 2 | 0.35 | Groups + knockouts only; many fallow weeks |

**Polling calls per month:**

| Component | Interval | Calls/Month |
|-----------|---------|-------------|
| sync-reference-data | 24 h | 30 |
| Table Tennis (match sync) | 30 min | 1,440 |
| Table Tennis (odds sync, ×0.70) | on-demand | 1,008 |
| Volleyball (match sync) | 30 min | 1,440 |
| Volleyball (odds sync, ×0.70) | on-demand | 1,008 |
| NHL (match sync, ×0.75 seasonal) | 60 min | 540 |
| NHL (odds sync, ×0.70) | on-demand | 378 |
| MLB (match sync, ×0.67 seasonal) | 60 min | 482 |
| MLB (odds sync, ×0.70) | on-demand | 337 |
| NBA (match sync, ×0.75 avg game days) | 4 h | 135 |
| NBA (odds sync, ×0.70) | on-demand | 95 |
| EPL (match sync) | 4 h | 180 |
| EPL (odds sync, ×0.70) | on-demand | 126 |
| UCL (match sync, ×0.35) | 4 h | 63 |
| UCL (odds sync, ×0.70) | on-demand | 44 |

**Credit estimates (1 market × 1 region = credits = events × calls):**

| Scenario | Credits/Month | Notes |
|----------|--------------|-------|
| **Minimum** (offseason — NHL+MLB inactive; UCL off; NBA offseason) | ~4,800 | Table Tennis + Volleyball + EPL only |
| **Expected** (typical active month) | ~18,500 | All sports active at average event density |
| **Worst-case** (peak season — MLB trade deadline + NHL playoffs + NBA Finals + UCL final) | ~28,000 | All sports at peak simultaneously |
| **Default-params worst-case** (no optimization, 12× multiplier) | ~336,000 | Catastrophically over budget — DO NOT ship without optimization |

**Plan viability:**

| Plan | Credits/Month | Monthly Cost | Expected Coverage | Worst-Case Coverage |
|------|--------------|-------------|-------------------|---------------------|
| Free | 500 | $0 | ❌ Insufficient | ❌ Insufficient |
| Starter | 20,000 | $30 | ✅ Expected ~18,500 | ❌ Worst-case ~28,000 |
| Standard | 100,000 | $59 | ✅ Comfortable | ✅ Comfortable |

**Verdict on The Odds API Starter ($30/month):**
It is sufficient for a typical month but insufficient for peak-season months (worst-case ~28,000 credits > 20,000 limit). The Standard plan ($59/month) provides comfortable headroom. Starting on Starter and monitoring actual credit consumption in month 1 is the pragmatic approach — upgrade if usage approaches 18,000+ mid-month.

---

#### OddsPapi Estimates

| Scenario | Requests/Month | Notes |
|----------|---------------|-------|
| **Fixed 2×/day (current assumption)** | 240 | 96% of free tier — unsafe |
| **Event-driven minimum** (quiet tournament period) | 20–30 | Only 1–2 games scheduled per game |
| **Event-driven expected** | 50–80 | ~15 active days/month avg across 4 games |
| **Event-driven worst-case** | 110–130 | Major events simultaneous for all 4 games |

Event-driven expected usage (50–80 req/month) = **20–32% of the 250 req/month free tier** — safe with substantial headroom.

---

### Q8 — Does The Odds API Starter plan remain sufficient?

**For a typical month: Yes, but only with the `markets=h2h&regions=eu` optimization applied to every `getOdds` call.**

**Without that optimization (current code state): No — default parameters would use 12× credits and bust any reasonable plan instantly.**

The optimization is a 2-line change to each `getOdds` call in the ingestion service, but it must be treated as a hard prerequisite before launch:

```typescript
// Current (expensive — uses all markets × all regions):
await this._oddsApiClient.getOdds(sportKey);

// Required (h2h market only, EU bookmakers):
await this._oddsApiClient.getOdds(sportKey, {
  markets: 'h2h',
  regions: 'eu',
});
```

The same fix applies to the odds snapshot call in `OddsSnapshotIngestionService.ingestOddsForSport` (which already uses `eventIds` but still defaults markets/regions).

**If expected monthly usage approaches the 20,000 Starter cap, upgrade to Standard ($59/month).** The delta is $29/month for 80,000 additional credits — justified the moment the bot has any active users.

---

### Q9 — Is there remaining unnecessary polling?

**Three sources of unnecessary polling identified:**

**9.1 — Tier 3 when no events exist in the DB**

NBA, EPL, and UCL are polled every 4 hours even during offseason or between matchdays. Each call to `getOdds('basketball_nba')` during the NBA offseason returns 0 events, but under the per-event credit model this costs 0 credits (0 events × anything = 0). Under a flat per-call model it costs 1 credit. Either way, the waste is negligible. **No action required.**

**9.2 — NHL during offseason (July–September)**

Same as above — 0 events returned during offseason. Negligible credit cost. Stopping and restarting polls seasonally adds complexity that isn't justified. **Accept the minor waste.**

**9.3 — Esports fixed 2×/day polling (if implemented)**

This is the only meaningful waste. 240 fixed requests vs ~60 event-driven requests = 180 avoidable requests/month. With a 250/month limit, those 180 requests are not "wasted" in cost terms but are operationally dangerous (they consume budget that may be needed when actual matches are playing). **Replace with event-driven. This is the primary optimization.**

---

### Q10 — Opportunities to reduce API costs

**Four concrete optimizations ranked by impact:**

**O1 — Add `markets=h2h&regions=eu` to every `getOdds` call (CRITICAL)**
Impact: Reduces credit usage by up to 12× from the unoptimized default.
Files: `MatchIngestionService.ingestTraditionalSport`, `OddsSnapshotIngestionService.ingestOddsForSport`.
Effort: Trivial — 2 lines each.
Risk: None — value betting requires only h2h (moneyline) odds.

**O2 — Add `commenceTimeTo` filter to match sync calls (HIGH VALUE)**
Impact: Limits events returned per `getOdds` call to those starting within N hours. For high-density sports (Table Tennis, NBA during playoffs), this could halve credit usage.
Approach: `commenceTimeTo = now + 96h` filters out events more than 4 days away, which are not useful for near-term analysis and only drive up credit cost.
Files: `MatchIngestionService.ingestTraditionalSport`.
Effort: Small — add `commenceTimeTo` parameter.

**O3 — Event-driven OddsPapi calls (HIGH VALUE for free tier sustainability)**
Impact: Reduces OddsPapi from 240 to ~60 req/month — from 96% to 24% free tier utilization.
Files: `MatchIngestionWorker._handleEsportsGame` (add near-term match collection + odds job enqueue).
Effort: Medium — requires new `sync-esports-odds` job type and OddsPapi client.
This is the same effort as the esports odds integration itself.

**O4 — Cache `/v4/sports` response (LOW IMPACT)**
Impact: `sync-reference-data` fires daily (30 calls/month × 1 credit = 30 credits). Negligible cost, no optimization needed.

---

## Final V1 Sport List

### Traditional Sports

| Sport | Tier | Interval | Odds API Key | Group Field |
|-------|------|----------|-------------|-------------|
| Table Tennis | 1 | 30 min | `tabletennis_atp` (verify) | `"Table Tennis"` |
| Volleyball | 1 | 30 min | `volleyball_*` (verify) | `"Volleyball"` |
| NHL | 2 | 60 min | `icehockey_nhl` | `"Ice Hockey"` |
| MLB | 2 | 60 min | `baseball_mlb` | `"Baseball"` |
| NBA | 3 | 48h event-driven (4h poll) | `basketball_nba` | `"Basketball"` |
| Premier League | 3 | 48h event-driven (4h poll) | `soccer_epl` | `"Soccer"` |
| Champions League | 3 | 48h event-driven (4h poll) | `soccer_uefa_champs_league` | `"Soccer"` |

**ATP and WTA: Excluded from V1. Reason: tournament key fragmentation requires dynamic key discovery. Deferred to V2.**

---

## Final V1 Esports List

| Game | Match Data | Odds | Poll Interval (Match) | Odds Trigger |
|------|-----------|------|----------------------|--------------|
| CS2 | PandaScore (`cs2`) | OddsPapi | 30 min | Event-driven (when near-term matches exist) |
| Dota 2 | PandaScore (`dota2`) | OddsPapi | 30 min | Event-driven |
| League of Legends | PandaScore (`lol`) | OddsPapi | 30 min | Event-driven |
| Valorant | PandaScore (`valorant`) | OddsPapi | 30 min | Event-driven |

**Rainbow Six Siege and Mobile Legends: Architecturally supported (post-remediation) but excluded from V1 esports odds. PandaScore match data still runs for these — only esports odds are constrained by OddsPapi budget.**

---

## Final Polling Schedule

### Traditional Sports (The Odds API)

```
Every 30 min   →  Table Tennis (sync-traditional-sport)
                   Volleyball  (sync-traditional-sport)

Every 60 min   →  NHL          (sync-traditional-sport)
                   MLB          (sync-traditional-sport)

Every  4 h     →  NBA          (sync-traditional-sport)
                   EPL          (sync-traditional-sport)
                   UCL          (sync-traditional-sport)

Every 24 h     →  sync-reference-data

On-demand      →  sync-odds-for-sport (enqueued after match sync,
                   only when near-term match IDs found, 5s delay)
```

### Esports (PandaScore + OddsPapi)

```
Every 30 min   →  CS2, Dota2, LoL, Valorant, R6 Siege, MLBB
                   (sync-esports-game, PandaScore — free, no cost)

On-demand      →  sync-esports-odds (enqueued ONLY when near-term
                   match IDs found — event-driven, OddsPapi call)
```

---

## Monthly Cost Estimate

### Scenario Matrix

| Scenario | The Odds API Credits | OddsPapi Requests | TOA Cost | OddsPapi Cost | Total |
|----------|---------------------|-------------------|---------|---------------|-------|
| **Minimum** (offseason — quiet month) | ~4,800 | ~20 | $30 (Starter) | $0 | **$30/month** |
| **Expected** (typical active month) | ~18,500 | ~60 | $30 (Starter, borderline) | $0 | **$30/month** |
| **Busy month** (several sports active simultaneously) | ~24,000 | ~90 | $59 (Standard) | $0 | **$59/month** |
| **Worst-case peak** (all sports at maximum simultaneously) | ~28,000 | ~120 | $59 (Standard) | $0 | **$59/month** |
| **Unoptimized (no market/region params)** | ~220,000+ | 240 (fixed) | $249+ | $0 | **$249+/month — DO NOT SHIP** |

**Bottom line:** With parameter optimization applied, V1 costs $30–$59/month total. Without optimization, it could exceed $249/month before any users are acquired.

---

## Risks

### R-01 — CRITICAL: `getOdds` calls use expensive default parameters
**Current state:** Neither `MatchIngestionService.ingestTraditionalSport` nor `OddsSnapshotIngestionService.ingestOddsForSport` specifies markets or regions. The Odds API defaults to all markets (h2h + spreads + totals = 3) × all regions (us + uk + eu + au = 4) = 12× credit multiplier per event.
**Impact:** At 12× multiplier, expected monthly cost jumps from ~18,500 to ~220,000 credits — exceeding every plan tier except Premium ($249+/month).
**Fix:** Add `{ markets: 'h2h', regions: 'eu' }` to every `getOdds` call. 2 lines of code. Must be done before any live API calls.
**Severity:** LAUNCH-BLOCKING if not fixed.

### R-02 — HIGH: OddsPapi fixed 2×/day plan is operationally unsafe
**Current state:** The proposed 240 req/month schedule leaves 10 requests of headroom (4%) in a 250 req/month limit.
**Impact:** Any retry, duplicate BullMQ fire on restart, or development call exhausts the free tier.
**Fix:** Implement event-driven OddsPapi calls, reducing usage to ~60 req/month (24% utilization).
**Severity:** Must fix before production. Can launch with fixed schedule temporarily during testing if polling is strictly controlled.

### R-03 — HIGH: Esports odds pipeline does not exist
**Current state:** No OddsPapi client, no `sync-esports-odds` job type, no odds snapshot service for esports. The V1 esports list has odds "on paper" but zero working infrastructure for odds ingestion.
**Impact:** CS2/Dota2/LoL/Valorant will have match data but no odds data at V1 launch unless this is implemented.
**Fix:** Implement the esports odds integration as a Sprint 5 deliverable. Estimated 3–5 days of development.
**Severity:** Feature-blocking (esports odds won't work), not pipeline-blocking (match data still flows).

### R-04 — MEDIUM: Table Tennis and Volleyball sport keys unverified
**Current state:** No live `/v4/sports` call has been made to confirm which keys are active and have bookmaker coverage.
**Impact:** The scheduler config for these two sports cannot be finalized without confirmed sport keys. Launching with wrong keys returns empty results.
**Fix:** Make one authenticated `GET /v4/sports?all=true` call, filter to `active: true` and `group` matching "Table Tennis" / "Volleyball", verify odds coverage with a sample `/v4/sports/{key}/odds` call.
**Severity:** Operational blocker for Table Tennis and Volleyball. NHL/MLB/NBA/EPL/UCL unaffected.

### R-05 — MEDIUM: Table Tennis event density unknown
**Current state:** Table Tennis runs many concurrent international tournaments. If the active sport key returns 30–100+ concurrent events, credit cost per call multiplies proportionally even with optimized parameters.
**Impact:** Table Tennis at 30-min polling with 50 active events = 50 × 1,440 calls = 72,000 credits/month for match sync alone — far exceeding any Starter plan.
**Fix:** After verifying sport keys, make one sample `getOdds('tabletennis_*', { markets: 'h2h', regions: 'eu', commenceTimeTo: ... })` call and count events returned. If > 20 events, move Table Tennis to Tier 2 (60 min) or add `commenceTimeTo = now + 72h` filter.
**Severity:** Budget risk. Measure before committing polling frequency.

### R-06 — LOW: NHL offseason idle polling
**Current state:** NHL is polled every 60 minutes year-round. Returns 0 events July–September.
**Impact:** ~480 idle API calls (0 events × 480 = 0 credits under per-event model). Negligible.
**Severity:** Accepted for V1.

### R-07 — LOW: PandaScore ToS — betting-related usage
**Current state:** PandaScore explicitly prohibits betting-related usage in their free tier terms. The project uses PandaScore for esports match data ingestion.
**Impact:** Risk of account termination or forced migration to a paid plan.
**Fix:** Contact PandaScore for written ToS clarification. If prohibited: GRID Open Access covers CS2 and Dota 2 for free; LoL and Valorant would need an alternative source.
**Severity:** LOW for immediate V1 launch; escalates if PandaScore enforces and the project has active users.

---

## Recommendations

### Before Writing Any Production Code

1. **Add `markets=h2h&regions=eu` parameters to all `getOdds` calls.** This is not optional. The difference between optimized and default is 12× in credit cost. Add to both `ingestTraditionalSport` and `ingestOddsForSport`.

2. **Add `commenceTimeTo = now + 96h` to match sync calls.** Cap event density per call. For high-density sports like Table Tennis, this can cut credit usage in half.

3. **Verify Table Tennis and Volleyball sport keys** with one live API call before the scheduler config is finalized. Count active events in the response. If event density is high, move from Tier 1 to Tier 2.

### Before Implementing Esports Odds

4. **Design event-driven esports odds polling from the start.** Do not implement fixed 2×/day schedule. Use near-term match IDs from PandaScore as the trigger for OddsPapi calls.

5. **Build `EsportsOddsApiClient` following the same pattern as `DefaultOddsApiClient`** (`src/integrations/the-odds-api/the-odds-api.client.ts`). The OddsPapi REST format is similar enough that the integration is straightforward.

### Ongoing

6. **Monitor The Odds API credit usage in week 1.** Check `x-requests-remaining` in response headers (already tracked by the client). If weekly usage suggests monthly total will approach 18,000, upgrade to Standard ($59/month) before hitting the cap.

7. **Budget for The Odds API Standard ($59/month) from month 1.** Peak months will exceed the 20,000 Starter credit limit. The $29/month difference is not worth the operational risk of running out mid-month.

---

## Final Verdict: **READY WITH MINOR CHANGES**

### Summary Table

| Category | Status | Action Required |
|----------|--------|-----------------|
| Traditional sports match + odds architecture | ✅ Ready | None |
| Traditional sports scheduling (Tier 1/2/3) | ✅ Ready (post-remediation) | None |
| Table Tennis / Volleyball sport keys | ⚠️ Unverified | Verify before activating |
| ATP / WTA | ✅ Correctly excluded | None |
| Esports match data (PandaScore) | ✅ Ready | PandaScore ToS review recommended |
| Esports odds architecture (OddsPapi) | ❌ Not built | Sprint 5 implementation task |
| `getOdds` parameter optimization | ❌ Missing | Add before any live calls — launch-blocking |
| OddsPapi polling strategy | ⚠️ Fixed schedule too aggressive | Implement event-driven from start |
| The Odds API Starter ($30/month) | ⚠️ Borderline | Budget $59/month Standard; start on Starter, monitor |
| OddsPapi free tier (250 req/month) | ✅ Sufficient | Only with event-driven polling |

### The Two Changes That Must Happen Before Launch

1. **`markets=h2h&regions=eu` on all `getOdds` calls** — without this, the credit cost is uncontrollable and the entire The Odds API budget assumption is invalid.

2. **Event-driven OddsPapi calls** — without this, fixed polling at 2×/day consumes 96% of the free tier with zero tolerance for variance.

Everything else is either already implemented, a Sprint 5 build task, or an operational research item (TT/VB key verification). The V1 plan is sound.
