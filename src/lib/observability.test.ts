import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logClientError, logServerError, newRequestId } from './observability'

// The strings that must NEVER appear in a log line. Each is a realistic thing an
// exception thrown near the AI call can actually carry.
const PROMPT = 'SUMMARISE_THIS_CONFIDENTIAL_LEGAL_TEXT'
const TOKEN = 'sk-ant-api03-SUPERSECRETVALUE'
const EMAIL = 'grower@example.com'
const VENDOR = 'Anthropic error: rate limit exceeded for account acct_9931'

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

function emitted(): Record<string, unknown> {
  expect(errorSpy).toHaveBeenCalledTimes(1)
  return JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>
}

describe('newRequestId', () => {
  it('returns a non-empty id', () => {
    expect(newRequestId().length).toBeGreaterThan(15)
  })

  it('returns a DISTINCT id every call — two requests can never collide in the logs', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()))
    expect(ids.size).toBe(200)
  })

  it('encodes nothing about the caller — it is random, not derived', () => {
    // Guards the rule "do not derive the ID from user data or a timestamp": a
    // time-derived ID would be predictable and would itself leak when the request
    // happened. Consecutive IDs must share no common prefix.
    const a = newRequestId()
    const b = newRequestId()
    expect(a).not.toBe(b)
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8))
  })
})

describe('logServerError — emits ONLY the closed set of safe fields', () => {
  it('emits exactly one line, with exactly the allowed keys and nothing else', () => {
    logServerError({
      event: 'api_error',
      requestId: 'req-1',
      category: 'internal_error',
      status: 500,
      method: 'POST',
      route: 'api/compliance/ai-summary',
    })

    const log = emitted()
    // An exact key set, not a subset: if anyone later adds a field that carries a
    // payload (the error, the body, the headers), this fails.
    expect(Object.keys(log).sort()).toEqual(
      ['at', 'category', 'event', 'method', 'requestId', 'route', 'status'].sort(),
    )
    expect(log.requestId).toBe('req-1')
    expect(log.category).toBe('internal_error')
    expect(log.status).toBe(500)
    expect(log.method).toBe('post')
    expect(log.route).toBe('api/compliance/ai-summary')
  })

  it('REPLACES a category that is not a machine code — a leaked message cannot get through', () => {
    // The last line of defence. If a future caller wrongly passes an exception
    // message (or a prompt, or a token) where a code belongs, it is discarded
    // wholesale rather than logged.
    logServerError({
      event: 'api_error',
      requestId: 'req-2',
      category: `${VENDOR} ${TOKEN} ${EMAIL}`,
      status: 500,
      method: 'POST',
      route: 'api/compliance/ai-summary',
    })

    const raw = errorSpy.mock.calls[0][0] as string
    expect(emitted().category).toBe('unknown_error')
    for (const secret of [VENDOR, TOKEN, EMAIL, 'acct_9931']) {
      expect(raw, `must not leak: ${secret}`).not.toContain(secret)
    }
  })

  it('a non-code event name or method is likewise replaced', () => {
    logServerError({
      event: PROMPT,
      requestId: 'req-3',
      category: 'internal_error',
      status: 500,
      method: `POST ${TOKEN}`,
      route: 'api/compliance/ai-summary',
    })

    const raw = errorSpy.mock.calls[0][0] as string
    expect(raw).not.toContain(PROMPT)
    expect(raw).not.toContain(TOKEN)
    expect(emitted().event).toBe('unknown_error')
  })
})

describe('logClientError', () => {
  it('emits one line with the safe fields and no status/method', () => {
    logClientError({ event: 'ui_crash', requestId: 'ref-1', category: 'render_error', route: 'app_root' })

    const log = emitted()
    expect(Object.keys(log).sort()).toEqual(['at', 'category', 'event', 'requestId', 'route'].sort())
    expect(log.event).toBe('ui_crash')
    expect(log.category).toBe('render_error')
  })
})

// ─── Source sweep: the module cannot log what it cannot receive ──────────────
const SRC = Object.values(
  import.meta.glob('./observability.ts', { query: '?raw', import: 'default', eager: true }),
)[0] as string

describe('observability source — structurally incapable of leaking', () => {
  it('loaded', () => {
    expect(SRC.length).toBeGreaterThan(200)
  })

  it('never reads an error message, stack, header, cookie or body', () => {
    expect(SRC).not.toMatch(/\.stack\b/)
    expect(SRC).not.toMatch(/\.message\b/)
    expect(SRC).not.toMatch(/headers|cookie|authorization|\.body\b/i)
  })

  it('touches no browser storage and no env var', () => {
    expect(SRC).not.toMatch(/localStorage|sessionStorage/)
    expect(SRC).not.toMatch(/process\.env|import\.meta\.env/)
  })
})
