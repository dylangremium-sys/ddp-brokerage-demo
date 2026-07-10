import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserRssFetch } from './browserRssFetch'
import type { RssFetchInit } from './complianceRssConnector'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function makeInit(signal: AbortSignal): RssFetchInit {
  return {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    signal,
    headers: { 'User-Agent': 'test-agent', Accept: 'application/rss+xml' },
  }
}

describe('createBrowserRssFetch', () => {
  it('forwards the url + connector-built init to the global fetch and returns the response', async () => {
    const fakeResponse = { ok: true, status: 200, headers: { get: () => 'application/rss+xml' }, text: async () => '<rss/>' }
    const spy = vi.fn(async () => fakeResponse as unknown as Response)
    globalThis.fetch = spy as unknown as typeof fetch

    const adapter = createBrowserRssFetch()
    const controller = new AbortController()
    const init = makeInit(controller.signal)
    const resp = await adapter('https://www.example.gov/rss.xml', init)

    expect(spy).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = spy.mock.calls[0] as unknown as [string, RssFetchInit]
    expect(calledUrl).toBe('https://www.example.gov/rss.xml')
    // The safety-bearing init is forwarded verbatim; the adapter injects no credentials.
    expect(calledInit.method).toBe('GET')
    expect(calledInit.redirect).toBe('error')
    expect(calledInit.credentials).toBe('omit')
    expect(calledInit).toBe(init) // forwarded unchanged (no added cookies/tokens)
    expect(resp).toBe(fakeResponse as unknown as typeof resp)
  })

  it('propagates fetch rejections (e.g. abort / CORS) to the caller', async () => {
    globalThis.fetch = (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }) as unknown as typeof fetch
    const adapter = createBrowserRssFetch()
    const controller = new AbortController()
    await expect(adapter('https://www.example.gov/rss.xml', makeInit(controller.signal))).rejects.toThrow('aborted')
  })
})
