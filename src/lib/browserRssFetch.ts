import type { RssFetchImpl, RssFetchResponse } from './complianceRssConnector'

// ─── Browser fetch adapter for the RSS/Atom connector (Phase 2D) ────────────
//
// This is the ONLY module in the codebase that references the global `fetch`.
// It exists so that domain and UI modules never call `fetch` directly — they
// depend solely on the connector's injected RssFetchImpl contract, and this
// adapter is the single sanctioned bridge to the browser transport.
//
// It forwards the connector-built init verbatim. That init already encodes the
// connector's transport safety: `method: 'GET'`, `redirect: 'error'` (a
// redirect makes fetch reject rather than follow it), `credentials: 'omit'`
// (no cookies/authorization ever sent), an AbortController `signal` (timeout),
// and an explicit `User-Agent`/`Accept`. This adapter adds nothing and strips
// nothing — in particular it injects no credentials, tokens, or cookies.
//
// A browser Response structurally satisfies RssFetchResponse (ok/status/url/
// redirected/headers.get/text), so no field mapping is needed. Note that
// cross-origin regulatory feeds will typically be blocked by CORS in a real
// browser; such failures surface as the connector's `fetch_failed` error and
// are handled as an ordinary error state. Swapping this adapter for a
// server-side proxy is a later phase and requires no change to the connector
// or the orchestration.
//
// Since the deployed CSP (vercel.json) restricts `connect-src` to 'self' and
// Supabase, these requests are now refused by the policy BEFORE the CORS check
// rather than after it. Both surface identically as `fetch_failed`. That was a
// deliberate decision, taken after measuring the registered feeds — both of the
// seeded RSS sources already fail CORS today, so nothing working was given up.
// See docs/CSP_FEED_RETRIEVAL_DECISION.md. Making this path actually work needs
// the server-side proxy noted above, not a wider CSP: administrators register
// feed URLs at runtime, and a static header cannot enumerate them.

export function createBrowserRssFetch(): RssFetchImpl {
  return async (url, init) => {
    const response = await fetch(url, init)
    return response as unknown as RssFetchResponse
  }
}
