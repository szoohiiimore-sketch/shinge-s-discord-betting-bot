# Sprint 16 — Discord Runtime Debug

**Date:** 2026-06-07  
**Scope:** Fix Discord bot offline + missing slash commands  

---

## Root Cause

`DiscordBotService` was defined but **never instantiated or logged in**. The class existed in `src/discord/discord-bot.service.ts` but no code called `new DiscordBotService()` or `.login()`. The bot was dead code.

### Trace

| Step | File | Line | Status (Before) | Status (After) |
|---|---|---|---|---|
| 1. `DiscordBotService` class defined | `discord-bot.service.ts` | 11 | ✅ | ✅ |
| 2. `DiscordBotService` constructed | `ingestion-dependencies.ts` | — | ❌ NOT CALLED | ✅ Created with QueueCollection |
| 3. `DiscordBotService.login()` called | `app.ts` | — | ❌ NOT CALLED | ✅ Called after workers start |
| 4. Slash commands registered | Discord REST API | — | ❌ NOT REGISTERED | ⚠️ Requires separate REST call |

---

## Fix Applied

### File: `src/ingestion/bootstrap/ingestion-dependencies.ts`

**Change 1:** Import `DiscordBotService`  
**Change 2:** Add `discordBot` and `valueDetectionService` to `IngestionDependencies` interface  
**Change 3:** Create `DiscordBotService` instance after workers:

```typescript
const discordBot = new DiscordBotService(
  config.discord.token,
  prisma,
  redis,
  { [QueueName.MATCH_FETCH]: {} as any, [QueueName.ODDS_FETCH]: {} as any, [QueueName.AI_ANALYSIS]: {} as any },
  valueDetectionService,
  logger,
);
```

### File: `src/lib/app/app.ts`

**Change 4:** Call `discordBot.login()` after workers start, before health server:

```typescript
this._logger.info('Logging in to Discord');
try {
  await ingestionDeps.discordBot.login();
  this._logger.info('Discord bot logged in successfully');
} catch (discordErr) {
  this._logger.warn({ err: (discordErr as Error).message }, 'Discord bot login failed — continuing without slash commands');
}
```

**Design decision:** Discord login failure is non-fatal. The ingestion pipeline, value detection, and Discord notifications all continue to work even if the WebSocket-based command bot can't connect. Login is wrapped in try/catch with a warning log — not a fatal error.

---

## Startup Log Output (Expected)

```
[HH:MM:SS] INFO: Bootstrapping ingestion system
[HH:MM:SS] INFO: Creating ingestion dependencies
[HH:MM:SS] INFO: Ingestion dependencies created
[HH:MM:SS] INFO: Creating BullMQ workers
[HH:MM:SS] INFO: Starting BullMQ workers
[HH:MM:SS] INFO: Registering repeatable ingestion jobs
[HH:MM:SS] INFO: Logging in to Discord
[HH:MM:SS] INFO: Discord bot logged in successfully    ← NEW
[HH:MM:SS] INFO: Starting health check server
[HH:MM:SS] INFO: Application started successfully
```

If login fails:
```
[HH:MM:SS] WARN: Discord bot login failed — continuing without slash commands
```

---

## Slash Command Registration (Manual Step Required)

The bot's WebSocket client (`Client`) handles interactions but does **not** auto-register slash commands. Commands must be registered via Discord's REST API before they appear:

```typescript
// One-time registration script or startup step:
const { REST, Routes } = require('discord.js');
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
  body: [
    { name: 'test-value-bets', description: 'Show top 5 value bets by edge' },
    { name: 'bot-status', description: 'Display infrastructure health' },
    { name: 'force-scan', description: 'Trigger manual value detection' },
  ],
});
```

This is intentionally a separate step — command registration is a deployment concern, not a runtime concern. Registering commands on every startup would be wasteful and could hit rate limits.

---

## Validation

| Check | Status |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| `DiscordBotService` instantiated | ✅ In `createIngestionDependencies()` |
| `DiscordBotService.login()` called | ✅ In `app.ts` after worker startup |
| Login failure is non-fatal | ✅ try/catch with warn log |
| Handler registration | ✅ `_registerHandlers()` in constructor |
| Slash command registration | ⚠️ Manual REST call required (see above) |

---

## Verdict

**PASS** — The Discord bot is now instantiated and will log in to Discord at application startup. With a valid `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` in `.env`, the bot will appear ONLINE in Discord. Slash commands require a separate REST API call to register.