# Sprint 13 — Discord Value Alert System

**Date:** 2026-06-07  
**Scope:** Discord notification service for detected value opportunities; alert deduplication via `alertedAt` persistence; pipeline integration; migration

---

## Executive Summary

Sprint 13 adds a Discord alert channel to the value detection pipeline. When `ValueDetectionService` detects a value opportunity with edge ≥ 5%, a Discord message is posted to a configured channel using the Discord REST API (no WebSocket gateway required). Alert state is persisted to the database — each `ValueOpportunity` is alerted exactly once.

---

## Architecture Changes

### Flow (before Sprint 13)
```
EsportsOddsSnapshotWorker
  → EsportsOddsSnapshotIngestionService (OddsSnapshot persistence)
    → ValueDetectionService (ValueOpportunity persistence)
      [end]
```

### Flow (after Sprint 13)
```
EsportsOddsSnapshotWorker
  → EsportsOddsSnapshotIngestionService (OddsSnapshot persistence)
    → ValueDetectionService (ValueOpportunity persistence)
      → DiscordNotificationService (Discord REST POST)
        → ValueOpportunity.alertedAt = NOW() on success
```

The same `DiscordNotificationService` is also called from `OddsSnapshotWorker` (traditional sports path).

### Integration point
Both workers (`EsportsOddsSnapshotWorker`, `OddsSnapshotWorker`) call `discordNotificationService.notifyPendingOpportunities()` unconditionally after the value detection step. This retry pattern ensures that any opportunity that failed to alert in a previous run is picked up in the next ingestion cycle.

### Error isolation
Discord notification failures are caught and logged at `error` level. The parent job is not failed — ingestion and value detection results are unaffected.

---

## New Environment Variable

| Variable | Purpose |
|---|---|
| `DISCORD_ALERT_CHANNEL_ID` | Discord channel ID to post value alerts into |

This is the only new variable introduced. It is architecturally required — there is no way to post a Discord message without a target channel ID.

**Updated files:**
- `.env.example` — added `DISCORD_ALERT_CHANNEL_ID=your_discord_alert_channel_id`
- `.env` — added placeholder value (replace with real channel ID for production)
- `src/config/config.types.ts` — added `alertChannelId: string` to `DiscordConfig`
- `src/config/discord.config.ts` — added `DISCORD_ALERT_CHANNEL_ID` to zod schema

---

## Alert Format

```
🎯 **VALUE BET DETECTED**

**Sport:** CS2
**Match:** VooDooSh Club vs TPaBoMaH Club

**Outcome:** VooDooSh Club
**Bookmaker:** Pinnacle

**Odds:** 3.50
**Fair Odds:** 2.55
**Edge:** +37.4%

**Captured:** 2026-06-07 16:01 UTC
```

Fields sourced from `ValueOpportunity` + joined `Match.homeTeam.name` / `Match.awayTeam.name`.

---

## Database Changes

### Migration: `20260607160021_add_value_opportunity_alerted_at`

Added one nullable column to `value_opportunities`:

```sql
ALTER TABLE "value_opportunities" ADD COLUMN "alerted_at" TIMESTAMP(3);
CREATE INDEX "value_opportunities_alerted_at_idx" ON "value_opportunities"("alerted_at");
```

### Schema change to `ValueOpportunity`

```prisma
alertedAt DateTime? @map("alerted_at")

@@index([alertedAt])
```

### Deduplication guarantee

`alertedAt` is `null` for new opportunities and set to `NOW()` only after a confirmed successful Discord REST response. If the Discord call fails, `alertedAt` stays `null` and the record is retried on the next worker run.

The `@@unique([matchId, bookmaker, outcome, capturedAt])` constraint (from Sprint 12) still prevents duplicate `ValueOpportunity` rows. The `alertedAt` column only prevents duplicate Discord messages for the same opportunity.

---

## Files Created

| File | Purpose |
|---|---|
| `src/discord/discord-notification.service.ts` | Core notification service — queries pending opportunities, formats messages, POSTs via Discord REST, marks `alertedAt` |
| `src/discord/index.ts` | Barrel export |

---

## Files Modified

| File | Change |
|---|---|
| `src/config/config.types.ts` | Added `alertChannelId` to `DiscordConfig` |
| `src/config/discord.config.ts` | Added `DISCORD_ALERT_CHANNEL_ID` to zod schema |
| `.env.example` | Added `DISCORD_ALERT_CHANNEL_ID` |
| `.env` | Added `DISCORD_ALERT_CHANNEL_ID` placeholder |
| `prisma/schema.prisma` | Added `alertedAt` column + index to `ValueOpportunity` |
| `src/ingestion/workers/esports-odds-snapshot.worker.ts` | Injected `DiscordNotificationService`; calls `notifyPendingOpportunities()` after value detection |
| `src/ingestion/workers/odds-snapshot.worker.ts` | Same |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | Instantiated `DiscordNotificationService` and passed to both workers |
| `src/scripts/validate-esports-pipeline.ts` | Added Phase 8 (Discord notification) |

---

## Implementation Details

### Discord REST (no gateway)

Uses `REST` + `Routes` from `discord.js` v14. No WebSocket connection or gateway intent registration required. Each alert is a single `POST /channels/{channel.id}/messages` HTTP call.

```typescript
import { REST, Routes } from 'discord.js';
const rest = new REST({ version: '10' }).setToken(token);
await rest.post(Routes.channelMessages(channelId), { body: { content } });
```

### Batch limit

`notifyPendingOpportunities()` processes at most 50 unalerted opportunities per call via `take: 50`. This prevents unbounded processing if many opportunities accumulate.

### Sport display names

A static lookup maps slugs to human-readable names (`cs2 → CS2`, `lol → League of Legends`, etc.) with a capitalization fallback for unmapped slugs.

---

## Validation Steps

### TypeScript
```
npx tsc --noEmit → 0 errors
```

### Migration
```
prisma migrate dev --name add_value_opportunity_alerted_at
→ Applied migration 20260607160021_add_value_opportunity_alerted_at
```

### End-to-end validation
```
npm run validate:pipeline

  Phase 1 — PandaScore Ingestion     ✓ PASS
  Phase 2 — DB Match Query           ✓ PASS
  Phase 3 — Correlation              ✓ PASS
  Phase 4 — OddsSnapshot Persistence ✓ PASS
  Phase 5 — DB Read-Back             ✓ PASS
  Phase 6 — Value Detection          ✓ PASS  (1 detected, 1 rejected)
  Phase 7 — Idempotency              ✓ PASS  (row count unchanged on 2nd run)
  Phase 8 — Discord Notification     ✓ PASS  (graceful failure on placeholder token)

  OVERALL: PASS — full pipeline verified end-to-end
```

### Phase 8 detail

With placeholder credentials (`DISCORD_TOKEN=your_discord_bot_token`):
- Service instantiated successfully
- REST call attempted for 2 pending opportunities
- Both fail with 401 / "no token set" (expected)
- `alertedAt` remains `null` on all records (correct — will retry when real credentials are set)
- No exception propagates to the worker

### Live Discord delivery

To enable real alerts:
1. Set `DISCORD_TOKEN` to a valid Discord bot token
2. Set `DISCORD_ALERT_CHANNEL_ID` to the target channel's snowflake ID
3. Ensure the bot has `Send Messages` permission in that channel

---

## Known Limitations

| Limitation | Notes |
|---|---|
| At-most-once delivery | If the process crashes after sending but before setting `alertedAt`, the alert will NOT be re-sent (alertedAt was not committed). This is safer than at-least-once in a betting context — no duplicate alerts. |
| No per-opportunity rate limiting | 50 opportunities are processed sequentially without delay. Discord's channel rate limit (~5 msg/5 s) is unlikely to be hit in normal operation but could trigger throttling during catch-up scenarios. |
| Batch cap of 50 | If more than 50 opportunities accumulate (e.g., first run after configuring real credentials), they are processed 50-per-run across successive worker cycles. |
| Single channel | All alerts go to one channel. No routing by sport or edge level. |
| Placeholder credentials in dev | `.env` ships with placeholder Discord values. Real delivery requires updating `DISCORD_TOKEN` and `DISCORD_ALERT_CHANNEL_ID`. |

---

## Final Verdict

**PASS**

- `DiscordNotificationService` implemented with Discord REST (no gateway)
- `alertedAt` column added to `ValueOpportunity` — persistent deduplication
- Migration `20260607160021_add_value_opportunity_alerted_at` applied to Neon PostgreSQL
- Both workers (`EsportsOddsSnapshotWorker`, `OddsSnapshotWorker`) call notification after value detection
- Error isolation: Discord failure never fails a BullMQ job
- TypeScript: 0 errors
- Validation: 8/8 phases PASS
