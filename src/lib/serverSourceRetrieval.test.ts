// Unit tests for server-side official-source retrieval.
//
// Every test drives an injected fetch implementation — no test opens a socket.
// The focus is the safety gate: allowlisting, the SSRF guard, redirect
// revalidation, and the transport limits.

import { describe, it, expect, vi } from 'vitest'
import {
  retrieveOfficialSource,
  validateRetrievalTarget,
  htmlToText,
  selectRelevantSection,
  type SourceFetchImpl,
  type SourceFetchInit,
  type SourceFetchResponse,
  type SourceRetrievalPolicy,
} from './serverSourceRetrieval'

const RETRIEVED_AT = '2026-07-27T10:00:00.000Z'
const ALLOWED_HOST = 'www.fda.moph.go.th'
const BASE_URL = `https://${ALLOWED_HOST}/cannabis`

const policy: SourceRetrievalPolicy = { allowedHosts: [ALLOWED_HOST] }

function makeResponse(options: {
  status?: number
  contentType?: string | null
  body?: string
  headers?: Record<string, string>
  stream?: boolean
}): SourceFetchResponse {
  const { status = 200, contentType = 'text/html; charset=utf-8', body = '<html><body>ok</body></html>' } = options
  const headerMap = new Map<string, string>(
    Object.entries({
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(options.headers ?? {}),
    }).map(([k, v]) => [k.toLowerCase(), v]),
  )
  const bytes = new TextEncoder().encode(body)

  return {
    status,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    body: options.stream
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        })
      : null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  }
}

function fetchReturning(...responses: SourceFetchResponse[]): SourceFetchImpl {
  let index = 0
  return async () => responses[Math.min(index++, responses.length - 1)]
}

describe('validateRetrievalTarget', () => {
  it('denies by default when the allowlist is empty', () => {
    const result = validateRetrievalTarget(BASE_URL, { allowedHosts: [] })
    expect(result).toMatchObject({ ok: false, status: 'rejected_not_allowlisted' })
  })

  it('accepts an allowlisted HTTPS host', () => {
    expect(validateRetrievalTarget(BASE_URL, policy)).toEqual({ ok: true })
  })

  it('rejects plain HTTP', () => {
    const result = validateRetrievalTarget(`http://${ALLOWED_HOST}/x`, policy)
    expect(result).toMatchObject({ ok: false, status: 'rejected_not_https' })
  })

  it.each([
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data',
  ])('rejects the private/link-local address %s', (url) => {
    const result = validateRetrievalTarget(url, { allowedHosts: [new URL(url).hostname] })
    expect(result).toMatchObject({ ok: false, status: 'rejected_private_network' })
  })

  it('rejects a non-allowlisted host', () => {
    const result = validateRetrievalTarget('https://evil.example.com/x', policy)
    expect(result).toMatchObject({ ok: false, status: 'rejected_not_allowlisted' })
  })

  it('rejects a non-standard port unless explicitly allowed', () => {
    const url = `https://${ALLOWED_HOST}:8443/x`
    expect(validateRetrievalTarget(url, policy)).toMatchObject({ ok: false, status: 'rejected_disallowed_port' })
    expect(validateRetrievalTarget(url, { ...policy, allowedPorts: [8443] })).toEqual({ ok: true })
  })
})

describe('retrieveOfficialSource — successful retrieval', () => {
  it('retrieves, fingerprints and normalises the source', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL,
      policy,
      retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(makeResponse({ body: '<html><body><h1>Notice</h1><p>Limit text</p></body></html>' })),
    })

    expect(result.status).toBe('retrieved')
    expect(result.finalUrl).toBe(BASE_URL)
    expect(result.httpStatus).toBe(200)
    expect(result.contentType).toBe('text/html')
    expect(result.contentFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(result.retrievedAt).toBe(RETRIEVED_AT)
    expect(result.content).toContain('Notice')
    expect(result.content).toContain('Limit text')
    expect(result.content).not.toContain('<h1>')
    expect(result.reason).toBeNull()
  })

  it('fingerprints identical bytes identically and different bytes differently', async () => {
    const run = (body: string) =>
      retrieveOfficialSource({
        url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
        fetchImpl: fetchReturning(makeResponse({ body })),
      })

    const a = await run('<html>same</html>')
    const b = await run('<html>same</html>')
    const c = await run('<html>different</html>')

    expect(a.contentFingerprint).toBe(b.contentFingerprint)
    expect(a.contentFingerprint).not.toBe(c.contentFingerprint)
  })

  it('issues a credential-free GET with manual redirects', async () => {
    const seen: SourceFetchInit[] = []
    const spy: SourceFetchImpl = async (_url, init) => {
      seen.push(init)
      return makeResponse({})
    }

    await retrieveOfficialSource({ url: BASE_URL, policy, retrievedAt: RETRIEVED_AT, fetchImpl: spy })

    expect(seen[0].method).toBe('GET')
    expect(seen[0].redirect).toBe('manual')
    expect(seen[0].credentials).toBe('omit')
    expect(Object.keys(seen[0].headers).map((h) => h.toLowerCase())).not.toContain('authorization')
    expect(Object.keys(seen[0].headers).map((h) => h.toLowerCase())).not.toContain('cookie')
  })

  it('reads a streamed body', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(makeResponse({ body: '<html>streamed</html>', stream: true })),
    })
    expect(result.status).toBe('retrieved')
    expect(result.content).toContain('streamed')
  })
})

describe('retrieveOfficialSource — redirect handling', () => {
  it('follows an allowlisted redirect and records the chain', async () => {
    const target = `https://${ALLOWED_HOST}/cannabis/final`
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(
        makeResponse({ status: 302, headers: { location: target }, contentType: null }),
        makeResponse({ body: '<html>final</html>' }),
      ),
    })

    expect(result.status).toBe('retrieved')
    expect(result.finalUrl).toBe(target)
    expect(result.redirectChain).toEqual([BASE_URL, target])
  })

  it('rejects a redirect that leaves the allowlist', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(
        makeResponse({ status: 302, headers: { location: 'https://evil.example.com/x' }, contentType: null }),
        makeResponse({ body: 'should never be read' }),
      ),
    })

    expect(result.status).toBe('rejected_redirect')
    expect(result.reason).toMatch(/not on the allowlist/i)
    expect(result.content).toBeNull()
  })

  it('rejects a redirect into the private network — the SSRF case', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(
        makeResponse({ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' }, contentType: null }),
        makeResponse({ body: 'cloud metadata' }),
      ),
    })

    expect(result.status).toBe('rejected_redirect')
    expect(result.reason).toMatch(/private|metadata|allowlist/i)
    expect(result.content).toBeNull()
  })

  it('rejects a downgrade to HTTP via redirect', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(
        makeResponse({ status: 301, headers: { location: `http://${ALLOWED_HOST}/x` }, contentType: null }),
        makeResponse({}),
      ),
    })
    expect(result.status).toBe('rejected_redirect')
    expect(result.reason).toMatch(/https/i)
  })

  it('resolves a relative redirect against the current URL', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(
        makeResponse({ status: 302, headers: { location: '/notice' }, contentType: null }),
        makeResponse({ body: '<html>notice</html>' }),
      ),
    })
    expect(result.status).toBe('retrieved')
    expect(result.finalUrl).toBe(`https://${ALLOWED_HOST}/notice`)
  })

  it('stops after the redirect limit', async () => {
    let n = 0
    const loop: SourceFetchImpl = async () => {
      n += 1
      return makeResponse({ status: 302, headers: { location: `${BASE_URL}/${n}` }, contentType: null })
    }
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy: { ...policy, maxRedirects: 2 }, retrievedAt: RETRIEVED_AT, fetchImpl: loop,
    })
    expect(result.status).toBe('too_many_redirects')
  })

  it('rejects a redirect with no Location header', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(makeResponse({ status: 302, contentType: null })),
    })
    expect(result.status).toBe('rejected_redirect')
    expect(result.reason).toMatch(/no Location/i)
  })
})

describe('retrieveOfficialSource — transport limits and failures', () => {
  it('rejects an unsupported content type', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(makeResponse({ contentType: 'application/pdf' })),
    })
    expect(result.status).toBe('rejected_content_type')
    expect(result.content).toBeNull()
  })

  it('rejects a declared oversize response before reading it', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy: { ...policy, maxBytes: 100 }, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(makeResponse({ headers: { 'content-length': '999999' } })),
    })
    expect(result.status).toBe('too_large')
  })

  it('abandons a body that exceeds the cap while streaming', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy: { ...policy, maxBytes: 10 }, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(makeResponse({ body: 'x'.repeat(5000), stream: true })),
    })
    expect(result.status).toBe('too_large')
    expect(result.content).toBeNull()
  })

  it('records an HTTP error status', async () => {
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: fetchReturning(makeResponse({ status: 503, contentType: null })),
    })
    expect(result.status).toBe('http_error')
    expect(result.httpStatus).toBe(503)
    expect(result.reason).toMatch(/503/)
  })

  it('reports a timeout when the request aborts', async () => {
    const hang: SourceFetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })

    const result = await retrieveOfficialSource({
      url: BASE_URL, policy: { ...policy, timeoutMs: 20 }, retrievedAt: RETRIEVED_AT, fetchImpl: hang,
    })
    expect(result.status).toBe('timeout')
    expect(result.reason).toMatch(/20ms/)
  })

  it('reports a transport failure without leaking the underlying error', async () => {
    const boom: SourceFetchImpl = async () => {
      throw new Error('ECONNREFUSED 10.1.2.3:443 secret-internal-host')
    }
    const result = await retrieveOfficialSource({
      url: BASE_URL, policy, retrievedAt: RETRIEVED_AT, fetchImpl: boom,
    })
    expect(result.status).toBe('fetch_failed')
    expect(result.reason).not.toContain('ECONNREFUSED')
    expect(result.reason).not.toContain('secret-internal-host')
  })

  it('never fetches at all when the target is rejected up front', async () => {
    const spy = vi.fn()
    const result = await retrieveOfficialSource({
      url: 'https://evil.example.com/x', policy, retrievedAt: RETRIEVED_AT,
      fetchImpl: spy as unknown as SourceFetchImpl,
    })
    expect(result.status).toBe('rejected_not_allowlisted')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('htmlToText', () => {
  it('drops scripts, styles and tags but keeps the text', () => {
    const text = htmlToText('<html><head><style>a{}</style><script>evil()</script></head><body><h1>Title</h1><p>Body&nbsp;text</p></body></html>')
    expect(text).toContain('Title')
    expect(text).toContain('Body text')
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('a{}')
  })

  it('decodes common entities', () => {
    expect(htmlToText('<p>Fish &amp; Chips &lt;ok&gt;</p>')).toContain('Fish & Chips <ok>')
  })
})

describe('selectRelevantSection', () => {
  const text = ['Intro line', 'Cannabis extract rules apply here', 'Another line', 'Unrelated tail'].join('\n')

  it('returns a verbatim window around the best match', () => {
    const result = selectRelevantSection(text, ['cannabis', 'extract'])
    expect(result.matched).toBe(true)
    expect(result.matchedTerms).toEqual(expect.arrayContaining(['cannabis', 'extract']))
    expect(result.section).toContain('Cannabis extract rules apply here')
  })

  it('falls back to the opening of the document when nothing matches', () => {
    const result = selectRelevantSection(text, ['zzz-nothing'])
    expect(result.matched).toBe(false)
    expect(result.matchedTerms).toEqual([])
    expect(result.section).toContain('Intro line')
  })

  it('never fabricates content that was not in the source', () => {
    const result = selectRelevantSection(text, ['cannabis'])
    for (const line of result.section.split('\n')) {
      expect(text).toContain(line)
    }
  })
})
