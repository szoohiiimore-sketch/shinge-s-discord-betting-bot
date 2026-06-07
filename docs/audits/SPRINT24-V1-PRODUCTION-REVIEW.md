# Sprint 24 — V1 Production Review

**Date:** 2026-06-07  
**Scope:** Complete audit of all sprints and the full implementation against audit claims. Honest V1 deployment assessment.  
**Methodology:** Code-first. Every claim below is backed by a file path and line number.

---

## Executive Summary

V1 is **NOT deployable**. Two critical bugs introduced in Sprints 13 and 21 ensure the system produces zero value opportunities in production — for both traditional sports and esports. A third bug silently blocks all Discord slash commands for all users. All PASS verdicts in prior audits are TypeScript-only; no PASS audit involved live API calls or real data flowing through the full pipeline.

---

## Q1: Does the full pipeline work end-to-end?

**No. Both pipelines are broken in production.**

### Traditional Sports Pipeline

| Step | Status | Evidence |
|------|--------|----------|
| Match ingestion (The Odds API) | ✅ | `match-ingestion.service.ts:124` — `regions`, `markets`, `oddsFormat` present (fixed Sprint 13) |
| OddsSnapshot creation | ❌ **BROKEN** | `odds-snapshot-ingestion.service.ts:92` — missing required params → HTTP 422 |
| Value detection | ❌ (blocked by above) | No OddsSnapshot records → nothing to evaluate |
| Discord alerts | ❌ (blocked by above) | No ValueOpportunity records → nothing to send |

### Esports Pipeline

| Step | Status | Evidence |
|------|--------|----------|
| PandaScore match ingestion | ✅ | `match-ingestion.service.ts` — `getUpcomingMatches` + `getRunningMatches` |
| OddsPapi odds fetch | ✅ | `esports-odds-ingestion.service.ts:113` — `getOddsForGame()` called |
| OddsSnapshot creation | ✅ (Pinnacle only) | Records stored, but only 1 bookmaker |
| Value detection | ❌ **BROKEN** | `value-detection.service.ts:127` — `consensusSnaps.length = 0 < MIN_CONSENSUS_BOOKMAKERS (2)` → SKIPPED |
| Discord alerts | ❌ (blocked by above) | No ValueOpportunity records → nothing to send |

### Discord Slash Commands

| Status | Evidence |
|--------|----------|
| ❌ **BROKEN** for all users | `discord-bot.service.ts:113` — `members.cache.get()` returns `undefined` when `GuildMembers` intent absent |

---

## Q2: Are match results stored in the database?

**Schema supports it. Ingestion never populates it.**

The `Match` model has `status`, `homeScore`, `awayScore`, `result` fields. All three ingestion paths hardcode null:

- `src/ingestion/mappers/odds-api-event.mapper.ts` — `homeScore: null, awayScore: null, result: null`
- `src/ingestion/mappers/mapper.utils.ts` — `inferOddsApiMatchStatus()` only returns SCHEDULED or LIVE; FINISHED is unreachable
- `src/ingestion/services/match-ingestion.service.ts` — only calls `getUpcomingMatches` + `getRunningMatches` for esports; FINISHED matches are never fetched

Sprint 24 adds `SettlementService` which does fetch results via The Odds API `/scores` and PandaScore `/matches/past`. The settlement infrastructure is sound — but it operates on an empty dataset because there are no value opportunities to settle (blocked by BUG-1 and BUG-2).

---

## Q3: Can the system calculate ROI, win rate, P&L, CLV?

| Metric | Possible? | Notes |
|--------|-----------|-------|
| ROI | Yes (infrastructure in place) | Sprint 24 added `betResult`, `profitLossUnits` fields and `/roi` command |
| Win Rate | Yes (infrastructure in place) | Calculated from settled `betResult` counts |
| P&L | Yes (infrastructure in place) | Sum of `profitLossUnits` across settled opportunities |
| CLV (Closing Line Value) | **No** | Not implemented. Would require tracking odds movement from open to close. No infrastructure exists. |

**Practical reality:** ROI/win rate/P&L are all zero because no value opportunities are ever detected (BUG-1 + BUG-2).

---

## Q4: Are prior audit PASS verdicts accurate?

**No. All PASS verdicts are TypeScript compilation + startup checks only.**

| Sprint | Claimed | Actual |
|--------|---------|--------|
| Sprint 4 | PASS — ingestion pipeline complete | TypeScript passes; no live API call |
| Sprint 12 | PASS — value detection working | TypeScript passes; no live data tested |
| Sprint 13 | PASS — HTTP 422 bugs fixed | Only `match-ingestion.service.ts` fixed; `odds-snapshot-ingestion.service.ts` NOT fixed |
| Sprint 14 | PASS WITH RESERVATIONS — E2E validated | Explicitly deferred live API validation; startup logs only |
| Sprint 21 | PASS — quota optimization complete | Removed consensus bookmakers, breaking value detection (see BUG-2) |

Sprint 13 is the most damaging false claim. The audit says:
> "PASS — All three known bugs are fixed. The pipeline handles HTTP 422 correctly..."

This is incorrect. Only one of the two `getOdds()` call sites was fixed. The odds snapshot call (the more important one for value detection) was missed.

---

## Q5: Is the retry/resilience layer active in production?

**No. `createOddsApiClient()` returns `DefaultOddsApiClient` without retry logic.**

`src/integrations/the-odds-api/the-odds-api.factory.ts:41`:
```typescript
return new DefaultOddsApiClient(fullConfig, logger);
```

`ResilientOddsApiClient` exists and is complete, but is never used in the production path. It is only instantiated by:
- `OddsApiHealthChecker` (health checks only)
- Test scripts (`validate-esports-pipeline.ts`)

Transient network errors are not retried in production. The quota tracking in `ResilientOddsApiClient` is also never active.

---

## Q6: Is the OddsPapi quota counter accurate?

**No. It undercounts by 5–10x.**

`src/integrations/oddspapi/oddspapi.resilient-client.ts` — quota increments once per `getOddsForGame()` call. But each call makes 5–10 internal HTTP requests (one per market type). The hard limit of 10,000 represents HTTP requests, not logical calls. The effective limit is 1,000–2,000 `getOddsForGame()` calls before the real quota is exhausted — far below the 10,000 the counter tracks.

This was documented in the Sprint 21 audit as a known issue but not fixed.

---

## Q7: Is V1 deployable?

**No.** See Critical Bugs section below for the three bugs that must be fixed before deployment.

---

## Critical Bugs

### BUG-1 — Traditional sport odds ingestion always fails with HTTP 422

**File:** `src/ingestion/services/odds-snapshot-ingestion.service.ts:92`

```typescript
// CURRENT — BROKEN
const rawEvents = await this._oddsApiClient.getOdds(sportKey, {
  eventIds: apiEventIds.join(','),
  // MISSING: regions, markets, oddsFormat
});

// REQUIRED (see match-ingestion.service.ts:124 for reference)
const rawEvents = await this._oddsApiClient.getOdds(sportKey, {
  eventIds: apiEventIds.join(','),
  regions: 'eu,us,uk',
  markets: 'h2h',
  oddsFormat: 'decimal',
});
```

**Impact:** The Odds API v4 requires `regions` as a mandatory query parameter. Without it, every call returns HTTP 422. Zero OddsSnapshot records are created for any traditional sport. Traditional sport value detection has never produced output in production.

**False audit claim:** Sprint 13 audit section "HTTP 422 Fixes" states all `getOdds()` calls were fixed. Only `match-ingestion.service.ts` was modified. `odds-snapshot-ingestion.service.ts` was not touched.

---

### BUG-2 — Esports value detection produces zero results

**File:** `src/integrations/oddspapi/oddspapi.config.ts:17`

```typescript
// Sprint 21 "optimization"
BOOKMAKERS: ['pinnacle'] as readonly string[],
// Previously: ['pinnacle', 'bet365', 'unibet']
```

**Impact chain:**
1. OddsPapi fetches only Pinnacle odds
2. `EsportsOddsIngestionService` stores only Pinnacle `OddsSnapshot` records
3. `ValueDetectionService` filters: `pinnacleSnaps = outcomeSnapshots.filter(s => s.bookmaker === 'pinnacle')` → all snapshots
4. `consensusSnaps = outcomeSnapshots.filter(s => s.bookmaker !== 'pinnacle')` → **empty array**
5. `consensusSnaps.length (0) < MIN_CONSENSUS_BOOKMAKERS (2)` → SKIPPED for every outcome

`src/value-detection/value-detection.service.ts:7,119,127`:
```typescript
const MIN_CONSENSUS_BOOKMAKERS = 2;
// ...
const consensusSnaps = outcomeSnapshots.filter(s => s.bookmaker !== CANDIDATE_BOOKMAKER);
// ...
if (consensusSnaps.length < MIN_CONSENSUS_BOOKMAKERS) {
  // SKIPPED — always hits this branch with only Pinnacle data
```

**Sprint 21 misanalysis:** The Sprint 21 audit concluded that `bet365` and `unibet` snapshots "serve no purpose" because they're never read by value detection. This is incorrect. They ARE the consensus data. Pinnacle is the *candidate* (the value bet target); all other bookmakers are the *consensus* (the market average used to compute fair odds). Removing the consensus bookmakers removes the ability to detect any value at all.

---

### BUG-3 — All Discord slash commands blocked in production

**File:** `src/discord/discord-bot.service.ts:113`

```typescript
const member = interaction.guild?.members.cache.get(interaction.user.id);
const isAdmin = member?.permissions.has('Administrator') ?? false;

if (!isAdmin) {
  await interaction.reply({ content: 'This command is admin-only.', ephemeral: true });
  return;
}
```

**Impact:** The bot is initialized with `GatewayIntentBits.Guilds` only (line 98). Without the `GuildMembers` privileged intent, `members.cache` is not populated on interaction. `member` is always `undefined`, `isAdmin` is always `false`, and every slash command returns "This command is admin-only." to every user.

**Fix:** Fetch the member from the API at interaction time:
```typescript
const member = interaction.member;
const isAdmin = member instanceof GuildMember
  ? member.permissions.has('Administrator')
  : (member?.permissions as Readonly<PermissionsBitField> | null)?.has('Administrator') ?? false;
```
Or, simpler: use `interaction.memberPermissions?.has('Administrator') ?? false` — this is set by Discord on the interaction payload itself and requires no intent or cache lookup.

---

## Architectural Weaknesses

### A1 — Retry logic not wired to production client

`ResilientOddsApiClient` is complete but `createOddsApiClient()` returns `DefaultOddsApiClient`. Transient failures in The Odds API or PandaScore are not retried in production. One network blip during an ingestion cycle drops the entire odds batch silently.

**Fix:** `src/integrations/the-odds-api/the-odds-api.factory.ts` should wrap the returned client in `ResilientOddsApiClient`.

### A2 — Settlement sport keys hardcoded

`src/settlement/settlement.worker.ts` hardcodes `TRADITIONAL_SPORT_KEYS` and `ESPORTS_VIDEOGAMES`. These must be manually synchronized with the app configuration whenever a sport is added or removed. If they diverge, some sports are settled with stale data and others are never settled.

### A3 — No Discord message length guard

Discord enforces a 2,000-character limit per message. None of the Discord command handlers validate content length before calling `interaction.reply()`. A response exceeding 2,000 characters returns a 400 error from Discord, logged as an error with no user feedback.

High-risk commands: `/best-sports` with many sports, `/test-value-bets` with long team names.

### A4 — Settlement team name matching uses unsafe partial match fallback

`src/settlement/settlement.service.ts:56-57`:
```typescript
if (matchResult === 'HOME_WIN' && homeNameLower.includes(outcomeLower)) return 'WIN';
```

If `outcome = "City"`, this matches both "Manchester City" and "Kansas City". Any short team name substring of another team name will produce incorrect settlement results. These settlement errors compound silently.

---

## Data Quality Risks

### D1 — OddsSnapshot–Match correlation via fuzzy team name matching

Esports team names differ between PandaScore and OddsPapi. `src/ingestion/mappers/esports-odds-mapper.ts` uses `resolveAlias()` and Levenshtein distance matching. False positives associate odds with the wrong match. False negatives leave matches without odds, preventing value detection.

This is structural — there is no ground-truth ID correlation between PandaScore match IDs and OddsPapi odds. The team name bridge is the only link.

### D2 — `capturedAt` batch deduplication gaps

`OddsSnapshot.@@unique([matchId, bookmaker, outcome, capturedAt])` — if two ingestion runs complete within the same millisecond (unlikely but possible under load), both are treated as distinct batches. Value detection runs on only the most recent `capturedAt` batch, silently discarding the earlier one.

### D3 — OddsPapi quota undercounting (5–10x)

See Q6. The quota counter shows safety headroom that does not exist. At current ingestion frequency (4 games × N runs per day), the true HTTP quota may be exhausted far earlier than the counter indicates, and there is no circuit breaker to stop ingestion after real exhaustion.

---

## Missing Production Safeguards

| Safeguard | Status | Risk |
|-----------|--------|------|
| Dead-letter queue monitoring | Missing | Failed jobs silently accumulate with no alert |
| Last-successful-job timestamp | Missing | Pipeline could be silently down for hours |
| Discord message rate limit backoff | Missing | Rapid alert bursts could trigger Discord 429s |
| Duplicate alert guard against DB write failure | Missing | If `alertedAt` update fails after send, same alert sent again on next run |
| OddsPapi quota circuit breaker | Missing | Real HTTP quota may exhaust before counter reaches limit |
| Health endpoint for ingestion lag | Missing | `/health` checks DB/Redis ping, not whether jobs are executing |

---

## /value-bets Command

**Status:** Not yet implemented. Implementation follows this audit document per the sprint brief.

**Specification:**
- Source: database only, no external API calls
- Default: most recent 10 open (not alerted or all) opportunities
- Fields: sport, match (home vs away), selection (outcome), odds, edge %, detected timestamp
- Optional filter: `status` (open/alerted/all), `sport` (sport slug)
- Sorted by: `detectedAt` DESC

---

## Verdict

| Category | Status |
|----------|--------|
| Traditional sports pipeline | ❌ Zero output — HTTP 422 on every odds request |
| Esports pipeline | ❌ Zero output — no consensus bookmakers after Sprint 21 |
| Discord commands | ❌ All blocked — member cache empty without GuildMembers intent |
| Settlement system | ✅ Architecture sound — but operates on empty dataset |
| TypeScript compilation | ✅ Zero errors |
| Database schema | ✅ Correct and migrated |
| Queue infrastructure | ✅ Workers, schedulers, job registration functional |

**V1 is structurally sound but produces no output in production due to three implementation bugs. None of the value detection, alerting, or paper trading features have ever functioned in a deployed environment. The system has been validating TypeScript types while the core pipeline was silently broken across multiple sprints.**

**Minimum fix set before deployment:**
1. Fix `odds-snapshot-ingestion.service.ts:92` — add `regions: 'eu,us,uk', markets: 'h2h', oddsFormat: 'decimal'`
2. Fix `oddspapi.config.ts:17` — restore `bet365` and `unibet` to `BOOKMAKERS`
3. Fix `discord-bot.service.ts:113` — replace `members.cache.get()` with `interaction.memberPermissions`

These three changes unblock all three pipelines. No architectural redesign required.
