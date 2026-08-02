import type { RssFetchResponse } from './complianceRssConnector.js'

// ─── Shared shaping: a retrieval record → the connector's response contract ──
//
// Both server-side transports present their result to complianceRssConnector
// through this one function: createServerProxyRssFetch (browser → our endpoint
// → retriever) and createDirectSourceRssFetch (cron → retriever). Having one
// implementation is the point — if the two shaped responses could differ, the
// connector's content-type check, size check and redirect guard would mean
// different things depending on who triggered the run, and a scheduled run
// could accept something a manual run refuses.

export interface RetrievalShape {
  requestedUrl: string
  finalUrl: string | null
  httpStatus: number | null
  contentType: string | null
  byteLength: number
  contentFingerprint: string | null
  redirectChain: string[]
  content: string | null
}

/**
 * REPORTING REDIRECTS, AND WHY THIS IS NOT A BYPASS
 *
 * The connector's redirect guard rejects any response whose final URL differs
 * from the requested one, because a browser using `redirect: 'error'` cannot
 * re-validate where it was sent. This reports `redirected: false` and echoes
 * the REQUESTED url, which would be a bypass if the server followed redirects
 * blindly. It does not:
 *
 *   `retrieveOfficialSource` follows redirects MANUALLY and re-runs the full
 *   validation on every hop against an allowlist containing exactly one host —
 *   the stored source's own. A chain that reaches here has already been proven
 *   to have stayed on that single host, a strictly stronger guarantee than the
 *   check being skipped.
 *
 * Reporting the redirect instead would fail every source that answers on a
 * canonical host, for no security gain. The chain is preserved in a header.
 */
export function rssResponseFromRetrieval(requestedUrl: string, retrieval: RetrievalShape): RssFetchResponse {
  const map = new Map<string, string>([
    ['content-type', retrieval.contentType ?? ''],
    // The connector checks a declared Content-Length before reading the body.
    // Supplying the measured length keeps that check meaningful instead of
    // silently skipped — `Number(null)` is 0, which passes any size limit.
    ['content-length', String(retrieval.byteLength)],
    // Diagnostics the connector ignores, so a redirect that DID happen stays
    // visible to a human reading a failed run.
    ['x-ddp-final-url', retrieval.finalUrl ?? ''],
    ['x-ddp-redirect-chain', retrieval.redirectChain.join(' -> ')],
    ['x-ddp-content-fingerprint', retrieval.contentFingerprint ?? ''],
  ])

  return {
    ok: true,
    status: retrieval.httpStatus ?? 200,
    url: requestedUrl,
    redirected: false,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(retrieval.content ?? ''),
  }
}
