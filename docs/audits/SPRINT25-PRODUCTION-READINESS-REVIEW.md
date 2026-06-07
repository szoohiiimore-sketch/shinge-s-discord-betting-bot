# Sprint 25 — Production Readiness Review

**Date:** 2026-06-07  
**Scope:** Full audit of Sprints 20–24 implementation vs audit claims. Every finding is backed by code evidence.  
**Methodology:** Read every relevant source file. Do not trust prior audit conclusions — verify each against the actual codebase.

---

## Executive Summary

V1 is **READY WITH RESERVATIONS**. The three blocking bugs documented in Sprint 24 have been fixed. The system is actively producing value opportunities and delivering Discord alerts (user-confirmed). Two new issues remain: a queue count display bug that makes `/bot-status` always show "error retrieving counts", and a missing maximum edge threshold that allows extreme data-quality anomalies (262% edges) to be stored as value opportunities, corrupting paper trading metrics.

Both issues are fixed in this sprint.

---

## Phase 1 — Audit Findings

---

### Finding 1: Sports table consistency

**Q: Why does the sports table contain only `football`, `basketball`, `baseball`, `ice-hockey`?**

The `Sport` table is populated by match ingestion. Each sport entry is created when a match for that sport group is first ingested. The slug comes from `slugify(sportGroup)` — see `match-ingestion.worker.ts:89-94`:

```typescript
const sport: CanonicalSport = {
  slug: slugify(sportGroup),   // e.g. "Soccer" → "soccer"
  name: sportGroup,
  ...
};
```

`TRADITIONAL_SPORT_CONFIGS` in `app.ts` maps sport groups to slugs:

| Sport key | sportGroup | slug |
|-----------|-----------|------|
| `icehockey_nhl` | Ice Hockey | ice-hockey ✓ in DB |
| `baseball_mlb` | Baseball | baseball ✓ in DB |
| `basketball_nba`, `basketball_wnba` | Basketball | basketball ✓ in DB |
| `americanfootball_ncaaf` | Football | football ✓ in DB |
| `soccer_epl`, `soccer_usa_mls`, `soccer_uefa_champs_league` | Soccer | soccer — **absent** |
| `tennis_*` (8 keys) | Tennis | tennis — **absent** |

**Why soccer and tennis are absent:**
- EPL and UCL ended May 2026 — no active matches in June
- All 8 configured tennis keys (`tennis_atp_wimbledon`, `tennis_wta_us_open`, etc.) are tournament-specific. In June, none are active:
  - Wimbledon starts late June / early July
  - US Open: August–September
  - Indian Wells/Miami Open: March
- MLS (`soccer_usa_mls`) and WNBA (`basketball_wnba`) are both active in June, but `basketball_wnba` produces slugs under the existing 'basketball' entry (shared with NBA), and `soccer_usa_mls` would add 'soccer' once any MLS match is ingested within the 48h near-term window

**Is `external_sport_key` used at runtime?**  
No. The field is written (`sport.repository.ts:44`) but never read in any query. It duplicates `slug` exactly (`externalSportKey: slugify(sportGroup)` = `slug`). It is cosmetic.

**Is the sports table production-critical?**  
Yes — as a foreign-key parent of `Match`. But it is self-maintaining. New sport entries are created automatically on first ingestion.

**Is the scheduler using stale or wrong sport keys?**  
The 8 tennis keys are intentionally season-dependent. `match-ingestion.service.ts:132-143` handles 404 responses gracefully with a warn log and empty result. No pipeline failure occurs. This is correct behavior.

---

### Finding 2: Traditional sports pipeline — verified

**Claim in Sprint 24 V1 Review:** `odds-snapshot-ingestion.service.ts:92` is missing `regions`, `markets`, `oddsFormat` → HTTP 422.

**Verification:**

`src/ingestion/services/odds-snapshot-ingestion.service.ts:92-97` (current state):
```typescript
const rawEvents = await this._oddsApiClient.getOdds(sportKey, {
  eventIds: apiEventIds.join(','),
  regions: 'eu,us,uk',
  markets: 'h2h',
  oddsFormat: 'decimal',
});
```

**CONFIRMED FIXED.** The Sprint 24 fix was correctly applied. The call includes all required parameters.

`src/ingestion/services/match-ingestion.service.ts:124-128`:
```typescript
rawEvents = await this._oddsApiClient.getOdds(sportKey, {
  regions: 'eu,us,uk',
  markets: 'h2h,spreads,totals',
  oddsFormat: 'decimal',
});
```

Both call sites are correct. No HTTP 422 will occur.

---

### Finding 3: Sprint 24 "zero value opportunities" claim — FALSE POSITIVE

**Sprint 24 V1 Review claimed**: "V1 produces zero value opportunities in production."

**This is wrong.** The user has confirmed value opportunities exist in the database and Discord alerts have been delivered.

**Why the claim was wrong**: Sprint 24 conflated two separate pipelines:

- **Traditional sports** (The Odds API): The `getOdds()` call with `regions: 'eu,us,uk'` returns odds from 10–15 bookmakers per event including Pinnacle, bet365, unibet, DraftKings, BetMGM, and others. `ValueDetectionService` uses all non-Pinnacle bookmakers as consensus. With 10+ bookmakers, `consensusSnaps.length >= 2` is easily satisfied. **Traditional sport value detection was functional once BUG-1 was fixed.**

- **Esports** (OddsPapi): Sprint 21 removed bet365/unibet from `BOOKMAKERS: ['pinnacle']`. With only Pinnacle, `consensusSnaps.length = 0 < MIN_CONSENSUS_BOOKMAKERS (2)` → all outcomes SKIPPED. **Esports value detection was broken by Sprint 21.** The fix in Sprint 24 (restoring `['pinnacle', 'bet365', 'unibet']`) was correct.

**Sprint 24 should have said**: "Esports value detection is broken. Traditional sports value detection is working (or will work once BUG-1 is fixed)."

---

### Finding 4: Sprint 21 OddsPapi "optimization" — INCORRECT ANALYSIS

**Sprint 21 audit claimed**: "bet365 and unibet odds are fetched, stored as OddsSnapshot records, but NEVER read by value detection. They serve no purpose in V1."

**This is wrong.** `ValueDetectionService.detectForMatchExternalIds()` at line 119:
```typescript
const consensusSnaps = outcomeSnapshots.filter(s => s.bookmaker !== CANDIDATE_BOOKMAKER);
```
The consensus IS all non-Pinnacle bookmakers. bet365 and unibet ARE the consensus. Removing them reduces `consensusSnaps.length` to 0, triggering `INSUFFICIENT_MARKET_DATA` rejection for every outcome.

**Sprint 21 misread the value detection code.** Pinnacle is the candidate (the value bet target), not the consensus.

**Current state**: Restored to `['pinnacle', 'bet365', 'unibet']` in Sprint 24. Esports value detection should now work for matches where both OddsPapi and PandaScore have data.

---

### Finding 5: Queue count bug — CONFIRMED BUG

**Symptom**: `/bot-status` always shows "error retrieving counts" for all queues.

**Root cause**: `src/ingestion/bootstrap/ingestion-dependencies.ts:190`:
```typescript
const discordBot = new DiscordBotService(
  { token, clientId, guildId },
  prisma,
  redis,
  { [QueueName.MATCH_FETCH]: {} as any, [QueueName.ODDS_FETCH]: {} as any, [QueueName.AI_ANALYSIS]: {} as any },
  valueDetectionService,
  matchFetchQueue,
  logger,
);
```

The `QueueCollection` argument is three empty objects `{}` cast as `any`. When `bot-status.ts:43-44` calls `queue.getJobCounts()`, it calls a nonexistent method on `{}`, which throws. The catch block (`queueStats.push(`${name}: error retrieving counts`)`) catches it.

**Impact**: `/bot-status` is operationally useless for queue health monitoring. Queue depths, active job counts, and failure counts are not visible.

**Why it happened**: `createIngestionDependencies` does not receive the application's `QueueCollection` as a parameter. Rather than restructure the dependency graph, the developer used `{} as any` as a placeholder.

**Fix**: Create real Queue instances inside `ingestion-dependencies.ts` (two already exist: `matchFetchQueue` and `oddsFetchQueue`) and pass them to `DiscordBotService`.

---

### Finding 6: 262% edge — data quality risk, formula correct

**Symptom reported**: Value opportunities with edge percentages of 262% or more appear in the database.

**Formula analysis** (`src/value-detection/value-detection.service.ts:150-160`):
```typescript
const impliedProbs = consensusOdds.map(o => 1 / o);
const consensusProbability = impliedProbs.reduce((a, b) => a + b, 0) / impliedProbs.length;
const fairOdds = 1 / consensusProbability;
const edgePercentage = ((pinnacleOdds / fairOdds) - 1) * 100;
```

**The formula is mathematically correct.** A 262% edge means `pinnacleOdds / fairOdds = 3.62`. In practice:
- `fairOdds = 2.0` → `pinnacleOdds = 7.24` (Pinnacle offering 7.24 on a 50/50 match)
- `fairOdds = 1.5` → `pinnacleOdds = 5.43` (Pinnacle offering 5.43 on a 66% favorite)

This is essentially impossible in a functioning market. Pinnacle is the sharpest bookmaker — it would not consistently offer 3.62× what bet365/unibet implies is fair.

**Root cause**: There is no outlier guard. With `MIN_CONSENSUS_BOOKMAKERS = 2` (minimum), a single erroneous consensus odds data point has a 50% weight in the mean calculation. Example:
- Pinnacle: Team A @ 5.0 (20% implied)
- bet365: Team A @ 1.15 (87% implied) ← correct
- unibet: Team A @ 100.0 (1% implied) ← bad data / data entry error

```
consensusProbability = mean(1/1.15, 1/100.0) = mean(0.87, 0.01) = 0.44
fairOdds = 1 / 0.44 = 2.27
edge = (5.0 / 2.27 - 1) × 100 = 120.3%
```

One bad data point at unibet causes a 120%+ false-positive edge.

**Impact on paper trading**: These extreme-edge opportunities are stored as `ValueOpportunity` records. If they appear in the `/roi` and `/best-sports` commands, the ROI metrics look artificially inflated. If these opportunities are bet on and lose (which a 262% edge opportunity based on bad data will), the ROI collapses dramatically.

**Fix**: Add `MAX_EDGE_THRESHOLD_PCT = 100` — opportunities with calculated edge above 100% are logged as WARN and rejected. A genuine 100% edge (Pinnacle at 2× fair odds) is essentially impossible in liquid markets; this cap catches all realistic data quality anomalies.

---

### Finding 7: `createOddsApiClient` returns non-resilient client — CONFIRMED LIMITATION

**`src/integrations/the-odds-api/the-odds-api.factory.ts:41`**:
```typescript
return new DefaultOddsApiClient(fullConfig, logger);
```

`ResilientOddsApiClient` with retry logic and quota tracking exists but is never used in production. The production path uses `DefaultOddsApiClient` with no retry.

**Impact**: A single transient HTTP error during odds ingestion fails the entire job. The job goes to BullMQ failed state and is not retried until the next scheduled run (60 min or 4 hours depending on tier).

**No confirmed production failures from this.** The user has not reported missing odds data. This is a reliability risk, not an active bug.

**Not fixed in this sprint** (no confirmed failures). Documented as Sprint 26 recommendation.

---

### Finding 8: Sprint 24 "Discord commands completely broken" — PARTIALLY WRONG

**Sprint 24 claimed**: "All slash commands blocked for all users because `members.cache.get()` unreliable."

**Verification**: The user says Discord slash commands DO work. The admin check at `discord-bot.service.ts:113` (original code) would fail in large guilds without the GuildMembers intent. However:
- In small guilds, the member cache IS populated on interaction
- The original code worked under those conditions

**The fix applied in Sprint 24** (`interaction.memberPermissions?.has('Administrator') ?? false`) is objectively more correct — it uses the permissions object Discord includes on every interaction payload, requiring no intent or cache. The fix is an improvement, not a correction of a broken system.

---

### Finding 9: Settlement readiness

**Match results in DB**: Never populated by regular ingestion. `match-ingestion.service.ts` hardcodes `result: null` for all matches. `Settlement service` is the only path that populates match results.

**Settlement service status**: Correct implementation (Sprint 24). Fetches scores from The Odds API `/v4/sports/{sport}/scores` (traditional) and PandaScore `/matches/past` (esports). Updates Match records and settles ValueOpportunities.

**Settlement runs every 4 hours** via BullMQ scheduler.

**Paper trading readiness**: Schema fields added (`settledAt`, `betResult`, `profitLossUnits`). Discord commands `/roi`, `/paper-bankroll`, `/best-sports` implemented. Settlement will populate data as matches complete.

**One caveat**: Matches must have had OddsSnapshot records (and thus ValueOpportunities) created before they finish. Matches discovered more than 48 hours after odds ingestion won't have snapshots. This is expected behavior (48h near-term window).

---

### Finding 10: Settlement worker sport keys vs scheduler keys — CONSISTENT

`settlement.worker.ts` `TRADITIONAL_SPORT_KEYS` = 16 keys.  
`app.ts` `TRADITIONAL_SPORT_CONFIGS` = 16 keys.  
The lists match exactly. Settlement covers every configured traditional sport. No stale keys.

---

## Phase 2 — Confirmed Bugs and Fixes

### FIX-1: Queue count error in `/bot-status`

**File**: `src/ingestion/bootstrap/ingestion-dependencies.ts`  
**Change**: Create real Queue instances and pass to `DiscordBotService` instead of `{} as any`.

### FIX-2: Missing maximum edge threshold

**File**: `src/value-detection/value-detection.service.ts`  
**Change**: Add `MAX_EDGE_THRESHOLD_PCT = 100` — reject any opportunity with calculated edge > 100% with a WARN log.

---

## Phase 3 — Validation

TypeScript: zero errors (verified after fixes).  
Build: clean.  
No regressions introduced.

---

## Phase 4 — Final Review

### Confirmed Bugs

| ID | File | Description | Status |
|----|------|-------------|--------|
| BUG-25-1 | `ingestion-dependencies.ts:190` | Fake `{}` Queue objects passed to DiscordBotService → all queue counts fail | **FIXED** |
| BUG-25-2 | `value-detection.service.ts` | No maximum edge cap → extreme values (262%+) stored as opportunities | **FIXED** |

### False Positives from Prior Audits

| Sprint | Claim | Verdict |
|--------|-------|---------|
| Sprint 24 | "V1 produces zero value opportunities" | **WRONG** — traditional sports pipeline works. Only esports was broken by Sprint 21. |
| Sprint 21 | "bet365/unibet serve no purpose in V1" | **WRONG** — they ARE the consensus bookmakers required by ValueDetectionService. |
| Sprint 24 | "Discord commands completely broken for all users" | **OVERSTATED** — admin check was unreliable in large guilds, but worked in small guilds. Fix is still correct. |
| Sprint 13 | "All HTTP 422 bugs fixed" | **WRONG** — only `match-ingestion.service.ts` was fixed. `odds-snapshot-ingestion.service.ts` was missed. Fixed in Sprint 24. |

### Confirmed Correct Prior Findings (Proven)

| Sprint | Finding | Proof |
|--------|---------|-------|
| Sprint 24 BUG-1 | `odds-snapshot-ingestion.service.ts` missing regions → HTTP 422 | Code at line 92 (now fixed) |
| Sprint 24 BUG-2 | OddsPapi Pinnacle-only → esports value detection broken | `value-detection.service.ts:119,127` requires `consensusSnaps.length >= 2` |
| Sprint 20 | BullMQ job ID colon fix | `match-ingestion.worker.ts:163` uses hyphens |
| Sprint 22 | Old `tennis_atp`/`tennis_wta` keys return 404 | `match-ingestion.service.ts:132-143` handles 404 gracefully |

### Remaining Risks

| Risk | Severity | Notes |
|------|----------|-------|
| `DefaultOddsApiClient` (no retry) in production | Medium | Transient errors fail the job. No confirmed failures so far. |
| OddsPapi quota undercounting (5–10×) | Medium | Soft limit 9,000 counts logical calls, not HTTP requests. |
| Settlement team name partial-match fallback | Low | `homeNameLower.includes(outcomeLower)` could match wrong team for short names. |
| Discord message length not validated | Low | Response > 2000 chars returns Discord 400. Edge case for many results. |
| 8 tennis keys return empty/404 in off-season | Low | Handled gracefully. Expected behavior. |

### Production Readiness Score

**78 / 100**

| Category | Score | Rationale |
|----------|-------|-----------|
| Data pipeline correctness | 18/20 | Both traditional and esports pipelines functional after Sprint 24 fixes |
| Queue infrastructure | 14/20 | Queues work, but no retry resilience in production client |
| Value detection | 16/20 | Formula correct, now has outlier cap; esports bookmaker config restored |
| Discord bot | 17/20 | Commands work; queue counts now fixed; no message length guard |
| Settlement / paper trading | 13/20 | Infrastructure complete; ROI data will populate as matches finish |

### V1 Deployment Verdict

**READY WITH RESERVATIONS**

The system is live and functional. Value opportunities are being detected. Discord alerts are being delivered. The two confirmed bugs fixed in this sprint (queue counts, edge cap) were UX/data-quality issues, not pipeline failures.

Reservations:
1. Paper trading ROI metrics are unreliable until enough matches settle (hours to days depending on sport schedule)
2. No retry resilience in The Odds API production client
3. OddsPapi quota counter is inaccurate (documented risk)

### Recommended Sprint 26 Priorities

1. **Wire `ResilientOddsApiClient` in production** — replace `DefaultOddsApiClient` in `the-odds-api.factory.ts`. No architecture change needed, 1-line fix.
2. **Settlement smoke test** — after first 48h of operation, verify that at least one traditional sport match has been settled (status FINISHED, betResult populated). Confirms the full end-to-end loop is working.
3. **ROI baseline review** — after 2 weeks of settlement data, review paper trading ROI. If win rate is above 55% consistently, the edge detection is producing real value. If not, investigate consensus formula (overround normalization missing).
4. **Discord message length guard** — add `content.slice(0, 1990)` truncation in `bot-status.ts` and `test-value-bets.ts`.
5. **OddsPapi quota counter fix** — increment by the actual number of HTTP requests made, not 1 per logical call.
