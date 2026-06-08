# Local Redis Migration Audit

**Date:** 2026-06-08  
**Scope:** Determine whether the project can safely migrate from hosted (Upstash) Redis to local Redis  

---

## 1. Complete Redis Usage Trace

### 1.1 BullMQ Queues (3)

| Queue | File | Redis Interaction | Data Stored |
|---|---|---|---|
| `match-fetch` | `src/lib/queue/queue-factory.ts` | Queue constructor receives Redis connection | Job state (waiting/active/completed/failed), repeatable job definitions |
| `odds-fetch` | `src/lib/queue/queue-factory.ts` | Queue constructor receives Redis connection | Job state |
| `ai-analysis` | `src/lib/queue/queue-factory.ts` | Queue constructor receives Redis connection | Job state (currently unused) |

### 1.2 BullMQ Workers (3)

| Worker | File | Redis Interaction | Data Stored |
|---|---|---|---|
| `match-fetch` | `src/lib/queue/worker-factory.ts` | Worker constructor receives Redis connection | Worker state, job locks, stalled job detection |
| `odds-fetch` | `src/lib/queue/worker-factory.ts` | Worker constructor receives Redis connection | Worker state |
| `ai-analysis` | `src/lib/queue/worker-factory.ts` | Worker constructor receives Redis connection | Worker state |

### 1.3 Redis Cooldown Keys

| Key Pattern | File | Purpose | TTL |
|---|---|---|---|
| `{env}:esports-odds-cooldown:{videogame}` | `src/ingestion/workers/match-ingestion.worker.ts` (lines 147-178) | Prevents frequent OddsPapi calls — 4-hour cooldown between enqueues | 14400 seconds (4h) |

### 1.4 Quota Tracking

| Key Pattern | File | Purpose | TTL |
|---|---|---|---|
| `oddspapi:quota:YYYY-MM` | `src/integrations/oddspapi/quota.tracker.ts` | Atomic Lua INCR counter for monthly OddsPapi API calls | 31 × 86400 seconds (31 days, set on first write per month) |

### 1.5 Health Checks

| File | Redis Interaction |
|---|---|
| `src/lib/health/health-aggregator.ts` | `PING` command to verify connectivity |
| `src/lib/health/health-server.ts` | Passes Redis instance to health aggregator |

### 1.6 Redis Client Configuration

**File:** `src/lib/redis/redis-factory.ts`

```typescript
const redis = new Redis(config.url, {
  lazyConnect: true,
  connectTimeout: 10_000,
  maxRetriesPerRequest: null,  // Required by BullMQ workers
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(200 * Math.pow(2, times - 1), 30_000);
  },
});
```

**Config source:** `src/config/redis.config.ts` — reads `REDIS_URL` from environment.

---

## 2. Critical Business Data Assessment

| Redis Key | Critical Business Data? | Recoverable from PostgreSQL? |
|---|---|---|
| BullMQ job state (waiting, active, completed, failed) | ✅ YES for in-flight jobs | ❌ NO — ephemeral. Pending jobs lost on restart. Scheduled repeatable jobs re-register on app restart. |
| BullMQ repeatable job definitions | ⚠️ YES — if wiped, must re-register | ✅ YES — re-registered on each startup by `scheduleIngestionJobs()` |
| BullMQ job locks & stalled detection | ❌ NO — temporary | N/A — workers re-acquire on restart |
| `{env}:esports-odds-cooldown:{game}` | ❌ NO — rate limiting only | N/A — resets on restart. Worst case: one extra OddsPapi call per game. |
| `oddspapi:quota:YYYY-MM` | ⚠️ Low — quota count | ❌ NO — if reset, counter starts from 0. At 720 calls/month max, the 10,000 hard limit won't be hit. |

**Conclusion: NO critical business data is stored exclusively in Redis.** All business data (matches, odds, value opportunities, users, predictions) is stored in PostgreSQL.

---

## 3. Persistence Requirements

### What happens if Redis is restarted:

| Scenario | Impact |
|---|---|
| Running jobs are lost | BullMQ's stalled interval (15s) detects and re-queues them. Long-running jobs may need manual re-trigger via `/force-ingestion`. |
| Scheduled repeatable jobs are lost | Re-registered on next app restart by `scheduleIngestionJobs()`. |
| Cooldown keys expire | Resets cooldown protection. Worst case: one extra OddsPapi call per game. |
| Quota counter resets to 0 | Takes months to exhaust at current usage. Counter rebuilds naturally. |
| PostgreSQL data | **No data loss** — all business records safe. |

**Lost on restart:** In-flight jobs (retried), cooldowns (reset), quota position (rebuilds).

---

## 4. Current Configuration

### Environment Variable

```
REDIS_URL=redis://localhost:6379
```

### Default in `.env.example`

```
REDIS_URL=redis://localhost:6379
```

Already points to `localhost:6379`. **No configuration change needed.**

---

## 5. Migration Complexity Classification

### **LOW** — Zero code changes required

1. `REDIS_URL` already defaults to `redis://localhost:6379`
2. No Redis-specific hosted features used (no Streams, no Gears, no JSON)
3. BullMQ works identically with local Redis
4. No Upstash-specific auth or TLS hardcoded

---

## 6. Local Redis Requirements

### Docker Command

```powershell
docker run -d --name betting-redis -p 6379:6379 redis:7-alpine
```

### Docker Compose

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    restart: unless-stopped
    volumes:
      - redis_data:/data
    command: redis-server --save 60 1 --loglevel warning

volumes:
  redis_data:
```

### Required Environment Variables

| Variable | Value |
|---|---|
| `REDIS_URL` | `redis://localhost:6379` |

No other Redis variables exist.

### Startup Procedure

1. Start Redis: `docker compose up -d redis`
2. Start app: `npm run dev`

---

## 7. Blockers

| Blocker | Severity |
|---|---|
| Docker must be installed | Low |
| Port 6379 must be free | Low |
| No TLS/encryption (local only) | Low |

---

## 8. Migration Plan

### Phase 1: Verify Docker (5 min)

```powershell
docker --version
netstat -an | findstr ":6379"
docker run -d --name betting-redis -p 6379:6379 redis:7-alpine
docker exec betting-redis redis-cli PING
```

### Phase 2: Configure (1 min)

Verify `REDIS_URL=redis://localhost:6379` in `.env`.

### Phase 3: Start (1 min)

```powershell
npm run dev
```

### Phase 4: Verify (5 min)

```powershell
curl http://localhost:3000/health
# Expected: {"status":"healthy","redis":"connected"}
```

### Phase 5: Rollback (if needed)

```powershell
docker stop betting-redis && docker rm betting-redis
# Change REDIS_URL back to hosted URL in .env
npm run dev
```

---

## 9. Verdict

| Question | Answer |
|---|---|
| Can the project use local Redis? | ✅ **YES — no code changes required** |
| Migration complexity | **LOW** |
| Critical business data in Redis? | ❌ **NO** — all in PostgreSQL |
| Lost on restart? | In-flight jobs (retried), cooldowns (reset) |
| Blockers? | None |

The migration is a **configuration-only change**. `REDIS_URL` already defaults to `redis://localhost:6379`. All BullMQ queues, workers, cooldown keys, and quota tracking work identically with local Redis.