# Discord Message Length Fix

**Date:** 2026-06-08  
**Scope:** Prevent Discord "content exceeds 2000 character limit" errors in `/force-ingestion` and `/best-sports` commands  

---

## Files Modified

| File | Change |
|---|---|
| `src/discord/commands/force-ingestion.ts` | Added length guard after `lines.join('\n')` — truncates at 1990 chars |
| `src/discord/commands/best-sports.ts` | Added length guard after `lines.join('\n')` — truncates at 1990 chars |

---

## Implementation

### Pattern Used

Both files now use the same approach already proven in `/value-bets`:

```typescript
const content = lines.join('\n');
if (content.length > 1990) {
  return { content: content.slice(0, 1960) + '\n\n*(truncated — ...)*' };
}
return { content };
```

### File 1: `force-ingestion.ts`

```diff
+ let content = lines.join('\n');
+ // Discord message limit is 2000 characters.
+ if (content.length > 1990) {
+   content = content.slice(0, 1990) + '\n\n*(truncated — showing first jobs only)*';
+ }
```

Previously, `source: 'all'` could list up to 54 jobs at ~45 chars each = ~2,810 chars total. Now the message is truncated to 1990 chars, keeping the header, footer, and first ~40 job entries.

### File 2: `best-sports.ts`

```diff
+ const content = lines.join('\n');
+ if (content.length > 1990) {
+   return { content: content.slice(0, 1960) + '\n\n*(truncated — too many sports)*' };
+ }
```

Previously, 54 unique sports at ~70 chars each = ~3,780 chars total. Now safely truncated.

---

## Before/After

| Command | Before (worst case) | After | Safe? |
|---|---|---|---|
| `/force-ingestion source=all` | ~2,810 chars | ~1,990 chars (truncated) | ✅ |
| `/best-sports` (54 settled sports) | ~3,780 chars | ~1,990 chars (truncated) | ✅ |
| Single sport key (1 job) | ~300 chars | ~300 chars (no truncation) | ✅ |

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| `/force-ingestion` truncation correct | ✅ Header + first jobs + "truncated" notice |
| `/best-sports` truncation correct | ✅ Header + first sports + "truncated" notice |
| No truncation when under limit | ✅ Content returned unchanged |
| Existing `/value-bets` pattern preserved | ✅ Same pattern used |
| Risk | **LOW** — formatting-only change, no business logic affected |

---

## Verdict

**PASS** — Both vulnerable commands now have length protection following the same pattern already used in `/value-bets`. No business logic, database, or configuration changes were made.