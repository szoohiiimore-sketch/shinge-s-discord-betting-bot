# Restore Missing Discord Commands

**Date:** 2026-06-08  
**Scope:** Restore the 4 Discord slash commands removed during the ROI Presence implementation  

---

## Files Modified

| File | Change |
|---|---|
| `src/discord/discord-bot.service.ts` | Added 4 import lines, 4 `SLASH_COMMANDS` definitions, 4 `_handleCommand` handler blocks |

---

## Restoration Details

### Imports Added (lines 10–13)

```typescript
import { getRoiStats } from './commands/roi';
import { getPaperBankroll } from './commands/paper-bankroll';
import { getBestSports } from './commands/best-sports';
import { getValueBets } from './commands/value-bets';
```

### SLASH_COMMANDS Entries Added

| Command | Description | Options |
|---|---|---|
| `roi` | Show paper trading ROI and win rate | Optional: `period` (7d, 30d, all) |
| `paper-bankroll` | Show paper trading bankroll (starting: 1000 units) | None |
| `best-sports` | Show ROI and win rate by sport | None |
| `value-bets` | Show value opportunities from the database (newest first) | Optional: `status` (all, open, alerted), `sport` (slug filter) |

### _handleCommand Blocks Added

All 4 handlers follow the same pattern as existing commands — import the function, call it with the Prisma client and options, reply with the content.

---

## Command Count

| Status | Count | Commands |
|---|---|---|
| **Before** | 4 | test-value-bets, bot-status, force-scan, force-ingestion |
| **After** | **8** | test-value-bets, bot-status, force-scan, force-ingestion, roi, paper-bankroll, best-sports, value-bets |

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| `/roi` registered | ✅ In `SLASH_COMMANDS` array |
| `/paper-bankroll` registered | ✅ In `SLASH_COMMANDS` array |
| `/best-sports` registered | ✅ In `SLASH_COMMANDS` array |
| `/value-bets` registered | ✅ In `SLASH_COMMANDS` array |
| All 4 `getRoiStats`, `getPaperBankroll`, `getBestSports`, `getValueBets` imported | ✅ |
| All 4 handler blocks present in `_handleCommand` | ✅ |
| ROI Presence feature preserved | ✅ `_updatePresence()` unchanged |
| All existing commands preserved | ✅ test-value-bets, bot-status, force-scan, force-ingestion unchanged |

---

## Verdict

**PASS** — All 4 missing commands restored. SLASH_COMMANDS array increased from 4 to 8 entries. All 4 command files exist on disk and are now properly imported, registered, and handled.