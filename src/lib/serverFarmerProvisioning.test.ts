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
})

describe('handleProvisionFarmer — provisioning outcomes', () => {
  it('invites and promotes for a ddp_admin caller (200)', async () => {
    const res = await handleProvisionFarmer(makeDeps(), { token: 'admin-token', body: validBody })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, userId: 'new-1', promoted: true, alreadyExisted: false })
  })

  it('reports a duplicate/existing user as 409 without promoting', async () => {
    const res = await handleProvisionFarmer(
      makeDeps({ inviteFarmer: async () => ({ kind: 'already_exists' }) }),
      { token: 'admin-token', body: validBody },
    )
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ok: false, reason: 'user_already_exists' })
  })

  it('reports a partial failure when invite succeeds but promotion fails (502)', async () => {
    const res = await handleProvisionFarmer(
      makeDeps({ promotePendingToFarmer: async () => false }),
      { token: 'admin-token', body: validBody },
    )
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ ok: false, stage: 'promotion', userId: 'new-1' })
    // Must NOT claim the farmer was fully provisioned.
    expect(res.body.ok).not.toBe(true)
  })

  it('surfaces an invite-stage error as 502', async () => {
    const res = await handleProvisionFarmer(
      makeDeps({ inviteFarmer: async () => ({ kind: 'error', message: 'smtp down' }) }),
      { token: 'admin-token', body: validBody },
    )
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ ok: false, stage: 'invite' })
  })
})
