// ─── RED TEAM: adversarial probes against the COA review build ──────────────
//
// These tests try to BREAK the controls introduced for gate #77. Each one
// documents its intent and asserts the CURRENT behaviour, so a probe that
// currently succeeds (i.e. an attack that works) is recorded as a failing
// control rather than quietly forgotten.
//
// Where an attack succeeds, the assertion encodes the gap and the test name
// says so, so the suite stays green and honest until the gap is closed — at
// which point the test must be inverted.
//
// Skipped unless DDP_STAGING_E2E=1. Writes only to staging.
//
//   set -a && . ./.env.staging && set +a
//   DDP_STAGING_E2E=1 npm test -- coaRedTeam

import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { validateRetrievalTarget, retrieveOfficialSource } from './serverSourceRetrieval'
import { assertNoConclusion } from './coaSuggestionBinding'
import { MAX_BASE64_CHARS } from './serverCoaReview'

const enabled = process.env.DDP_STAGING_E2E === '1'
const supabaseUrl = process.env.STAGING_SUPABASE_URL ?? ''
const anonKey = process.env.STAGING_SUPABASE_ANON_KEY ?? ''
const adminEmail = process.env.STAGING_ADMIN_EMAIL ?? ''
const adminPassword = process.env.STAGING_ADMIN_PASSWORD ?? ''
const pendingEmail = process.env.STAGING_PENDING_EMAIL ?? ''
const pendingPassword = process.env.STAGING_PENDING_PASSWORD ?? ''

const ready = enabled && !!(supabaseUrl && anonKey && adminEmail && adminPassword)

function clientForToken(token: string): SupabaseClient {
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function signIn(email: string, password: string) {
  const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`)
  return { token: data.session.access_token, userId: data.session.user.id }
}

// ─── Attacks that need no database ──────────────────────────────────────────

describe('RED: SSRF guard — encoding and resolution', () => {
  const policy = { allowedHosts: ['www.fda.moph.go.th'] }

  it('blocks obfuscated loopback encodings because they are not allowlisted', () => {
    // Deny-by-default is doing the work here, NOT the SSRF classifier.
    for (const url of ['https://2130706433/', 'https://0x7f000001/', 'https://017700000001/', 'https://127.1/']) {
      expect(validateRetrievalTarget(url, policy)).toMatchObject({ ok: false })
    }
  })

  it('BLUE: obfuscated loopback encodings are normalised before classification', () => {
    // A red-team hypothesis that turned out to be WRONG, kept as a regression
    // guard. The classifier only understands dotted-quad IPv4, so decimal, hex,
    // octal, short-form and Unicode-digit encodings looked like a bypass — but
    // validateConnectorUrlSafety reads parsed.hostname, and the WHATWG URL
    // parser has already normalised every one of these to 127.0.0.1. The guard
    // therefore holds even with the allowlist deliberately opened up.
    for (const host of ['2130706433', '0x7f000001', '017700000001', '127.1']) {
      expect(new URL(`https://${host}/`).hostname).toBe('127.0.0.1')
      expect(validateRetrievalTarget(`https://${host}/`, { allowedHosts: [host, '127.0.0.1'] }))
        .toMatchObject({ ok: false, status: 'rejected_private_network' })
    }
  })

  it('GAP: validation is name-based — a hostname resolving to a private IP is not detected', () => {
    // The guard never resolves DNS, so an allowlisted name that resolves to an
    // internal address would pass. Mitigated in practice only by the
    // single-entry allowlist pointing at a government domain.
    const permissive = { allowedHosts: ['localtest.me'] } // public name -> 127.0.0.1
    expect(validateRetrievalTarget('https://localtest.me/', permissive)).toEqual({ ok: true })
  })

  it('holds the line on scheme, port and redirect hops', async () => {
    expect(validateRetrievalTarget('http://www.fda.moph.go.th/', policy)).toMatchObject({ status: 'rejected_not_https' })
    expect(validateRetrievalTarget('https://www.fda.moph.go.th:8443/', policy)).toMatchObject({ status: 'rejected_disallowed_port' })

    // A redirect off the allowlist is refused mid-chain.
    const hop = await retrieveOfficialSource({
      url: 'https://www.fda.moph.go.th/', policy, retrievedAt: '2026-07-27T00:00:00Z',
      fetchImpl: async () => ({
        status: 302,
        headers: { get: (n: string) => (n.toLowerCase() === 'location' ? 'https://169.254.169.254/' : null) },
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    })
    expect(hop.status).toBe('rejected_redirect')
  })
})

describe('RED: conclusion denylist strength', () => {
  it('GAP: assertNoConclusion is a denylist and is trivially evadable', () => {
    // It guards only the deterministic text this system composes, so it is
    // defence-in-depth. It would NOT hold against free-text input.
    expect(assertNoConclusion('This batch conforms to every applicable requirement.')).toBeNull()
    expect(assertNoConclusion('Fit for release to the buyer.')).toBeNull()
    expect(assertNoConclusion('No regulatory obstacle exists.')).toBeNull()
    // The phrasings it does catch:
    expect(assertNoConclusion('This batch is compliant.')).toBeTruthy()
  })
})

describe('RED: upload size ceiling vs platform limit', () => {
  it('BLUE (was LOW): the upload ceiling now sits under the platform body limit', () => {
    // RED found the ceiling set at 34 MB while Vercel caps a serverless request
    // body at ~4.5 MB — so oversize uploads died with an opaque platform error
    // instead of the handler's own message. The ceiling is now below the cap.
    const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024
    expect(MAX_BASE64_CHARS).toBeLessThan(VERCEL_BODY_LIMIT)
    // A real TNR COA (~1.8 MB -> ~2.4 MB base64) still has ample headroom.
    expect(1.8 * 1024 * 1024 * 1.34).toBeLessThan(MAX_BASE64_CHARS)
  })
})

// ─── Attacks against the live database ──────────────────────────────────────

describe.skipIf(!ready)('RED: database controls under attack', () => {
  let admin: { token: string; userId: string }
  let client: SupabaseClient
  let docId = ''
  let goodSourceId = ''
  let suggestionId = ''

  beforeAll(async () => {
    admin = await signIn(adminEmail, adminPassword)
    client = clientForToken(admin.token)

    // Upsert so the probe is re-runnable: the document fingerprint is unique
    // by design, and a previous run will already have created this row.
    const { data: doc, error: docError } = await client.from('coa_documents').upsert({
      document_fingerprint: 'ed'.repeat(32),
      byte_length: 100, page_count: 3,
      parser_version: 'tnr-coa-adapter/1.0.0', extraction_status: 'ok',
      report_number: 'RP-REDTEAM-0001', sample_name: 'Red Team Probe',
    }, { onConflict: 'document_fingerprint' }).select('id').single()
    if (docError || !doc) throw new Error(`red-team fixture failed: ${docError?.message}`)
    docId = (doc as { id: string }).id

    const { data: source } = await client.from('coa_source_versions').insert({
      source_key: 'th-fda', authority: 'Thai FDA', jurisdiction: 'Thailand',
      requested_url: 'https://www.fda.moph.go.th/', retrieval_status: 'retrieved',
      content_fingerprint: 'c'.repeat(64), relevant_section: 'red team fixture',
    }).select('id').single()
    goodSourceId = (source as { id: string }).id

    const { data: suggestion } = await client.from('coa_suggestions').insert({
      coa_document_id: docId, source_version_id: goodSourceId,
      state: 'bound', suggestion_text: 'Red team bound suggestion.',
    }).select('id').single()
    suggestionId = (suggestion as { id: string }).id
  }, 90_000)

  it('BLUE: refuses to bind a suggestion to an unverified source', async () => {
    const { data: bad } = await client.from('coa_source_versions').insert({
      source_key: 'th-fda', authority: 'Thai FDA', jurisdiction: 'Thailand',
      requested_url: 'https://www.fda.moph.go.th/', retrieval_status: 'timeout',
    }).select('id').single()

    const { error } = await client.from('coa_suggestions').insert({
      coa_document_id: docId, source_version_id: (bad as { id: string }).id,
      state: 'bound', suggestion_text: 'Should be refused.',
    })
    expect(error?.message ?? '').toMatch(/not successfully retrieved/i)
  }, 60_000)

  it('BLUE: refuses to promote a quarantined suggestion to bound via UPDATE', async () => {
    const { data: bad } = await client.from('coa_source_versions').insert({
      source_key: 'th-fda', authority: 'Thai FDA', jurisdiction: 'Thailand',
      requested_url: 'https://www.fda.moph.go.th/', retrieval_status: 'http_error',
    }).select('id').single()

    const { data: quarantined } = await client.from('coa_suggestions').insert({
      coa_document_id: docId, source_version_id: (bad as { id: string }).id,
      state: 'quarantined', suggestion_text: 'Quarantined.', reason: 'source failed',
    }).select('id').single()

    const { error } = await client.from('coa_suggestions')
      .update({ state: 'bound' })
      .eq('id', (quarantined as { id: string }).id)

    expect(error, 'UPDATE to bound must fire the same trigger').not.toBeNull()
  }, 60_000)

  it('BLUE (was HIGH): a source version cited by a bound suggestion is immutable', async () => {
    // RED found that the migration-31 binding trigger fired on coa_suggestions
    // only, so a cited source could be downgraded to 'timeout' underneath an
    // already-bound suggestion. Migration 32 makes a cited version immutable.
    const { error } = await client.from('coa_source_versions')
      .update({ retrieval_status: 'timeout' })
      .eq('id', goodSourceId)

    expect(error, 'downgrading a cited source must now be refused').not.toBeNull()
    expect(error?.message ?? '').toMatch(/immutable/i)

    const { data: source } = await client.from('coa_source_versions')
      .select('retrieval_status, content_fingerprint').eq('id', goodSourceId).single()
    expect((source as { retrieval_status: string }).retrieval_status).toBe('retrieved')
    expect((source as { content_fingerprint: string }).content_fingerprint).toBeTruthy()

    const { data: suggestion } = await client.from('coa_suggestions')
      .select('state').eq('id', suggestionId).single()
    expect((suggestion as { state: string }).state).toBe('bound')
  }, 60_000)

  it('BLUE (was HIGH): stored provenance cannot be overwritten by an admin token', async () => {
    // RED overwrote a server-extracted total_thc with the literal 'FABRICATED'
    // via the FOR ALL admin policy. Migration 32 makes coa_extracted_fields
    // append-only (SELECT + INSERT only, plus a loud trigger).
    const { data: before } = await client.from('coa_extracted_fields')
      .select('normalized_value').eq('coa_document_id', docId).eq('field_key', 'total_thc').maybeSingle()

    await client.from('coa_extracted_fields')
      .update({ normalized_value: 'FABRICATED-AGAIN' })
      .eq('coa_document_id', docId).eq('field_key', 'total_thc')

    const { data: after } = await client.from('coa_extracted_fields')
      .select('normalized_value').eq('coa_document_id', docId).eq('field_key', 'total_thc').maybeSingle()

    // RLS exposes no UPDATE path, so the statement matches zero rows.
    expect(after?.normalized_value).toBe(before?.normalized_value)
    expect(after?.normalized_value).not.toBe('FABRICATED-AGAIN')

    // Deleting provenance is refused the same way.
    await client.from('coa_extracted_fields').delete().eq('coa_document_id', docId)
    const { data: survivors } = await client.from('coa_extracted_fields')
      .select('field_key').eq('coa_document_id', docId)
    expect((survivors ?? []).length).toBeGreaterThan(0)
  }, 60_000)

  it('BLUE: a decision cannot be altered or deleted once recorded', async () => {
    const { data: decision } = await client.from('coa_decisions').insert({
      coa_document_id: docId, source_version_id: goodSourceId,
      decision: 'on_hold', previous_state: 'pending_review', resulting_state: 'on_hold',
      note: 'red team', evidence_version: 'tnr-coa-adapter/1.0.0@redteam',
      decided_by: admin.userId,
    }).select('id').single()

    const decisionId = (decision as { id: string }).id

    await client.from('coa_decisions').update({ note: 'tampered' }).eq('id', decisionId)
    await client.from('coa_decisions').delete().eq('id', decisionId)

    // The record is untouched — which is the property that matters.
    const { data: after } = await client.from('coa_decisions')
      .select('id, note').eq('id', decisionId).single()
    expect(after, 'the decision must still exist').not.toBeNull()
    expect((after as { note: string }).note).toBe('red team')

    // NOTE (red-team finding, low severity): the refusal is SILENT. There is no
    // UPDATE/DELETE policy on coa_decisions, so RLS matches zero rows and both
    // statements succeed against nothing. The append-only trigger — which does
    // raise loudly, as VERIFY J proves for an owner connection — is never
    // reached through PostgREST. Data integrity holds via two independent
    // layers, but an API-level tamper attempt leaves no error and no signal.
  }, 60_000)

  it('BLUE: an admin cannot record a decision in another user\'s name', async () => {
    const { error } = await client.from('coa_decisions').insert({
      coa_document_id: docId, decision: 'rejected',
      previous_state: 'pending_review', resulting_state: 'rejected',
      note: 'impersonation attempt', evidence_version: 'x',
      decided_by: '00000000-0000-0000-0000-000000000000',
    })
    expect(error, 'decided_by must be pinned to auth.uid()').not.toBeNull()
  }, 60_000)

  it('BLUE: a pending-role account can neither read nor decide', async () => {
    if (!pendingEmail || !pendingPassword) {
      throw new Error('STAGING_PENDING_EMAIL/PASSWORD required for this probe')
    }
    const pending = await signIn(pendingEmail, pendingPassword)
    const pendingClient = clientForToken(pending.token)

    const { data: docs } = await pendingClient.from('coa_documents').select('id')
    expect(docs ?? []).toEqual([])

    const { data: sources } = await pendingClient.from('coa_source_versions').select('id')
    expect(sources ?? []).toEqual([])

    const { error } = await pendingClient.from('coa_decisions').insert({
      coa_document_id: docId, decision: 'rejected',
      previous_state: 'pending_review', resulting_state: 'rejected',
      note: 'unauthorized', evidence_version: 'x', decided_by: pending.userId,
    })
    expect(error).not.toBeNull()
  }, 60_000)

  it('BLUE: the audit log rejects an invented action and cannot be rewritten', async () => {
    const { error: badAction } = await client.from('compliance_audit_log').insert({
      actor_type: 'admin', actor_id: admin.userId, action: 'coa_quietly_approved',
      entity_type: 'coa', entity_id: docId,
    })
    expect(badAction).not.toBeNull()

    const { error: tamper } = await client.from('compliance_audit_log')
      .update({ reason: 'rewritten' }).eq('entity_id', docId)
    expect(tamper, 'the audit log must be append-only').not.toBeNull()
  }, 60_000)
})
