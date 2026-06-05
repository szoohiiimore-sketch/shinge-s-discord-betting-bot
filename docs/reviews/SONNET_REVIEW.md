# Sonnet Repository Review

> **Reviewer:** Claude Sonnet 4.6  
> **Date:** 2026-06-05  
> **Branch:** main (no git history)  
> **Scope:** Sprint 1 + Sprint 2 Phases 1–8

---

## File Tree

```
c:/Betting/
├── .env.example
├── .eslintrc.cjs
├── .gitignore
├── .prettierrc
├── ARCHITECTURE-V1.md
├── FINAL-V1-DATA-MODEL.md
├── README.md
├── SPRINT1-FOUNDATION.md
├── SPRINT2-CORE-INFRASTRUCTURE.md
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── prisma/
│   └── schema.prisma
├── src/
│   ├── main.ts                            ← PLACEHOLDER ONLY
│   ├── config/
│   │   ├── api.config.ts
│   │   ├── app.config.ts
│   │   ├── betting.config.ts
│   │   ├── config.loader.ts
│   │   ├── config.types.ts
│   │   ├── database.config.ts
│   │   ├── discord.config.ts
│   │   ├── index.ts
│   │   └── redis.config.ts
│   └── lib/
│       ├── app/
│       │   ├── app-state.ts
│       │   ├── app.ts
│       │   └── index.ts
│       ├── errors/
│       │   ├── app-error.ts
│       │   ├── business-rule-error.ts
│       │   ├── config-error.ts
│       │   ├── database-error.ts
│       │   ├── external-api-error.ts
│       │   ├── index.ts
│       │   ├── not-found-error.ts
│       │   ├── queue-error.ts
│       │   ├── redis-error.ts
│       │   └── validation-error.ts
│       ├── health/
│       │   ├── health-aggregator.ts
│       │   ├── health-lifecycle.ts
│       │   ├── health-server.ts
│       │   ├── health-types.ts
│       │   └── index.ts
│       ├── logger/
│       │   ├── index.ts
│       │   ├── logger.ts
│       │   └── logger.types.ts
│       ├── prisma/
│       │   ├── index.ts
│       │   ├── prisma-error-translator.ts
│       │   ├── prisma-factory.ts
│       │   ├── prisma-health.ts
│       │   └── prisma-lifecycle.ts
│       ├── queue/
│       │   ├── index.ts
│       │   ├── queue-factory.ts
│       │   ├── queue-health.ts
│       │   ├── queue-lifecycle.ts
│       │   ├── queue-types.ts
│       │   └── worker-factory.ts
│       └── redis/
│           ├── index.ts
│           ├── redis-error-translator.ts
│           ├── redis-factory.ts
│           ├── redis-health.ts
│           └── redis-lifecycle.ts
└── docs/
    ├── archive/
    │   └── (5 design documents)
    ├── audits/
    │   └── (3 audit documents)
    └── reviews/
        └── SONNET_REVIEW.md  ← this file
```

---

## Executive Summary

The repository implements Sprint 2 infrastructure (Phases 1–8) for a Discord-based betting intelligence platform targeting a single server with ≤5 users. The foundation is well-structured: configuration is validated with Zod, errors form a clean hierarchy, logging uses pino with secret redaction, and each infrastructure concern (Prisma, Redis, BullMQ, health) is isolated into its own module with factory/lifecycle/health file separation.

The critical structural problem is that **`src/main.ts` is a two-line placeholder and `Application.ts` startup/shutdown skeletons are not wired to the actual infrastructure modules built in Phases 5–8.** The infrastructure code (prisma-factory, redis-factory, queue-factory, health-server) is complete and correct, but the `Application` class that was meant to orchestrate them was never updated after its skeleton was written in Phase 4. The application cannot start.

Outside that orchestration gap, code quality is high for its complexity tier. Type safety is strict, the error hierarchy is well-designed, lifecycle patterns are consistent, and the Prisma schema is clean and scope-compliant.

---

## Architecture Score: 74 / 100

Strong module separation and pattern consistency. Score held back by the disconnection between the `Application` orchestrator and the infrastructure modules, over-engineering of `Dependencies` typed as `unknown`, and the absence of any signal handling or bootstrap entrypoint.

## Code Quality Score: 82 / 100

Strict TypeScript, immutable errors, pino with secret redaction, Zod validation on all config. Deductions for the `cleanup()` / `shutdown()` duplication, the `type as unknown as ConnectionOptions` cast pattern in queue/worker factories, `DIRECT_DATABASE_URL` loaded but not used by Prisma, and parseInt without NaN validation in betting config.

## Infrastructure Score: 86 / 100

Prisma, Redis, BullMQ, and health check modules are individually complete and correct. Retry strategy, graceful shutdown, health aggregation, and error translation are all properly implemented. Deductions for the orphaned `verifyRedisConnection` function (defined but not called in lifecycle), health server not having a request timeout guard, and BullMQ workers using a placeholder processor that throws on every job.

---

## Findings

### Critical Issues

**C1 — Application entrypoint is a stub; infrastructure modules are never wired**

`src/main.ts` contains only `console.log('Betting Intelligence Platform — placeholder')`. The `Application` class in `app.ts` has skeleton methods (`initPrisma`, `initRedis`, `createQueues`, `createWorkers`, `startHealthServer`) that return stub values (`{ initialized: true }`, `{}`, `{ started: true }`). None of the real infrastructure modules (`prisma-factory`, `redis-factory`, `queue-factory`, `health-lifecycle`) are imported or called from `Application`. Running `npm run start` or `npm run dev` produces a single console.log line and exits. Nothing connects.

**C2 — Startup failure leaves `_state = FAILED` but cleanup swallows all errors silently**

In `app.ts` line 137, on startup failure the state is manually assigned to `FAILED` (bypassing `transitionTo`), then `cleanup()` is called. `cleanup()` collects all errors into an array and logs them but does **not** re-throw. If cleanup itself fails, the startup error chain is silently dropped. The original startup exception is re-thrown (line 141), but cleanup errors are discarded. This can mask partial teardown failures during a failed startup.

---

### Major Issues

**M1 — `cleanup()` and `shutdown()` are identical methods; dead code duplication**

`app.ts` lines 223–277 (`cleanup`) and 283–337 (`shutdown`) are byte-for-byte identical in structure. Both iterate `healthServer → workers → queues → redis → prisma` in reverse order, collect errors, and log them. The only difference is their call site. This is a straightforward DRY violation that will diverge over time as real shutdown logic is added to one but not the other.

**M2 — `Dependencies` typed as `unknown`; type safety lost at orchestration layer**

`app.ts` lines 17–27 type all dependency fields as `unknown | undefined | null`. This means any consumer of `app.deps.prisma` must cast it before use, defeating TypeScript's guarantees at the only point where all dependencies come together.

**M3 — `verifyRedisConnection` is dead code**

`redis-lifecycle.ts` exports `verifyRedisConnection` (lines 48–75), a function that PINGs Redis after connecting to confirm readiness. It is never called anywhere in the codebase. The connectRedis call in the Application skeleton does not invoke it. The Redis connection is established but never verified.

**M4 — `DIRECT_DATABASE_URL` is validated and loaded but never used**

`database.config.ts` requires `DIRECT_DATABASE_URL` as a mandatory env var. The Prisma schema (`schema.prisma` line 7) uses only `DATABASE_URL`. The `createPrismaClient` factory (`prisma-factory.ts` line 24) passes `config.url` (which is `DATABASE_URL`). `config.directUrl` is loaded, stored in Config, but passed nowhere. This means the env var requirement will cause startup failures in environments where only a single connection URL is available, without providing any benefit.

**M5 — BullMQ workers use a `placeholderProcessor` that always throws**

`worker-factory.ts` lines 16–22 define a processor that throws on every job with `No processor registered for queue`. Workers are created with this processor and, once started in Phase 9, will immediately fail every enqueued job. The `removeOnFail.age` of 86,400s means 24 hours of failed jobs will accumulate before removal.

**M6 — `parseInt` without NaN validation in betting config**

`betting.config.ts` lines 20–22 call `parseInt(..., 10)` on the three betting env vars after Zod validates that the strings are non-empty (`z.string().min(1)`). If the values are non-numeric strings (e.g. `"abc"`), parseInt returns `NaN` silently and Zod's `transform` does not catch it. The config object will carry `NaN` values for `defaultBankroll`, `maxConcurrentBets`, and `analysisBudgetDaily`.

---

### Minor Issues

**m1 — Reconnect event logged twice for Redis**

`redis-factory.ts` registers both `retryStrategy` (line 36–41, logs `warn`) and `reconnecting` event listener (line 63–65, logs `warn`). Both fire on reconnect. Each reconnect attempt will emit two warning log lines.

**m2 — Health server has no per-request timeout**

`health-server.ts` `handleHealthRequest` calls `aggregateHealth` with three concurrent async health checks. If any check hangs indefinitely (e.g. a stalled Prisma query), the health endpoint will also hang indefinitely. There is no `AbortController` or timeout wrapper on the health check calls.

**m3 — `stopHealthServer` has a race condition on double-resolve**

`health-lifecycle.ts` lines 82–94: the Promise wrapping `server.close()` can resolve twice if `server.close()` completes before the 5-second `setTimeout` fires. `resolve()` is called in the `close` callback AND after the timeout. While calling a resolved Promise's resolve a second time is a no-op in JS, the `setTimeout` is not cleared on success, so it fires unnecessarily for every clean shutdown.

**m4 — `PORT` parsed with `parseInt` but stored as `number` in AppConfig without range validation**

`app.config.ts` line 16 defaults `PORT` to `'3000'` and parses with `parseInt`. No validation ensures the port is in range 1–65535. A value like `"99999"` or `"0"` would be accepted silently.

**m5 — Logger type is a direct alias of pino Logger**

`logger.types.ts` line 10: `export type Logger = PinoLogger`. While pragmatic for V1, this leaks pino's full API surface as the application contract. If pino is ever replaced (e.g. for testing), every file importing `Logger` is a change point.

**m6 — No test files exist**

`package.json` includes `vitest` as a dev dependency and defines `test`/`test:watch`/`test:coverage` scripts. Zero test files exist under `src/` or any other directory. No coverage baseline exists for the infrastructure code that has been built.

**m7 — `REDACTED_PATHS` in logger uses wildcard patterns that pino does not support**

`logger.ts` lines 17–21 include patterns like `'*.DISCORD_TOKEN'`. Pino's `redact` option supports nested dot-notation paths (e.g. `'config.DISCORD_TOKEN'`) but not glob wildcards (`*`). The wildcard entries will silently have no effect. The top-level paths (`'DISCORD_TOKEN'`) will work, but nested occurrences under arbitrary keys will not be redacted.

---

### Positive Findings

**P1 — Error hierarchy is clean and well-structured**

`AppError` provides an immutable base with code, statusCode, retryable, cause, and context. Subclasses (`DatabaseError`, `RedisError`, `QueueError`, `ExternalApiError`, `ValidationError`, `NotFoundError`, `BusinessRuleError`) are lean, correctly set defaults, and map cleanly to HTTP semantics. `Object.freeze` on construction and `Object.setPrototypeOf` for instanceof safety are both present. This is production-quality error design.

**P2 — Configuration validation with Zod is comprehensive**

All six config sections use `safeParse`, collect all issues, and throw a single descriptive error. The `deepFreeze` in `config.loader.ts` ensures the loaded config is immutable throughout the process lifetime. Config is passed as a constructor argument, never read from `process.env` directly in infrastructure modules.

**P3 — Prisma error translator covers all critical error codes**

`prisma-error-translator.ts` maps P1000, P1001, P1002, P1003, P2002, P2003, P2024, P2025 to typed application errors with correct `retryable` flags. Unknown codes fall through to a generic `DatabaseError` rather than leaking Prisma internals.

**P4 — ApplicationState machine is correct and enforced**

`app-state.ts` defines all valid transitions explicitly. `assertValidTransition` throws on invalid transitions. The state machine covers all terminal states (`STOPPED`, `FAILED`). `FAILED` is correctly terminal with no outgoing edges.

**P5 — Redis retry strategy is well-designed**

Exponential backoff (200ms → 30s cap), max 10 retries, `lazyConnect: true` to control connection timing, and `maxRetriesPerRequest: 3` for individual command failures. This is appropriate for a V1 single-server deployment.

**P6 — BullMQ worker lifecycle handles graceful shutdown correctly**

`queue-lifecycle.ts` pauses workers before closing them, then closes queues last. `closeWorkers` collects errors without throwing to ensure all workers attempt shutdown. This ordering (pause → close workers → close queues) is the correct BullMQ shutdown sequence.

**P7 — Prisma schema is clean and scope-correct**

All models use UUID PKs, snake_case column mapping, appropriate `onDelete` semantics (Cascade for user preferences, Restrict for financial/match data), and composite unique constraints. No over-indexing.

**P8 — Health aggregator runs checks concurrently**

`health-aggregator.ts` uses `Promise.all` for the three health checks. Degraded status (queues failing) is correctly distinguished from unhealthy (database or Redis failing).

**P9 — TypeScript configuration is strict and correct**

`strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch` all enabled. Path aliases configured. Separate `tsconfig.build.json` correctly excludes tests and scripts from the production build.

**P10 — pino secret redaction is correctly positioned**

`DISCORD_TOKEN`, `THE_ODDS_API_KEY`, `PANDASCORE_API_KEY`, `DEEPSEEK_API_KEY` are listed in `REDACTED_PATHS`. The top-level path entries will correctly redact these keys if they appear at the root of a logged object.

---

## Removed Scope Verification

The following items from the out-of-scope list were checked and are **correctly absent** from the implementation:

| Item | Status |
|------|--------|
| LearningInsight | Not present in schema or source |
| Historical Learning Service | Not present |
| Analytics Service / Module | Not present |
| Alert Entity | Not present in schema |
| Alert persistence | Not present |
| Discord DM notifications | Not present |
| Kelly Criterion | Not present |
| UserBet | Not present in schema |
| BetTransaction | Not present in schema |
| Real wager tracking | Not present |
| Real bookmaker account tracking | Not present |
| Deposit tracking | Not present |
| Withdrawal tracking | Not present |
| Multi-server Discord support | `DiscordConfig.guildId` is a single value |
| SaaS functionality | Not present |
| Subscription systems | Not present |
| Payment systems | Not present |
| Email notifications | Not present |
| SMS notifications | Not present |

All removed scope items are confirmed absent. **Scope verification: PASS.**

---

## Technical Debt

| Debt Item | Location | Impact |
|-----------|----------|--------|
| `cleanup()` / `shutdown()` duplication | `app.ts:223–337` | Will diverge when real shutdown logic is added |
| `Dependencies` typed as `unknown` | `app.ts:17–27` | Forces unsafe casts at every consumer |
| `verifyRedisConnection` dead code | `redis-lifecycle.ts:48–75` | Redis connection unverified at startup |
| `DIRECT_DATABASE_URL` unused | `database.config.ts`, `prisma-factory.ts` | Mandatory env var provides no benefit |
| Placeholder processor throws always | `worker-factory.ts:16–22` | All jobs will fail once workers start |
| No test suite | entire codebase | Infrastructure code has zero coverage |
| Pino wildcard redaction paths ineffective | `logger.ts:17–21` | Nested secrets may leak in logs |

---

## Future Risks

### Architectural Risks

- **Application.ts orchestration gap will compound.** Every new phase that adds real dependencies must fight the `unknown`-typed `Dependencies` container and the disconnect from infrastructure modules. If not fixed before Phase 9, each new integration will require type gymnastics.
- **Single `Application` class becomes a god object.** As Phases 9+ add Discord bot, match service, odds service, and AI analysis, the `start()` method risks becoming a 200-line sequential startup sequence that is difficult to test or modify.

### Scaling Risks

- **BullMQ concurrency is hardcoded to 1.** `DEFAULT_WORKER_OPTIONS.concurrency = 1` is defined as a `const`. For V1 (single user, no real load), this is acceptable. For any growth, this becomes a bottleneck with no configuration path.
- **Health check runs live DB/Redis queries on every request.** At high poll frequency (e.g. Kubernetes liveness probes every 5s), the `SELECT 1` and `PING` will add measurable load. Acceptable for V1.

### Maintainability Risks

- **`QueueName` enum and `QueueCollection`/`WorkerCollection` interfaces must be kept in sync manually.** Adding a new queue requires updates to the enum, both interfaces, and `DEFAULT_WORKER_OPTIONS` documentation. No structural enforcement.
- **`Logger` type alias to pino.** Once business logic imports `Logger` from `@/lib/logger`, switching logging libraries requires touching every file that uses pino-specific methods (`child`, `bindings`, etc.).

### Dependency Risks

- **pino-pretty in devDependencies, but `createLogger` references it by name in production code.** If `config.pretty` is `true` in a production build, `pino-pretty` must be present. It is in `devDependencies` only. This will silently fail with a module-not-found error at runtime if `NODE_ENV != production` logic doesn't reliably gate it.
- **discord.js installed but zero usage in source.** `discord.js@^14.16.0` is in `dependencies`. No Discord code exists. This is Sprint 3+ scope but adds ~40MB to the production bundle unnecessarily until then.

### Hidden Complexity

- **Prisma `$on` event API is deprecated in Prisma 5.x.** `prisma-factory.ts` uses `prisma.$on('error', ...)`, `$on('warn', ...)`, and `$on('info', ...)`. Prisma 5.x deprecated the event-based logging API in favour of structured log objects. The `@ts-ignore` / `ignoreDeprecations: "5.0"` in tsconfig suppresses TypeScript warnings about this. This will break in Prisma 6.

---

## Recommended Fixes

### Must Fix

1. **Implement `main.ts` bootstrap** — wire `loadConfig`, `createLogger`, and `new Application(config, logger).start()` with SIGTERM/SIGINT handlers. This is the most critical gap.

2. **Wire `Application` skeleton methods to real infrastructure modules** — replace the stub returns in `initPrisma`, `connectDatabase`, `initRedis`, `connectRedis`, `createQueues`, `createWorkers`, and `startHealthServer` with calls to the actual factory/lifecycle functions that were built in Phases 5–8.

3. **Extract shared shutdown sequence** — merge `cleanup()` and `shutdown()` into a single private `teardown()` method to eliminate the duplication.

4. **Fix `Dependencies` types** — replace `unknown` with proper typed references (`PrismaClient | undefined | null`, `Redis | undefined | null`, `QueueCollection | undefined | null`, etc.).

5. **Fix `parseInt` without NaN guard in betting config** — add `.refine(val => !isNaN(parseInt(val, 10)), { message: '...' })` or use `z.coerce.number()` in the schema.

### Should Fix

6. **Call `verifyRedisConnection` after `connectRedis`** in the startup sequence — the function exists and is correct; it is simply never invoked.

7. **Remove `DIRECT_DATABASE_URL` requirement or use it** — either add it to the Prisma datasource (`directUrl = env("DIRECT_DATABASE_URL")`) as intended for PgBouncer bypass, or remove the requirement from `database.config.ts`.

8. **Remove duplicate `reconnecting` log** — remove either the `retryStrategy` warn log or the `reconnecting` event listener, not both.

9. **Fix pino redact wildcard patterns** — replace `'*.DISCORD_TOKEN'` etc. with concrete nested paths that actually exist, or remove them. Pino does not support glob wildcards in `redact.paths`.

10. **Add health check request timeout** — wrap `aggregateHealth` in a `Promise.race` with a timeout (e.g. 5s) to prevent health endpoint hangs.

11. **Move `pino-pretty` to dependencies or gate it strictly** — if `LOG_PRETTY=true` is ever used in non-dev environments, `pino-pretty` must be available at runtime.

### Nice To Have

12. **Add at least one infrastructure integration test** — a test that creates and closes a Prisma client, and one that creates and destroys a Redis client, would establish a baseline and catch lifecycle regressions.

13. **Fix `stopHealthServer` double-resolve** — clear the `setTimeout` when `server.close()` completes successfully.

14. **Validate port range in `app.config.ts`** — add `.refine(val => { const n = parseInt(val,10); return n >= 1 && n <= 65535; })`.

15. **Remove `discord.js` from `dependencies` until Sprint 3** — or move to `optionalDependencies` to avoid the bundle weight penalty.

---

## Sprint 2 Readiness Assessment

**READY WITH CONCERNS**

The infrastructure modules (Phases 1–8) are individually complete, correct, and well-implemented. The blocking concern is that `main.ts` and `Application.ts` are stubs that do not call any of them. Phase 9 can begin only after the orchestration gap is closed (Must Fix items 1–2). The remaining Must Fix items (3–5) should be addressed before any business logic is built on top.

---

## Final Verdict

**PASS WITH CONCERNS**

The foundation is solid: error hierarchy, configuration, logging, Prisma schema, Redis client, BullMQ workers, and health checks are all individually correct. The project is structurally sound and scope-compliant. The primary concern is not quality of the infrastructure code — it is that the orchestration layer (`main.ts` + `Application`) was never wired to the infrastructure. This is a sprint-completion gap, not a fundamental design flaw, and it is fixable with a focused session before Phase 9 begins.
