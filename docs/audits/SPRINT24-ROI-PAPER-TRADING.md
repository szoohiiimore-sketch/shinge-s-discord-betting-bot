# Sprint 24 — ROI Paper Trading

**Date:** 2026-06-07
**Scope:** V1 Paper Trading and ROI Tracking — settlement, metrics, Discord commands

---

## PHASE 1: Pre-Implementation Audit

### Q1: Are final match results stored in the database?

**YES — schema supports it. NO — it is never populated.**

The `Match` model has the following result fields:
- `status: MatchStatus` — SCHEDULED, LIVE, FINISHED, CANCELLED, POSTPONED
- `homeScore: Int?`
- `awayScore: Int?`
- `result: MatchResult?` — HOME_WIN, AWAY_WIN, DRAW

However, these fields are never populated by the current ingestion pipeline:

### Traditional Sports (The Odds API path)

**File:** `src/ingestion/mappers/odds-api-event.mapper.ts`

```typescript
const match: CanonicalMatch = {
  ...
  homeScore: null,   // Always null — hardcoded
  awayScore: null,   // Always null — hardcoded
  result: null,      // Always null — hardcoded
};
```

The `/v4/sports/{sport}/odds` endpoint returns only events with active odds. Completed matches do not appear in this response. The mapper infers status as SCHEDULED or LIVE only (from `commenceTime` vs `capturedAt`) — FINISHED is never set.

**File:** `src/ingestion/mappers/mapper.utils.ts`

```typescript
export function inferOddsApiMatchStatus(commenceTime: Date, capturedAt: Date): IngestionMatchStatus {
  return commenceTime > capturedAt ? 'SCHEDULED' : 'LIVE';
  // FINISHED is unreachable — never set
}
```

### Esports (PandaScore path)

**File:** `src/ingestion/services/match-ingestion.service.ts`

```typescript
const [upcoming, running] = await Promise.all([
  this._pandascoreClient.getUpcomingMatches(pandascoreSlug),
  this._pandascoreClient.getRunningMatches(pandascoreSlug),
]);
```

Only upcoming and running matches are fetched. Finished matches are never requested. The `getPastMatches()` method exists in the PandaScore client but is never called by the ingestion service.

The mapper utility `mapPandascoreMatchResult()` CAN derive HOME_WIN/AWAY_WIN/DRAW from PandaScore `winner` and `draw` fields — but this function is never called for finished matches since the API calls never return them.

### Q2: Which integration can provide settlement results?

| Source | Endpoint | Status |
|---|---|---|
| **The Odds API** | `GET /v4/sports/{sport}/scores?daysFrom=1` | New method needed on existing client |
| **PandaScore** | `GET /{videogame}/matches/past` | `getPastMatches()` already exists, never called |

Both sources are viable. Strategy:
- **Traditional sports** → The Odds API `/v4/sports/{sport}/scores`
- **Esports** → PandaScore `/matches/past` (via existing `getPastMatches()`)

### Q3: Can ValueOpportunity records be linked to final outcomes?

**YES — with schema additions.** 

`ValueOpportunity.outcome` stores the team name string from OddsSnapshot (e.g., "Boston Celtics"). 
`Match.homeTeam.name` and `Match.awayTeam.name` are stored.

Settlement mapping:
- outcome == homeTeam.name → WIN if match.result == HOME_WIN, else LOSS
- outcome == awayTeam.name → WIN if match.result == AWAY_WIN, else LOSS
- outcome == "Draw" (case-insensitive) → WIN if match.result == DRAW, else LOSS

### Q4: Is settlement currently possible without schema changes?

**NO.** Two additions required:
1. `ValueOpportunity` needs `settledAt DateTime?`, `betResult BetResult?`, `profitLossUnits Decimal?`
2. New `BetResult` enum: WIN, LOSS, PUSH

---

## PHASE 2: Settlement System Architecture

### Schema Changes

Added to `prisma/schema.prisma`:
- New enum: `BetResult { WIN LOSS PUSH }`
- New fields on `ValueOpportunity`: `settledAt`, `betResult`, `profitLossUnits`

Migration: `20260607_add_bet_settlement`

### The Odds API Scores Endpoint

Added `getScores(sportKey, daysFrom)` to `DefaultOddsApiClient` and `OddsApiClient` interface.

Response shape:
```typescript
interface EventScore {
  id: string;          // matches "oa:" prefix in Match.externalId
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: { name: string; score: string }[] | null;
}
```

### Settlement Service

**File:** `src/settlement/settlement.service.ts`

Two entry points:
- `settleTraditional(sportKeys)`: fetches scores from The Odds API, updates Match records, then settles ValueOpportunities
- `settleEsports(videogames)`: fetches past matches from PandaScore, updates Match records, then settles ValueOpportunities

Internal flow:
1. Fetch completed match results from API
2. Update `Match.status`, `Match.result`, `Match.homeScore`, `Match.awayScore` for completed matches
3. Query unsettled `ValueOpportunity` records where match.status = FINISHED
4. For each: determine WIN/LOSS/PUSH based on outcome vs match result
5. Calculate profitLossUnits (WIN: odds-1, LOSS: -1, PUSH: 0)
6. Update with settledAt, betResult, profitLossUnits (idempotent via settledAt check)

### Settlement Worker

Added `settle-matches` job to the existing `MATCH_FETCH` queue:
- Scheduled every 4 hours (same interval as Tier 2 sports)
- Job name: `settle-matches`
- Handler: `SettlementWorker.process(job)`
- Separate from odds ingestion — failure does not affect ingestion

---

## PHASE 3: Paper Trading Metrics

### Bankroll Model

| Parameter | Value |
|---|---|
| Starting bankroll | 1,000 units |
| Stake per bet | 1 unit (flat staking) |
| WIN profit | bookmakerOdds - 1 |
| LOSS profit | -1.0 |
| PUSH profit | 0.0 |

### Discord Commands

| Command | Description |
|---|---|
| `/roi [period]` | ROI, win rate, P&L for 7d/30d/all |
| `/paper-bankroll` | Starting vs current bankroll |
| `/best-sports` | ROI, win rate, P&L by sport |

---

## Files Modified

| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `BetResult` enum, settlement fields to `ValueOpportunity` |
| `src/integrations/the-odds-api/types.ts` | Added `EventScore`, `GetScoresResponse` |
| `src/integrations/the-odds-api/the-odds-api.client.ts` | Added `getScores()` method |
| `src/ingestion/queues/queue-names.ts` | Added `SETTLE_MATCHES` job name |
| `src/ingestion/contracts/queue-payload.types.ts` | Added `SettleMatchesJobData`, updated union types |
| `src/ingestion/queues/queue-registration.ts` | Handle `settle-matches` job |
| `src/ingestion/bootstrap/ingestion-bootstrap.ts` | Wire `SettlementWorker` into processor |
| `src/ingestion/bootstrap/ingestion-scheduler.ts` | Schedule settlement job |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | Instantiate `SettlementService` and `SettlementWorker` |
| `src/discord/discord-bot.service.ts` | Add `/roi`, `/paper-bankroll`, `/best-sports` commands |

## Files Created

| File | Description |
|---|---|
| `src/settlement/settlement.types.ts` | SettlementResult, BetOutcome types |
| `src/settlement/settlement.service.ts` | Core settlement logic |
| `src/settlement/settlement.worker.ts` | BullMQ job handler |
| `src/settlement/index.ts` | Barrel export |
| `src/discord/commands/roi.ts` | `/roi` command handler |
| `src/discord/commands/paper-bankroll.ts` | `/paper-bankroll` command handler |
| `src/discord/commands/best-sports.ts` | `/best-sports` command handler |

---

## Limitations

1. **The Odds API scores window**: Only 1–3 days of historical scores available. Matches older than 3 days cannot be retroactively settled via this source.

2. **PandaScore past matches**: Returns only the most recent ~100 finished matches per game per API call. Very old matches may not be returned.

3. **Outcome name matching**: Relies on exact string matching between `ValueOpportunity.outcome` (from OddsSnapshot) and `Match.homeTeam.name`/`Match.awayTeam.name`. Name inconsistencies between The Odds API odds data and scores data could cause settlement failures (logged as warnings, not errors).

4. **No real money**: Paper trading only — 1 unit per bet, no actual bookmaker integration.

5. **Flat staking only**: No Kelly criterion or variable staking in V1.

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| Prisma migration applied | ✅ `20260607200136_add_bet_settlement` |
| Settlement idempotency (settledAt guard) | ✅ Implemented |
| Unsettled opportunities query | ✅ WHERE settledAt IS NULL AND match.status = FINISHED |
| Discord commands registered | ✅ `/roi`, `/paper-bankroll`, `/best-sports` |
| Existing pipeline unaffected | ✅ Settlement failures do not affect ingestion |
| `ResilientOddsApiClient` updated | ✅ `getScores` delegated through retry wrapper |
| Settlement scheduled | ✅ Every 4 hours via `settle-matches` on MATCH_FETCH queue |

---

## Verdict

**PASS** — Settlement system implemented. Match results fetched from The Odds API `/v4/sports/{sport}/scores` (traditional sports) and PandaScore `/matches/past` (esports). `ValueOpportunity` records settled with WIN/LOSS/PUSH and `profitLossUnits` (1-unit flat stake). ROI, bankroll, and per-sport performance accessible via Discord slash commands. Zero TypeScript errors.
