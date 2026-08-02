# CSP and regulatory feed retrieval — measurement and decision

**Date:** 2026-07-28 · **Context:** PR #80 (`security/vercel-security-headers`, audit R6)
**Reviewer point addressed:** "Permit registered feed origins in `connect-src`" (Codex P1)

## The objection

`vercel.json` sets `connect-src 'self' <supabase>`. `src/lib/browserRssFetch.ts` performs a
browser `fetch()` to arbitrary external regulatory feed URLs, reached from the "Check feed"
button in `src/pages/admin/DDPComplianceWatchtower.tsx` and from
`src/lib/watchtowerIngestionService.ts`. The CSP blocks all of them, so every check would
surface as unavailable *regardless of the feed's CORS behaviour*.

The objection is factually correct. The question is what to do about it, and that depends on
whether the feature works today. So it was measured rather than assumed.

## What was measured

### 1. Which sources can reach the fetch path at all

`evaluateManualMonitoringEligibility()` (`src/lib/complianceManualMonitoring.ts:64`) gates the
button. A source is eligible **only** when its connector kind is `rss` or `atom`; everything
else is reported ineligible and the button is disabled. Of the eight seeded sources in
`src/lib/watchtowerStarterSources.ts`, **two** are `monitoringMethod: 'rss'`. The other six are
`'html'` and can never reach `fetch`.

### 2. Whether those origins permit a browser to read them

Read-only `GET` with an `Origin` header, 2026-07-28:

| Source | Kind | HTTP | `Access-Control-Allow-Origin` | Works in a browser? |
|---|---|---|---|---|
| `sukl.gov.cz/feed/` | **rss** | 200 | *absent* | **No** — blocked by CORS |
| `eur-lex.europa.eu/…rssId=222` | **rss** | 200 | *absent* | **No** — blocked by CORS |
| `www.fda.moph.go.th` | html | 200 | reflects any origin | n/a — ineligible |
| `www.customs.go.th` | html | 200 | a third-party origin | n/a — ineligible |
| `www.oncb.go.th` | html | 200 | *absent* | n/a — ineligible |
| `www.moph.go.th` | html | 403 | *absent* | n/a — ineligible |
| `www.doa.go.th` | html | 403 | *absent* | n/a — ineligible |
| `ratchakitcha.soc.go.th` | html | 403 | *absent* | n/a — ineligible |

Both eligible feeds return no `Access-Control-Allow-Origin`. With `credentials: 'omit'` (which
the connector sets) a browser requires that header to expose the response. **Both therefore fail
in a real browser today, before the CSP is considered.** This matches the header comment already
in `browserRssFetch.ts`: "cross-origin regulatory feeds will typically be blocked by CORS".

Exactly one origin (`www.fda.moph.go.th`) does reflect `Origin` and would work — but it is
registered as `html`, so the eligibility gate excludes it. It is not reachable by this path.

### 3. What is registered in production

**Not determinable.** `public.regulatory_sources` has RLS enabled and its policy calls
`public.is_ddp_admin()`, which the read-only audit role may not execute:

```
ERROR:  permission denied for function is_ddp_admin
```

`pg_class.reltuples` is `-1` (never analysed), so not even a row count is available. The seeded
list above is what the repository ships; what an administrator has since registered in
production is an explicit unknown. See "Residual risk".

## Decision — option (b), keep the restrictive CSP

The three options were:

- **(a) Add the registered feed origins to `connect-src`.** Rejected. It would add two origins
  that are *proven not to work anyway*, so it fixes nothing while widening the policy and
  implying support that does not exist. More fundamentally it cannot work as a general
  solution: administrators register feed URLs at runtime, and `vercel.json` is a static file
  baked at deploy time. A static allowlist can never cover an origin set that is chosen after
  the build. The only allowlist that would cover it is a wildcard, which is forbidden.
- **(b) Keep the CSP; document that it makes an already-failing path fail earlier.** **Chosen.**
  Both feeds that can reach this code path are already blocked by CORS, a control held by the
  feed publisher and not by us.
- **(c) Route feed fetches through a server-side proxy.** The correct long-term fix, and the one
  `browserRssFetch.ts` already anticipates ("Swapping this adapter for a server-side proxy is a
  later phase and requires no change to the connector or the orchestration"). It is a new
  server endpoint with its own SSRF surface, host allowlisting and rate limiting — a feature,
  not a header change, and out of scope for this PR.

The CSP does not regress a working feature. It changes the failure mode of a non-working one
from "CORS error" to "CSP error", both of which surface identically as the connector's
`fetch_failed`.

## Residual risk, stated plainly

1. If an administrator has registered an RSS source whose origin *does* send
   `Access-Control-Allow-Origin`, that one check works today and this CSP breaks it. It could
   not be ruled out because production source rows are unreadable with the audit role. Nothing
   in the seeded configuration has that property.
2. The proxy (option c) remains the only design under which this feature can work for arbitrary
   feeds. Until it exists, browser-side feed checking is best-effort and mostly fails.

**This decision does not make the feature worse in any measured case. It also does not make it
work.** Option (c) is the follow-up.

---

## RESOLVED 2026-08-02 — option (c) is built

The follow-up this document names is implemented. Browser-side feed retrieval is gone:
`browserRssFetch.ts` was **deleted** rather than left in place, because a dead transport is an
invitation to re-wire it.

- `api/compliance/feed-retrieve.ts` — admin-authenticated, throttled, SSRF-guarded server
  retrieval. It takes a **registered source ID, never a URL**, so it cannot become a
  general-purpose outbound fetch primitive for an authenticated session.
- `src/lib/serverProxyRssFetch.ts` — a drop-in `RssFetchImpl`. As this document predicted,
  `complianceRssConnector.ts` required **no change**.
- `api/cron/ingest.ts` + the `crons` entry in `vercel.json` — the sweep now runs daily without
  anyone clicking.
- `src/lib/complianceHtmlWatchConnector.ts` — the six `html` sources (all six Thai regulators),
  which this document correctly notes could never reach `fetch` at all, are now watched for
  page changes.

Two corrections to the measurements above, re-measured 2026-08-02:

1. `sukl.gov.cz/feed/` serves **`application/rss+xml`**, not a generic XML type. The retriever's
   content-type allowlist did not include that media type, so the SSRF-guarded retriever would
   have rejected one of the only two working feeds at the content-type gate while accepting
   EUR-Lex (`application/xml`). Both feed media types are now allowlisted.
2. Residual risk 1 above is now moot: no feed is fetched from a browser, so `connect-src`
   cannot break a source that happens to send permissive CORS headers.

Residual risk 2 is closed. The remaining honest limitation is stated in
`complianceHtmlWatchConnector.ts`: a page-change watcher reports that a page changed, not what
changed, and on long pages it watches a relevance window rather than the whole document.
