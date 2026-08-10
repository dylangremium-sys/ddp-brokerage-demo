import { describe, it, expect } from 'vitest'
import {
  handleProvisionBuyer,
  type BuyerProvisioningDeps,
  type BuyerOrganisationInput,
} from './serverBuyerProvisioning'

// Base deps modelling a working environment. Each test overrides only what it
// needs. Tokens map to callers; caller ids map to roles.
function makeDeps(overrides: Partial<BuyerProvisioningDeps> = {}): BuyerProvisioningDeps {
  return {
    async getCallerFromToken(token) {
      switch (token) {
        case 'admin-token': return { id: 'admin-1' }
        case 'farmer-token': return { id: 'farmer-1' }
        case 'buyer-token': return { id: 'buyer-1' }
        case 'pending-token': return { id: 'pending-1' }
        case 'ghost-token': return { id: 'ghost-1' }
        default: return null
      }
    },
    async getProfileRole(id) {
      switch (id) {
        case 'admin-1': return 'ddp_admin'
        case 'farmer-1': return 'farmer'
        case 'buyer-1': return 'buyer'
        case 'pending-1': return 'pending'
        default: return null
      }
    },
    async resolveOrCreateOrganisation(input) {
      return input.kind === 'existing'
        ? { kind: 'resolved', organisationId: input.organisationId, created: false }
        : { kind: 'resolved', organisationId: 'org-new-1', created: true }
    },
    async inviteBuyer() {
      return { kind: 'invited', userId: 'new-1' }
    },
    async promotePendingToBuyer() {
      return true
    },
    async recordMembership() {
      return true
    },
    ...overrides,
  }
}

const EXISTING_ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const newOrgBody = {
  email: 'buyer@example.com',
  display_name: 'Anna Buyer',
  legal_name: 'Northwind Pharma GmbH',
  country_code: 'DE',
}

describe('handleProvisionBuyer — authentication & authorization', () => {
  it('rejects an anonymous request (no token) with 401', async () => {
    const res = await handleProvisionBuyer(makeDeps(), { token: null, body: newOrgBody })
    expect(res.status).toBe(401)
    expect(res.body.ok).toBe(false)
  })

  it('rejects an invalid/expired token with 401', async () => {
    const res = await handleProvisionBuyer(makeDeps(), { token: 'bogus', body: newOrgBody })
    expect(res.status).toBe(401)
  })

  it('rejects a farmer with 403 — role is read from the database', async () => {
    const res = await handleProvisionBuyer(makeDeps(), { token: 'farmer-token', body: newOrgBody })
    expect(res.status).toBe(403)
  })

  it('rejects a BUYER with 403 — a buyer cannot provision another buyer', async () => {
    const res = await handleProvisionBuyer(makeDeps(), { token: 'buyer-token', body: newOrgBody })
    expect(res.status).toBe(403)
  })

  it('rejects a caller with no profile row with 403 (fail closed)', async () => {
    const res = await handleProvisionBuyer(makeDeps(), { token: 'ghost-token', body: newOrgBody })
    expect(res.status).toBe(403)
  })

  it('creates NOTHING when authorization fails', async () => {
    // The whole point of ordering organisation-first is that it happens after
    // the role check, not before it.
    let touched = false
    const deps = makeDeps({
      async resolveOrCreateOrganisation() { touched = true; return { kind: 'error', message: 'x' } },
      async inviteBuyer() { touched = true; return { kind: 'error', message: 'x' } },
    })
    await handleProvisionBuyer(deps, { token: 'farmer-token', body: newOrgBody })
    expect(touched).toBe(false)
  })
})

describe('handleProvisionBuyer — privilege-escalation surface', () => {
  for (const key of [
    'role', 'id', 'user_id', 'org_type', 'verification_state', 'verified_by', 'farm_id',
  ]) {
    it(`refuses a body carrying '${key}'`, async () => {
      const res = await handleProvisionBuyer(makeDeps(), {
        token: 'admin-token',
        body: { ...newOrgBody, [key]: 'anything' },
      })
      expect(res.status).toBe(400)
      expect(String(res.body.error)).toContain(key)
    })
  }

  it('never lets a caller mark its own organisation verified', async () => {
    const res = await handleProvisionBuyer(makeDeps(), {
      token: 'admin-token',
      body: { ...newOrgBody, verification_state: 'verified' },
    })
    expect(res.status).toBe(400)
  })

  it('always requests org_type buyer — the caller cannot influence it', async () => {
    let seen: BuyerOrganisationInput | null = null
    const deps = makeDeps({
      async resolveOrCreateOrganisation(input) {
        seen = input
        return { kind: 'resolved', organisationId: 'org-new-1', created: true }
      },
    })
    await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    // The input type carries no org_type at all: 'buyer' is the dep's contract,
    // so there is no channel through which a caller could vary it.
    expect(seen).toEqual({
      kind: 'new',
      legalName: 'Northwind Pharma GmbH',
      displayName: undefined,
      countryCode: 'DE',
    })
  })
})

describe('handleProvisionBuyer — input validation', () => {
  it('rejects a non-object body', async () => {
    const res = await handleProvisionBuyer(makeDeps(), { token: 'admin-token', body: 'nope' })
    expect(res.status).toBe(400)
  })

  it('rejects an array body', async () => {
    const res = await handleProvisionBuyer(makeDeps(), { token: 'admin-token', body: [] })
    expect(res.status).toBe(400)
  })

  it('rejects a malformed email', async () => {
    const res = await handleProvisionBuyer(makeDeps(), {
      token: 'admin-token', body: { ...newOrgBody, email: 'not-an-email' },
    })
    expect(res.status).toBe(400)
  })

  it('rejects an over-length display name rather than truncating it', async () => {
    const res = await handleProvisionBuyer(makeDeps(), {
      token: 'admin-token', body: { ...newOrgBody, display_name: 'x'.repeat(121) },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('120')
  })

  it('requires an organisation — neither id nor legal name is a 400', async () => {
    const res = await handleProvisionBuyer(makeDeps(), {
      token: 'admin-token', body: { email: 'buyer@example.com' },
    })
    expect(res.status).toBe(400)
  })

  it('refuses BOTH an existing id and new organisation details', async () => {
    const res = await handleProvisionBuyer(makeDeps(), {
      token: 'admin-token', body: { ...newOrgBody, organisation_id: EXISTING_ORG },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('not both')
  })

  it('rejects a non-UUID organisationId', async () => {
    const res = await handleProvisionBuyer(makeDeps(), {
      token: 'admin-token', body: { email: 'buyer@example.com', organisation_id: 'org-1' },
    })
    expect(res.status).toBe(400)
  })

  // The live CHECK is `country_code ~ '^[A-Z]{2}$'` — case-sensitive. A form
  // that says "country code" and then rejects 'de' states a rule it never made.
  it("accepts a lowercase country code and uppercases it — 'de' → 'DE'", async () => {
    let seen: BuyerOrganisationInput | null = null
    const deps = makeDeps({
      async resolveOrCreateOrganisation(input) {
        seen = input
        return { kind: 'resolved', organisationId: 'org-new-1', created: true }
      },
    })
    const res = await handleProvisionBuyer(deps, {
      token: 'admin-token', body: { ...newOrgBody, country_code: 'de' },
    })
    expect(res.status).toBe(200)
    expect(seen).toMatchObject({ countryCode: 'DE' })
  })

  it('rejects a country code that is not two letters, before the database does', async () => {
    for (const bad of ['D', 'DEU', '12', '']) {
      const res = await handleProvisionBuyer(makeDeps(), {
        token: 'admin-token', body: { ...newOrgBody, country_code: bad },
      })
      expect(res.status).toBe(400)
    }
  })

  it('rejects an org_role outside the allowed set', async () => {
    const res = await handleProvisionBuyer(makeDeps(), {
      token: 'admin-token', body: { ...newOrgBody, org_role: 'superuser' },
    })
    expect(res.status).toBe(400)
  })

  it("defaults org_role to 'owner'", async () => {
    let seenRole = ''
    const deps = makeDeps({
      async recordMembership(_org, _user, role) { seenRole = role; return true },
    })
    const res = await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(res.status).toBe(200)
    expect(seenRole).toBe('owner')
  })
})

describe('handleProvisionBuyer — the happy path', () => {
  it('creates an organisation, invites, promotes and records membership, in that order', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      async resolveOrCreateOrganisation() {
        calls.push('organisation')
        return { kind: 'resolved', organisationId: 'org-new-1', created: true }
      },
      async inviteBuyer() { calls.push('invite'); return { kind: 'invited', userId: 'new-1' } },
      async promotePendingToBuyer() { calls.push('promote'); return true },
      async recordMembership() { calls.push('membership'); return true },
    })
    const res = await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true, userId: 'new-1', organisationId: 'org-new-1', organisationCreated: true, promoted: true,
    })
    expect(calls).toEqual(['organisation', 'invite', 'promote', 'membership'])
  })

  it('attaches a buyer to an EXISTING organisation without creating one', async () => {
    const res = await handleProvisionBuyer(makeDeps(), {
      token: 'admin-token',
      body: { email: 'second@example.com', organisation_id: EXISTING_ORG, org_role: 'viewer' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      organisationId: EXISTING_ORG, organisationCreated: false, orgRole: 'viewer',
    })
  })
})

describe('handleProvisionBuyer — partial failures are recoverable and say so', () => {
  it('reports a 404 when the named organisation does not exist', async () => {
    const deps = makeDeps({ async resolveOrCreateOrganisation() { return { kind: 'not_found' } } })
    const res = await handleProvisionBuyer(deps, {
      token: 'admin-token', body: { email: 'buyer@example.com', organisation_id: EXISTING_ORG },
    })
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ stage: 'organisation', reason: 'organisation_not_found' })
  })

  it('does NOT invite anyone when the organisation step fails', async () => {
    let invited = false
    const deps = makeDeps({
      async resolveOrCreateOrganisation() { return { kind: 'error', message: 'db down' } },
      async inviteBuyer() { invited = true; return { kind: 'invited', userId: 'new-1' } },
    })
    const res = await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ stage: 'organisation' })
    expect(invited).toBe(false)
  })

  it('returns the organisationId when the invite fails, so a retry reuses it', async () => {
    const deps = makeDeps({ async inviteBuyer() { return { kind: 'error', message: 'smtp exploded' } } })
    const res = await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ stage: 'invite', organisationId: 'org-new-1' })
  })

  it('never leaks the raw Admin-Auth error text to the client', async () => {
    const deps = makeDeps({
      async inviteBuyer() { return { kind: 'error', message: 'GoTrue: SMTP relay 550 at internal-host' } },
    })
    const res = await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(JSON.stringify(res.body)).not.toContain('GoTrue')
    expect(JSON.stringify(res.body)).not.toContain('internal-host')
  })

  it('reports an existing user as 409 without promoting them', async () => {
    let promoted = false
    const deps = makeDeps({
      async inviteBuyer() { return { kind: 'already_exists' } },
      async promotePendingToBuyer() { promoted = true; return true },
    })
    const res = await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(res.status).toBe(409)
    expect(promoted).toBe(false)
  })

  it('reports a failed promotion with the userId and warns against retrying by email', async () => {
    const deps = makeDeps({ async promotePendingToBuyer() { return false } })
    const res = await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ stage: 'promotion', reason: 'promotion_required', userId: 'new-1' })
    expect(String(res.body.error)).toContain('Do NOT retry')
  })

  it('does NOT record membership when promotion failed', async () => {
    // A profile still at 'pending' must not gain sight of an organisation.
    let recorded = false
    const deps = makeDeps({
      async promotePendingToBuyer() { return false },
      async recordMembership() { recorded = true; return true },
    })
    await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(recorded).toBe(false)
  })

  it('reports a failed membership with both ids, and says the buyer will see nothing', async () => {
    const deps = makeDeps({ async recordMembership() { return false } })
    const res = await handleProvisionBuyer(deps, { token: 'admin-token', body: newOrgBody })
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({
      stage: 'membership', reason: 'membership_required',
      userId: 'new-1', organisationId: 'org-new-1',
    })
    expect(String(res.body.error)).toContain('see nothing')
  })

  it('never reports ok:true on any partial failure', async () => {
    const partials: Array<Partial<BuyerProvisioningDeps>> = [
      { async resolveOrCreateOrganisation() { return { kind: 'error', message: 'x' } } },
      { async inviteBuyer() { return { kind: 'error', message: 'x' } } },
      { async promotePendingToBuyer() { return false } },
      { async recordMembership() { return false } },
    ]
    for (const partial of partials) {
      const res = await handleProvisionBuyer(makeDeps(partial), { token: 'admin-token', body: newOrgBody })
      expect(res.body.ok).not.toBe(true)
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
  })
})
