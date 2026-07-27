// ─── Staging end-to-end COA review (Gate P0 — issue #77) ────────────────────
//
// Drives the REAL server code paths against the REAL staging database with REAL
// authentication — the same modules api/compliance/coa-extract.ts and
// api/compliance/source-retrieve.ts delegate to, the same Supabase repository,
// the same live Thai FDA connector, and the same RLS-enforced decision insert
// the browser client uses.
//
// Skipped unless DDP_STAGING_E2E=1, because it writes to a shared database and
// makes a live outbound request. It never touches production.
//
//   set -a && . ./.env.staging && set +a
//   DDP_STAGING_E2E=1 DDP_COA_PDF_PATH="…/1_Mango.pdf" npm test -- coaReviewStaging
//
// What it proves that unit tests cannot:
//   * a supplied COA is extracted server-side and PERSISTED with page provenance
//   * an official source is retrieved live and its version stored
//   * a suggestion binds to that stored version — enforced by the DB trigger
//   * an authorized administrator records a real decision
//   * a NON-admin attempting the same decision is refused by the database
//   * a fresh read reproduces evidence, findings, source, suggestion, decision
//     and audit trail — i.e. refresh persistence

import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { handleCoaExtractRequest, handleSourceRetrieveRequest, type ServerCoaReviewDeps } from './serverCoaReview'
import { createCoaReviewSupabaseRepository } from './coaReviewSupabaseRepository'
import { unpdfTextExtractor } from './unpdfExtractor'

const enabled = process.env.DDP_STAGING_E2E === '1'
const pdfPath = process.env.DDP_COA_PDF_PATH
const supabaseUrl = process.env.STAGING_SUPABASE_URL ?? ''
const anonKey = process.env.STAGING_SUPABASE_ANON_KEY ?? ''
const adminEmail = process.env.STAGING_ADMIN_EMAIL ?? ''
const adminPassword = process.env.STAGING_ADMIN_PASSWORD ?? ''
const farmerEmail = process.env.STAGING_FARMER_A_EMAIL ?? ''
const farmerPassword = process.env.STAGING_FARMER_A_PASSWORD ?? ''

const ready = enabled && !!(pdfPath && supabaseUrl && anonKey && adminEmail && adminPassword)

/** A client bound to one user's access token — exactly what the API does. */
function clientForToken(token: string): SupabaseClient {
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function signIn(email: string, password: string): Promise<{ token: string; userId: string }> {
  const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message ?? 'no session'}`)
  return { token: data.session.access_token, userId: data.session.user.id }
}

function depsFor(token: string, userId: string): ServerCoaReviewDeps {
  const client = clientForToken(token)
  return {
    authenticate: async () => ({ userId }),
    getProfileRole: async (id) => {
      const { data } = await client.from('profiles').select('role').eq('id', id).single()
      return (data?.role as string) ?? null
    },
    repository: createCoaReviewSupabaseRepository(client, userId),
    pdfExtractor: unpdfTextExtractor,
    now: () => new Date().toISOString(),
  }
}

function request(body: unknown) {
  return { method: 'POST', contentType: 'application/json', authorization: 'Bearer staging', body }
}

describe.skipIf(!ready)('staging end-to-end COA review', () => {
  let admin: { token: string; userId: string }
  let coaDocumentId = ''
  let sourceVersionId = ''

  beforeAll(async () => {
    admin = await signIn(adminEmail, adminPassword)
  }, 60_000)

  it('extracts a supplied COA server-side and persists it with page provenance', async () => {
    const bytes = await readFile(pdfPath as string)
    const result = await handleCoaExtractRequest(
      request({ filename: 'staging-e2e.pdf', pdfBase64: bytes.toString('base64') }),
      depsFor(admin.token, admin.userId),
      'staging-e2e',
    )

    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const body = result.body as {
      document: { coaDocumentId: string; supported: boolean; pageCount: number; documentFingerprint: string }
      fields: Array<{ status: string; pageNumber: number | null }>
    }
    expect(body.document.supported).toBe(true)
    expect(body.document.pageCount).toBe(3)
    coaDocumentId = body.document.coaDocumentId
    expect(coaDocumentId).toBeTruthy()

    // Every extracted value cites a page.
    for (const field of body.fields.filter((f) => f.status === 'extracted')) {
      expect(field.pageNumber).toBeGreaterThanOrEqual(1)
    }
  }, 120_000)

  it('is idempotent — re-processing the same bytes does not create a second record', async () => {
    const bytes = await readFile(pdfPath as string)
    const result = await handleCoaExtractRequest(
      request({ filename: 'staging-e2e.pdf', pdfBase64: bytes.toString('base64') }),
      depsFor(admin.token, admin.userId),
      'staging-e2e-retry',
    )
    expect(result.status).toBe(200)
    expect((result.body as { document: { coaDocumentId: string } }).document.coaDocumentId).toBe(coaDocumentId)
  }, 120_000)

  it('retrieves the official source live and binds a suggestion to that version', async () => {
    const result = await handleSourceRetrieveRequest(
      request({ coaDocumentId }),
      depsFor(admin.token, admin.userId),
      'staging-e2e-source',
    )

    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const body = result.body as {
      sourceVersion: { sourceVersionId: string; retrievalStatus: string; contentFingerprint: string | null; authority: string }
      suggestion: { sourceContentFingerprint: string } | null
      suggestionState: string
    }

    expect(body.sourceVersion.retrievalStatus).toBe('retrieved')
    expect(body.sourceVersion.contentFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(body.suggestionState).toBe('bound')
    expect(body.suggestion?.sourceContentFingerprint).toBe(body.sourceVersion.contentFingerprint)
    sourceVersionId = body.sourceVersion.sourceVersionId
  }, 120_000)

  it('refuses to store a suggestion bound to an unverified source (DB trigger)', async () => {
    const client = clientForToken(admin.token)
    const { data: failed } = await client
      .from('coa_source_versions')
      .insert({
        source_key: 'th-fda', authority: 'Thai FDA', jurisdiction: 'Thailand',
        requested_url: 'https://www.fda.moph.go.th/', retrieval_status: 'timeout',
        failure_reason: 'staging e2e negative control',
      })
      .select('id').single()

    const { error } = await client.from('coa_suggestions').insert({
      coa_document_id: coaDocumentId,
      source_version_id: (failed as { id: string }).id,
      state: 'bound',
      suggestion_text: 'This must never be stored as bound.',
    })

    expect(error).not.toBeNull()
    expect(error?.message ?? '').toMatch(/not successfully retrieved/i)
  }, 60_000)

  it('lets an authorized administrator record a real decision', async () => {
    const client = clientForToken(admin.token)
    const { data, error } = await client
      .from('coa_decisions')
      .insert({
        coa_document_id: coaDocumentId,
        source_version_id: sourceVersionId,
        decision: 'escalated_to_legal',
        previous_state: 'pending_review',
        resulting_state: 'escalated_to_legal',
        note: 'Staging end-to-end verification.',
        evidence_version: 'tnr-coa-adapter/1.0.0@staging-e2e',
        decided_by: admin.userId,
      })
      .select('id, decided_by, decided_at').single()

    expect(error, error?.message).toBeNull()
    expect((data as { decided_by: string }).decided_by).toBe(admin.userId)

    await client.from('compliance_audit_log').insert({
      actor_type: 'admin', actor_id: admin.userId, action: 'coa_decision_recorded',
      entity_type: 'coa', entity_id: coaDocumentId,
      before_state: { state: 'pending_review' }, after_state: { state: 'escalated_to_legal' },
      reason: 'Staging end-to-end verification.',
      evidence_version: 'tnr-coa-adapter/1.0.0@staging-e2e',
      source_version_id: sourceVersionId,
    })
  }, 60_000)

  it('blocks an unauthorized (non-admin) decision attempt at the database', async () => {
    if (!farmerEmail || !farmerPassword) {
      throw new Error('STAGING_FARMER_A_EMAIL/PASSWORD are required for the negative authorization test')
    }
    const farmer = await signIn(farmerEmail, farmerPassword)
    const client = clientForToken(farmer.token)

    // A non-admin cannot even see the document, let alone decide on it.
    const { data: visible } = await client.from('coa_documents').select('id').eq('id', coaDocumentId)
    expect(visible ?? []).toEqual([])

    const { data, error } = await client.from('coa_decisions').insert({
      coa_document_id: coaDocumentId,
      decision: 'accepted_for_further_review',
      previous_state: 'pending_review',
      resulting_state: 'accepted_for_further_review',
      note: 'Unauthorized attempt — must be refused.',
      evidence_version: 'tnr-coa-adapter/1.0.0@staging-e2e',
      decided_by: farmer.userId,
    }).select('id')

    expect(error, 'a non-admin decision insert must be refused').not.toBeNull()
    expect(data).toBeNull()
  }, 60_000)

  it('reproduces the whole review from a fresh read — refresh persistence', async () => {
    // A brand-new client and session: nothing is carried over in memory.
    const fresh = await signIn(adminEmail, adminPassword)
    const client = clientForToken(fresh.token)

    const [doc, fields, findings, sources, suggestions, decisions, audit] = await Promise.all([
      client.from('coa_documents').select('id, parser_version, page_count, report_number').eq('id', coaDocumentId).single(),
      client.from('coa_extracted_fields').select('field_key, page_number, extraction_status').eq('coa_document_id', coaDocumentId),
      client.from('coa_findings').select('code').eq('coa_document_id', coaDocumentId),
      client.from('coa_source_versions').select('id, retrieval_status, content_fingerprint').eq('id', sourceVersionId).single(),
      client.from('coa_suggestions').select('state, source_version_id').eq('coa_document_id', coaDocumentId),
      client.from('coa_decisions').select('decision, previous_state, resulting_state, decided_by').eq('coa_document_id', coaDocumentId),
      client.from('compliance_audit_log').select('action, evidence_version, source_version_id').eq('entity_type', 'coa').eq('entity_id', coaDocumentId),
    ])

    expect(doc.data?.page_count).toBe(3)
    expect(doc.data?.report_number).toBeTruthy()

    // Provenance survived the round trip.
    const extracted = (fields.data ?? []).filter((f) => f.extraction_status === 'extracted')
    expect(extracted.length).toBeGreaterThan(8)
    for (const field of extracted) expect(field.page_number).toBeGreaterThanOrEqual(1)

    expect(sources.data?.retrieval_status).toBe('retrieved')
    expect(sources.data?.content_fingerprint).toMatch(/^[0-9a-f]{64}$/)

    expect((suggestions.data ?? []).some((s) => s.state === 'bound' && s.source_version_id === sourceVersionId)).toBe(true)
    expect((decisions.data ?? []).some((d) => d.resulting_state === 'escalated_to_legal')).toBe(true)

    const actions = (audit.data ?? []).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining([
      'coa_document_extracted', 'coa_source_retrieved', 'coa_suggestion_bound', 'coa_decision_recorded',
    ]))
    // The decision's audit event carries both version identities.
    const decisionEvent = (audit.data ?? []).find((a) => a.action === 'coa_decision_recorded')
    expect(decisionEvent?.evidence_version).toBeTruthy()
    expect(decisionEvent?.source_version_id).toBe(sourceVersionId)

    expect(findings.data).toBeDefined()
  }, 120_000)
})
