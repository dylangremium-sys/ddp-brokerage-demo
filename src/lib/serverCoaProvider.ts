import { COA_FIELD_NAMES, MEASUREMENT_ONLY_FIELDS, type RawExtractedReport } from './coaExtraction.js'

// ─── COA extraction provider ─────────────────────────────────────────────────
//
// Sends the PDF to the Anthropic Messages API as a document block and asks for
// structured fields back. Same shape as serverAiProvider.ts: one call, an
// AbortController timeout, no retry, no scheduling, and the key read from a
// server-only environment variable by the caller.
//
// NO OCR LIBRARY. The model reads PDFs natively, which is why nothing was added
// to package.json. NOT verified against the live API — that comment was false and
// has been removed. Run the throwaway script against real PDFs before merging.

export interface CoaProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  anthropicVersion?: string
  timeoutMs?: number
  maxTokens?: number
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

/**
 * A COA is far larger than the text the summariser handles, and a pack of five
 * reports is larger still. 90s, not the summariser's 60.
 */
const DEFAULT_TIMEOUT_MS = 90_000

/**
 * Caps thinking AND response text together. Nineteen fields across up to five
 * reports is a big structured reply, so this is above the summariser's ceiling —
 * a truncated reply is indistinguishable from a document that could not be read,
 * and would be recorded as the latter.
 */
const DEFAULT_MAX_TOKENS = 16_000

/**
 * The instruction. Every clause exists because of something in the real
 * documents, and the reasoning is kept here rather than in a commit message
 * because whoever edits this prompt needs it in front of them.
 */
function buildPrompt(): string {
  return [
    'You are reading a laboratory Certificate of Analysis for cannabis flower.',
    '',
    'A SINGLE PDF MAY CONTAIN SEVERAL SEPARATE REPORTS. Real packs from this',
    'laboratory contain five, each with its own Report No., Sample No. and Batch',
    'No. Return one entry per report. Never merge them: attributing one sample\'s',
    'numbers to another sample\'s batch is the most damaging error you can make',
    'here.',
    '',
    'Return ONLY JSON, no prose, in exactly this shape:',
    '{"reports":[{"report_number":"...","fields":[',
    '  {"field_name":"...","value":"...","confidence":0.0,"note":null}]}]}',
    '',
    `Permitted field_name values (use no others): ${COA_FIELD_NAMES.join(', ')}.`,
    '',
    'RULES:',
    '- confidence is your own 0..1 certainty for THAT field. Be honest: a low',
    '  number is useful, a wrong high number is not.',
    '- If a field is absent from the report, set value to null and explain in',
    '  note (for example "not in this panel"). Do not omit the field and do not',
    '  guess.',
    `- For ${MEASUREMENT_ONLY_FIELDS.join(', ')}: report the MEASURED VALUES as`,
    '  written, for example "As 0.01, Cd 0.02, Hg ND, Pb 0.03 ppm". These reports',
    '  state no limits — the Specification column reads N/A — so they contain no',
    '  pass or fail. NEVER return "pass", "fail" or "compliant". Judging against',
    '  a limit is done elsewhere, by rules this laboratory did not set.',
    '- Dates are DD/MM/YYYY. Return them exactly as printed; do not convert.',
    '- total_thc and total_cbd: use the report\'s own stated Total figures, which',
    '  it computes as %D9-THC + (%THCA x 0.877). Do not recalculate them.',
    '- Copy values exactly as printed. Do not round, convert units, or tidy.',
  ].join('\n')
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  // btoa exists in the Vercel Node runtime and in the browser; Buffer would tie
  // this file to Node and it is imported by the app's tsconfig graph.
  return btoa(binary)
}

/** Extracts the JSON object from a reply, tolerating a fenced code block. */
export function parseProviderReply(text: string): RawExtractedReport[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const reports = (parsed as { reports?: unknown }).reports
  if (!Array.isArray(reports)) return null

  // Shape-check only. Field names, confidences and the value-or-warning rule are
  // enforced by coaExtraction.ts against the database's own constraints — this
  // must not become a second, divergent validator.
  const out: RawExtractedReport[] = []
  for (const r of reports) {
    if (typeof r !== 'object' || r === null) continue
    const rec = r as Record<string, unknown>
    const fields = Array.isArray(rec.fields) ? rec.fields : []
    out.push({
      report_number: typeof rec.report_number === 'string' ? rec.report_number : null,
      fields: fields
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => ({
          field_name: typeof f.field_name === 'string' ? f.field_name : '',
          value: typeof f.value === 'string' ? f.value : null,
          confidence: typeof f.confidence === 'number' ? f.confidence : null,
          note: typeof f.note === 'string' ? f.note : null,
        })),
    })
  }
  return out
}

export function createCoaExtractionProvider(config: CoaProviderConfig) {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const anthropicVersion = config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS

  return async function extract(pdf: Uint8Array): Promise<RawExtractedReport[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': anthropicVersion,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: toBase64(pdf) },
                },
                { type: 'text', text: buildPrompt() },
              ],
            },
          ],
        }),
      })

      if (!res.ok) {
        // The body is never read into the error: it can echo document contents.
        throw new Error(`coa_extraction_provider_error_${res.status}`)
      }

      const json = (await res.json()) as { content?: { type?: string; text?: string }[] }
      const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      const reports = parseProviderReply(text)
      if (!reports) throw new Error('coa_extraction_malformed_reply')
      return reports
    } finally {
      clearTimeout(timer)
    }
  }
}
