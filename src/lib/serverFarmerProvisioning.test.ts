import { describe, it, expect } from 'vitest'
import {
  handleProvisionFarmer,
  type ProvisioningDeps,
  type InviteResult,
} from './serverFarmerProvisioning'

// Base deps modelling a working environment. Each test overrides only what it
// needs. Tokens map to callers; caller ids map to roles.
function makeDeps(overrides: Partial<ProvisioningDeps> = {}): ProvisioningDeps {
  return {
    async getCallerFromToken(token) {
      switch (token) {
        case 'admin-token': return { id: 'admin-1' }
        case 'farmer-token': return { id: 'farmer-1' }
        case 'pending-token': return { id: 'pending-1' }
        case 'ghost-token': return { id: 'ghost-1' }
        default: return null
      }
    },
    async getProfileRole(id) {
      switch (id) {
        case 'admin-1': return 'ddp_admin'
        case 'farmer-1': return 'farmer'
        case 'pending-1': return 'pending'
        default: return null
      }
    },
    async inviteFarmer() {
      return { kind: 'invited', userId: 'new-1' } as InviteResult
    },
    async promotePendingToFarmer() {
      return true
    },
    ...overrides,
  }
}

const validBody = { email: 'grower@example.com', display_name: 'Green Valley' }

describe('handleProvisionFarmer — authentication & authorization', () => {
  it('rejects an anonymous request (no token) with 401', async () => {
    const res = await handleProvisionFarmer(makeDeps(), { token: null, body: validBody })
    expect(res.status).toBe(401)
    expect(res.body.ok).toBe(false)
  })

  it('rejects an invalid/expired token with 401', async () => {
    const res = await handleProvisionFarmer(makeDeps(), { token: 'bogus', body: validBody })
    expect(res.status).toBe(401)
  })

  it('rejects a farmer caller with 403', async () => {
    const res = await handleProvisionFarmer(makeDeps(), { token: 'farmer-token', body: validBody })
    expect(res.status).toBe(403)
  })

  it('rejects a pending caller with 403', async () => {
    const res = await handleProvisionFarmer(makeDeps(), { token: 'pending-token', body: validBody })
    expect(res.status).toBe(403)
  })

  it('fails closed (403) when the caller has no profile row', async () => {
    const res = await handleProvisionFarmer(makeDeps(), { token: 'ghost-token', body: validBody })
    expect(res.status).toBe(403)
  })

  it('never trusts a role supplied in the body — rejects it with 400', async () => {
    const res = await handleProvisionFarmer(makeDeps(), {
      token: 'admin-token',
      body: { ...validBody, role: 'ddp_admin' },
    })
    expect(res.status).toBe(400)
  })
})

describe('handleProvisionFarmer — input validation', () => {
  it('rejects a malformed email with 400', async () => {
    const res = await handleProvisionFarmer(makeDeps(), {
      token: 'admin-token',
      body: { email: 'not-an-email' },
    })
    expect(res.status).toBe(400)
  })

  it('rejects an attempt to override the profile id with 400', async () => {
    const res = await handleProvisionFarmer(makeDeps(), {
      token: 'admin-token',
      body: { ...validBody, userId: 'victim-1' },
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-object body with 400', async () => {
    const res = await handleProvisionFarmer(makeDeps(), { token: 'admin-token', body: 'nope' })
    expect(res.status).toBe(400)
  })

  it('rejects over-length invite metadata with 400 (fail closed, not truncated)', async () => {
    const cases = [
      { display_name: 'x'.repeat(121) },
      { province: 'p'.repeat(86) },
      { phone_number: '9'.repeat(33) },
      { line_id: 'l'.repeat(65) },
    ]
    for (const extra of cases) {
      const res = await handleProvisionFarmer(makeDeps(), {
        token: 'admin-token',
        body: { email: 'grower@example.com', ...extra },
      })
      expect(res.status, `over-length ${Object.keys(extra)[0]} must be rejected`).toBe(400)
      expect(res.body.ok).toBe(false)
    }
  })

  it('rejects an over-length email with 400', async () => {
    const longLocal = 'a'.repeat(250)
    const res = await handleProvisionFarmer(makeDeps(), {
      token: 'admin-token',
      body: { email: `${longLocal}@example.com` },
    })
    expect(res.status).toBe(400)
  })

  it('accepts metadata at the boundary (does not over-reject)', async () => {
    const res = await handleProvisionFarmer(makeDeps(), {
      token: 'admin-token',
      body: { email: 'grower@example.com', display_name: 'x'.repeat(120), province: 'p'.repeat(85) },
    })
    expect(res.status).toBe(200)
  })
})

describe('handleProvisionFarmer — provisioning outcomes', () => {
  it('invites and promotes for a ddp_admin caller (200)', async () => {
    const res = await handleProvisionFarmer(makeDeps(), { token: 'admin-token', body: validBody })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, userId: 'new-1', promoted: true, alreadyExisted: false })
  })

  it('reports a duplicate/existing user as 409 with review-pending-users recovery, and does NOT promote by email', async () => {
    let promoteCalled = false
    const res = await handleProvisionFarmer(
      makeDeps({
        inviteFarmer: async () => ({ kind: 'already_exists' }),
        promotePendingToFarmer: async () => { promoteCalled = true; return true },
      }),
      { token: 'admin-token', body: validBody },
    )
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ok: false, reason: 'user_already_exists', recovery: 'review_pending_users' })
    // No lookup/auto-promotion by email: the promotion path must never run here.
    expect(promoteCalled).toBe(false)
  })

  it('partial failure (invite ok, promotion fails): userId + promotion_required + approve-by-id recovery, not success', async () => {
    const res = await handleProvisionFarmer(
      makeDeps({ promotePendingToFarmer: async () => false }),
      { token: 'admin-token', body: validBody },
    )
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({
      ok: false,
      stage: 'promotion',
      reason: 'promotion_required',
      userId: 'new-1',
      recovery: 'approve_pending_user_by_id',
    })
    // Must NOT claim success, and must signal that retrying the same email is not a valid retry.
    expect(res.body.ok).not.toBe(true)
    expect(String(res.body.error)).toMatch(/do not retry this email/i)
    expect(String(res.body.error)).toMatch(/by userId|user id/i)
  })

  it('surfaces an invite-stage error as 502', async () => {
    const res = await handleProvisionFarmer(
      makeDeps({ inviteFarmer: async () => ({ kind: 'error', message: 'smtp down' }) }),
      { token: 'admin-token', body: validBody },
    )
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ ok: false, stage: 'invite' })
  })

  it('does NOT leak the raw Supabase invite error to the client (coded/generic message only)', async () => {
    const secret = 'AuthApiError: SMTP relay 10.0.0.5 rejected sender key sk_live_leak'
    const res = await handleProvisionFarmer(
      makeDeps({ inviteFarmer: () => Promise.resolve({ kind: 'error', message: secret }) }),
      { token: 'admin-token', body: validBody },
    )
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ ok: false, stage: 'invite', reason: 'invite_failed' })
    expect(String(res.body.error)).not.toContain('SMTP')
    expect(String(res.body.error)).not.toContain('10.0.0.5')
    expect(String(res.body.error)).not.toContain('sk_live')
  })
})
