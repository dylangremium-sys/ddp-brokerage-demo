import { describe, it, expect } from 'vitest'
import {
  adminFilterKey,
  farmerFilterKey,
  getEvidenceRequest,
  listAdminEvidenceRequests,
  listEvidenceRequestHistory,
  listFarmerEvidenceRequests,
  mapEvidenceError,
} from './evidenceRequests'

/**
 * Service-result contract (v1.5 §9.3 error codes, §9.6 empty versus
 * unavailable).
 *
 * The single most consequential rule in §9 is that a FAILED read is never an
 * empty list (§17.14) — an empty list tells an administrator or farmer that
 * there is nothing to do, which is a false all-clear when the truth is simply
 * unknown. These tests run with no Supabase configured, which is exactly the
 * "no authoritative source" case, and assert the service reports unavailability
 * instead of fabricating emptiness.
 */

describe('every read reports unavailable, never empty, with no backend (§9.6)', () => {
  it('listAdminEvidenceRequests fails rather than returning []', async () => {
    const result = await listAdminEvidenceRequests({ scope: 'active' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe('DATA_UNAVAILABLE')
  })

  it('listFarmerEvidenceRequests fails rather than returning []', async () => {
    const result = await listFarmerEvidenceRequests({ scope: 'needs_response' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe('DATA_UNAVAILABLE')
  })

  it('getEvidenceRequest fails rather than returning an empty detail', async () => {
    const result = await getEvidenceRequest('req-1')
    expect(result.ok).toBe(false)
  })

  it('listEvidenceRequestHistory fails rather than returning []', async () => {
    const result = await listEvidenceRequestHistory('req-1')
    expect(result.ok).toBe(false)
  })

  it('marks an unavailable read as retryable so the UI can offer retry', async () => {
    const result = await listAdminEvidenceRequests({})
    expect(result.ok === false && result.error.retryable).toBe(true)
  })

  it('never resolves to a shape where `data` exists alongside a failure', async () => {
    const result = await listAdminEvidenceRequests({})
    expect('data' in result).toBe(false)
  })
})

describe('canonical error mapping (§9.3)', () => {
  it.each([
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'INVALID_TRANSITION',
    'CONFLICT',
    'TARGET_UNAVAILABLE',
    'UPLOAD_NOT_READY',
    'FILE_TYPE_NOT_ALLOWED',
    'FILE_TOO_LARGE',
  ])('maps the RPC exception message %s to its own code', code => {
    expect(mapEvidenceError({ message: code }).code).toBe(code)
  })

  it('maps a PostgREST-prefixed message form', () => {
    expect(mapEvidenceError({ message: 'CONFLICT: request revision changed' }).code).toBe('CONFLICT')
  })

  it('does NOT mistake a prose message that merely contains a code word', () => {
    // A trigger message like "...cannot be deleted" must not be read as a
    // canonical token just because a code substring appears somewhere in it.
    const mapped = mapEvidenceError({
      message: 'evidence attachment x: a submitted attachment cannot be deleted',
      code: '23514',
    })
    expect(mapped.code).toBe('VALIDATION_ERROR')
  })

  it('maps SQLSTATE insufficient_privilege to FORBIDDEN', () => {
    expect(mapEvidenceError({ message: 'permission denied', code: '42501' }).code).toBe('FORBIDDEN')
  })

  it('maps SQLSTATE serialization_failure to CONFLICT', () => {
    expect(mapEvidenceError({ message: 'could not serialize', code: '40001' }).code).toBe('CONFLICT')
  })

  it('maps a missing table to DATA_UNAVAILABLE — migration 24 is not applied here', () => {
    const mapped = mapEvidenceError({ message: 'relation does not exist', code: '42P01' })
    expect(mapped.code).toBe('DATA_UNAVAILABLE')
    expect(mapped.retryable).toBe(true)
  })

  it('maps PostgREST no-rows to NOT_FOUND', () => {
    expect(mapEvidenceError({ message: 'no rows', code: 'PGRST116' }).code).toBe('NOT_FOUND')
  })

  it('falls back to UNKNOWN rather than guessing', () => {
    expect(mapEvidenceError({ message: 'something odd', code: 'XX999' }).code).toBe('UNKNOWN')
    expect(mapEvidenceError(null).code).toBe('UNKNOWN')
    expect(mapEvidenceError(undefined).code).toBe('UNKNOWN')
  })

  it('marks only genuinely retryable codes as retryable', () => {
    expect(mapEvidenceError({ message: 'CONFLICT' }).retryable).toBe(true)
    expect(mapEvidenceError({ message: 'STORAGE_ERROR' }).retryable).toBe(true)
    // A refusal is not retryable — retrying an identical FORBIDDEN or an
    // invalid transition can only fail the same way.
    expect(mapEvidenceError({ message: 'FORBIDDEN' }).retryable).toBe(false)
    expect(mapEvidenceError({ message: 'INVALID_TRANSITION' }).retryable).toBe(false)
    expect(mapEvidenceError({ message: 'FILE_TOO_LARGE' }).retryable).toBe(false)
  })

  it('always carries a human-readable message', () => {
    expect(mapEvidenceError({ message: 'CONFLICT' }).message.length).toBeGreaterThan(0)
    expect(mapEvidenceError({}).message.length).toBeGreaterThan(0)
  })
})

describe('filter keys are stable scope identities (§9.7)', () => {
  it('produces the same key for equivalent admin filters', () => {
    expect(adminFilterKey({ scope: 'active' })).toBe(adminFilterKey({ scope: 'active' }))
  })

  it('distinguishes admin scopes', () => {
    expect(adminFilterKey({ scope: 'active' })).not.toBe(adminFilterKey({ scope: 'closed' }))
  })

  it('distinguishes each admin filter dimension', () => {
    const base = { scope: 'active' } as const
    const keys = new Set([
      adminFilterKey(base),
      adminFilterKey({ ...base, priority: 'urgent' }),
      adminFilterKey({ ...base, category: 'coa' }),
      adminFilterKey({ ...base, targetType: 'inventory_batch' }),
    ])
    expect(keys.size).toBe(4)
  })

  it('defaults an unspecified admin scope to active, matching the query', () => {
    expect(adminFilterKey({})).toBe(adminFilterKey({ scope: 'active' }))
  })

  it('distinguishes the three farmer tabs', () => {
    const keys = new Set([
      farmerFilterKey({ scope: 'needs_response' }),
      farmerFilterKey({ scope: 'submitted' }),
      farmerFilterKey({ scope: 'closed' }),
    ])
    expect(keys.size).toBe(3)
  })
})
