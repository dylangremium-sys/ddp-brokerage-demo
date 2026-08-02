// ─── Live regulatory-source retrieval check ─────────────────────────────────
//
// Performs REAL server-side HTTPS requests to the REGISTERED watchtower sources
// through the full safety gate. Skipped unless DDP_LIVE_SOURCE=1, so ordinary
// test runs and CI never depend on an external site being up.
//
//   DDP_LIVE_SOURCE=1 npm test -- serverSourceRetrieval.integration
//
// This is the test that demonstrates the premise of server-side retrieval: the
// same feeds are unreachable from a browser — neither sends an
// Access-Control-Allow-Origin header, and the deployed CSP refuses them before
// CORS is even consulted (docs/CSP_FEED_RETRIEVAL_DECISION.md) — and are
// retrieved without difficulty from a server.
//
// It reads the source list from the registry rather than hard-coding a URL, so
// the test cannot drift away from what the application actually monitors.
//
// Assertions are structural — that a retrieval succeeds, is fingerprinted, and
// yields parseable feed markup. Nothing about an authority's current wording is
// asserted, because that changes and is not ours to pin.

import { describe, it, expect } from 'vitest'
import { retrieveOfficialSource } from './serverSourceRetrieval'
import { normalizeConnectorHost } from './complianceSourceUrlSafety'
import { WATCHTOWER_STARTER_SOURCES } from './watchtowerStarterSources'

const live = process.env.DDP_LIVE_SOURCE === '1'

const FEED_SOURCES = WATCHTOWER_STARTER_SOURCES.filter(s => s.monitoringMethod === 'rss')

describe.skipIf(!live)('live regulatory feed retrieval', () => {
  it('has feed sources to exercise', () => {
    // Guards against the list being filtered down to nothing by a registry
    // change, which would leave every it.each below silently unrun.
    expect(FEED_SOURCES.length).toBeGreaterThan(0)
  })

  it.each(FEED_SOURCES.map(s => [s.name, s.url] as const))(
    'retrieves %s server-side through the full safety gate',
    async (_name, url) => {
      const host = normalizeConnectorHost(url)
      expect(host).not.toBeNull()
      const policy = { allowedHosts: [host as string] }

      const result = await retrieveOfficialSource({
        url,
        policy,
        retrievedAt: new Date().toISOString(),
      })

      expect(result.status, `retrieval failed: ${result.reason}`).toBe('retrieved')
      expect(result.httpStatus).toBe(200)
      expect(result.contentFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(result.finalUrl).toBeTruthy()
      expect(result.byteLength).toBeGreaterThan(0)

      // Every hop stayed on the allowlisted host.
      for (const hop of result.redirectChain) {
        expect(policy.allowedHosts).toContain(new URL(hop).hostname.toLowerCase())
      }

      // Feed markup must survive intact. If the HTML text-stripper ever starts
      // applying to feeds, this is where it shows up — the downstream parser
      // would otherwise report zero items, which reads as "the regulator
      // published nothing" rather than as a bug.
      expect(result.content).toMatch(/<(rss|feed|rdf:RDF)[\s>]/i)
    },
    30_000,
  )

  it('still refuses a non-allowlisted host with the live fetcher', async () => {
    const result = await retrieveOfficialSource({
      url: 'https://example.com/',
      policy: { allowedHosts: [normalizeConnectorHost(FEED_SOURCES[0].url) as string] },
      retrievedAt: new Date().toISOString(),
    })
    expect(result.status).toBe('rejected_not_allowlisted')
  })
})
