// Unit tests for the scheduled ingestion boundary.
//
// This route is publicly reachable over HTTPS — Vercel Cron invokes it like any
// other request — so the shared-secret check is the ONLY thing between the
// internet and an unattended outbound fetch sweep. Most of these tests are
// about that gate.

import { describe, it, expect } from 'vitest'
import {
  runScheduledIngestion,
  secretsMatch,
  presentedSecret,
  allowlistFromSources,
  type ScheduledIngestionDeps,
} from './serverScheduledIngestion'
import type { ServerIngestionRepository } from './serverIngestionRepository'
import type { RegulatorySource } from '../types'
import type { RssConnectorResult } from './complianceRssConnector'

const SECRET = 'a-sufficiently-long-cron-secret-value'
const NOW = '2026-08-02T02:00:00.000Z'

const SOURCE: RegulatorySource = {
  id: 'src-1',
  name: 'SUKL Czech Republic',
  jurisdiction: 'CZ',
  sourceType: 'government_regulator',
  url: 'https://sukl.gov.cz/feed/',
  isActive: true,
  monitoringMethod: 'rss',
  createdAt: '',
  updatedAt: '',
}

function okConnectorResult(sourceId: string): RssConnectorResult {
  return {
    ok: true,
    sourceId,
    feedKind: 'rss',
    itemCount: 0,
    decisions: [],
    feed: { kind: 'rss', title: 'x', items: [] },
    reason: 'ok',
    performsPersistence: false,
    canCreateLegalUpdate: false,
    canCreateRule: false,
    canCallAI: false,
  }
}

function makeRepository(overrides: Partial<ServerIngestionRepository> = {}): ServerIngestionRepository {
  let runSeq = 0
  return {
    fetchActiveSources: async () => [SOURCE],
    fetchKnownIdentity: async () => ({ contentHashes: [], sourceExternalIds: [] }),
    openRun: async () => ({ id: `run-${++runSeq}` }),
    closeRun: async () => ({}),
    insertItem: async () => {},
    insertCandidate: async () => ({ ok: true, legalUpdate: { id: 'lu-1' } as never }),
    ...overrides,
  }
}

function makeDeps(overrides: Partial<ScheduledIngestionDeps> = {}): ScheduledIngestionDeps {
  return {
    cronSecret: SECRET,
    repository: makeRepository(),
    buildRunConnector: () => async (source: RegulatorySource) => okConnectorResult(source.id),
    now: () => NOW,
    ...overrides,
  }
}

const authHeaders = { authorization: `Bearer ${SECRET}`, cronSecretHeader: null }

describe('secretsMatch', () => {
  it('accepts an identical secret and rejects everything else', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true)
    expect(secretsMatch(SECRET, SECRET.toUpperCase())).toBe(false)
    expect(secretsMatch(SECRET, `${SECRET}x`)).toBe(false)
    expect(secretsMatch(SECRET, SECRET.slice(0, -1))).toBe(false)
    expect(secretsMatch(SECRET, '')).toBe(false)
  })

  it('rejects a value differing only in the last character', () => {
    // The case an early-exit comparison would leak the most about.
    const almost = `${SECRET.slice(0, -1)}X`
    expect(almost.length).toBe(SECRET.length)
    expect(secretsMatch(SECRET, almost)).toBe(false)
  })
})

describe('presentedSecret', () => {
  it('reads a Bearer authorization header', () => {
    expect(presentedSecret({ authorization: 'Bearer abc', cronSecretHeader: null })).toBe('abc')
  })

  it('reads the explicit cron header and prefers it', () => {
    expect(presentedSecret({ authorization: 'Bearer abc', cronSecretHeader: 'xyz' })).toBe('xyz')
  })

  it('returns null when neither is usable', () => {
    expect(presentedSecret({ authorization: null, cronSecretHeader: null })).toBeNull()
    expect(presentedSecret({ authorization: 'abc', cronSecretHeader: null })).toBeNull()
  })
})

describe('allowlistFromSources', () => {
  it('derives hosts from the sources themselves and dedups', () => {
    expect(
      allowlistFromSources([
        SOURCE,
        { ...SOURCE, id: '2', url: 'https://sukl.gov.cz/other' },
        { ...SOURCE, id: '3', url: 'https://eur-lex.europa.eu/x' },
      ]),
    ).toEqual(['sukl.gov.cz', 'eur-lex.europa.eu'])
  })

  it('contributes nothing for an unparseable URL', () => {
    // Deny by default: the source then fails the connector's allowlist gate
    // rather than silently reaching the network.
    expect(allowlistFromSources([{ ...SOURCE, url: 'not a url' }])).toEqual([])
  })
})

describe('runScheduledIngestion — authorisation', () => {
  it('runs the sweep with a correct secret', async () => {
    const result = await runScheduledIngestion(authHeaders, 'GET', makeDeps())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, trigger: 'scheduled', sources: 1 })
  })

  it('FAILS CLOSED with 503 when CRON_SECRET is unset', async () => {
    // The decisive test. A route that becomes public when a variable is
    // forgotten is worse than no route: nothing would look broken.
    let fetched = false
    const deps = makeDeps({
      cronSecret: null,
      buildRunConnector: () => async (s: RegulatorySource) => {
        fetched = true
        return okConnectorResult(s.id)
      },
    })
    const result = await runScheduledIngestion({ authorization: null, cronSecretHeader: null }, 'GET', deps)
    expect(result.status).toBe(503)
    expect(fetched).toBe(false)
  })

  it('fails closed when the secret is unset EVEN IF a caller presents one', async () => {
    const result = await runScheduledIngestion(authHeaders, 'GET', makeDeps({ cronSecret: null }))
    expect(result.status).toBe(503)
  })

  it.each([
    [{ authorization: null, cronSecretHeader: null }, 'no credential'],
    [{ authorization: 'Bearer wrong-secret-value-here-xx', cronSecretHeader: null }, 'wrong secret'],
    [{ authorization: `Bearer ${SECRET}x`, cronSecretHeader: null }, 'secret with an extra character'],
    [{ authorization: SECRET, cronSecretHeader: null }, 'secret without the Bearer scheme'],
    [{ authorization: null, cronSecretHeader: 'nope' }, 'wrong explicit header'],
  ] as const)('rejects %j (%s)', async (headers, why) => {
    const result = await runScheduledIngestion(headers, 'GET', makeDeps())
    expect(result.status, `expected 401 for ${why}`).toBe(401)
  })

  it('tolerates surrounding whitespace on an otherwise correct secret', async () => {
    // A header value that round-trips through a config field commonly picks up
    // a trailing space. Trimming is deliberate; it does not weaken the
    // comparison, which still runs over the full trimmed value.
    const result = await runScheduledIngestion(
      { authorization: `Bearer ${SECRET} `, cronSecretHeader: null },
      'GET',
      makeDeps(),
    )
    expect(result.status).toBe(200)
  })

  it('never reaches the network on a failed authorisation', async () => {
    let fetched = false
    const deps = makeDeps({
      buildRunConnector: () => async (s: RegulatorySource) => {
        fetched = true
        return okConnectorResult(s.id)
      },
    })
    await runScheduledIngestion({ authorization: 'Bearer nope', cronSecretHeader: null }, 'GET', deps)
    expect(fetched).toBe(false)
  })

  it('never reads the source registry on a failed authorisation', async () => {
    let read = false
    const deps = makeDeps({
      repository: makeRepository({
        fetchActiveSources: async () => {
          read = true
          return [SOURCE]
        },
      }),
    })
    await runScheduledIngestion({ authorization: null, cronSecretHeader: null }, 'GET', deps)
    expect(read).toBe(false)
  })

  it('gives the same answer for a missing and a wrong secret', async () => {
    const missing = await runScheduledIngestion({ authorization: null, cronSecretHeader: null }, 'GET', makeDeps())
    const wrong = await runScheduledIngestion({ authorization: 'Bearer nope', cronSecretHeader: null }, 'GET', makeDeps())
    expect(missing).toEqual(wrong)
  })

  it('rejects an unsupported method', async () => {
    const result = await runScheduledIngestion(authHeaders, 'DELETE', makeDeps())
    expect(result.status).toBe(405)
  })

  it('accepts POST for a manual re-trigger', async () => {
    const result = await runScheduledIngestion(authHeaders, 'POST', makeDeps())
    expect(result.status).toBe(200)
  })
})

describe('runScheduledIngestion — the run itself', () => {
  it('attributes the run to the scheduler with no actor id', async () => {
    // Inventing a user id here would put a false attribution into the audit
    // evidence for every overnight run.
    const seen: Array<{ trigger: string; actorType: string; actorId: string | null }> = []
    const deps = makeDeps({
      repository: makeRepository({
        openRun: async (input) => {
          seen.push({ trigger: input.triggerType, actorType: input.actorType, actorId: input.actorId })
          return { id: 'run-1' }
        },
      }),
    })
    await runScheduledIngestion(authHeaders, 'GET', deps)
    expect(seen[0]).toEqual({ trigger: 'scheduled', actorType: 'scheduler', actorId: null })
  })

  it('reports a source-registry failure as 503 rather than a silent empty sweep', async () => {
    // A sweep that reads zero sources and reports success is the worst possible
    // outcome: the dashboard says "0 failed" and monitoring has silently stopped.
    const deps = makeDeps({
      repository: makeRepository({
        fetchActiveSources: async () => {
          throw new Error('db down')
        },
      }),
    })
    const result = await runScheduledIngestion(authHeaders, 'GET', deps)
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ error: 'sources_unavailable' })
  })

  it('summarises the batch outcome', async () => {
    const deps = makeDeps({
      repository: makeRepository({
        fetchActiveSources: async () => [SOURCE, { ...SOURCE, id: 'src-2', url: 'https://eur-lex.europa.eu/x.rss' }],
      }),
    })
    const result = await runScheduledIngestion(authHeaders, 'GET', deps)
    expect(result.body).toMatchObject({ ok: true, sources: 2, allowedHosts: 2 })
  })

  it('turns an unexpected batch failure into a 500, never an unhandled rejection', async () => {
    const deps = makeDeps({
      repository: makeRepository({
        fetchKnownIdentity: async () => {
          throw new Error('boom')
        },
      }),
    })
    const result = await runScheduledIngestion(authHeaders, 'GET', deps)
    expect(result.status).toBe(500)
  })
})
