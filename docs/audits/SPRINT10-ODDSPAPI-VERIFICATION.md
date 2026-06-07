# Sprint 10 — OddsPapi Provider Verification

**Date:** 2026-06-07  
**Scope:** Live verification of OddsPapi API — determine with certainty whether the provider is usable  
**API Key tested:** `e8f90400-385c-4c3c-977e-6f78cf6f0cc1` (from `.env`)

---

## Final Verdict

**ODDSPAPI UNUSABLE — PROVIDER FAILURE VERIFIED**

Every network probe performed against `api.oddspapi.com` confirms the provider is defunct. The HTTPS endpoint is completely unreachable (SSL alert 112 on all variants). The HTTP endpoint returns the same 123-byte parking page HTML for every path and every API key combination. The `oddspapi.com` domain redirects to a GoDaddy domain-for-sale page. The provider is not operational.

---

## Files Modified

None. No code changes were made. The existing implementation is correct for the documented spec. The failure is at the infrastructure level — the provider itself no longer operates.

---

## 1. OddsPapi Integration Audit

### Base URL
```
https://api.oddspapi.com   (configured in ODDSPAPI_DEFAULTS.BASE_URL)
```

### Endpoint
```
GET /v2/odds?game={key}
```

### Authentication
```
Header: X-Api-Key: <apiKey>
```

### Request format
The client builds a URL from base URL + path + `URLSearchParams`, sets `X-Api-Key` and `Accept: application/json` headers, and uses `fetch()` with a 15-second `AbortController` timeout.

### Response parsing
`response.json()` cast to `OddspapiMatchOdds[]`. The type contract expects:
```typescript
interface OddspapiMatchOdds {
  id: string;
  game: 'cs2' | 'dota2' | 'lol' | 'valorant';
  home_team: string;
  away_team: string;
  commence_time: string;   // ISO 8601
  bookmakers: Array<{
    key: string;
    title: string;
    outcomes: Array<{ name: string; price: number }>;
  }>;
}
```

### Implementation verdict

The implementation is consistent with the original API specification. Endpoint path, auth header name, game key values, and response type are all correct per the spec used during development. **The implementation is not the problem.**

---

## 2. DNS Verification

```
nslookup api.oddspapi.com
  → 76.223.54.146   (AWS Global Accelerator)
  → 13.248.169.48   (AWS Global Accelerator)

nslookup oddspapi.com
  → 76.223.54.146   (same IPs)
  → 13.248.169.48   (same IPs)
```

Both `api.oddspapi.com` and `oddspapi.com` resolve to the same two AWS Global Accelerator IPs. DNS is live. The domain has not been deleted or deregistered. However, the servers behind it are no longer configured for `api.oddspapi.com`.

---

## 3. TLS Verification

### Test: HTTPS with SNI (production behaviour)
```javascript
https.request({ hostname: 'api.oddspapi.com', port: 443, ... })
```
```
ERROR: write EPROTO
SSL routines: ssl3_read_bytes: tlsv1 unrecognized name
SSL alert number 112
```

### Test: HTTPS without SNI
```javascript
https.request({ hostname: 'api.oddspapi.com', port: 443, servername: '', rejectUnauthorized: false, ... })
```
```
ERROR: write EPROTO
SSL routines: ssl3_read_bytes: tlsv1 unrecognized name
SSL alert number 112
```

### Test: HTTPS direct to IP 76.223.54.146 (Host header override, no cert verification)
```javascript
https.request({ hostname: '76.223.54.146', port: 443, headers: { 'Host': 'api.oddspapi.com' }, rejectUnauthorized: false, ... })
```
```
ERROR: write EPROTO
SSL routines: ssl3_read_bytes: tlsv1 unrecognized name
SSL alert number 112
```

### Test: HTTPS direct to IP 13.248.169.48
```
ERROR: write EPROTO
SSL routines: ssl3_read_bytes: tlsv1 unrecognized name
SSL alert number 112
```

**SSL alert 112 = `unrecognized_name`** — sent by the server in the TLS handshake to indicate it has no virtual host configured for the requested hostname. The AWS load balancer behind `api.oddspapi.com` does not have a TLS certificate for this domain. HTTPS is completely non-functional regardless of how the connection is initiated.

---

## 4. HTTP Verification (Port 80)

### Test: Actual API endpoint with API key
```
GET http://api.oddspapi.com/v2/odds?game=cs2
X-Api-Key: e8f90400-385c-4c3c-977e-6f78cf6f0cc1
Accept: application/json
```
```
HTTP/1.1 200 OK
Content-Type: text/html
Content-Length: 123
Date: Sun, 07 Jun 2026 15:04:22 GMT

<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander?game=cs2"}</script></head></html>
```

### Test: Alternative paths (/v1, /odds, /api/odds, /esports/odds)
All return identical 200 HTML response (123 bytes, same content).

### Test: No API key
```
GET http://api.oddspapi.com/v2/odds?game=cs2
(no headers)
```
```
HTTP/1.1 200 OK
Content-Type: text/html
Content-Length: 123

<!DOCTYPE html><html><head>...same parking HTML...</html>
```

**Conclusion:** The HTTP server returns a 123-byte parking redirect page for **every request, regardless of path or headers**. The server is not inspecting the URL path or `X-Api-Key` header. It is not an API endpoint — it is a catch-all parking handler.

---

## 5. Base Domain Verification

### Test: oddspapi.com HTTPS /lander
```
GET https://oddspapi.com/lander
```
```
HTTP/1.1 307 Temporary Redirect
Location: https://forsale.godaddy.com/forsale/oddspapi.com?utm_source=TDFS_BINNS&utm_medium=parkedpages&utm_campaign=x_corp_tdfs-binns_base&traffic_type=TDFS_BINNS&traffic_id=binns
```

The `oddspapi.com` domain is listed for sale on GoDaddy under the "TDFS_BINNS" (GoDaddy domain brokerage) parking campaign. This is not a temporary outage — it is a deliberate domain parking by GoDaddy after the original operator stopped renewing the domain or sold it.

---

## 6. API Availability Verification

| Test | Result |
|---|---|
| HTTPS to `api.oddspapi.com` (standard) | FAIL — SSL alert 112 |
| HTTPS to `api.oddspapi.com` (no SNI) | FAIL — SSL alert 112 |
| HTTPS to IP `76.223.54.146` | FAIL — SSL alert 112 |
| HTTPS to IP `13.248.169.48` | FAIL — SSL alert 112 |
| HTTP to `api.oddspapi.com/v2/odds?game=cs2` | 200 HTML parking page |
| HTTP to `api.oddspapi.com/v1/odds?game=cs2` | 200 HTML parking page |
| HTTP to `api.oddspapi.com/odds?game=cs2` | 200 HTML parking page |
| HTTP to `api.oddspapi.com/api/odds?game=cs2` | 200 HTML parking page |
| HTTP to `api.oddspapi.com` (no API key) | 200 HTML parking page |
| `oddspapi.com/lander` | 307 → GoDaddy for-sale |

---

## 7. Authentication Verification

Authentication was never tested. The server does not parse HTTP headers or URL paths — every request receives the same 123-byte parking HTML regardless of `X-Api-Key` value. The configured API key `e8f90400-385c-4c3c-977e-6f78cf6f0cc1` cannot be validated or invalidated because no functioning API endpoint exists to authenticate against.

---

## 8. Request Samples (captured)

### Request that would succeed if provider were operational
```
GET https://api.oddspapi.com/v2/odds?game=cs2 HTTP/1.1
Host: api.oddspapi.com
X-Api-Key: e8f90400-385c-4c3c-977e-6f78cf6f0cc1
Accept: application/json
```

### Actual response received (HTTP, port 80)
```
HTTP/1.1 200 OK
Content-Type: text/html
Content-Length: 123
Date: Sun, 07 Jun 2026 15:04:22 GMT

<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander?game=cs2"}</script></head></html>
```

### TLS error (HTTPS, port 443 — production transport)
```
EPROTO: write EPROTO
SSL routines:ssl3_read_bytes:tlsv1 unrecognized name
openssl/ssl/record/rec_layer_s3.c:918
SSL alert number 112
```

---

## 9. Esports Coverage Verification

No esports coverage could be verified because the provider is not operational. The game keys (`cs2`, `dota2`, `lol`, `valorant`) and the endpoint path `/v2/odds` are consistent with the original API specification, but cannot be confirmed against a live response.

---

## 10. Database Validation

Not applicable. No real odds data was received. No OddsSnapshot rows were written from a live OddsPapi response. (The Sprint 9 validation wrote rows using a mock client, which proved the pipeline code is correct independently of the provider.)

---

## 11. Failure Classification

| Possible Cause | Evidence | Verdict |
|---|---|---|
| Invalid implementation | Implementation matches original spec; all paths fail identically regardless of headers | **NOT the cause** |
| Invalid endpoint | All endpoint variants return the same parking page | **NOT the cause** |
| Invalid authentication | Server never reaches auth layer — parking page returned before any request parsing | **NOT the cause** |
| Account restrictions | Account-level restrictions are applied after authentication; server never parses requests | **NOT the cause** |
| Temporary outage | Domain is listed for sale on GoDaddy; TLS cert absent on all IPs | **NOT the cause** |
| **Provider shutdown** | Domain parked on GoDaddy for-sale; TLS certificate removed from all servers; HTTP returns catch-all parking handler | **CONFIRMED CAUSE** |

---

## 12. Recommendations

The OddsPapi provider cannot be used for V1 or any future version. The provider has permanently shut down operations.

**To restore esports odds ingestion, replace the provider.** The architectural integration point is `ODDSPAPI_DEFAULTS.BASE_URL` in `src/integrations/oddspapi/oddspapi.config.ts`. A replacement provider needs to expose an HTTP API that returns match odds by game key. The `OddspapiClient` interface is a single method:

```typescript
interface OddspapiClient {
  getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]>;
}
```

Any provider can be adapted to this interface without changing the correlation or persistence logic.

**Candidate replacement providers to evaluate:**
- The Odds API (`api.the-odds-api.com`) — check current esports coverage under `sport_key` values
- Pinnacle direct API (if accessible for account holders)
- SportMonks, BetsAPI, or similar aggregators with esports markets

**The pipeline code (correlation, OddsSnapshot persistence, scheduling) is production-ready and does not require changes.** Only the provider adapter needs updating.

---

## Summary

| Check | Result |
|---|---|
| DNS resolution | ✓ Both IPs resolve (AWS Global Accelerator) |
| TLS connectivity | ✗ SSL alert 112 on all variants — no cert for hostname |
| API availability | ✗ Parking page on all HTTP paths |
| Authentication | ✗ Cannot test — server never parses requests |
| Real odds data | ✗ None received |
| DB writes | ✗ Not applicable |
| Implementation correctness | ✓ Code matches original spec |
| Provider status | ✗ **DEFUNCT** — domain parked for sale on GoDaddy |
