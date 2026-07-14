// ─── AI-summary endpoint wrapper (P0-B observability) ───────────────────────
//
// api/compliance/ai-summary.ts is a thin Vercel adapter that "delegates ALL
// request handling to the pure, mock-tested core". That is why this file exists
// rather than the logic living in the adapter: api/ is outside the vitest include
// glob and outside the app tsconfig, so anything put there is untestable. Keeping
// the observability behaviour here means it is driven by real tests instead of
// source-text assertions.
//
// It adds exactly two things to the existing pipeline and changes nothing else:
//   1. a correlation ID on every failure response, echoed to the caller;
//   2. one structured, privacy-safe log line for every server-side fault (5xx).
//
// The 200 response is passed through byte-for-byte: successful AI output, its
// guardrails and its provenance are untouched.

// The .js extensions are REQUIRED, not stylistic. Vercel ships this function as
// native Node ESM and does not bundle it, so an extensionless relative import
// resolves to a file that does not exist on disk and the function dies at load
// with ERR_MODULE_NOT_FOUND before any handler code runs. Vite, vitest and tsc
// all resolve extensionless imports happily, so nothing in `npm run ci:verify`
// catches this — only the deployed runtime does. Every other import in this
// function's graph already uses .js for the same reason (serverAiSummary.ts:1-8,
// api/compliance/ai-summary.ts).
import { handleAiSummaryRequest } from './serverAiSummary.js'
import type { NormalizedRequest, ServerAiSummaryDeps } from './serverAiSummary.js'
import { logServerError, newRequestId } from './observability.js'

export const AI_SUMMARY_ROUTE = 'api/compliance/ai-summary'

export interface EndpointResult {
  status: number
  body: unknown
}

/** The generic client-facing text. Deliberately says nothing about the cause. */
const MISCONFIGURED_MESSAGE = 'The service is not configured.'
const INTERNAL_MESSAGE = 'An unexpected error occurred.'

/**
 * Runs the endpoint.
 *
 * @param deps `null` when the server-only environment variables are absent — the
 *   fail-closed misconfiguration path, which must never look like a client error.
 * @param requestId injectable purely so tests can assert correlation; production
 *   callers let it default.
 */
export async function runAiSummaryEndpoint(
  request: NormalizedRequest,
  deps: ServerAiSummaryDeps | null,
  requestId: string = newRequestId(),
): Promise<EndpointResult> {
  const method = request.method
  const route = AI_SUMMARY_ROUTE

  if (!deps) {
    logServerError({ event: 'api_error', requestId, category: 'server_misconfigured', status: 503, method, route })
    return {
      status: 503,
      body: { ok: false, error: 'server_misconfigured', message: MISCONFIGURED_MESSAGE, requestId },
    }
  }

  try {
    const result = await handleAiSummaryRequest(request, deps)

    // Success: pass straight through. No field is added, removed or reordered.
    if (result.body.ok) return { status: result.status, body: result.body }

    // A 5xx from the core is a server-side fault (e.g. the AI provider failed) and
    // is exactly what we want to see in the logs. A 4xx is a caller mistake —
    // expected, self-inflicted, and not worth a log line per occurrence — but it
    // still gets a correlation ID so a support report can be tied to a response.
    if (result.status >= 500) {
      logServerError({ event: 'api_error', requestId, category: result.body.error, status: result.status, method, route })
    }
    return { status: result.status, body: { ...result.body, requestId } }
  } catch {
    // The exception itself is never touched: not logged, not inspected, not
    // returned. It is the one object guaranteed to be able to carry the prompt,
    // the source legal text, the provider's response or the caller's token.
    logServerError({ event: 'api_error', requestId, category: 'internal_error', status: 500, method, route })
    return {
      status: 500,
      body: { ok: false, error: 'internal_error', message: INTERNAL_MESSAGE, requestId },
    }
  }
}
