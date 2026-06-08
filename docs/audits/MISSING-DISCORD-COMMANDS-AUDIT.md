# Missing Discord Commands Audit

**Date:** 2026-06-08  
**Scope:** Investigate why `/roi`, `/paper-bankroll`, `/best-sports`, and `/value-bets` no longer appear  

---

## Root Cause

**A) Commands are not defined in the `SLASH_COMMANDS` array.**

The `SLASH_COMMANDS` array in `src/discord/discord-bot.service.ts` contains only 4 entries. The 4 missing commands were **removed during the ROI presence implementation** when `discord-bot.service.ts` was rewritten with `write_to_file`.

### Current `SLASH_COMMANDS` (lines 13–40)

```typescript
const SLASH_COMMANDS = [
  { name: 'test-value-bets', description: 'Show top 5 value bets by edge' },
  { name: 'bot-status', description: 'Display infrastructure health' },
  { name: 'force-scan', description: 'Trigger manual value detection on recent matches' },
  { name: 'force-ingestion', description: 'Trigger real API fetch → odds snapshots → value detection', options: [...] },
];
```

**The following commands are MISSING from the array:**

- `roi`
- `paper-bankroll`
- `best-sports`
- `value-bets`

---

## Trace

### Registration Flow

```
DiscordBotService.login()
  → SLASH_COMMANDS (hardcoded array)
  → REST.put(Routes.applicationGuildCommands(clientId, guildId), { body: SLASH_COMMANDS })
  → Discord API receives ONLY the 4 commands in the array
  → Discord overwrites previous command list with these 4
```

Discord's `PUT` method replaces ALL previously registered guild commands with the provided list. The previous registration (which included 8 commands) was fully overwritten by the current 4-command list.

### History

| Sprint | SLASH_COMMANDS Count | Commands |
|---|---|---|
| Before ROI presence changes | 8 | test-value-bets, bot-status, force-scan, force-ingestion, roi, paper-bankroll, best-sports, value-bets |
| After `discord-bot.service.ts` rewrite | **4** | test-value-bets, bot-status, force-scan, force-ingestion |

The 4 missing commands were removed when `discord-bot.service.ts` was overwritten during the ROI presence implementation. The rewrite stripped the SLASH_COMMANDS array of the extra commands and their corresponding import statements.

---

## Is `_handleCommand` Also Missing Handlers?

### Current `_handleCommand` (lines 108–148)

The handler method contains `if` blocks for:
- `test-value-bets` ✅
- `bot-status` ✅
- `force-scan` ✅
- `force-ingestion` ✅

The missing commands (`roi`, `paper-bankroll`, `best-sports`, `value-bets`) have no `if` blocks either. They were also removed during the rewrite. The handler blocks referenced imports (`getRoiStats`, `getPaperBankroll`, `getBestSports`, `getValueBets`) that were removed as well.

---

## Related Files

| File | Status | Details |
|---|---|---|
| `src/discord/discord-bot.service.ts` | **Contains the bug** | `SLASH_COMMANDS` array has 4 entries instead of 8 |
| `src/discord/commands/roi.ts` | Exists on disk | But never imported or registered |
| `src/discord/commands/paper-bankroll.ts` | Exists on disk | But never imported or registered |
| `src/discord/commands/best-sports.ts` | Exists on disk | But never imported or registered |
| `src/discord/commands/value-bets.ts` | Exists on disk | But never imported or registered |

---

## Recommended Fix

1. Add the 4 missing command definitions to the `SLASH_COMMANDS` array
2. Add the 4 missing import statements
3. Add the 4 missing `if` blocks in `_handleCommand`

### Implementation Complexity: **LOW**

Adding 4 command definitions to an array, 4 import lines, and 4 handler blocks. No database changes, no new logic, no configuration changes.

### Risk Level: **LOW**

The command files already exist and work independently. This is purely a registration and wiring restoration.

---

## Summary

| Question | Answer |
|---|---|
| Are the command files on disk? | ✅ YES — all 4 files exist |
| Are they imported? | ❌ NO — removed during rewrite |
| Are they in SLASH_COMMANDS? | ❌ NO — removed during rewrite |
| Are they handled in `_handleCommand`? | ❌ NO — removed during rewrite |
| Root cause | `discord-bot.service.ts` rewrite stripped extra commands |
| Fix complexity | LOW — restore 4 definitions, 4 imports, 4 handlers |

**Verdict:** The 4 commands were inadvertently removed when `discord-bot.service.ts` was rewritten. The command files exist intact but are neither imported nor registered.