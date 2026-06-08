# Discord Message Length Audit

**Date:** 2026-06-08  
**Scope:** Identify which Discord command generates messages exceeding Discord's 2000 character limit  

---

## All Commands Analyzed

| Command | Sends via | Has Truncation? | Max Length Estimate | Safe? |
|---|---|---|---|---|
| `/value-bets` | `interaction.reply` | ✅ `content.length > 1900 → truncate` | ~1,900 chars | ✅ **Safe** (hard truncation at 1870) |
| `/best-sports` | `interaction.reply` | ❌ **None** | **~3,780 chars** | ❌ **VULNERABLE** |
| `/roi` | `interaction.reply` | N/A (fixed output) | ~300 chars | ✅ Safe |
| `/paper-bankroll` | `interaction.reply` | N/A (fixed output) | ~300 chars | ✅ Safe |
| `/bot-status` | `interaction.reply` | N/A (fixed output) | ~500 chars | ✅ Safe |
| `/force-ingestion` | `interaction.editReply` | ❌ **None** | **~3,200 chars** | ❌ **VULNERABLE** |
| `/force-scan` | `interaction.reply` | N/A (fixed output) | ~300 chars | ✅ Safe |
| `/test-value-bets` | `interaction.reply` | Capped at 5 by `take: 5` | ~500 chars | ✅ Safe |
| Discord alert notifications | `channel.send` | N/A (single match) | ~400 chars | ✅ Safe |
| Settlement outcomes | `channel.send` | N/A (single match) | ~200 chars | ✅ Safe |
| Daily summary | `channel.send` | N/A (single message) | ~400 chars | ✅ Safe |

---

## 1. `/force-ingestion` — Source of the Bug

### File: `src/discord/commands/force-ingestion.ts`, lines 92–106

When called with `source: 'all'`, the function iterates over ALL 50 entries in `SPORT_KEY_TO_GROUP`:

```typescript
for (const [sportKey, group] of Object.entries(SPORT_KEY_TO_GROUP)) {
  // ... enqueues job
  jobs.push({ queue: 'match-fetch', jobName: 'sync-traditional-sport', ... });
}

// Plus 4 esports games
for (const videogame of gameKeys) {
  jobs.push({ queue: 'match-fetch', jobName: 'sync-esports-game', ... });
}
```

### Worst-case message length calculation

```
Header:  "**Data Source:** External API..." + "**API Calls:** Pending..." + "🚀 FORCE INGESTION" + "**Source:** all" + "**Sport Key:** (all)" + "**Jobs Enqueued:** 54" = ~300 chars
54 entries at ~45 chars each = 2,430 chars
Footer: "Jobs will execute asynchronously..." = ~80 chars
Total: ~2,810 chars → **EXCEEDS 2,000**
```

### Actual vulnerable code path (lines 92–106)

No truncation or length check on the response content before `interaction.editReply()`.

---

## 2. `/best-sports` — Secondary Risk

### File: `src/discord/commands/best-sports.ts`, lines 58–69

```typescript
for (const row of rows) {
  lines.push(
    `**${displaySport(row.sport)}** — ${row.total} bets`,
    `ROI: ${roiSign}${row.roi.toFixed(1)}% | Win Rate: ... | P&L: ...`,
    '',
  );
}
```

With 54 unique sports (50 traditional + 4 esports) stored in the database, each sport generates ~70 characters. `54 × 70 = 3,780 chars` + header ~1,000 chars overwritten.

But wait — the `bySport` map contains at most the number of unique `value_opportunity.sport` values that have settled bets. The actual number is likely much smaller (maybe 10-20 unique sports with settled bets). But if all 54 sports have settled bets, this would exceed 2000.

### No truncation protection

There is no length check between `lines.join('\n')` and `return { content }`.

---

## Recommended Fix

### Option A: Truncation (Recommended — **LOWEST** risk)

For both vulnerable commands, add a length guard after building the content:

```typescript
const content = lines.join('\n');
if (content.length > 1990) {
  return { content: content.slice(0, 1960) + '\n\n*(truncated — too many results)*' };
}
return { content };
```

This is the same pattern already used by `/value-bets` (lines 91-94).

**Files to change:**
- `src/discord/commands/force-ingestion.ts` — Add truncation after `lines.join('\n')`
- `src/discord/commands/best-sports.ts` — Add truncation after `lines.join('\n')`

### Option B: Split into Multiple Messages

Would require changing return type to `string[]` and sending multiple replies. More complex, higher risk.

### Option C: Discord Embeds

Embeds are not subject to the 2000-char limit per field but have their own limits (6000 chars total). However, switching to embeds would require changing all commands for consistency.

**Recommended: Option A — Truncation to 1990 chars**

---

## Summary

| Command | File | Lines | Issue | Fix |
|---|---|---|---|---|
| `/force-ingestion` | `force-ingestion.ts` | 92–106 | No length guard on 50+ job entries | Truncate to 1990 chars |
| `/best-sports` | `best-sports.ts` | 58–69 | No length guard on 54+ sport entries | Truncate to 1990 chars |

Both fixes follow the same pattern already implemented in `/value-bets`.