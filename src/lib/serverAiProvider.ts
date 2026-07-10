import type {
  AiDraftSummarySections,
  AiSummaryProviderInput,
  ComplianceAiSummaryProvider,
} from './aiComplianceProvider'
import type { AIComplianceOutput } from './aiComplianceTypes'

// ─── Server-side AI provider adapter (Phase 2I) ─────────────────────────────
//
// Implements ComplianceAiSummaryProvider against a real AI vendor over direct
// HTTPS — no vendor SDK dependency is added. Chosen provider: Anthropic
// Messages API (the model family this product already standardises on), called
// with a strict JSON-only instruction so the model returns exactly the five
// review-oriented sections. It runs ONLY on the server (api/compliance/
// ai-summary.ts) — the API key is read from a server-only env var by that
// adapter and injected here as config; it never reaches the browser bundle.
//
// The adapter is transport + shape-normalisation only. It does NOT decide
// eligibility, does NOT run the wording guard, and cannot approve/certify/
// create a rule/enforce — the reused guarded orchestration
// (complianceAiSummarisation.ts) owns all of that. On any transport failure it
// throws a GENERIC Error (no vendor text, no key, no stack surfaced upstream);
// a timeout aborts and surfaces as an AbortError so the orchestration maps it
// to provider_timeout. A malformed / non-JSON model reply is returned as an
// output whose value fails the orchestration's shape check → malformed_output.

export interface ServerAiProviderConfig {
  /** Server-only secret. Never a VITE_-prefixed value. */
  apiKey: string
  model: string
  /** Defaults to the public Anthropic API base. */
  baseUrl?: string
  anthropicVersion?: string
  /** Abort the request after this many ms. */
  timeoutMs?: number
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  promptVersionId?: string
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 1_500

const SYSTEM_PROMPT = [
  'You produce a STRUCTURED DRAFT summary of a single legal/regulatory update',
  'for a human legal reviewer. You never approve, certify, verify, guarantee, or',
  'declare anything compliant or export-ready; you never create or enforce a',
  'rule; you never make a buyer-facing decision. Draft facts and open questions',
  'only. Respond with a SINGLE JSON object and nothing else, exactly:',
  '{"draftSummary": string, "possibleSignificance": string, "uncertainties":',
  'string, "reviewQuestions": string[], "sourceReferences": string[]}.',
].join(' ')

/** Builds the user-content evidence block from ONLY the permitted input fields. */
function buildEvidenceText(input: AiSummaryProviderInput): string {
  const lines = [
    `Title: ${input.itemTitle}`,
    `Jurisdiction: ${input.jurisdiction}`,
    `Source: ${input.sourceName}`,
    `Source URL: ${input.sourceUrl}`,
    `Published: ${input.publishedAt ?? 'unknown'}`,
    '',
    'Source evidence:',
    input.rawEvidence,
  ]
  return lines.join('\n')
}

interface AnthropicTextBlock { type?: string; text?: unknown }
interface AnthropicResponse { content?: unknown }

function extractText(json: unknown): string {
  const content = (json as AnthropicResponse | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as AnthropicTextBlock
      return b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

export function createServerAiSummaryProvider(config: ServerAiProviderConfig): ComplianceAiSummaryProvider {
  const fetchImpl = config.fetchImpl ?? fetch
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const anthropicVersion = config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const promptVersionId = config.promptVersionId ?? 'server-draft-summary-v1'

  return {
    async draftSummary(input: AiSummaryProviderInput): Promise<AIComplianceOutput<AiDraftSummarySections>> {
      // AbortController timeout only — no scheduling, polling, or retry.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': anthropicVersion,
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: DEFAULT_MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: buildEvidenceText(input) }],
          }),
        })
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        // Generic — never surface vendor status text, body, or the key upstream.
        throw new Error('AI provider request failed.')
      }

      let parsed: unknown
      try {
        const json = await response.json()
        parsed = JSON.parse(extractText(json))
      } catch {
        parsed = null // orchestration's shape check → malformed_output
      }

      return {
        value: parsed as AiDraftSummarySections,
        confidence: 0,
        provenance: {
          actorType: 'ai_assistant',
          promptVersion: { id: promptVersionId, description: 'Server-side AI draft summariser' },
          modelInfo: { provider: 'anthropic', model: config.model },
          generatedAt: new Date().toISOString(),
          requiresHumanReview: true,
        },
      }
    },
  }
}
