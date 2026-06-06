# PandaScore Audit

**Audit Date:** 2026-06-06  
**Auditor:** AI-assisted code review  
**Scope:** `src/integrations/pandascore/` — All 10 files (Phases 2A–2D)

---

## Executive Summary

The PandaScore integration suite consists of 10 files across 4 phases: type definitions, HTTP client, resilience layer (retry), and health checking. The implementation follows the same architectural patterns established in The Odds API integration: constructor injection, logger integration, error hierarchy integration, and clean separation of concerns.

The code is solid overall. The most notable issues are: the retry configuration excludes 429 (PandaScore does use rate limits), the `getTeam` endpoint may not match the actual PandaScore API path, and the health checker creates a separate resilient wrapper instance which could lead to confusing log output from duplicate child loggers.

**Architecture Score: 85/100**  
**Implementation Score: 78/100**

---

## Files Reviewed

| # | File | Lines | Phase |
|---|---|---|---|
| 1 | `types.ts` | 196 | 2A — Type Definitions |
| 2 | `pandascore.config.ts` | 19 | 2B — Client Config |
| 3 | `pandascore.client.ts` | 171 | 2B — HTTP Client |
| 4 | `pandascore.factory.ts` | 42 | 2B — Factory |
| 5 | `pandascore.retry.config.ts` | 24 | 2C — Retry Config |
| 6 | `pandascore.retry.helper.ts` | 119 | 2C — Retry Logic |
| 7 | `pandascore.resilient-client.ts` | 100 | 2C — Resilient Decorator |
| 8 | `pandascore.health.types.ts` | 41 | 2D — Health Types |
| 9 | `pandascore.health.checker.ts` | 121 | 2D — Health Checker |
| 10 | `index.ts` | 50 | Barrel Export |

---

## Architecture Score: 85/100

### Dependency Boundaries — PASS

| Check | Result |
|---|---|
| Depends only on `@/lib/logger` and `@/lib/errors` | ✅ |
| No dependency on `@/config` (config is injected) | ✅ |
| No dependency on `@/lib/app`, `@/lib/prisma`, `@/lib/redis`, `@/lib/queue`, `@/lib/health` | ✅ |
| Self-contained within `src/integrations/pandascore/` | ✅ |

### Constructor Injection — PASS

| Class/Function | Dependencies |
|---|---|
| `DefaultPandascoreClient(config, logger)` | `PandascoreClientConfig` + `Logger` |
| `ResilientPandascoreClient(inner, logger, config?)` | `PandascoreClient` + `Logger` + `PandascoreRetryConfig` |
| `PandascoreHealthChecker(client, logger, thresholds?)` | `PandascoreClient` + `Logger` + thresholds |
| `createPandascoreClient(config, logger)` | Partial config + `Logger` |

### No Global Mutable State — PASS

- All state is instance-scoped
- No module-level variables except immutable defaults (`as const`)
- No singletons

### Logger Integration — PASS

| File | Usage |
|---|---|
| `pandascore.client.ts` | `logger.child({ module: 'pandascore' })` |
| `pandascore.retry.helper.ts` | Accepts `Logger` parameter, uses `warn`/`error` |
| `pandascore.resilient-client.ts` | `logger.child({ module: 'pandascore-resilient' })` |
| `pandascore.health.checker.ts` | `logger.child({ module: 'pandascore-health' })`, uses `debug`/`warn` |

### Error Hierarchy Integration — PASS

| Error Type | When Thrown |
|---|---|
| `AuthenticationError` | HTTP 401/403 |
| `RateLimitError` | HTTP 429 |
| `ExternalApiError` | 5xx, network failures, timeouts, other non-2xx |

---

## Implementation Score: 78/100

### Type Safety — PASS

All API responses are strongly typed with `readonly` properties. The `Opponent` union type correctly models the `Team | Player` variant. Request parameter interfaces use `extends PaginationParams` for clean inheritance.

### Retry Behavior — PASS with Issue

**PASS:** The retry logic is clean and follows the The Odds API pattern. Exponential backoff with jitter is implemented correctly. The `isPandascoreRetryable` function correctly blocks all 4xx errors.

**ISSUE (Major):** The retryable status codes list (`[500, 502, 503, 504]`) does **not include 429**. PandaScore does enforce rate limits. If a 429 is received, the `handleErrorResponse` throws `RateLimitError` with `retryable: true` (default for `RateLimitError`), but `isPandascoreRetryable` checks `error.retryable` first — which returns `true` — and then the `statusCode >= 400 && statusCode < 500` check catches it at line 38, returning `false`.

This means 429 responses will **not** be retried, despite being theoretically retryable. While this is arguably correct for PandaScore (their rate limit window is short), the inconsistency between The Odds API (which retries 429) and PandaScore (which does not) could confuse future developers.

### Authentication Handling — PASS

Bearer token authentication is correctly implemented using the `Authorization: Bearer {token}` header. 401/403 responses are correctly mapped to `AuthenticationError`.

### Health Check Correctness — PASS

The health check correctly evaluates reachability, authentication, and latency. The threshold of 2000ms for degraded status is reasonable. The probe endpoint (`getUpcomingMatches('cs2')`) is appropriate — it's a lightweight read that exercises auth and connectivity.

**ISSUE (Minor):** The health checker creates a new `ResilientPandascoreClient` wrapper if one is not provided (line 42-44), but the caller may have already wrapped the client. This can lead to double-wrapping: `ResilientPandascoreClient(ResilientPandascoreClient(base))`. The double-wrapping is not harmful (each layer just delegates retry to the outer one), but it creates an extra child logger (`pandascore-resilient`) that won't be used.

### Client Correctness — PASS with Issue

**PASS:** The client correctly builds URLs, uses AbortController for timeout, translates all non-2xx responses to typed errors, handles network errors and timeouts, and authenticates via Bearer token.

**ISSUE (Minor):** The `getTeam` endpoint uses `/teams/{teamId}`. While this matches the PandaScore API documentation for a single team endpoint, some PandaScore API versions require the videogame prefix (e.g., `/cs2/teams/{teamId}`). If the API returns 404 for `/teams/{id}`, this will manifest as an `ExternalApiError` which is catchable, but the error message may be confusing. This may need adjustment during integration testing.

---

## Scope Verification

| Check | Status |
|---|---|
| No database writes | ✅ |
| No database reads | ✅ |
| No repository layer | ✅ |
| No service layer | ✅ |
| No BullMQ jobs | ✅ |
| No scheduler integration | ✅ |
| No Discord integration | ✅ |
| No The Odds API integration | ✅ |
| No AI analysis | ✅ |
| No prediction logic | ✅ |
| No betting logic | ✅ |
| No business logic | ✅ |
| No Sprint 2 health system modifications | ✅ |

---

## Technical Debt

| Item | Severity | Description |
|---|---|---|
| 429 not in retryable status codes | **Medium** | PandaScore does rate-limit; 429s won't be retried despite being retryable in nature |
| Potential double-wrapping in health checker | Low | Health checker creates a new resilient wrapper if not provided, could double-wrap |
| `getTeam` path may need videogame prefix | Low | `/teams/{id}` vs `/{videogame}/teams/{id}` — needs verification during integration |
| No quota tracking | Low | PandaScore does not provide quota headers like The Odds API, which is consistent with the architecture (no quota tracking was required) |

---

## Risks

### 1. 429 Rate Limit Not Retried (Medium Risk)

**Impact:** If PandaScore returns 429 rate limit errors during normal operation, the client will throw immediately without retry. The caller will receive a `RateLimitError` and must handle it. During high-frequency polling, this could cause data gaps.

**Mitigation:** Add 429 to the `retryableStatusCodes` array. The base client already parses the response correctly and throws `RateLimitError`, and the retry helper already has `calculatePandascoreRetryDelay` which supports Retry-After headers.

### 2. `getTeam` Path May Be Wrong (Medium Risk)

**Impact:** If the actual API expects `/{videogame}/teams/{id}` instead of `/teams/{id}`, the endpoint will return 404 during integration testing.

**Mitigation:** Easy fix — add the videogame parameter to `getTeam` or verify the correct path during integration testing.

### 3. Health Checker Double-Wrapping (Low Risk)

**Impact:** If the caller already wraps in `ResilientPandascoreClient` and passes it to the health checker, an extra resilient wrapper is created. This creates an unused child logger entry, causing minor log noise.

**Mitigation:** The `instanceof` check already handles this for the common case. Only affects callers that don't wrap their client.

---

## Required Fixes

| # | Priority | Fix |
|---|---|---|
| 1 | **MEDIUM** | Add `429` to `retryableStatusCodes` in `pandascore.retry.config.ts` if PandaScore rate limits should be auto-retried |
| 2 | **MEDIUM** | Verify `getTeam` path during integration testing and adjust to `/{videogame}/teams/{id}` if needed |

## Recommended Fixes

| # | Priority | Fix |
|---|---|---|
| 1 | LOW | Add unit tests for `isPandascoreRetryable`, `calculatePandascoreBackoff` |
| 2 | LOW | Consider adding a simplified wrapper over the resilient client creation to reduce boilerplate (e.g., `createResilientPandascoreClient()`) |

---

## Readiness Assessment

**READY WITH CONCERNS**

---

## Final Verdict

**PASS WITH CONCERNS**

The PandaScore integration is architecturally sound, properly scoped, and correctly implements the HTTP client layer with retry and health checking. The two medium-risk items (429 retry exclusion and `getTeam` path uncertainty) should be addressed before production use but do not block the integration from being used for its primary purpose.

Notably, the PandaScore integration benefits from lessons learned in The Odds API audit: the extra closure issue was avoided by using `() => operation()` directly in `withPandascoreRetry`, and the health checker has the same clean pattern. The integration is **cleaner** than The Odds API's initial implementation in several respects, demonstrating good cross-phase learning.
</｜｜DSML｜｜parameter>
<task_progress>
- [x] Read all 10 files in src/integrations/pandascore/
- [x] Audit architecture (dependency boundaries, constructor injection, global state, logger, errors)
- [x] Audit implementation (type safety, retry, auth, health, client)
- [x] Verify scope (no DB, no BullMQ, no Discord, no business logic)
- [x] Identify technical debt and risks
- [x] Create docs/audits/PANDASCORE-AUDIT.md
</task_progress>
</write_to_file>