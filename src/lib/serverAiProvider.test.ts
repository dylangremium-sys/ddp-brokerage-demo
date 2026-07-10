import { describe, expect, it } from 'vitest'
import type { AiSummaryProviderInput } from './aiComplianceProvider'
import { createServerAiSummaryProvider } from './serverAiProvider'

// ─── Phase 2I — server-side AI provider adapter tests ───────────────────────
//
// Mocked fetch only — no real network, no real key. Proves the adapter sends
// ONLY permitted evidence, keeps the API key in a header (never the body),
// times out via AbortController, and never surfaces vendor detail or the key.

const INPUT: AiSummaryProviderInput = {
  legalUpdateId: 'lu-1',
  sourceName: 'Thai FDA',
  sourceUrl: 'https://example.test/notice',
  jurisdiction: 'Thailand',
  itemTitle: 'Cultivation notice',
  publishedAt: '2026-06-01T00:00:00.000Z',
  rawEvidence: 'Raw evidence ประกาศ 🌿',
  provenanceChecksum: 'a'.repeat(64),
  status: 'new',
}

const MODEL_SECTIONS = {
  draftSummary: 'A drafted summary.',
  possibleSignificance: 'Possible significance.',
  uncertainties: 'Some uncertainties.',
  reviewQuestions: ['Q1?'],
  sourceReferences: ['Thai FDA'],
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function anthropicOk(sections: unknown = MODEL_SECTIONS): Response {
  return jsonResponse({ content: [{ type: 'text', text: JSON.stringify(sections) }] })
}

/** Wraps arbitrary model text as an Anthropic 200 reply for parser tests. */
function anthropicRaw(text: string): Response {
  return jsonResponse({ content: [{ type: 'text', text }] })
}

/** Drives the provider once with the given raw model text and returns value. */
async function valueFor(text: string): Promise<unknown> {
  const provider = createServerAiSummaryProvider({
    apiKey: 'sk-x',
    model: 'claude-test',
    fetchImpl: async () => anthropicRaw(text),
  })
  return (await provider.draftSummary(INPUT)).value
}

const JSON_TEXT = JSON.stringify(MODEL_SECTIONS)

describe('createServerAiSummaryProvider — transport', () => {
  it('POSTs to the messages endpoint with the key in a header, not the body', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const provider = createServerAiSummaryProvider({
      apiKey: 'sk-secret-server-key',
      model: 'claude-test',
      baseUrl: 'https://vendor.test',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return anthropicOk()
      },
    })

    await provider.draftSummary(INPUT)

    expect(capturedUrl).toBe('https://vendor.test/v1/messages')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-secret-server-key')
    expect(headers['anthropic-version']).toBeTruthy()

    const bodyText = String(capturedInit?.body)
    // The key must never appear in the request body.
    expect(bodyText).not.toContain('sk-secret-server-key')
    // Only permitted evidence is sent — no capability flags, no checksum leak.
    expect(bodyText).not.toContain('canApprove')
    expect(bodyText).not.toContain('a'.repeat(64))
    // Permitted evidence (incl. Thai/Unicode) is present.
    expect(bodyText).toContain('Thailand')
    expect(bodyText).toContain('ประกาศ')
  })

  it('returns a parsed AIComplianceOutput when the model returns valid JSON', async () => {
    const provider = createServerAiSummaryProvider({
      apiKey: 'sk-x',
      model: 'claude-test',
      fetchImpl: async () => anthropicOk(),
    })
    const out = await provider.draftSummary(INPUT)
    expect(out.value).toEqual(MODEL_SECTIONS)
    expect(out.provenance.modelInfo.provider).toBe('anthropic')
    expect(out.provenance.modelInfo.model).toBe('claude-test')
    expect(out.provenance.requiresHumanReview).toBe(true)
  })

  it('throws a generic error on a non-2xx response (no vendor detail or key)', async () => {
    const provider = createServerAiSummaryProvider({
      apiKey: 'sk-secret',
      model: 'claude-test',
      fetchImpl: async () => jsonResponse({ error: { message: 'invalid x-api-key sk-secret' } }, 401),
    })
    await expect(provider.draftSummary(INPUT)).rejects.toThrow(/AI provider request failed/)
    await provider.draftSummary(INPUT).catch((e: unknown) => {
      expect(String((e as Error).message)).not.toContain('sk-secret')
    })
  })

  it('aborts via AbortController on timeout and surfaces an AbortError', async () => {
    const provider = createServerAiSummaryProvider({
      apiKey: 'sk-x',
      model: 'claude-test',
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }),
    })
    await expect(provider.draftSummary(INPUT)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('returns a non-sections value when the model reply is not valid JSON (→ downstream malformed)', async () => {
    const provider = createServerAiSummaryProvider({
      apiKey: 'sk-x',
      model: 'claude-test',
      fetchImpl: async () => jsonResponse({ content: [{ type: 'text', text: 'not json at all' }] }),
    })
    const out = await provider.draftSummary(INPUT)
    expect(out.value).toBeNull()
  })
})

describe('createServerAiSummaryProvider — response parsing', () => {
  it('accepts plain valid JSON', async () => {
    expect(await valueFor(JSON_TEXT)).toEqual(MODEL_SECTIONS)
  })

  it('accepts a valid ```json fenced block', async () => {
    expect(await valueFor('```json\n' + JSON.stringify(MODEL_SECTIONS, null, 2) + '\n```')).toEqual(MODEL_SECTIONS)
  })

  it('accepts a valid ```JSON fenced block (case-insensitive label)', async () => {
    expect(await valueFor('```JSON\n' + JSON_TEXT + '\n```')).toEqual(MODEL_SECTIONS)
  })

  it('accepts whitespace around a single fenced block', async () => {
    expect(await valueFor('\n\n   ```json\n' + JSON_TEXT + '\n```   \n\n')).toEqual(MODEL_SECTIONS)
  })

  it('preserves provenance on a fenced success (anthropic / model / requiresHumanReview)', async () => {
    const provider = createServerAiSummaryProvider({
      apiKey: 'sk-x',
      model: 'claude-test',
      fetchImpl: async () => anthropicRaw('```json\n' + JSON_TEXT + '\n```'),
    })
    const out = await provider.draftSummary(INPUT)
    expect(out.value).toEqual(MODEL_SECTIONS)
    expect(out.provenance.modelInfo.provider).toBe('anthropic')
    expect(out.provenance.modelInfo.model).toBe('claude-test')
    expect(out.provenance.requiresHumanReview).toBe(true)
  })

  it('rejects prose before a fenced block', async () => {
    expect(await valueFor('Here you go:\n```json\n' + JSON_TEXT + '\n```')).toBeNull()
  })

  it('rejects prose after a fenced block', async () => {
    expect(await valueFor('```json\n' + JSON_TEXT + '\n```\nHope this helps!')).toBeNull()
  })

  it('rejects multiple fenced blocks', async () => {
    expect(await valueFor('```json\n' + JSON_TEXT + '\n```\n```json\n' + JSON_TEXT + '\n```')).toBeNull()
  })

  it('rejects malformed JSON inside a fenced block', async () => {
    expect(await valueFor('```json\n{ "draftSummary": }\n```')).toBeNull()
  })

  it('rejects an unclosed fence', async () => {
    expect(await valueFor('```json\n' + JSON_TEXT)).toBeNull()
  })

  it('rejects arbitrary prose that contains a JSON object', async () => {
    expect(await valueFor('The summary is {"draftSummary":"x"} and more text.')).toBeNull()
  })

  it('rejects a JSON array (non-object)', async () => {
    expect(await valueFor(JSON.stringify([MODEL_SECTIONS]))).toBeNull()
  })

  it('rejects a non-object JSON scalar', async () => {
    expect(await valueFor('"just a string"')).toBeNull()
  })

  it('rejects an empty response', async () => {
    expect(await valueFor('')).toBeNull()
    expect(await valueFor('   \n  ')).toBeNull()
  })
})
