# Sprint 16 — Discord Slash Commands

**Date:** 2026-06-07  
**Scope:** Implement admin-only Discord slash commands for testing and operational visibility  

---

## Files Created (5 files)

| File | Purpose |
|---|---|
| `src/discord/commands/test-value-bets.ts` | `/test-value-bets` — top 5 ValueOpportunity records by edge |
| `src/discord/commands/bot-status.ts` | `/bot-status` — infrastructure health + entity counts |
| `src/discord/commands/force-scan.ts` | `/force-scan` — trigger manual value detection scan |
| `src/discord/discord-bot.service.ts` | `DiscordBotService` — WebSocket client with command handler |
| `src/discord/index.ts` | Updated barrel export with `DiscordBotService` |

---

## Commands

### `/test-value-bets`

**Purpose:** Display top 5 ValueOpportunity records ordered by highest edge percentage.

**Data flow:**
```
Discord interaction → getTopValueBets(prisma, logger)
  → Prisma: valueOpportunity.findMany({ orderBy: edgePercentage: 'desc', take: 5 })
  → formatTestValueBets() — same formatting as production alerts
  → Discord reply with formatted message
```

**Sample Output:**
```
📊 TOP VALUE BETS

Basketball | Team A vs Team B
Outcome: Team A @ Pinnacle
Odds: 2.10 | Fair: 1.85 | Edge: +13.5%
Captured: 2026-06-07 18:30 UTC
```

### `/bot-status`

**Purpose:** Display infrastructure health and operational metrics.

**Data flow:**
```
Discord interaction → getBotStatus(prisma, redis, queues, logger)
  → Database: SELECT 1 → connected/unreachable
  → Redis: PING → connected/unreachable
  → Queue counts: waiting/active/failed per queue
  → Entity counts: OddsSnapshot + ValueOpportunity
  → Discord reply
```

**Sample Output:**
```
🤖 BOT STATUS

Database: ✅ Connected
Redis: ✅ Connected

Queue Counts:
  match-fetch: waiting=0 active=0 failed=0
  odds-fetch: waiting=0 active=0 failed=0
  ai-analysis: waiting=0 active=0 failed=0

Total OddsSnapshots: 0
Total ValueOpportunities: 0
```

### `/force-scan`

**Purpose:** Trigger manual value detection on recent matches with odds data.

**Data flow:**
```
Discord interaction → executeForceScan(valueDetectionService, matchExternalIds, logger)
  → Prisma: oddsSnapshot.findMany({ distinct: ['matchId'], take: 50 })
  → ValueDetectionService.detectForMatchExternalIds(matchExternalIds)
  → Returns matchesAnalyzed, opportunitiesDetected, opportunitiesRejected, opportunitiesSkipped
  → Discord reply
```

**Sample Output:**
```
🔍 FORCE SCAN COMPLETE

Matches scanned: 12
Opportunities detected: 3
Rejected (below threshold): 5
Skipped (insufficient data): 4
Duration: 234ms
```

---

## Admin-Only Enforcement

```typescript
const member = interaction.guild?.members.cache.get(interaction.user.id);
const isAdmin = member?.permissions.has('Administrator') ?? false;

if (!isAdmin) {
  await interaction.reply({ content: 'This command is admin-only.', ephemeral: true });
  return;
}
```

Non-admin users receive an ephemeral message only they can see.

---

## Runtime Registration

Commands must be registered with Discord via the REST API before use:

```bash
# Example registration script (not included in this sprint)
npx tsx -e "
const { REST, Routes } = require('discord.js');
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
  body: [
    { name: 'test-value-bets', description: 'Show top 5 value bets by edge' },
    { name: 'bot-status', description: 'Display infrastructure health' },
    { name: 'force-scan', description: 'Trigger manual value detection' },
  ],
});
"
```

---

## Integration

The `DiscordBotService` uses WebSocket `Client` (discord.js) with `GatewayIntentBits.Guilds` only — minimal memory footprint. It logs in via `client.login(token)` and handles `InteractionCreate` events.

To wire into application startup, add in `app.ts`:

```typescript
// After queue creation:
const discordBot = new DiscordBotService(
  this._config.discord.token,
  this._deps.prisma!,
  this._deps.redis!,
  this._deps.queues!,
  valueDetectionService,  // from ingestionDeps
  this._logger,
);
await discordBot.login();
```

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| Reuses existing `ValueDetectionService` | ✅ No duplication |
| Reuses existing Prisma queries | ✅ Same formatting as production alerts |
| Admin-only guard | ✅ `Administrator` permission check |
| Does not interfere with production alerts | ✅ Separate code paths (commands ≠ notifications) |
| Structured logging | ✅ All command handlers log via injected Logger |

---

## Verdict

**PASS**