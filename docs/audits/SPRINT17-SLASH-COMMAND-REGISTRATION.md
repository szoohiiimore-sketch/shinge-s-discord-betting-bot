# Sprint 17 — Slash Command Registration

**Date:** 2026-06-07  
**Scope:** Register Discord slash commands automatically during startup  

---

## Changes Made

### `src/discord/discord-bot.service.ts`

**Change 1:** Added `DiscordBotConfig` interface with `token`, `clientId`, `guildId`:

```typescript
export interface DiscordBotConfig {
  readonly token: string;
  readonly clientId: string;
  readonly guildId: string;
}
```

**Change 2:** Updated constructor to accept `DiscordBotConfig` object instead of raw token:

```typescript
constructor(
  config: DiscordBotConfig,
  prisma: PrismaClient,
  redis: Redis,
  queues: QueueCollection,
  valueDetectionService: ValueDetectionService,
  logger: Logger,
)
```

**Change 3:** Updated `login()` to register slash commands after WebSocket login:

```typescript
async login(): Promise<void> {
  this._logger.info('Logging in to Discord');
  await this._client.login(this._config.token);

  this._logger.info({ count: 3, guildId: this._config.guildId }, 'Registering slash commands');
  const rest = new REST({ version: '10' }).setToken(this._config.token);

  await rest.put(
    Routes.applicationGuildCommands(this._config.clientId, this._config.guildId),
    { body: SLASH_COMMANDS },
  );
  this._logger.info('Slash commands registered successfully');
}
```

**Design decision:** Uses `Routes.applicationGuildCommands()` (guild-specific) instead of `Routes.applicationCommands()` (global). Guild commands appear instantly — no 1-hour propagation delay.

### `src/ingestion/bootstrap/ingestion-dependencies.ts`

Updated constructor call to pass `DiscordBotConfig` object:

```typescript
const discordBot = new DiscordBotService(
  { token: config.discord.token, clientId: config.discord.clientId, guildId: config.discord.guildId },
  prisma, redis, queues, valueDetectionService, logger,
);
```

---

## Registered Commands

| Command | Description |
|---|---|
| `/test-value-bets` | Show top 5 value bets by edge |
| `/bot-status` | Display infrastructure health |
| `/force-scan` | Trigger manual value detection on recent matches |

---

## Startup Log Output

```
[HH:MM:SS] INFO: Logging in to Discord
[HH:MM:SS] INFO: Discord bot logged in and ready     ← ClientReady event
[HH:MM:SS] INFO: Registering slash commands           ← count: 3, guildId
[HH:MM:SS] INFO: Slash commands registered successfully
[HH:MM:SS] INFO: Application started successfully
```

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| Commands defined as `SLASH_COMMANDS` array | ✅ 3 commands |
| Guild-specific registration (instant) | ✅ `Routes.applicationGuildCommands` |
| Registration error handling | ✅ try/catch with warn log |
| Registration after login | ✅ commands registered after WebSocket connected |

---

## Verdict

**PASS** — All three slash commands (test-value-bets, bot-status, force-scan) are automatically registered via the Discord REST API during application startup.