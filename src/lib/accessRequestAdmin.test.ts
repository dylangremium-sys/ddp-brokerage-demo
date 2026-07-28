import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  ACCESS_REQUEST_STATUSES,
  ACCESS_REQUEST_STATUS_LABELS,
  TRIAGE_ACTIONS,
  mapAccessRequestRow,
} from './accessRequestAdmin'

// ─── The admin triage path (audit R5, second-order) ─────────────────────────
//
// Migration 34 shipped an `admin triage` UPDATE policy and a status CHECK
// allowing 'declined'/'duplicate', but nothing in the application ever read the
// queue or drove that policy — so spam could not be dispositioned in-app at all,
// and migration 34's deliberate absence of a DELETE policy left only direct SQL,
// which the production change freeze forbids.

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

interface SbError { code?: string; message?: string }

/** Mock client whose select/update return the supplied result. */
function mockSupabase(result: { data?: unknown; error?: SbError | null }) {
  const calls: { updates: Array<Record<string, unknown>> } = { updates: [] }
  const client = {
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
      }),
      update: (data: Record<string, unknown>) => {
        calls.updates.push(data)
        return { eq: () => Promise.resolve({ error: result.error ?? null }) }
      },
    }),
  }
  vi.doMock('./supabase', () => ({ supabase: client, isSupabaseConfigured: true }))
  return calls
}

describe('the disposition vocabulary matches the database', () => {
  it('every status the UI can render is one the CHECK allows', () => {
    // migration 34: CHECK (status IN ('new','contacted','invited','declined','duplicate'))
    expect([...ACCESS_REQUEST_STATUSES]).toEqual(['new', 'contacted', 'invited', 'declined', 'duplicate'])
  })

  it('every status has a label, so no raw enum reaches the screen', () => {
    for (const s of ACCESS_REQUEST_STATUSES) {
      expect(ACCESS_REQUEST_STATUS_LABELS[s], `no label for ${s}`).toBeTruthy()
    }
  })

  it('triage offers the two spam dispositions the finding requires', () => {
    expect(TRIAGE_ACTIONS).toContain('declined')
    expect(TRIAGE_ACTIONS).toContain('duplicate')
  })

  it('triage never offers "new" — an enquiry cannot be un-reviewed', () => {
    expect(TRIAGE_ACTIONS).not.toContain('new')
  })

  it('every triage action is a valid database status', () => {
    for (const s of TRIAGE_ACTIONS) {
      expect(ACCESS_REQUEST_STATUSES as readonly string[]).toContain(s)
    }
  })
})

describe('row mapping is defensive', () => {
  it('maps a full row', () => {
    const row = mapAccessRequestRow({
      id: 'abc', full_name: 'Somchai', email: 'a@b.com', phone: '+66',
      province: 'Buriram', position: 'Owner', preferred_language: 'th',
      note: 'hello', status: 'new', review_note: '', reviewed_at: null,
      created_at: '2026-07-28T00:00:00Z',
    })
    expect(row).toMatchObject({ id: 'abc', fullName: 'Somchai', status: 'new' })
  })

  it('drops a row with no id rather than rendering a broken entry', () => {
    expect(mapAccessRequestRow({ full_name: 'x' })).toBeNull()
    expect(mapAccessRequestRow(null)).toBeNull()
    expect(mapAccessRequestRow('nonsense')).toBeNull()
  })

  it('falls back to a known status rather than trusting an unexpected one', () => {
    expect(mapAccessRequestRow({ id: 'a', status: 'something-else' })?.status).toBe('new')
  })
})

describe('loading the queue', () => {
  it('returns mapped rows', async () => {
    mockSupabase({ data: [{ id: '1', full_name: 'A', status: 'new' }, { id: '2', status: 'declined' }] })
    const { loadAccessRequests } = await import('./accessRequestAdmin')
    const rows = await loadAccessRequests()
    expect(rows.map(r => r.id)).toEqual(['1', '2'])
  })

  it('reports a missing table distinctly from a genuine failure', async () => {
    // The environment has not had migration 34 applied. Telling the operator to
    // retry would be a lie.
    mockSupabase({ error: { code: 'PGRST205', message: 'Could not find the table' } })
    const { loadAccessRequests, AccessRequestAdminError } = await import('./accessRequestAdmin')
    await expect(loadAccessRequests()).rejects.toThrow(AccessRequestAdminError)
    await expect(loadAccessRequests()).rejects.toMatchObject({ code: 'backend_unavailable' })
  })

  it('reports a real failure as load_failed, not as an empty queue', async () => {
    // Presenting an errored read as "no enquiries" would hide the entire queue.
    mockSupabase({ error: { code: '08006', message: 'connection failure' } })
    const { loadAccessRequests } = await import('./accessRequestAdmin')
    await expect(loadAccessRequests()).rejects.toMatchObject({ code: 'load_failed' })
  })

  it('throws when Supabase is not configured', async () => {
    vi.doMock('./supabase', () => ({ supabase: null, isSupabaseConfigured: false }))
    const { loadAccessRequests } = await import('./accessRequestAdmin')
    await expect(loadAccessRequests()).rejects.toMatchObject({ code: 'not_configured' })
  })
})

describe('dispositioning an enquiry', () => {
  it('sends only status and review_note', async () => {
    // reviewed_by/reviewed_at are set by migration 34's trigger from auth.uid().
    // Sending them from the client would be a false-attribution vector.
    const calls = mockSupabase({ error: null })
    const { setAccessRequestStatus } = await import('./accessRequestAdmin')
    await setAccessRequestStatus('req-1', 'declined', 'spam')

    expect(calls.updates).toHaveLength(1)
    expect(Object.keys(calls.updates[0]).sort()).toEqual(['review_note', 'status'])
    expect(calls.updates[0]).toEqual({ status: 'declined', review_note: 'spam' })
  })

  it('refuses a status the database CHECK would reject, without a round trip', async () => {
    const calls = mockSupabase({ error: null })
    const { setAccessRequestStatus } = await import('./accessRequestAdmin')
    await expect(
      // @ts-expect-error deliberately invalid, as a caller bug would be
      setAccessRequestStatus('req-1', 'approved'),
    ).rejects.toMatchObject({ code: 'update_failed' })
    expect(calls.updates).toHaveLength(0)
  })

  it('refuses an over-long review note before the database does', async () => {
    const calls = mockSupabase({ error: null })
    const { setAccessRequestStatus } = await import('./accessRequestAdmin')
    await expect(setAccessRequestStatus('req-1', 'declined', 'x'.repeat(2001)))
      .rejects.toMatchObject({ code: 'update_failed' })
    expect(calls.updates).toHaveLength(0)
  })

  it('maps an RLS denial to forbidden rather than a generic failure', async () => {
    mockSupabase({ error: { code: '42501', message: 'permission denied' } })
    const { setAccessRequestStatus } = await import('./accessRequestAdmin')
    await expect(setAccessRequestStatus('req-1', 'declined')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('surfaces a failed update instead of swallowing it', async () => {
    mockSupabase({ error: { code: '08006', message: 'connection failure' } })
    const { setAccessRequestStatus } = await import('./accessRequestAdmin')
    await expect(setAccessRequestStatus('req-1', 'declined')).rejects.toMatchObject({ code: 'update_failed' })
  })
})

describe('the module offers no hard delete', () => {
  it('exports no delete function', async () => {
    // Migration 34: "Deliberately NO delete policy" — an enquiry is a record of
    // who asked for access. Spam is dispositioned, not erased.
    const mod = await import('./accessRequestAdmin')
    const names = Object.keys(mod).join(' ').toLowerCase()
    expect(names).not.toMatch(/delete|remove|purge|destroy/)
  })
})
