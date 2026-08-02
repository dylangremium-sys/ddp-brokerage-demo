// ─── Feed-retrieval endpoint wrapper ─────────────────────────────────────────
//
// `api/compliance/feed-retrieve.ts` is a thin Vercel adapter that delegates all
// request handling to the pure, mock-tested core. That is why this file exists
// rather than the logic living in the adapter: `api/` is outside the vitest
// include glob and outside the app tsconfig, so anything put there is asserted
// only by source-text matching. Keeping the observability behaviour here means
// it is driven by real tests.
//
// Mirrors serverAiSummaryEndpoint.ts exactly. Two additions to the pipeline and
// nothing else: a correlation ID on every failure response, and one structured,
// privacy-safe log line per server-side fault (5xx).

// The .js extensions are REQUIRED, not stylistic. Vercel ships this function as
// native Node ESM and does not bundle it, so an extensionless relative import
// resolves to a file that does not exist on disk and the function dies at load
// with ERR_MODULE_NOT_FOUND before any handler code runs. Vite, vitest and tsc
// all resolve extensionless imports happily, so nothing in `npm run ci:verify`
// catches this — only the deployed runtime does.
import { handleFeedRetrieveRequest } from './serverFeedRetrieval.js'
import type { NormalizedRequest, ServerFeedRetrievalDeps } from './serverFeedRetrieval.js'
import { logServerError, newRequestId } from './observability.js'

export const FEED_RETRIEVE_ROUTE = 'api/compliance/feed-retrieve'

export interface EndpointResult {
  status: number
  body: unknown
}

const MISCONFIGURED_MESSAGE = 'The service is not configured.'
const INTERNAL_MESSAGE = 'An unexpected error occurred.'

/**
 * Runs the endpoint.
 *
 * @param deps `null` when the server-only environment variables are absent — the
 *   fail-closed misconfiguration path, which must never look like a client error.
 * @param requestId injectable purely so tests can assert correlation.
 */
export async function runFeedRetrieveEndpoint(
  request: NormalizedRequest,
  deps: ServerFeedRetrievalDeps | null,
  requestId: string = newRequestId(),
): Promise<EndpointResult> {
  const method = request.method
  const route = FEED_RETRIEVE_ROUTE

  if (!deps) {
    logServerError({ event: 'api_error', requestId, category: 'server_misconfigured', status: 503, method, route })
    return {
      status: 503,
      body: { ok: false, error: 'server_misconfigured', message: MISCONFIGURED_MESSAGE, requestId },
    }
  }

  try {
    const result = await handleFeedRetrieveRequest(request, deps)

    // Success: pass straight through. No field is added, removed or reordered.
    if (result.body.ok) return { status: result.status, body: result.body }

    if (result.status >= 500) {
      logServerError({ event: 'api_error', requestId, category: result.body.error, status: result.status, method, route })
    }
    return { status: result.status, body: { ...result.body, requestId } }
  } catch {
    // The exception itself is never touched: not logged, not inspected, not
    // returned. Here it is the one object guaranteed to be able to carry the
    // caller's token, or a chunk of a third-party response body.
    logServerError({ event: 'api_error', requestId, category: 'internal_error', status: 500, method, route })
    return {
      status: 500,
      body: { ok: false, error: 'internal_error', message: INTERNAL_MESSAGE, requestId },
    }
  }
}
