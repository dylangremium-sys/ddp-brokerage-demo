// Unit tests for the COA review endpoint cores.
//
// Every dependency is injected, so no test opens a socket, reads a PDF, or
// touches a database. The focus is the request gate (method / content type /
// authentication / admin authorization) and the two flows' contracts —
// especially that a failed source retrieval yields NO suggestion.

import { describe, it, expect, vi } from 'vitest'
import {
  handleCoaExtractRequest,
  handleSourceRetrieveRequest,
  decodeBase64,
  type CoaReviewRepository,
  type NormalizedRequest,
  type ServerCoaReviewDeps,
  type SaveExtractionInput,
  type SaveSuggestionInput,
  type AuditEventInput,
} from './serverCoaReview'
import type { PdfTextExtractor } from './serverCoaPdf'
import type { SourceFetchImpl, SourceFetchResponse } from './serverSourceRetrieval'
import { makeTnrPages } from './__fixtures__/tnrCoaFixture'

const NOW = '2026-07-27T12:00:00.000Z'
const REQUEST_ID = 'req-test'

// A minimal, valid PDF byte header followed by filler — the adapter only checks
// the %PDF- signature; page text comes from the injected extractor.
const PDF_BYTES = new TextEncoder().encode('%PDF-1.3\nfake body for tests')
const PDF_BASE64 = btoa(String.fromCharCode(...PDF_BYTES))

function makeRepository(overrides: Partial<CoaReviewRepository> = {}) {
  const saved: {
    extractions: SaveExtractionInput[]
    suggestions: SaveSuggestionInput[]
    audits: AuditEventInput[]
  } = { extractions: [], suggestions: [], audits: [] }

  const repository: CoaReviewRepository = {
    listKnownDocuments: async () => [],
    saveExtraction: async (input) => {
      saved.extractions.push(input)
      return {
        coaDocumentId: 'coa-1',
        documentFingerprint: input.documentFingerprint,
        reportNumber: input.reportNumber,
        sampleName: input.sampleName,
      }
    },
    getDocument: async () => ({
      coaDocumentId: 'coa-1', documentFingerprint: 'a'.repeat(64),
      reportNumber: 'RP-E2602-0196', sampleName: 'Mango',
    }),
    listFindings: async () => [],
    saveSourceVersion: async (input) => ({
      sourceVersionId: 'sv-1',
      authority: input.authority,
      jurisdiction: input.jurisdiction,
      url: input.finalUrl ?? input.requestedUrl,
      retrievalStatus: input.retrievalStatus as never,
      contentFingerprint: input.contentFingerprint,
      retrievedAt: input.retrievedAt,
      section: input.relevantSection,
    }),
    saveSuggestion: async (input) => {
      saved.suggestions.push(input)
      return { suggestionId: 'sg-1' }
    },
    appendAuditEvent: async (input) => {
      saved.audits.push(input)
    },
    ...overrides,
  }
  return { repository, saved }
}

const tnrExtractor: PdfTextExtractor = async () => ({ totalPages: 3, pages: makeTnrPages() })

function makeDeps(overrides: Partial<ServerCoaReviewDeps> = {}): ServerCoaReviewDeps {
  return {
    authenticate: async () => ({ userId: 'user-1' }),
    getProfileRole: async () => 'ddp_admin',
    repository: makeRepository().repository,
    pdfExtractor: tnrExtractor,
    now: () => NOW,
    ...overrides,
  }
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: 'POST',
    contentType: 'application/json',
    authorization: 'Bearer token-abc',
    body: { filename: 'coa.pdf', pdfBase64: PDF_BASE64 },
    ...overrides,
  }
}

function htmlResponse(body: string): SourceFetchResponse {
  const bytes = new TextEncoder().encode(body)
  return {
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
    body: null,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  }
}

describe('request gate', () => {
  it.each([
    [{ method: 'GET' }, 405],
    [{ contentType: 'text/plain' }, 415],
    [{ authorization: null }, 401],
    [{ authorization: 'Token abc' }, 401],
  ])('rejects %o', async (overrides, status) => {
    const result = await handleCoaExtractRequest(request(overrides), makeDeps(), REQUEST_ID)
    expect(result.status).toBe(status)
  })

  it('rejects an invalid access token', async () => {
    const deps = makeDeps({ authenticate: async () => null })
    const result = await handleCoaExtractRequest(request(), deps, REQUEST_ID)
    expect(result.status).toBe(401)
  })

  it.each(['farmer', 'buyer', 'viewer', null])('rejects the non-admin role %s', async (role) => {
    const deps = makeDeps({ getProfileRole: async () => role })
    const result = await handleCoaExtractRequest(request(), deps, REQUEST_ID)
    expect(result.status).toBe(403)
    expect((result.body as { error: string }).error).toBe('forbidden')
  })

  it('never extracts or persists when authorization fails', async () => {
    const { repository, saved } = makeRepository()
    const extractor = vi.fn(tnrExtractor)
    const deps = makeDeps({ repository, pdfExtractor: extractor, getProfileRole: async () => 'farmer' })

    await handleCoaExtractRequest(request(), deps, REQUEST_ID)

    expect(extractor).not.toHaveBeenCalled()
    expect(saved.extractions).toEqual([])
    expect(saved.audits).toEqual([])
  })

  it('reads the role from the profile, never from the request body', async () => {
    const deps = makeDeps({ getProfileRole: async () => 'farmer' })
    const result = await handleCoaExtractRequest(
      request({ body: { filename: 'x.pdf', pdfBase64: PDF_BASE64, role: 'ddp_admin', isAdmin: true } }),
      deps,
      REQUEST_ID,
    )
    expect(result.status).toBe(403)
  })
})

describe('handleCoaExtractRequest', () => {
  it('extracts, persists and audits a supported COA', async () => {
    const { repository, saved } = makeRepository()
    const result = await handleCoaExtractRequest(request(), makeDeps({ repository }), REQUEST_ID)

    expect(result.status).toBe(200)
    const body = result.body as { ok: boolean; document: Record<string, unknown>; fields: unknown[]; findings: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.document.supported).toBe(true)
    expect(body.document.pageCount).toBe(3)
    expect(body.document.documentFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(body.fields.length).toBeGreaterThan(8)

    expect(saved.extractions).toHaveLength(1)
    expect(saved.extractions[0].reportNumber).toBe('RP-E2602-0196')
    expect(saved.extractions[0].fields.some((f) => f.pageNumber !== null)).toBe(true)

    const audit = saved.audits.find((a) => a.action === 'coa_document_extracted')
    expect(audit).toBeDefined()
    expect(audit?.evidenceVersion).toMatch(/^tnr-coa-adapter\/1\.0\.0@[0-9a-f]{64}$/)
  })

  it('rejects a payload that is not a PDF', async () => {
    const notPdf = btoa('this is not a pdf at all')
    const result = await handleCoaExtractRequest(
      request({ body: { filename: 'x.pdf', pdfBase64: notPdf } }), makeDeps(), REQUEST_ID,
    )
    expect(result.status).toBe(422)
    expect((result.body as { extractionStatus: string }).extractionStatus).toBe('not_a_pdf')
  })

  it('rejects a PDF with no text layer and stores no extraction', async () => {
    const { repository, saved } = makeRepository()
    const empty: PdfTextExtractor = async () => ({ totalPages: 3, pages: ['', '', ''] })
    const result = await handleCoaExtractRequest(
      request(), makeDeps({ repository, pdfExtractor: empty }), REQUEST_ID,
    )
    expect(result.status).toBe(422)
    expect((result.body as { extractionStatus: string }).extractionStatus).toBe('no_text_layer')
    expect(saved.extractions).toEqual([])
    expect(saved.audits.some((a) => a.action === 'coa_extraction_failed')).toBe(true)
  })

  it('stores an unsupported document format without inventing fields', async () => {
    const { repository, saved } = makeRepository()
    const foreign: PdfTextExtractor = async () => ({ totalPages: 3, pages: ['other', 'doc', 'here'] })
    const result = await handleCoaExtractRequest(
      request(), makeDeps({ repository, pdfExtractor: foreign }), REQUEST_ID,
    )

    expect(result.status).toBe(200)
    const body = result.body as { document: { supported: boolean }; fields: unknown[]; findings: Array<{ code: string }> }
    expect(body.document.supported).toBe(false)
    expect(body.fields).toEqual([])
    expect(body.findings[0].code).toBe('unsupported_document')
    expect(saved.extractions[0].extractionStatus).toBe('unsupported_format')
  })

  it('flags a duplicate against documents already on file', async () => {
    const extractor = tnrExtractor
    // Same bytes -> same fingerprint; the repository reports it as known.
    const known = [{ coaDocumentId: 'coa-earlier', documentFingerprint: 'zzz', reportNumber: 'RP-E2602-0196' }]
    const { repository } = makeRepository({ listKnownDocuments: async () => known })
    const result = await handleCoaExtractRequest(
      request(), makeDeps({ repository, pdfExtractor: extractor }), REQUEST_ID,
    )
    const findings = (result.body as { findings: Array<{ code: string }> }).findings
    expect(findings.some((f) => f.code === 'duplicate_report_number')).toBe(true)
  })

  it('rejects a body that is not valid base64', async () => {
    const result = await handleCoaExtractRequest(
      request({ body: { filename: 'x.pdf', pdfBase64: '!!!not base64!!!' } }), makeDeps(), REQUEST_ID,
    )
    expect(result.status).toBe(400)
  })
})

describe('handleSourceRetrieveRequest', () => {
  const retrieveRequest = () => request({ body: { coaDocumentId: 'coa-1' } })

  it('retrieves the source, binds a suggestion and audits both', async () => {
    const { repository, saved } = makeRepository()
    const fetchImpl: SourceFetchImpl = async () => htmlResponse('<html><body><p>Cannabis notice text</p></body></html>')

    const result = await handleSourceRetrieveRequest(
      retrieveRequest(), makeDeps({ repository, fetchImpl }), REQUEST_ID,
    )

    expect(result.status).toBe(200)
    const body = result.body as {
      sourceVersion: { retrievalStatus: string; contentFingerprint: string }
      suggestion: { sourceContentFingerprint: string } | null
      suggestionState: string
    }
    expect(body.sourceVersion.retrievalStatus).toBe('retrieved')
    expect(body.suggestionState).toBe('bound')
    expect(body.suggestion?.sourceContentFingerprint).toBe(body.sourceVersion.contentFingerprint)

    expect(saved.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['coa_source_retrieved', 'coa_suggestion_bound']),
    )
    // The bound suggestion's audit event carries the source version it rests on.
    expect(saved.audits.find((a) => a.action === 'coa_suggestion_bound')?.sourceVersionId).toBe('sv-1')
  })

  it('produces NO suggestion when the source cannot be verified', async () => {
    const { repository, saved } = makeRepository()
    const failing: SourceFetchImpl = async () => {
      throw new Error('connection reset')
    }

    const result = await handleSourceRetrieveRequest(
      retrieveRequest(), makeDeps({ repository, fetchImpl: failing }), REQUEST_ID,
    )

    expect(result.status).toBe(200)
    const body = result.body as { suggestion: unknown; suggestionState: string; suggestionReason: string }
    expect(body.suggestion).toBeNull()
    expect(body.suggestionState).toBe('not_created')
    expect(body.suggestionReason).toMatch(/could not be verified/i)

    // The failed retrieval is still recorded — that IS the unverified state.
    expect(saved.audits.some((a) => a.action === 'coa_source_retrieval_failed')).toBe(true)
    expect(saved.suggestions).toEqual([])
  })

  it('produces no suggestion when the authority returns an error status', async () => {
    const { repository, saved } = makeRepository()
    const serverError: SourceFetchImpl = async () => ({
      status: 503,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
    })

    const result = await handleSourceRetrieveRequest(
      retrieveRequest(), makeDeps({ repository, fetchImpl: serverError }), REQUEST_ID,
    )
    expect((result.body as { suggestion: unknown }).suggestion).toBeNull()
    expect(saved.suggestions).toEqual([])
  })

  it('returns 404 for an unknown document', async () => {
    const { repository } = makeRepository({ getDocument: async () => null })
    const result = await handleSourceRetrieveRequest(
      retrieveRequest(), makeDeps({ repository }), REQUEST_ID,
    )
    expect(result.status).toBe(404)
  })

  it('requires a coaDocumentId', async () => {
    const result = await handleSourceRetrieveRequest(
      request({ body: {} }), makeDeps(), REQUEST_ID,
    )
    expect(result.status).toBe(400)
  })

  it('never retrieves anything for a non-admin caller', async () => {
    const fetchImpl = vi.fn()
    const deps = makeDeps({ getProfileRole: async () => 'farmer', fetchImpl: fetchImpl as unknown as SourceFetchImpl })
    const result = await handleSourceRetrieveRequest(retrieveRequest(), deps, REQUEST_ID)
    expect(result.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stores the retrieved section verbatim from the source', async () => {
    let stored = ''
    const { repository } = makeRepository({
      saveSourceVersion: async (input) => {
        stored = input.relevantSection
        return {
          sourceVersionId: 'sv-1', authority: input.authority, jurisdiction: input.jurisdiction,
          url: input.requestedUrl, retrievalStatus: input.retrievalStatus as never,
          contentFingerprint: input.contentFingerprint, retrievedAt: input.retrievedAt,
          section: input.relevantSection,
        }
      },
    })
    const fetchImpl: SourceFetchImpl = async () =>
      htmlResponse('<html><body><p>Intro</p><p>Cannabis licensing announcement</p></body></html>')

    await handleSourceRetrieveRequest(retrieveRequest(), makeDeps({ repository, fetchImpl }), REQUEST_ID)

    expect(stored).toContain('Cannabis licensing announcement')
    expect(stored).not.toContain('<p>')
  })
})

describe('decodeBase64', () => {
  it('round-trips bytes', () => {
    const decoded = decodeBase64(PDF_BASE64)
    expect(decoded && Array.from(decoded)).toEqual(Array.from(PDF_BYTES))
  })

  it('accepts a data URL prefix', () => {
    expect(decodeBase64(`data:application/pdf;base64,${PDF_BASE64}`)).not.toBeNull()
  })

  it('returns null for invalid input', () => {
    expect(decodeBase64('!!!')).toBeNull()
  })
})
