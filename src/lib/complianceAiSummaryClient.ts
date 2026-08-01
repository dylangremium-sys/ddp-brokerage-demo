import type {
  AiDraftSummarySections,
  AiSummaryProviderInput,
  ComplianceAiSummaryProvider,
} from './aiComplianceProvider'
import type { AIComplianceOutput } from './aiComplianceTypes'
import { SUPPORTED_CAPABILITY } from './serverAiSummary'

// ─── Browser client adapter (Phase 2I) ──────────────────────────────────────
//
// A ComplianceAiSummaryProvider that speaks ONLY to our own authenticated
// endpoint (/api/compliance/ai-summary). It is pure transport: it never calls a
// vendor endpoint, never knows a vendor request format, never holds a provider
// secret, and never constructs a provider authorization header. It:
//
//   1. obtains the current Supabase session access token (injected getter);
//   2. fails closed if there is no valid token;
//   3. POSTs only the permitted evidence fields (explicit allowlist — the
//      inbound request object may carry extra capability flags at runtime,
//      which must never be forwarded);
//   4. sends Authorization: Bearer <access token>;
//   5. maps any non-OK / transport error into the existing orchestration result
//      model by throwing (generic errors → provider_error; an aborted request →
//      AbortError → provider_timeout);
//   6. blocks a duplicate concurrent request.
//
// The returned value is fed straight back into the SAME guarded orchestration
// (complianceAiSummarisation.ts) on the client, which re-validates the shape and
// re-runs the wording guard before a human ever sees the draft.

export interface ComplianceAiSummaryClientDeps {
  /** Returns the current Supabase session access token, or null if none. */
  getAccessToken: () => Promise<string | null>
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Defaults to the same-origin endpoint. */
  endpoint?: string
}

const DEFAULT_ENDPOINT = '/api/compliance/ai-summary'

interface ServerSuccessBody {
  ok: true
  sections: AiDraftSummarySections
  provenance: { provider: string; model: string; generatedAt: string }
  /** Optional so an older server response still parses; absent is read as
   *  "nothing upstream filtered", never as an error. */
  referenceIntegrity?: { droppedReferences?: unknown }
}

function isServerSuccess(v: unknown): v is ServerSuccessBody {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return o.ok === true && typeof o.sections === 'object' && o.sections !== null && typeof o.provenance === 'object' && o.provenance !== null
}

export function createComplianceAiSummaryHttpClient(
  deps: ComplianceAiSummaryClientDeps,
): ComplianceAiSummaryProvider {
  const fetchImpl = deps.fetchImpl ?? fetch
  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT
  let inFlight = false

  return {
    async draftSummary(input: AiSummaryProviderInput): Promise<AIComplianceOutput<AiDraftSummarySections>> {
      if (inFlight) {
        // Duplicate concurrent request — fail closed rather than fan out.
        throw new Error('An AI draft summary request is already in progress.')
      }
      inFlight = true
      try {
        const accessToken = await deps.getAccessToken()
        if (!accessToken) {
          // Fail closed: no authenticated session ⇒ no request is made.
          throw new Error('No authenticated session.')
        }

        // Explicit allowlist — never spread `input` (it may carry capability
        // flags at runtime). No secret or vendor header is constructed here.
        const requestBody = {
          legalUpdateId: input.legalUpdateId,
          sourceName: input.sourceName,
          sourceUrl: input.sourceUrl,
          jurisdiction: input.jurisdiction,
          itemTitle: input.itemTitle,
          publishedAt: input.publishedAt,
          rawEvidence: input.rawEvidence,
          provenanceChecksum: input.provenanceChecksum,
          status: input.status,
          capability: SUPPORTED_CAPABILITY,
        }

        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          // A non-OK response from OUR OWN endpoint is not evidence that the AI
          // provider failed. This used to map every status to provider_error,
          // which surfaced "The AI provider could not complete the request" for
          // a 400 that never left the browser — sending anyone debugging it to
          // look at the vendor. 4xx means the request was rejected before a
          // provider was called; 5xx keeps the provider_error path, because the
          // server's own 502/503/504 genuinely do mean provider trouble.
          //
          // The server's `error` field is already a safe coarse class (it never
          // carries vendor status text, bodies or keys), so echoing it into the
          // thrown message leaks nothing that was not already returned.
          let serverCode: string | null = null
          try {
            const problem: unknown = await response.json()
            if (
              typeof problem === 'object' && problem !== null &&
              typeof (problem as { error?: unknown }).error === 'string'
            ) {
              serverCode = (problem as { error: string }).error
            }
          } catch {
            // Unreadable body — fall back to the coarse class from the status.
          }

          const error = new Error(
            serverCode
              ? `The AI draft summary request was rejected (${serverCode}).`
              : 'The AI draft summary request was not completed.',
          )
          if (response.status >= 400 && response.status < 500) {
            error.name = 'AiRequestInvalidError'
          }
          throw error
        }

        const json: unknown = await response.json()
        if (!isServerSuccess(json)) {
          throw new Error('The AI draft summary response was unreadable.')
        }

        // ALWAYS set, including zero. This field is the signal that the
        // references were already verified against the AUTHORITATIVE evidence
        // — the stored row the server read — not merely a count to display.
        // Setting it only when the count was non-zero made it useless as that
        // signal in the ordinary case, and left the browser re-verifying a
        // server-verified list against its own copy of the evidence.
        const upstreamDropped = json.referenceIntegrity?.droppedReferences
        const dropped =
          typeof upstreamDropped === 'number' && Number.isFinite(upstreamDropped) && upstreamDropped > 0
            ? Math.floor(upstreamDropped)
            : 0
        return {
          value: json.sections,
          confidence: 0,
          provenance: {
            actorType: 'ai_assistant',
            promptVersion: { id: 'server', description: 'Server-side AI draft summariser' },
            modelInfo: { provider: json.provenance.provider, model: json.provenance.model },
            generatedAt: json.provenance.generatedAt,
            requiresHumanReview: true,
            upstreamDroppedReferences: dropped,
          },
        }
      } finally {
        inFlight = false
      }
    },
  }
}
