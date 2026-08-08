import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resolveNavigationTarget } from './navigationGuard'
import type { Page } from '../types'

// The review screen is where a named administrator turns an uploaded file into
// a recorded decision a buyer may eventually rely on. These tests pin the three
// properties that make that decision trustworthy: it is admin-only, it never
// sends the reviewer identity, and an unreadable register is never rendered as
// an empty one.

const selectSpy = vi.fn()
const updateSpy = vi.fn<(table: string, patch: Record<string, unknown>) => void>()

vi.mock('./supabase', () => {
  const builder = (table: string) => ({
    select: () => {
      selectSpy(table)
      return {
        order: () => Promise.resolve({ data: [], error: null }),
      }
    },
    update: (patch: Record<string, unknown>) => {
      updateSpy(table, patch)
      return { eq: () => Promise.resolve({ error: null }) }
    },
  })
  return { supabase: { from: builder }, isSupabaseConfigured: true }
})

const { setDocumentReviewStatus, loadFarmerDocuments } = await import('./db')

const DOC = 'c0f19f0e-a69a-4c3e-b3fe-0eed9af80eaa'

beforeEach(() => { updateSpy.mockClear(); selectSpy.mockClear() })

describe('setDocumentReviewStatus — the client never chooses the reviewer', () => {
  it('sends ONLY review_status', async () => {
    // reviewed_by and reviewed_at are written by migration 64's BEFORE UPDATE
    // trigger from auth.uid(). Sending them from here would be dead weight that
    // reads as though the client picks who decided — and the whole point of the
    // trigger is that it cannot.
    await setDocumentReviewStatus(DOC, 'accepted')
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [table, patch] = updateSpy.mock.calls[0]
    expect(table).toBe('farmer_documents')
    expect(patch).toEqual({ review_status: 'accepted' })
    expect(patch).not.toHaveProperty('reviewed_by')
    expect(patch).not.toHaveProperty('reviewed_at')
  })

  it('carries each of the three legal statuses through unchanged', async () => {
    for (const status of ['accepted', 'rejected', 'pending'] as const) {
      updateSpy.mockClear()
      await setDocumentReviewStatus(DOC, status)
      expect(updateSpy.mock.calls[0][1]).toEqual({ review_status: status })
    }
  })

  it('refuses an id that is not a UUID before touching the database', async () => {
    await expect(setDocumentReviewStatus('not-a-uuid', 'accepted')).rejects.toThrow(/UUID/)
    expect(updateSpy).not.toHaveBeenCalled()
  })
})

describe('loadFarmerDocuments — an unreadable register is not an empty one', () => {
  it('reads the register table', async () => {
    await loadFarmerDocuments()
    expect(selectSpy).toHaveBeenCalledWith('farmer_documents')
  })

  it('throws on a read failure rather than returning []', async () => {
    // This is the difference between "nothing is waiting for review" and "we
    // could not find out". loadBatchPhotosFromDB degrades quietly on purpose —
    // a missing thumbnail is cosmetic. A silently empty review queue tells an
    // operator there is no work when there may be plenty.
    vi.resetModules()
    vi.doMock('./supabase', () => ({
      supabase: {
        from: () => ({
          select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }) }),
        }),
      },
      isSupabaseConfigured: true,
    }))
    const { loadFarmerDocuments: failing } = await import('./db')
    await expect(failing()).rejects.toThrow(/permission denied/)
    vi.doUnmock('./supabase')
    vi.resetModules()
  })
})

describe('the evidence screen is admin-only', () => {
  const AS_BUYER = { isDemo: false, isSignedIn: true, isAdminRole: false, isBuyerRole: true }

  it('sends a buyer away from the evidence review page', () => {
    // A buyer reaching this screen would see every farm's documents — the
    // double-blind failure the product cannot survive, in its most direct form.
    expect(resolveNavigationTarget('ddp-document-review' as Page, AS_BUYER)).toBe('buyer-dashboard')
  })
})
