import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { FarmProfile } from '../types'

// ─── The write ORDER inside createFarmProfile is load-bearing ────────────────
//
// farm_profiles is written with an upsert (`ON CONFLICT`). Under row level
// security PostgreSQL evaluates the UPDATE policy for a statement carrying an
// ON CONFLICT clause, and `farm_profiles: farmer update own` requires a row in
// farm_memberships. So the membership must already exist when the profile is
// written.
//
// Before this fix the order was farms -> farm_profiles -> farm_memberships. The
// profile upsert therefore failed with 42501 every time, createFarmProfile threw,
// and the membership write was never reached — so the next attempt failed the
// same way, forever. Measured against production on 2026-08-02: a real farmer's
// upsert was refused, and the identical upsert succeeded once a membership row
// existed.
//
// The damage was quiet. The farms row (written first) lands, so the farm shows up
// in the admin queue with its flat fields filled in, while every JSONB section
// stays empty and the compliance score reads 0/900 — a farm that looks
// non-compliant rather than unsaved.
//
// This test asserts the ORDER, not the presence, because presence was never the
// problem.

const calls: string[] = []

beforeEach(() => {
  calls.length = 0
  vi.resetModules()

  // A Supabase double that records which table each write hits, in order.
  const client = {
    from(table: string) {
      return {
        upsert: () => {
          calls.push(table)
          return Promise.resolve({ error: null })
        },
      }
    },
  }

  vi.doMock('./supabase', () => ({ supabase: client, isSupabaseConfigured: () => true }))
  vi.doMock('./browserPersistence', () => ({ shouldPersistToBrowser: () => false }))
})

const FARM = {
  id: '11111111-1111-4111-8111-111111111111',
  tradingName: 'Order Test Farm',
  status: 'Submitted to DDP',
} as unknown as FarmProfile

const USER = '22222222-2222-4222-8222-222222222222'

describe('createFarmProfile — membership must be written before the profile', () => {
  it('writes farm_memberships BEFORE farm_profiles', async () => {
    const db = await import('./db')
    await db.createFarmProfile(FARM, USER)

    const membership = calls.indexOf('farm_memberships')
    const profile = calls.indexOf('farm_profiles')

    expect(membership, 'farm_memberships was never written').toBeGreaterThanOrEqual(0)
    expect(profile, 'farm_profiles was never written').toBeGreaterThanOrEqual(0)

    // THE ASSERTION. With this inverted, every first-time farmer profile save is
    // refused by RLS and the farmer cannot recover by retrying.
    expect(
      membership,
      `farm_memberships must precede farm_profiles, got order: ${calls.join(' -> ')}`,
    ).toBeLessThan(profile)
  })

  it('still writes the farms row first', async () => {
    // farms must come first regardless: the farm_profiles INSERT policy checks
    // `EXISTS (SELECT 1 FROM farms WHERE id = farm_id AND created_by = auth.uid())`,
    // so the farm has to exist and be visible before either later write.
    const db = await import('./db')
    await db.createFarmProfile(FARM, USER)
    expect(calls[0]).toBe('farms')
  })

  it('skips the membership when no user id is supplied, and still writes the profile', async () => {
    // The membership write is guarded by `if (userId && isValidUUID(userId))`.
    // Reordering must not turn a missing user id into a skipped profile — that
    // would trade one silent data loss for another.
    const db = await import('./db')
    await db.createFarmProfile(FARM, undefined)
    expect(calls).toContain('farms')
    expect(calls).toContain('farm_profiles')
    expect(calls).not.toContain('farm_memberships')
  })
})
