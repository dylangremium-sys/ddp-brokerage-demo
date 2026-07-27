// ─── Live official-source retrieval check (Gate P0 — issue #77) ─────────────
//
// Performs a REAL server-side HTTPS request to the configured Thai FDA source
// through the full safety gate. Skipped unless DDP_LIVE_SOURCE=1, so ordinary
// test runs and CI never depend on an external site being up.
//
//   DDP_LIVE_SOURCE=1 npm test -- serverSourceRetrieval.integration
//
// Assertions are structural — that a real retrieval succeeds, is fingerprinted,
// and yields readable text. Nothing about the authority's current wording is
// asserted, because that changes and is not ours to pin.

import { describe, it, expect } from 'vitest'
import { retrieveOfficialSource } from './serverSourceRetrieval'
import { THAI_FDA_SOURCE, COA_SOURCE_POLICY, COA_RELEVANCE_TERMS } from './coaOfficialSources'
import { selectRelevantSection } from './serverSourceRetrieval'

const live = process.env.DDP_LIVE_SOURCE === '1'

describe.skipIf(!live)('live Thai FDA retrieval', () => {
  it('retrieves the configured official source server-side', async () => {
    const result = await retrieveOfficialSource({
      url: THAI_FDA_SOURCE.url,
      policy: COA_SOURCE_POLICY,
      retrievedAt: new Date().toISOString(),
    })

    expect(result.status, `retrieval failed: ${result.reason}`).toBe('retrieved')
    expect(result.httpStatus).toBe(200)
    expect(result.contentFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(result.finalUrl).toBeTruthy()
    expect(result.byteLength).toBeGreaterThan(0)
    expect((result.content ?? '').length).toBeGreaterThan(0)

    // Every hop stayed on an allowlisted host.
    for (const url of result.redirectChain) {
      expect(COA_SOURCE_POLICY.allowedHosts).toContain(new URL(url).hostname.toLowerCase())
    }

    // A relevant section can be selected verbatim from what was served.
    const section = selectRelevantSection(result.content ?? '', COA_RELEVANCE_TERMS)
    expect(section.section.length).toBeGreaterThan(0)
    for (const line of section.section.split('\n')) {
      expect(result.content).toContain(line)
    }
  }, 30_000)

  it('still refuses a non-allowlisted host with the live fetcher', async () => {
    const result = await retrieveOfficialSource({
      url: 'https://example.com/',
      policy: COA_SOURCE_POLICY,
      retrievedAt: new Date().toISOString(),
    })
    expect(result.status).toBe('rejected_not_allowlisted')
  })
})
