import type { RssFetchImpl, RssFetchResponse } from './complianceRssConnector'
import { SUPPORTED_CAPABILITY } from './serverFeedRetrieval'

// ─── Server-proxy adapter for the RSS/Atom connector ────────────────────────
//
// The drop-in replacement for `createBrowserRssFetch`. It satisfies the SAME
// `RssFetchImpl` contract, so `complianceRssConnector.ts` — the parser, the
// Cannamonitor policy gate, the size limits, the monitoring decisions — is
// completely unchanged by this. Only the transport moves.
//
// WHY THE BROWSER ADAPTER CANNOT BE FIXED IN PLACE
// Measured, not assumed (docs/CSP_FEED_RETRIEVAL_DECISION.md, re-measured
// 2026-08-02): the deployed CSP restricts `connect-src` to 'self' and Supabase,
// and both registered feeds send no `Access-Control-Allow-Origin`. So a browser
// fetch to a regulator fails twice over, and would keep failing if either cause
// were removed on its own. Widening the CSP is not the fix — administrators
// register feed URLs at runtime, and a static header cannot enumerate them.
//
// WHY THE FETCH IMPL IS BUILT PER SOURCE
// `RssFetchImpl` is handed a URL, but /api/compliance/feed-retrieve accepts a
// source ID and reads the URL from the database. That asymmetry is deliberate,
// not an impedance mismatch to paper over: it is what stops this endpoint being
// an authenticated general-purpose outbound fetch primitive. So the source ID is
// captured in a closure at the call site, where the source object is in hand,
// and the `url` argument is used only as a consistency assertion.

export interface ServerProxyRssFetchDeps {
  /** Returns the current Supabase session access token, or null if none. */
  getAccessToken: () => Promise<string | null>
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Defaults to the same-origin endpoint. */
  endpoint?: string
}

const DEFAULT_ENDPOINT = '/api/compliance/feed-retrieve'

interface ProxySuccessBody {
  ok: true
  retrieval: {
    status: string
    requestedUrl: string
    finalUrl: string | null
    httpStatus: number | null
    contentType: string | null
    byteLength: number
    contentFingerprint: string | null
    redirectChain: string[]
    content: string | null
  }
}

function isProxySuccess(v: unknown): v is ProxySuccessBody {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (o.ok !== true) return false
  const r = o.retrieval
  return typeof r === 'object' && r !== null && typeof (r as { content?: unknown }).content === 'string'
}

/** Builds the header bag the connector reads, plus diagnostics it ignores. */
function headersFor(retrieval: ProxySuccessBody['retrieval']): { get(name: string): string | null } {
  const map = new Map<string, string>([
    ['content-type', retrieval.contentType ?? ''],
    // The connector checks a declared Content-Length before reading the body.
    // Supplying the measured byte length keeps that check meaningful instead of
    // silently skipped — `Number(null)` is 0, which passes any size limit.
    ['content-length', String(retrieval.byteLength)],
    // Diagnostics. The connector does not read these; they exist so a redirect
    // that DID happen is still visible to a human reading a failed run, rather
    // than being erased by the reporting decision documented below.
    ['x-ddp-final-url', retrieval.finalUrl ?? ''],
    ['x-ddp-redirect-chain', retrieval.redirectChain.join(' -> ')],
    ['x-ddp-content-fingerprint', retrieval.contentFingerprint ?? ''],
  ])
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null }
}

/**
 * Creates an `RssFetchImpl` that retrieves `sourceId` through the server.
 *
 * REPORTING REDIRECTS, AND WHY THIS IS NOT A BYPASS
 * The connector's own redirect guard (step 3 of `executeRssConnector`) rejects
 * any response whose final URL differs from the requested one, because a
 * browser using `redirect: 'error'` cannot re-validate where it was sent. This
 * adapter reports `redirected: false` and echoes the REQUESTED url, which would
 * be a bypass if the server were merely following redirects blindly. It is not:
 *
 *   `retrieveOfficialSource` follows redirects MANUALLY and re-runs the full
 *   validation on every hop against an allowlist containing exactly one host —
 *   the stored source's own. A redirect chain that reaches this code has
 *   therefore already been proven to have stayed on that single host, which is
 *   a strictly stronger guarantee than the check being skipped here.
 *
 * Reporting the redirect instead would fail every source that answers on a
 * canonical host, for no security gain. The chain is still surfaced in
 * `x-ddp-redirect-chain`.
 */
export function createServerProxyRssFetch(
  sourceId: string,
  deps: ServerProxyRssFetchDeps,
): RssFetchImpl {
  const doFetch = deps.fetchImpl ?? fetch
  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT

  return async (url, init): Promise<RssFetchResponse> => {
    const token = await deps.getAccessToken()
    if (!token) {
      // Fail closed and in the connector's own vocabulary: a throw becomes a
      // recorded `fetch_failed` run, not an unhandled rejection.
      throw new Error('no active session')
    }

    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sourceId, capability: SUPPORTED_CAPABILITY }),
      // The connector owns the timeout; its AbortController signal is forwarded
      // so a hung proxy call aborts on the same schedule a direct fetch would.
      signal: init.signal,
    })

    if (!response.ok) {
      // Surface the server's own coded error rather than inventing one. The
      // recurring defect in this codebase's AI client is collapsing every
      // non-OK status into "the provider failed", which sends an operator to
      // the wrong place; the status is included here so triage can start from
      // the truth.
      let code = 'unknown'
      try {
        const body = (await response.json()) as { error?: unknown }
        if (typeof body.error === 'string') code = body.error
      } catch {
        // A non-JSON error body is itself unremarkable; the status still tells
        // the story.
      }
      throw new Error(`feed-retrieve failed (status ${response.status}, ${code})`)
    }

    const body: unknown = await response.json()
    if (!isProxySuccess(body)) {
      throw new Error('feed-retrieve returned an unrecognised body')
    }
    const { retrieval } = body

    if (retrieval.requestedUrl !== url) {
      // The server fetched something other than what this connector asked for.
      // That should be impossible — both sides read the same stored row — so it
      // means the registry changed underneath the run, or the wrong sourceId was
      // closed over. Either way the parsed result would be attributed to the
      // wrong source, so refuse rather than record a mis-attributed item.
      throw new Error('feed-retrieve returned a different URL than requested')
    }

    return {
      ok: true,
      status: retrieval.httpStatus ?? 200,
      url,
      redirected: false,
      headers: headersFor(retrieval),
      text: async () => retrieval.content ?? '',
    }
  }
}
