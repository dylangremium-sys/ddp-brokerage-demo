import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
 * checked "no throw on success" would have passed before #85, after #85, and
 * after #88's revert — it would be exactly the kind of test the brief warns
 * about, one that passes whether or not the code works.
 *
 * DIRECTION OF THE ASSERTION. #88 reverted this client to a direct browser ->
 * Supabase insert, and this file then pinned that direction ("does NOT call the
 * server endpoint"). That revert is now itself reverted: the client posts to
 * /api/public/access-request again, so the transport assertion is inverted with
 * it. Leaving the old direction pinned would have made the fix un-shippable
 * while telling us nothing true.
 *
 * WHY THIS IS SAFE TO SHIP BEFORE MIGRATION 36. The endpoint fails closed with
 * 503 when its throttle RPCs are absent. The 503 branch below is what turns that
 * into an honest "contact the DDP team directly" rather than a retry the visitor
 * can never satisfy. That branch is asserted here precisely because it is the
 * behaviour that bounds the risk of deploying ahead of the migration.
 *
 * `fetch` is stubbed so the exact request — URL, method, body — is observable.
 */

const supabaseStub = vi.hoisted(() => ({
  fromCalls: [] as string[],
  configured: true,
}))

vi.mock('./supabase', () => ({
  get isSupabaseConfigured() { return supabaseStub.configured },
  get supabase() {
    return supabaseStub.configured
      ? { from: (t: string) => { supabaseStub.fromCalls.push(t); throw new Error('unreachable') } }
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

/** A Response-alike with only the fields this client reads. */
function reply(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  supabaseStub.fromCalls = []
  supabaseStub.configured = true
  fetchMock = vi.fn().mockResolvedValue(reply(200))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('submitAccessRequest — throttled server-endpoint path', () => {
  it('POSTs to /api/public/access-request and never inserts from the browser', async () => {
    // The transport assertion. This goes red if the client is ever repointed at
    // a direct Supabase insert again — the path that cannot be rate limited,
    // because it does not traverse Vercel at all.
    await expect(submitAccessRequest(VALID)).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/public/access-request')
    expect(init.method).toBe('POST')
    expect(supabaseStub.fromCalls).toEqual([])
  })

  it('sends a trimmed payload in the shape the endpoint validates', async () => {
    await submitAccessRequest(VALID)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({
      fullName: 'Somchai Prasert',
      email: 'somchai@example.com',
      phone: '0812345678',
      province: 'Chiang Mai',
      position: 'Owner',
      preferredLanguage: 'th',
      note: '200 rai of longan',
    })
    // The server pins status and reviewer. A submitter must never supply either,
    // or the server-authoritative INSERT policy is doing nothing.
    expect(body).not.toHaveProperty('status')
    expect(body).not.toHaveProperty('reviewed_by')
    expect(body).not.toHaveProperty('reviewed_at')
  })

  it('sends phone, because the endpoint rejects a submission without it', async () => {
    // serverAccessRequestIntake.validateSubmission requires phone at 5-40 chars
    // and returns 400 before the throttle is ever consulted. A payload missing
    // this field fails in a way that looks like an endpoint fault.
    await submitAccessRequest(VALID)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.phone).toBe('0812345678')
    expect(body.phone.length).toBeGreaterThanOrEqual(5)
  })

  it('reports an unconfigured backend without sending anything', async () => {
    supabaseStub.configured = false

    await expect(submitAccessRequest(VALID)).rejects.toMatchObject({ code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid input before any request', async () => {
    await expect(submitAccessRequest({ ...VALID, email: 'not-an-email' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps 503 (throttle RPCs absent — migration 36 unapplied) to backend_unavailable', async () => {
    // THE DEPLOY-SAFETY ASSERTION. Between deploying this client and applying
    // migration 36, the endpoint fails closed with 503. The visitor must be told
    // to reach DDP another way, not asked to retry something that cannot succeed.
    fetchMock.mockResolvedValue(reply(503))

    const err = await submitAccessRequest(VALID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccessRequestError)
    expect((err as AccessRequestError).code).toBe('backend_unavailable')
    expect((err as AccessRequestError).message).toMatch(/contact the DDP team directly/i)
  })

  it('maps 429 to rate_limited rather than to a generic failure', async () => {
    // A throttled supplier is not a broken form. Collapsing 429 into
    // submit_failed would tell a legitimate visitor to retry immediately, which
    // both fails and burns another slot.
    fetchMock.mockResolvedValue(reply(429))

    await expect(submitAccessRequest(VALID)).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('maps 400 to invalid_input', async () => {
    fetchMock.mockResolvedValue(reply(400))

    await expect(submitAccessRequest(VALID)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('maps a network failure to submit_failed', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(submitAccessRequest(VALID)).rejects.toMatchObject({ code: 'submit_failed' })
  })

  it('never leaks a server message to the UI', async () => {
    fetchMock.mockResolvedValue(reply(500))

    const err = await submitAccessRequest(VALID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccessRequestError)
    expect((err as AccessRequestError).code).toBe('submit_failed')
    expect((err as AccessRequestError).message).not.toMatch(/constraint|column|relation|permission/i)
  })
})
