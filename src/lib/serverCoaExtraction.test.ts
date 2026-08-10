import { describe, it, expect } from 'vitest'
import {
  handleCoaExtractRequest,
  validateCoaExtractBody,
  type CoaExtractionDeps,
  type CoaExtractRequest,
} from './serverCoaExtraction'
import type { RawExtractedReport } from './coaExtraction'

// ─── The COA extraction endpoint, exercised entirely with mocks ──────────────
//
// No network, no Supabase, no PDF. The properties under test are not "a 200 is
// returned" but the ones that cost money or mislead a reviewer if they fail:
// nothing is extracted before the caller is proved to be an admin, nothing is
// extracted twice, and a failure records nothing at all.

const DOC = {
  id: '11111111-1111-4111-8111-111111111111',
  fileName: '602918346421698884_RP-E2602-0197_EX26-0191_Calli Krush Co.,LTD.pdf',
  storagePath: 'farm/batch/coa.pdf',
  sha256Hex: null,
}

const ONE_REPORT: RawExtractedReport[] = [
  {
    report_number: 'RP-E2602-0197',
    fields: [
      { field_name: 'report_number', value: 'RP-E2602-0197', confidence: 0.99 },
      { field_name: 'sample_id', value: 'EX26-0191', confidence: 0.99 },
      { field_name: 'total_thc', value: '21.31', confidence: 0.99 },
      { field_name: 'water_activity', value: null, confidence: null, note: 'not in this panel' },
    ],
  },
]

interface Spy {
  extractCalls: number
  persisted: { reportNumber: string | null; row: { field_name: string } }[]
  reservations: number
}

function makeDeps(overrides: Partial<CoaExtractionDeps> = {}): CoaExtractionDeps & { spy: Spy } {
  const spy: Spy = { extractCalls: 0, persisted: [], reservations: 0 }
  const deps: CoaExtractionDeps = {
    authenticate: () => Promise.resolve({ userId: 'admin-1' }),
    getProfileRole: () => Promise.resolve('ddp_admin'),
    getDocument: () => Promise.resolve(DOC),
    fetchDocumentBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    extract: () => {
      spy.extractCalls += 1
      return Promise.resolve(ONE_REPORT)
    },
    reserveExtractionSlot: () => {
      spy.reservations += 1
      return Promise.resolve({ allowed: true })
    },
    persistExtractions: (_id, rows) => {
      spy.persisted.push(...rows)
      return Promise.resolve()
    },
    countExistingExtractions: () => Promise.resolve(0),
    ...overrides,
  }
  return Object.assign(deps, { spy })
}

function req(overrides: Partial<CoaExtractRequest> = {}): CoaExtractRequest {
  return {
    method: 'POST',
    contentType: 'application/json',
    authorization: 'Bearer valid',
    body: { documentId: DOC.id },
    ...overrides,
  }
}

describe('validateCoaExtractBody', () => {
  it('accepts exactly { documentId }', () => {
    expect(validateCoaExtractBody({ documentId: DOC.id })).toEqual({ ok: true, documentId: DOC.id })
  })

  it('rejects an unknown field rather than ignoring it', () => {
    // An ignored field is an unnoticed one. If a caller thinks they are steering
    // the extraction, the request should fail rather than quietly not do it.
    const r = validateCoaExtractBody({ documentId: DOC.id, farmId: 'x' })
    expect(r.ok).toBe(false)
  })

  it('rejects a non-UUID id', () => {
    expect(validateCoaExtractBody({ documentId: 'not-a-uuid' }).ok).toBe(false)
  })
})

describe('nothing is extracted before the caller is proved to be an admin', () => {
  it('refuses an unauthenticated caller and spends nothing', async () => {
    const deps = makeDeps()
    const r = await handleCoaExtractRequest(req({ authorization: null }), deps)
    expect(r.status).toBe(401)
    expect(deps.spy.extractCalls).toBe(0)
    expect(deps.spy.reservations).toBe(0)
  })

  it('refuses a farmer and spends nothing', async () => {
    // Staff-triggered means staff-only. A farmer must not be able to run up the
    // bill by pressing a button on their own upload.
    const deps = makeDeps({ getProfileRole: () => Promise.resolve('farmer') })
    const r = await handleCoaExtractRequest(req(), deps)
    expect(r.status).toBe(403)
    expect(deps.spy.extractCalls).toBe(0)
    expect(deps.spy.reservations).toBe(0)
  })

  it('does not consume an allowance for a malformed request', async () => {
    const deps = makeDeps()
    const r = await handleCoaExtractRequest(req({ body: { nope: 1 } }), deps)
    expect(r.status).toBe(400)
    expect(deps.spy.reservations).toBe(0)
  })
})

describe('the spend ceiling', () => {
  it('refuses with 429 and never calls the model', async () => {
    const deps = makeDeps({ reserveExtractionSlot: () => Promise.resolve({ allowed: false, windowSeconds: 3600 }) })
    const r = await handleCoaExtractRequest(req(), deps)
    expect(r.status).toBe(429)
    expect(r.body.retryAfterSeconds).toBe(3600)
    expect(deps.spy.extractCalls).toBe(0)
  })

  it('fails CLOSED when the ledger is unreachable', async () => {
    // An unreachable throttle must never read as "no extractions yet".
    const deps = makeDeps({ reserveExtractionSlot: () => Promise.reject(new Error('down')) })
    const r = await handleCoaExtractRequest(req(), deps)
    expect(r.status).toBe(503)
    expect(deps.spy.extractCalls).toBe(0)
  })
})

describe('the same document is never extracted twice', () => {
  it('returns 409 and does not call the model again', async () => {
    // Cost control and correctness: a second run would also create machine rows
    // competing with the first while a reviewer is deciding what to accept.
    const deps = makeDeps({ countExistingExtractions: () => Promise.resolve(4) })
    const r = await handleCoaExtractRequest(req(), deps)
    expect(r.status).toBe(409)
    expect(deps.spy.extractCalls).toBe(0)
    expect(deps.spy.persisted).toHaveLength(0)
  })
})

describe('failures record nothing', () => {
  it('persists nothing when the document cannot be fetched', async () => {
    const deps = makeDeps({ fetchDocumentBytes: () => Promise.reject(new Error('gone')) })
    const r = await handleCoaExtractRequest(req(), deps)
    expect(r.status).toBe(502)
    expect(deps.spy.persisted).toHaveLength(0)
  })

  it('persists nothing when extraction throws, and leaks no detail', async () => {
    const deps = makeDeps({ extract: () => Promise.reject(new Error('model said: SECRET-PAYLOAD')) })
    const r = await handleCoaExtractRequest(req(), deps)
    expect(r.status).toBe(502)
    expect(deps.spy.persisted).toHaveLength(0)
    expect(JSON.stringify(r.body)).not.toContain('SECRET-PAYLOAD')
  })

  it('reports 422 rather than success when no report is recognised', async () => {
    const deps = makeDeps({ extract: () => Promise.resolve([]) })
    const r = await handleCoaExtractRequest(req(), deps)
    expect(r.status).toBe(422)
    expect(deps.spy.persisted).toHaveLength(0)
  })

  it('says nothing was recorded when the write fails', async () => {
    const deps = makeDeps({ persistExtractions: () => Promise.reject(new Error('db')) })
    const r = await handleCoaExtractRequest(req(), deps)
    expect(r.status).toBe(503)
    expect(r.body.message).toMatch(/nothing has been recorded/i)
  })
})

describe('the happy path', () => {
  it('persists every field, including the ones it could not read', async () => {
    const deps = makeDeps()
    const r = await handleCoaExtractRequest(req(), deps)

    expect(r.status).toBe(200)
    expect(r.body.reportsFound).toBe(1)
    // Four fields in, four rows out — the unreadable water_activity included,
    // because "not found" is evidence and must not vanish.
    expect(deps.spy.persisted).toHaveLength(4)
    expect(deps.spy.persisted.map((p) => p.row.field_name)).toContain('water_activity')
  })

  it('marks the result as requiring human review', async () => {
    // Nothing this endpoint returns is a compliance decision.
    const r = await handleCoaExtractRequest(req(), makeDeps())
    expect(r.body.requiresHumanReview).toBe(true)
  })

  it('reports several reports from one document without treating it as an error', async () => {
    const two: RawExtractedReport[] = [
      { report_number: 'RP-E2602-0196', fields: [{ field_name: 'total_thc', value: '26.86', confidence: 0.99 }] },
      { report_number: 'RP-E2602-0197', fields: [{ field_name: 'total_thc', value: '21.31', confidence: 0.99 }] },
    ]
    const deps = makeDeps({ extract: () => Promise.resolve(two) })
    const r = await handleCoaExtractRequest(req(), deps)

    expect(r.status).toBe(200)
    expect(r.body.reportsFound).toBe(2)
    // Each row keeps the report it came from, so one sample's numbers can never
    // be attributed to another's batch.
    expect(deps.spy.persisted.map((p) => p.reportNumber)).toEqual(['RP-E2602-0196', 'RP-E2602-0197'])
  })

  it('surfaces a filename disagreement without refusing the extraction', async () => {
    // Either side could be the wrong one, so it is a flag for a human, not a
    // rejection.
    const mismatch: RawExtractedReport[] = [
      { report_number: 'RP-E2602-0192', fields: [{ field_name: 'total_thc', value: '21.06', confidence: 0.99 }] },
    ]
    const deps = makeDeps({ extract: () => Promise.resolve(mismatch) })
    const r = await handleCoaExtractRequest(req(), deps)

    expect(r.status).toBe(200)
    const reports = r.body.reports as { crossCheckWarnings: string[] }[]
    expect(reports[0].crossCheckWarnings.join(' ')).toMatch(/RP-E2602-0192/)
  })
})
