import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Behavioural coverage for the public supplier-intake CLIENT.
 *
 * WHY THIS FILE EXISTS. This module had no unit test at all, and that is how the
 * 2026-07-29 outage shipped: #85 repointed submitAccessRequest() at
 * /api/public/access-request, whose handler calls two RPCs that only migration 36
 * creates. Migration 36 was applied nowhere, so every real submission 503'd and
 * the public form was down. 2287 tests stayed green throughout, because none of
 * them asserted anything about which path this client takes.
 *
 * So these tests assert the TRANSPORT, not just the outcome. A test that only
 * checked "no throw on success" would have passed before and after #85 and would
 * pass again after the next repoint — it would be exactly the kind of test the
 * brief warns about, one that passes whether or not the code works.
 *
 * The Supabase client is mocked so the exact insert payload is observable.
 */

const h = vi.hoisted(() => ({
  table: null as string | null,
  inserted: [] as Record<string, unknown>[],
  result: { error: null as { code?: string; message?: string } | null },
  configured: true,
}))

vi.mock('./supabase', () => ({
  get isSupabaseConfigured() { return h.configured },
  get supabase() {
    return h.configured
      ? {
          from: (t: string) => {
            h.table = t
            return {
              insert: (row: Record<string, unknown>) => {
                h.inserted.push(row)
                return Promise.resolve(h.result)
              },
            }
          },
        }
      : null
  },
}))

import { submitAccessRequest, AccessRequestError } from './accessRequestClient'

const VALID = {
  fullName: '  Somchai Prasert  ',
  email: '  somchai@example.com ',
  phone: ' 0812345678 ',
  province: 'Chiang Mai',
  position: 'Owner',
  preferredLanguage: 'th' as const,
  note: '  200 rai of longan  ',
}

beforeEach(() => {
  h.table = null
  h.inserted = []
  h.result = { error: null }
  h.configured = true
  vi.restoreAllMocks()
})

describe('submitAccessRequest — temporary direct-insert path (incident revert)', () => {
  it('inserts into farmer_access_requests and does NOT call the server endpoint', async () => {
    // The transport assertion. This is the one that goes red if the client is
    // repointed at /api/public/access-request while migration 36 is unapplied —
    // i.e. the exact regression that caused the outage.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(submitAccessRequest(VALID)).resolves.toBeUndefined()

    expect(h.table).toBe('farmer_access_requests')
    expect(h.inserted).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('trims the payload and pins status to new with no reviewer', async () => {
    await submitAccessRequest(VALID)

    expect(h.inserted[0]).toEqual({
      full_name: 'Somchai Prasert',
      email: 'somchai@example.com',
      phone: '0812345678',
      province: 'Chiang Mai',
      position: 'Owner',
      preferred_language: 'th',
      note: '200 rai of longan',
      status: 'new',
    })
    // A reviewer must never be settable by the submitter.
    expect(h.inserted[0]).not.toHaveProperty('reviewed_by')
    expect(h.inserted[0]).not.toHaveProperty('reviewed_at')
  })

  it('reports an unconfigured backend without attempting a write', async () => {
    h.configured = false

    await expect(submitAccessRequest(VALID)).rejects.toMatchObject({ code: 'not_configured' })
    expect(h.inserted).toHaveLength(0)
  })

  it('rejects invalid input before any write', async () => {
    await expect(submitAccessRequest({ ...VALID, email: 'not-an-email' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(h.inserted).toHaveLength(0)
  })

  it('maps PGRST205 (migration 34 absent) to backend_unavailable', async () => {
    h.result = { error: { code: 'PGRST205', message: 'table not in schema cache' } }

    await expect(submitAccessRequest(VALID)).rejects.toMatchObject({ code: 'backend_unavailable' })
  })

  it('maps 42501 (migration 36 revoked the anon INSERT) to backend_unavailable', async () => {
    // Applying migration 36 while this revert is live is the foreseeable next
    // failure. It must degrade to "contact us directly", not to a "try again"
    // the visitor can never satisfy.
    h.result = { error: { code: '42501', message: 'permission denied for table farmer_access_requests' } }

    await expect(submitAccessRequest(VALID)).rejects.toMatchObject({ code: 'backend_unavailable' })
  })

  it('never leaks the driver message to the UI', async () => {
    h.result = { error: { code: '23514', message: 'violates check constraint "farmer_access_requests_phone_check"' } }

    const err = await submitAccessRequest(VALID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccessRequestError)
    expect((err as AccessRequestError).code).toBe('submit_failed')
    expect((err as AccessRequestError).message).not.toContain('constraint')
  })
})
