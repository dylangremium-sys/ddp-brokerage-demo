// Unit tests for the server-proxy RSS fetch adapter.
//
// The adapter's whole job is to look exactly like a fetch to the connector
// while actually going through our own endpoint, so the tests are mostly about
// the SHAPE it presents back: the connector must be able to apply its
// content-type check, its size check and its redirect guard against it without
// modification.

import { describe, it, expect } from 'vitest'
import { createServerProxyRssFetch } from './serverProxyRssFetch'
import { SUPPORTED_CAPABILITY } from './serverFeedRetrieval'
import type { RssFetchInit } from './complianceRssConnector'

const SOURCE_ID = 'src-1'
const URL_ = 'https://sukl.gov.cz/feed/'
const FEED = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>'

const init: RssFetchInit = {
  method: 'GET',
  redirect: 'error',
  credentials: 'omit',
  headers: { 'User-Agent': 'test', Accept: 'application/rss+xml' },
  signal: new AbortController().signal,
}

function successPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    retrieval: {
      status: 'retrieved',
      requestedUrl: URL_,
      finalUrl: URL_,
      httpStatus: 200,
      contentType: 'application/rss+xml; charset=UTF-8',
      byteLength: new TextEncoder().encode(FEED).length,
      contentFingerprint: 'a'.repeat(64),
      retrievedAt: '2026-08-02T12:00:00.000Z',
      redirectChain: [URL_],
      reason: null,
      content: FEED,
      ...overrides,
    },
    source: { id: SOURCE_ID, name: 'SUKL', url: URL_ },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** Records what the adapter sent, and replies with whatever is supplied. */
function stubFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: unknown, requestInit: unknown) => {
    calls.push({ url: String(url), init: requestInit as RequestInit })
    return typeof response === 'function' ? await response() : response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('createServerProxyRssFetch — the request it sends', () => {
  it('POSTs the SOURCE ID and never the URL', async () => {
    const { impl, calls } = stubFetch(jsonResponse(successPayload()))
    const proxy = createServerProxyRssFetch(SOURCE_ID, {
      getAccessToken: () => Promise.resolve('token-abc'),
      fetchImpl: impl,
    })
    await proxy(URL_, init)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/compliance/feed-retrieve')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toEqual({ sourceId: SOURCE_ID, capability: SUPPORTED_CAPABILITY })
    // The decisive assertion. If the URL ever travels in the body, the endpoint
    // stops being a fixed-target retriever and becomes a general-purpose
    // outbound fetch primitive that an admin session can aim anywhere.
    expect(JSON.stringify(body)).not.toContain('sukl.gov.cz')
  })

  it('sends the caller bearer token', async () => {
    const { impl, calls } = stubFetch(jsonResponse(successPayload()))
    const proxy = createServerProxyRssFetch(SOURCE_ID, {
      getAccessToken: () => Promise.resolve('token-abc'),
      fetchImpl: impl,
    })
    await proxy(URL_, init)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer token-abc')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('fails closed when there is no session, without calling the endpoint', async () => {
    const { impl, calls } = stubFetch(jsonResponse(successPayload()))
    const proxy = createServerProxyRssFetch(SOURCE_ID, {
      getAccessToken: () => Promise.resolve(null),
      fetchImpl: impl,
    })
    await expect(proxy(URL_, init)).rejects.toThrow(/no active session/)
    expect(calls).toHaveLength(0)
  })

  it('forwards the connector abort signal so its timeout still governs', async () => {
    const { impl, calls } = stubFetch(jsonResponse(successPayload()))
    const controller = new AbortController()
    const proxy = createServerProxyRssFetch(SOURCE_ID, {
      getAccessToken: () => Promise.resolve('token-abc'),
      fetchImpl: impl,
    })
    await proxy(URL_, { ...init, signal: controller.signal })
    expect(calls[0].init.signal).toBe(controller.signal)
  })
})

describe('createServerProxyRssFetch — the response it presents', () => {
  async function respond(overrides: Record<string, unknown> = {}) {
    const { impl } = stubFetch(jsonResponse(successPayload(overrides)))
    const proxy = createServerProxyRssFetch(SOURCE_ID, {
      getAccessToken: () => Promise.resolve('token-abc'),
      fetchImpl: impl,
    })
    return await proxy(URL_, init)
  }

  it('presents the feed body and the upstream content-type', async () => {
    const response = await respond()
    expect(response.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(FEED)
    // The connector requires /(rss|atom|xml)/ and rejects html. If the real
    // content-type were dropped, every feed would fail invalid_content_type.
    expect(response.headers.get('content-type')).toMatch(/rss/)
  })

  it('declares content-length, so the connector size check is not vacuous', async () => {
    const response = await respond()
    // Number(null) is 0, which passes any size limit — an absent header would
    // silently disable the check rather than fail it.
    const declared = Number(response.headers.get('content-length'))
    expect(declared).toBe(new TextEncoder().encode(FEED).length)
  })

  it('echoes the requested URL and reports no redirect', async () => {
    // The connector rejects any response whose URL differs from the request.
    // The server has already re-validated every hop against a ONE-host
    // allowlist, so reporting the hop here would fail a source that answers on
    // a canonical host, for no security gain.
    const response = await respond({ finalUrl: 'https://sukl.gov.cz/feed/index.xml', redirectChain: [URL_, 'https://sukl.gov.cz/feed/index.xml'] })
    expect(response.url).toBe(URL_)
    expect(response.redirected).toBe(false)
  })

  it('still surfaces the redirect chain for a human reading the run', async () => {
    const response = await respond({ redirectChain: [URL_, 'https://sukl.gov.cz/feed/index.xml'] })
    expect(response.headers.get('x-ddp-redirect-chain')).toContain('index.xml')
  })

  it('surfaces the content fingerprint', async () => {
    const response = await respond()
    expect(response.headers.get('x-ddp-content-fingerprint')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('createServerProxyRssFetch — failure handling', () => {
  function failing(body: unknown, status: number) {
    const { impl } = stubFetch(jsonResponse(body, status))
    const proxy = createServerProxyRssFetch(SOURCE_ID, {
      getAccessToken: () => Promise.resolve('token-abc'),
      fetchImpl: impl,
    })
    return proxy(URL_, init)
  }

  it('reports the server status AND its coded error, not a generic failure', async () => {
    // The recurring defect in this repo's AI client is collapsing every non-OK
    // status into "the provider failed", which sends an operator to the wrong
    // place. Both facts must survive to the message.
    await expect(failing({ ok: false, error: 'rate_limited' }, 429)).rejects.toThrow(/429/)
    await expect(failing({ ok: false, error: 'rate_limited' }, 429)).rejects.toThrow(/rate_limited/)
  })

  it('survives a non-JSON error body', async () => {
    const { impl } = stubFetch({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response)
    const proxy = createServerProxyRssFetch(SOURCE_ID, {
      getAccessToken: () => Promise.resolve('token-abc'),
      fetchImpl: impl,
    })
    await expect(proxy(URL_, init)).rejects.toThrow(/502/)
  })

  it('rejects an unrecognised success body rather than parsing nothing', async () => {
    await expect(failing({ ok: true }, 200)).rejects.toThrow(/unrecognised/)
  })

  it('refuses a reply for a DIFFERENT url than requested', async () => {
    // Both sides read the same stored row, so this should be impossible. If it
    // happens the registry changed mid-run or the wrong id was closed over, and
    // parsing would attribute items to the wrong source.
    const { impl } = stubFetch(jsonResponse(successPayload({ requestedUrl: 'https://elsewhere.example/feed' })))
    const proxy = createServerProxyRssFetch(SOURCE_ID, {
      getAccessToken: () => Promise.resolve('token-abc'),
      fetchImpl: impl,
    })
    await expect(proxy(URL_, init)).rejects.toThrow(/different URL/)
  })
})
