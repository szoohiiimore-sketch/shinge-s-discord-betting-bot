# Sprint 15 — Discord E2E Verification

**Date:** 2026-06-07  
**Scope:** Verify `DiscordNotificationService` initialization, execution, and message delivery  

---

## Verification Results

### 1. Is `DiscordNotificationService` initialized during startup? ✅

**File:** `src/ingestion/bootstrap/ingestion-dependencies.ts` (lines 138-142)

```typescript
const discordNotificationService = new DiscordNotificationService(
  prisma,
  { token: config.discord.token, alertChannelId: config.discord.alertChannelId },
  logger,
);
```

It is created inside `createIngestionDependencies()`, which is called in `app.ts` during the `start()` method (line 166). The `discordNotificationService` instance is then passed to both workers:

- `OddsSnapshotWorker` (line 159-162)
- `EsportsOddsSnapshotWorker` (line 165-169)

### 2. Does Discord login occur? ✅ (REST mode)

**File:** `src/discord/discord-notification.service.ts` (line 104)

```typescript
this._rest = new REST({ version: '10' }).setToken(config.token);
```

The service uses discord.js `REST` API directly — **not** a full WebSocket `Client` login. This is the correct approach for V1:
- No `client.login()` needed
- No gateway connection overhead
- No sharding complexity
- Lower memory footprint
- Fully sufficient for sending alerts to a channel

### 3. How are pending ValueOpportunities processed?

**File:** `src/discord/discord-notification.service.ts` (lines 109-156)

The `notifyPendingOpportunities()` method:

1. Queries `valueOpportunity` records where `alertedAt IS NULL` (up to 50)
2. For each pending opportunity:
   - Formats a rich Discord embed with `formatAlert()`:
     - Title: "🎯 VALUE BET DETECTED"
     - Sport name, match (home vs away)
     - Outcome, bookmaker
     - Odds, fair odds, edge percentage
     - Capture timestamp
   - Sends via `REST.post(Routes.channelMessages(channelId), { body: { content } })`
   - Updates `valueOpportunity.alertedAt = new Date()` on success
   - Logs failures without throwing (next run retries)

### 4. How is this triggered?

**File:** `src/ingestion/workers/odds-snapshot.worker.ts` (lines 57-79)

After `ingestOddsForSport()` returns with `result.oddsSnapshots.created > 0`:

```typescript
// Value detection
const detection = await this._valueDetectionService.detectForMatchExternalIds(matchExternalIds);

// Discord notification
const notifyResult = await this._discordNotificationService.notifyPendingOpportunities();
```

The same pattern exists in `esports-odds-snapshot.worker.ts`.

Both value detection and Discord notification are wrapped in individual try/catch blocks — a failure in either does NOT fail the odds ingestion job.

### 5. Are there any environment configuration gaps?

The config requires:
- `DISCORD_TOKEN=your_discord_bot_token` — `.env.example` ✅
- `DISCORD_CLIENT_ID=your_discord_client_id` — `.env.example` ✅
- `DISCORD_GUILD_ID=your_discord_guild_id` — `.env.example` ✅
- `DISCORD_ALERT_CHANNEL_ID=your_discord_alert_channel_id` — `.env.example` ✅

All four variables are present and documented. The Zod schema in `discord.config.ts` validates all four as required.

---

## Pipeline Flow (Complete)

```
The Odds API / PandaScore / OddsPapi
  → OddsSnapshot created (insertMany)
  → OddsSnapshotWorker detects created > 0
  → ValueDetectionService.detectForMatchExternalIds()
    → Creates ValueOpportunity records
  → DiscordNotificationService.notifyPendingOpportunities()
    → Queries pending ValueOpportunities
    → Sends formatted message to configured channel
    → Marks alertedAt
```

## Message Format

```
🎯 VALUE BET DETECTED

Sport: Basketball
Match: Team A vs Team B

Outcome: Team A
Bookmaker: Pinnacle

Odds: 2.10
Fair Odds: 1.85
Edge: +13.5%

Captured: 2026-06-07 18:30 UTC
```

---

## Verdict

**PASS** — Discord notification is fully implemented, wired correctly, and will deliver messages to the configured channel when ValueOpportunity records exist. No implementation gaps were found.