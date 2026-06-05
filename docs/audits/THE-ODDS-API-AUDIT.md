# The Odds API Audit

**Audit Date:** 2026-06-06  
**Auditor:** AI-assisted code review  
**Scope:** `src/integrations/the-odds-api/` — All 11 files (Phases 1A–1D)

---

## Executive Summary

The Odds API integration suite consists of 11 files across 4 phases: type definitions, HTTP client, resilience layer (retry/quota), and health checking. The implementation is architecturally sound, follows constructor injection patterns, integrates properly with the existing logger and error hierarchy, and has zero TypeScript compilation errors. No business logic, database persistence, BullMQ integration, or Discord integration was introduced.

However, several issues were identified: the quota tracking is reactive (error-driven) rather than proactive (header-parsed), the `buildSearchParams` method passes query param names through unchanged rather than converting camelCase to snake_case as documented, and the resilient client's `withRetry` wraps the operation in an extra closure layer that breaks the `attempt` counter.

**Architecture Score: 82/100**  
**Implementation Score: 75/100**

---

## Files Reviewed

| # | File | Lines | Phase |
|---|---|---|---|
| 1 | `types.ts` | 170 | 1A — Type Definitions |
| 2 | `the-odds-api.config.ts` | 19 | 1B — Client Config |
| 3 | `the-odds-api.client.ts` | 198 | 1B — HTTP Client |
| 4 | `the-odds-api.factory.ts` | 42 | 1B — Factory |
| 5 | `retry.config.ts` | 24 | 1C — Retry Config |
| 6 | `retry.helper.ts` | 130 | 1C — Retry Logic |
| 7 | `quota.types.ts` | 56 | 1C — Quota Types |
| 8 | `resilient-client.ts` | 148 | 1C — Resilient Decorator |
| 9 | `health.types.ts` | 41 | 1D — Health Types |
| 10 | `health.checker.ts` | 148 | 1D — Health Checker |
| 11 | `index.ts` | 38 | Barrel Export |

---

## Architecture Score: 82/100

### Dependency Boundaries — PASS

| Check | Result |
|---|---|
| Depends only on `@/lib/logger` and `@/lib/errors` | ✅ |
| No dependency on `@/config` (config is injected) | ✅ |
| No dependency on `@/lib/app` | ✅ |
| No dependency on `@/lib/prisma` | ✅ |
| No dependency on `@/lib/redis` | ✅ |
| No dependency on `@/lib/queue` | ✅ |
| No dependency on `@/lib/health` | ✅ |
| Self-contained within `src/integrations/the-odds-api/` | ✅ |

### Constructor Injection — PASS

Every class and factory accepts dependencies as explicit parameters:

| Class/Function | Dependencies |
|---|---|
| `DefaultOddsApiClient(config, logger)` | `OddsApiClientConfig` + `Logger` |
| `ResilientOddsApiClient(inner, logger, config?)` | `OddsApiClient` + `Logger` + `RetryConfig` |
| `OddsApiHealthChecker(client, logger, thresholds?)` | `OddsApiClient` + `Logger` + thresholds |
| `createOddsApiClient(config, logger)` | Partial config + `Logger` |

No `new PrismaClient()`, `new Redis()`, or service locator calls exist.

### No Global Mutable State — PASS

- All state is instance-scoped (`private quota: QuotaState` in `ResilientOddsApiClient`)
- All functions are pure or operate on instance state only
- No module-level variables (except `as const` defaults which are immutable)
- No singletons

### Logger Integration — PASS

| File | Usage |
|---|---|
| `the-odds-api.client.ts` | `logger.child({ module: 'the-odds-api' })` |
| `resilient-client.ts` | `logger.child({ module: 'resilient-client' })` |
| `retry.helper.ts` | Accepts `Logger` parameter, uses `warn`/`error` |
| `health.checker.ts` | `logger.child({ module: 'odds-api-health' })`, uses `debug`/`warn` |

### Error Hierarchy Integration — PASS

| Error Type | When Thrown |
|---|---|
| `AuthenticationError` | HTTP 401/403 |
| `RateLimitError` | HTTP 429 |
| `ExternalApiError` | 5xx, network failures, timeouts, other non-2xx |

---

## Implementation Score: 75/100

### Type Safety — PASS with Minor Issues

**PASS:** All API responses are strongly typed with `readonly` properties. All request parameters have typed interfaces.

**ISSUE (Minor):** `ApiErrorResponse` is defined in `types.ts` (lines 129-133) but never used anywhere in the codebase. It was removed from the import in `the-odds-api.client.ts` after a compiler warning, but remains defined. This is dead code.

**ISSUE (Minor):** `RateLimitInfo` in `types.ts` (lines 140-145) is also unused. The resilient client has its own `QuotaState` and `RateLimitState` types, making this type redundant.

### Retry Behavior — PASS with Issues

**PASS:** The retry logic correctly distinguishes retryable from non-retryable errors. Exponential backoff with jitter is implemented correctly. The `withRetry` function is well-structured.

**ISSUE (Major):** In `resilient-client.ts`, the `executeWithResilience` method wraps the operation in an extra closure:

```typescript
return await withRetry(
  () => operation(),  // ← Extra closure
  this.config,
  this.logger,
  operationName,
);
```

This means every retry attempt calls `operation()` as a fresh call, which calls `this.inner.getSports()` as a fresh call. While functionally correct, the `attempt` parameter passed to the inner function is ignored. This is not a bug (it doesn't produce wrong results) but the `attempt` parameter is misleading — the signature says `(attempt: number) => Promise<T>` but the actual retry mechanism doesn't use it. The wrapper `() => operation()` discards the attempt counter entirely.

**ISSUE (Minor):** The `isRetryable` function has redundant logic:

```typescript
// retry.config.ts
retryableStatusCodes: [429, 500, 502, 503, 504],

// retry.helper.ts
if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
  return false;  // Block 4xx except 429
}

return config.retryableStatusCodes.includes(statusCode) || statusCode === 0;
```

The first check (line 30) is redundant with the `retryableStatusCodes.includes()` check on line 34, but provides an early-exit optimisation. Acceptable.

### Rate Limit Handling — PASS with Concern

**PASS:** HTTP 429 is correctly caught and thrown as `RateLimitError` in the base client. The resilient client will retry on 429 since it's in the `retryableStatusCodes` list.

**ISSUE (Major):** The base client does not parse `Retry-After` headers from 429 responses. The `context` object passed to `RateLimitError` does not include `retryAfterMs` or `retryAfter` fields. This means the resilient client cannot calculate meaningful backoff from the server's suggested wait time. The `withRetry` function uses its own exponential backoff regardless of `Retry-After` headers.

### Quota Tracking — FAIL

**ISSUE (Critical):** Quota tracking in `ResilientOddsApiClient` is entirely reactive — it only updates quota state when an error occurs (line 100: `this.updateQuotaFromError(error)`). On successful responses, quota is **never updated**.

The Odds API returns quota information in response headers (`x-requests-remaining`, `x-requests-used`, etc.). The base client (`the-odds-api.client.ts`) does not read or propagate these headers. The resilient client's `updateQuotaFromError` method tries to extract `requestsRemaining`, `totalRequests`, and `resetTimestamp` from error context, but the base client never sets these values in the error context.

**Result:** `getQuotaState()` always returns the initial state (all zeros, `isExhausted: false`) on success, and only updates on errors when those specific context fields happen to be set (which they never are from the base client).

### Health Check Correctness — PASS with Concern

**PASS:** The health check correctly evaluates reachability, authentication, and quota utilization. Statuses match requirements.

**ISSUE (Minor):** The health check always reports `quotaUtilization: 0` and `requestsRemaining: 0` because the quota tracking never actually works (see above). This means `evaluateStatus` will always return `'healthy'` as long as the API is reachable and authenticated, since `quotaUtilization` is always 0 (never >= 0.8).

**ISSUE (Minor):** The `reachable` and `authenticated` fields in the success path (line 65-66) are hardcoded to `true` rather than derived from the actual response. This is functionally correct (if we got past `getSports()` without an error, we know both are true) but the hardcoding suggests the fields could be removed.

### API Client Correctness — PASS

**PASS:** The client correctly:
- Builds URLs with the API key
- Uses AbortController for timeout
- Translates all non-2xx responses to typed errors
- Handles network errors and timeouts
- Supports all three API endpoints

**ISSUE (Minor):** The `buildSearchParams` method's JSDoc says "converting camelCase keys to the API's snake_case format" but the `keyMap` record maps `regions` → `'regions'` (identity mapping). All keys pass through unchanged. The comment is misleading — no actual camelCase-to-snake_case conversion happens. The API itself accepts camelCase query parameters, so this works, but the comment is wrong.

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
| No PandaScore integration | ✅ |
| No AI analysis | ✅ |
| No prediction logic | ✅ |
| No betting logic | ✅ |
| No business logic | ✅ |
| No Sprint 2 health system modifications | ✅ |

---

## Technical Debt

| Item | Severity | Description |
|---|---|---|
| Dead `ApiErrorResponse` type | Low | Defined in `types.ts`, never imported or used |
| Dead `RateLimitInfo` type | Low | Defined in `types.ts`, never imported or used |
| Misleading JSDoc in `buildSearchParams` | Low | Claims camelCase→snake_case conversion, doesn't do it |
| Quota tracking is completely non-functional | **High** | Only updates on error, never on success |
| Retry `attempt` parameter is ignored | Low | The wrapper `() => operation()` discards the attempt counter |
| No `Retry-After` header parsing | Medium | 429 responses don't pass retry-after info to the backoff logic |

---

## Risks

### 1. Quota tracking is non-functional (High Risk)

**Impact:** Health check always reports `degradedQuotaPercent` as 0, so the API will never report `degraded` or `unhealthy` due to quota exhaustion. Users will only discover quota issues when they start getting 429 responses.

**Mitigation:** Either:
- Parse response headers (`x-requests-remaining`, etc.) in the base client and pass them through the return type
- Or remove quota tracking entirely and rely on 429 detection

### 2. Retry-After headers ignored (Medium Risk)

**Impact:** When the server sends a `Retry-After: 60` header, the client ignores it and uses its own exponential backoff. This could result in faster retries than the server expects, potentially worsening rate limiting.

**Mitigation:** Parse the `Retry-After` header in `handleErrorResponse` and pass it in the error context, then prefer it over calculated backoff in `withRetry`.

### 3. Extra closure in executeWithResilience (Low Risk)

**Impact:** The `attempt` parameter passed to `withRetry`'s operation callback is never used. If future developers add attempt-aware logic (e.g., "ignore errors on first attempt"), it won't work without fixing this.

**Mitigation:** Change `() => operation()` to `() => operation()` — actually this needs to change to `async (attempt) => operation()` but since the inner operation doesn't use `attempt` either, this is a design smell.

---

## Required Fixes

| # | Priority | Fix |
|---|---|---|
| 1 | **HIGH** | Fix quota tracking by parsing response headers in the base client |
| 2 | **MEDIUM** | Parse `Retry-After` from 429 responses and pass it in error context |
| 3 | **LOW** | Remove unused `ApiErrorResponse` and `RateLimitInfo` types or use them |
| 4 | **LOW** | Fix misleading JSDoc in `buildSearchParams` |
| 5 | **LOW** | Fix extra closure in `executeWithResilience` to pass `attempt` through |

## Recommended Fixes

| # | Priority | Fix |
|---|---|---|
| 1 | LOW | Extract `const RESPONSE_HEADERS_QUOTA_TOTAL = 'x-requests-remaining'` (or whatever the actual header names are) into constants |
| 2 | LOW | Add unit tests for `isRetryable`, `calculateBackoff`, and `withRetry` |

---

## Readiness Assessment

**READY WITH CONCERNS**

---

## Final Verdict

**PASS WITH CONCERNS**

The Odds API integration is architecturally sound, properly scoped, and correctly implements the HTTP client layer. The resilience layer has a **critical defect** in quota tracking (it never works on successful responses) and a **medium-risk defect** in Retry-After header handling. These should be addressed before relying on quota-based health checks, but they do not block the integration from being used for its primary purpose: making API calls with retry on transient failures.
</｜｜DSML｜｜parameter>
<task_progress>
- [x] Read all 11 files in src/integrations/the-odds-api/
- [x] Audit architecture (dependency boundaries, constructor injection, global state, logger, errors)
- [x] Audit implementation (type safety, retry, rate limiting, quota, health, client)
- [x] Verify scope (no DB, no BullMQ, no Discord, no business logic)
- [x] Identify technical debt and risks
- [x] Create docs/audits/THE-ODDS-API-AUDIT.md
</task_progress>
</write_to_file>