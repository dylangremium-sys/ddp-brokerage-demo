// Admin "resend invitation" — authorization, refusal and sequencing.
//
// The refusals matter more than the happy path. This endpoint mints a credential
// for somebody else's account, so the tests are weighted toward everything it
// must REFUSE to do.

import { describe, it, expect, vi } from 'vitest'
import {
  handleResendInvitation,
  type ResendDeps,
  type AccountLookup,
  type ReissueResult,
} from './serverInvitationResend'

const ADMIN = { id: 'admin-1' }
const EMAIL = 'grower@example.com'

function deps(overrides: Partial<ResendDeps> = {}): ResendDeps {
  return {
    getCallerFromToken: vi.fn(async () => ADMIN),
    getProfileRole: vi.fn(async () => 'ddp_admin'),
    findAccountByEmail: vi.fn(async (): Promise<AccountLookup> => ({ kind: 'unconfirmed', userId: 'user-9' })),
    reissueInvitation: vi.fn(async (): Promise<ReissueResult> => ({ kind: 'emailed' })),
    ...overrides,
  }
}

const req = (body: unknown = { email: EMAIL }, token: string | null = 'tok') => ({ token, body })

describe('authentication and authorization', () => {
  it('401s without a token', async () => {
    const res = await handleResendInvitation(deps(), req({ email: EMAIL }, null))
    expect(res.status).toBe(401)
  })

  it('401s when the token does not resolve', async () => {
    const res = await handleResendInvitation(deps({ getCallerFromToken: async () => null }), req())
    expect(res.status).toBe(401)
  })

  it.each(['farmer', 'pending', 'buyer', ''])('403s a caller whose role is %s', async (role) => {
    const res = await handleResendInvitation(deps({ getProfileRole: async () => role }), req())
    expect(res.status).toBe(403)
  })

  it('403s when the caller has no profile row at all', async () => {
    const res = await handleResendInvitation(deps({ getProfileRole: async () => null }), req())
    expect(res.status).toBe(403)
  })

  it('reads the role from the database, not from the request body', async () => {
    // A caller must not be able to promote themselves by asserting a role.
    const d = deps({ getProfileRole: async () => 'farmer' })
    const res = await handleResendInvitation(d, req({ email: EMAIL, role: 'ddp_admin' }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(d.reissueInvitation).not.toHaveBeenCalled()
  })

  it('issues nothing when authorization fails', async () => {
    const d = deps({ getProfileRole: async () => 'farmer' })
    await handleResendInvitation(d, req())
    expect(d.findAccountByEmail).not.toHaveBeenCalled()
    expect(d.reissueInvitation).not.toHaveBeenCalled()
  })
})

describe('input validation', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'email=x'],
    ['a number', 7],
  ])('400s when the body is %s', async (_label, body) => {
    expect((await handleResendInvitation(deps(), req(body))).status).toBe(400)
  })

  it.each(['role', 'id', 'userId', 'user_id', 'profileId', 'profile_id'])(
    'rejects a body carrying %s',
    async (key) => {
      const res = await handleResendInvitation(deps(), req({ email: EMAIL, [key]: 'x' }))
      expect(res.status).toBe(400)
    },
  )

  it.each(['', '   ', 'not-an-email', 'a@b', '@example.com', 'grower@'])(
    'rejects the malformed address %p',
    async (email) => {
      expect((await handleResendInvitation(deps(), req({ email }))).status).toBe(400)
    },
  )

  it('rejects an over-length address', async () => {
    const email = `${'a'.repeat(250)}@example.com`
    expect(email.length).toBeGreaterThan(254)
    expect((await handleResendInvitation(deps(), req({ email }))).status).toBe(400)
  })

  it('trims surrounding whitespace before use', async () => {
    const d = deps()
    await handleResendInvitation(d, req({ email: `  ${EMAIL}  ` }))
    expect(d.findAccountByEmail).toHaveBeenCalledWith(EMAIL)
  })
})

describe('refusals — what this endpoint must NOT do', () => {
  it('REFUSES an account that already has a password', async () => {
    // The core hazard: re-inviting a live account mints a fresh credential for
    // it on the strength of an email address alone. That is account takeover
    // wearing a helpful face.
    const d = deps({ findAccountByEmail: async () => ({ kind: 'confirmed' }) })
    const res = await handleResendInvitation(d, req())
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('already_active')
    expect(res.body.recovery).toBe('use_password_reset')
    expect(d.reissueInvitation).not.toHaveBeenCalled()
  })

  it('REFUSES when more than one profile matches', async () => {
    // profiles.email is nullable with no unique constraint, so a duplicate is
    // possible — and guessing could hand one supplier's invitation to another.
    const d = deps({ findAccountByEmail: async () => ({ kind: 'ambiguous' }) })
    const res = await handleResendInvitation(d, req())
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('ambiguous_account')
    expect(d.reissueInvitation).not.toHaveBeenCalled()
  })

  it('REFUSES when no account exists, and says which tool to use', async () => {
    const d = deps({ findAccountByEmail: async () => ({ kind: 'absent' }) })
    const res = await handleResendInvitation(d, req())
    expect(res.status).toBe(404)
    expect(res.body.reason).toBe('no_such_account')
    expect(res.body.recovery).toBe('invite_and_create_account')
    expect(d.reissueInvitation).not.toHaveBeenCalled()
  })

  it('looks the account up BEFORE issuing anything', async () => {
    const order: string[] = []
    const d = deps({
      findAccountByEmail: async () => { order.push('lookup'); return { kind: 'unconfirmed', userId: 'u' } },
      reissueInvitation: async () => { order.push('reissue'); return { kind: 'emailed' } },
    })
    await handleResendInvitation(d, req())
    expect(order).toEqual(['lookup', 'reissue'])
  })
})

describe('re-issue outcomes', () => {
  it('reports an emailed invitation', async () => {
    const res = await handleResendInvitation(deps(), req())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, delivered: 'email', userId: 'user-9' })
    expect(res.body).not.toHaveProperty('actionLink')
  })

  it('returns a link when the provider would not send the mail', async () => {
    const d = deps({
      reissueInvitation: async () => ({ kind: 'link_only', actionLink: 'https://app/#access_token=t&type=invite' }),
    })
    const res = await handleResendInvitation(d, req())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, delivered: 'link' })
    expect(res.body.actionLink).toContain('type=invite')
  })

  it('502s on a provider failure without leaking the provider message', async () => {
    const d = deps({
      reissueInvitation: async () => ({ kind: 'error', message: 'GoTrue: smtp relay 550 rejected sender' }),
    })
    const res = await handleResendInvitation(d, req())
    expect(res.status).toBe(502)
    expect(res.body.reason).toBe('reissue_failed')
    expect(JSON.stringify(res.body)).not.toMatch(/smtp|GoTrue|550/i)
  })

  it('never reports ok on a failure', async () => {
    for (const lookup of ['absent', 'ambiguous', 'confirmed'] as const) {
      const res = await handleResendInvitation(
        deps({ findAccountByEmail: async () => ({ kind: lookup } as AccountLookup) }),
        req(),
      )
      expect(res.body.ok, lookup).toBe(false)
    }
  })
})
