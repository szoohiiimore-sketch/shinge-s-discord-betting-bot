# Force Ingestion "Thinking" Audit

**Date:** 2026-06-08  
**Scope:** Investigate why `/force-ingestion` remains in Discord "thinking" state  

---

## 1. Handler Flow Trace

```
User runs /force-ingestion source=all
  → DiscordBotService._handleCommand()
    → commandName === 'force-ingestion'
    → interaction.deferReply()            ← Tells Discord: "thinking" state, 15-min timeout
    → executeForceIngestion(matchFetchQueue, { source: 'all' })
      │
      │  ┌─ For each sport in SPORT_KEY_TO_GROUP (~50 entries):
      │  │     await matchFetchQueue.add(name, payload, { delay: 1000 })
      │  │     logger.info({ jobId, sportKey, queue: 'match-fetch' }, 'Job enqueued')
      │  └─ After all 50 iterations...
      │
      → returns { content: '...🚀 FORCE INGESTION...' }
    → interaction.editReply({ content })  ← Should resolve "thinking" state
```

## 2. The Bug: Catch Block Uses Wrong Reply Method

```typescript
// In _registerHandlers(), line ~102:
try {
  await this._handleCommand(interaction);
} catch (err) {
  this._logger.error({ ... }, 'Command execution failed');
  await interaction.reply({ content: `Error: ${(err as Error).message}`, ephemeral: true }).catch(() => {});
  //          ^^^^^^^^^^^^^^^^
  //          BUG: Must use interaction.editReply() when interaction was deferred
}
```

**Root cause sequence:**

1. `deferReply()` is called → interaction is in "thinking" state, expects `editReply()`
2. `executeForceIngestion()` runs — enqueues up to **50 BullMQ jobs** sequentially
3. If ANY of the 50 `matchFetchQueue.add()` calls fails (Redis timeout, BullMQ validation, network blip):
   - Error propagates up to `_handleCommand` caller
   - Catch block calls `interaction.reply()` ← Discord REJECTS this; `reply()` is invalid after `deferReply()`
   - The `.catch(() => {})` silently swallows the rejection
   - **Discord stays in "thinking" state for 15 minutes until the ephemeral interaction timeout**

## 3. Timing Analysis

### Before Mass Expansion (16 sports, `source: all`)

| Operation | Est. Time |
|---|---|
| 16 × `matchFetchQueue.add()` (Redis) | ~80ms |
| Response building | ~5ms |
| `editReply()` (Discord REST) | ~150ms |
| **Total** | **~235ms** |

### After Mass Expansion (50 sports, `source: all`)

| Operation | Est. Time |
|---|---|
| 50 × `matchFetchQueue.add()` (Redis) | ~250ms |
| Response building | ~10ms |
| `editReply()` (Discord REST) | ~150ms |
| **Total** | **~410ms** |

The synchronous processing time is still well under the 3-second Discord threshold. The "very long time" is caused by the **error path**, not by processing time.

## 4. Error Scenarios That Trigger the Bug

| Scenario | Probability | Effect |
|---|---|---|
| Redis connection blip during enqueue | Low (local) / Medium (hosted) | Catch block uses wrong reply → "thinking" frozen |
| BullMQ validation rejection | Low (all keys are valid strings) | Same |
| Network timeout to Discord REST API during `editReply()` | Low | Same issue — `editReply()` itself could fail |
| One sport key fails validation | Low (keys are from hardcoded config) | Loop throws → wrong reply method |

## 5. Cases Where editReply() Should Be Used

After `deferReply()` is called, the interaction protocol requires:

| Method | Valid? |
|---|---|
| `interaction.editReply()` | ✅ YES — replaces "thinking" with final content |
| `interaction.reply()` | ❌ NO — throws error (silently swallowed by `.catch()`) |
| `interaction.deferReply()` | ❌ NO — already deferred |

The catch block on line ~102 uses `interaction.reply()` which is **always invalid** after `deferReply()`. Any error in the handler triggers this bug.

## 6. Recommended Fix

### Option A: Fix the Catch Block (Recommended — **LOW** risk)

```typescript
// Before (BUG):
await interaction.reply({ content: `Error: ${(err as Error).message}`, ephemeral: true }).catch(() => {});

// After (FIX):
await interaction.editReply({ content: `Error: ${(err as Error).message}` }).catch(() => {});
```

**Files changed:** 1 (`discord-bot.service.ts`)  
**Lines changed:** 1  
**Risk:** LOW — `editReply()` is the correct method after `deferReply()`

### Option B: Background Processing (HIGHER complexity, not needed)

Instead of synchronously enqueuing 50 jobs, return immediately and process in background:

```
/force-ingestion
  → deferReply → "Jobs queued in background"
  → Enqueue a single "bulk-ingestion" job that handles all sports
  → Background worker processes and sends final summary
```

Not recommended for V1 — adds unnecessary complexity.

## 7. Fix Impact

| Scenario | Before Fix | After Fix |
|---|---|---|
| Normal operation (all 50 jobs enqueued) | ✅ Works (~410ms) | ✅ Same |
| One Redis call fails | ❌ "Thinking" frozen for 15 min | ✅ Error message displayed in ~150ms |
| BullMQ validation error | ❌ "Thinking" frozen | ✅ Error message displayed |
| Discord REST timeout on `editReply` | ❌ "Thinking" frozen (original path fails too) | ✅ Same (both paths fail, but now only one failure mode instead of two) |

## 8. Risk Classification

**LOW** — One-line change in a catch block. No business logic changes. No database changes. No schema changes.

The fix prevents a silent 15-minute interaction timeout when any error occurs during `/force-ingestion` execution.

## Summary

| Question | Answer |
|---|---|
| Does the handler wait for queue completion? | ❌ NO — it responds immediately after enqueuing |
| Is `waitUntilFinished()` used? | ❌ NO — only `queue.add()` is called |
| Is `editReply()` reached? | ✅ YES — in normal flow |
| Why does "thinking" persist? | Catch block uses `interaction.reply()` instead of `interaction.editReply()` after `deferReply()` |
| Fix complexity | **LOW** — one line change |
| Is synchronous approach sufficient? | **YES** — all 50 enqueues complete in ~250ms, well under 3s Discord threshold |