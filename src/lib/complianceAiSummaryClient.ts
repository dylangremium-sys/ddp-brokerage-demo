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
          // Map any server error to the orchestration's provider_error path.
          throw new Error('The AI draft summary request was not completed.')
        }

        const json: unknown = await response.json()
        if (!isServerSuccess(json)) {
          throw new Error('The AI draft summary response was unreadable.')
        }

        // The server has already run the reference guard, so `sections` is
        // filtered and the browser's own pass will find nothing to drop. Carry
        // the server's count forward or the reviewer is shown a zero.
        const upstreamDropped = json.referenceIntegrity?.droppedReferences
        return {
          value: json.sections,
          confidence: 0,
          provenance: {
            actorType: 'ai_assistant',
            promptVersion: { id: 'server', description: 'Server-side AI draft summariser' },
            modelInfo: { provider: json.provenance.provider, model: json.provenance.model },
            generatedAt: json.provenance.generatedAt,
            requiresHumanReview: true,
            upstreamDroppedReferences:
              typeof upstreamDropped === 'number' && Number.isFinite(upstreamDropped) && upstreamDropped > 0
                ? Math.floor(upstreamDropped)
                : undefined,
          },
        }
      } finally {
        inFlight = false
      }
    },
  }
}
