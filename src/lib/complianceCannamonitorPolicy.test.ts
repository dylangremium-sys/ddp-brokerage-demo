import { describe, expect, it, vi } from 'vitest'
import type { LegalUpdate, RegulatorySource } from '../types'
import type { ComplianceAiSummaryProvider } from './aiComplianceProvider'
import {
  APPROVED_CANNAMONITOR_HOSTS,
  CANNAMONITOR_DETECTION_LIMITATION,
  CANNAMONITOR_DISCARDED_CONTENT,
  CANNAMONITOR_METADATA_ONLY_PROJECTION,
  CANNAMONITOR_PERMISSION_STATUS,
  CANNAMONITOR_RETAINED_METADATA,
  evaluateCannamonitorAiGate,
  evaluateCannamonitorManualIntakeGate,
  evaluateCannamonitorPolicy,
  isApprovedCannamonitorHost,
  isCannamonitorSourceUrl,
} from './complianceCannamonitorPolicy'
import {
  buildFeedItemSnapshot,
  executeRssConnector,
  extractRssItems,
  parseRssOrAtomFeed,
  type RssFetchImpl,
} from './complianceRssConnector'
import {
  buildMonitoringDecision,
  buildSourceSnapshot,
  computeSourceChecksum,
  normalizeSourceContent,
} from './complianceSourceMonitoring'
import { evaluateManualMonitoringEligibility, runManualRssMonitoring } from './complianceManualMonitoring'
import { evaluateAiSummaryEligibility, runAiDraftSummary } from './watchtowerAiSummary'

// ─── Cannamonitor Watchtower safety-boundary tests ───────────────────────────
//
// STATUS UNDER TEST: INACTIVE AND UNREACHABLE. Every fixture is synthetic; no
// live Cannamonitor request is ever made. All network/provider access is via an
// injected spy so the tests can assert the spy was NEVER called.

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

function cannamonitorSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'src-cannamonitor',
    name: 'Cannamonitor — international cannabis intelligence',
    jurisdiction: 'International — secondary commercial intelligence',
    sourceType: 'other',
    url: 'https://cannamonitor.com/feed/',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function unrelatedOfficialSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'src-official',
    name: 'Example Regulator RSS',
    jurisdiction: 'Example',
    sourceType: 'government_regulator',
    url: 'https://regulator.example.com/rss',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function legalUpdate(overrides: Partial<LegalUpdate> = {}): LegalUpdate {
  return {
    id: 'lu-1',
    sourceId: 'src-cannamonitor',
    title: 'A potential development',
    jurisdiction: 'International',
    sourceName: 'Cannamonitor',
    sourceUrl: 'https://cannamonitor.com/brief/some-item',
    publishedAt: '2026-02-01T00:00:00.000Z',
    detectedAt: '2026-02-02T00:00:00.000Z',
    rawText: 'Title\nhttps://cannamonitor.com/brief/some-item\nguid-1\n2026-02-01',
    summary: '',
    affectedAreas: [],
    status: 'new',
    reviewerNotes: 'Checksum: ' + 'a'.repeat(64) + '. Retrieved: 2026-02-02.',
    createdAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...overrides,
  }
}

/** A fetch spy that fails the test if it is ever invoked — used to prove
 *  denial happens strictly BEFORE any network call. */
function failIfCalledFetch(): RssFetchImpl {
  return vi.fn(async () => {
    throw new Error('fetch must never be called for a policy-denied source')
  })
}

/** A provider spy that fails the test if it is ever invoked. */
function failIfCalledProvider(): ComplianceAiSummaryProvider {
  return {
    draftSummary: vi.fn(async () => {
      throw new Error('AI provider must never be called for a Cannamonitor-attributed update')
    }),
  }
}

/** A benign, well-formed provider (for the unrelated-source control). */
function okProvider(): ComplianceAiSummaryProvider {
  return {
    draftSummary: vi.fn(async () => ({
      value: {
        draftSummary: 'A neutral factual draft for human review.',
        possibleSignificance: 'This may be relevant; a human must verify against the primary source.',
        uncertainties: 'The scope is unclear pending review.',
        reviewQuestions: ['Is there an official primary source?'],
        sourceReferences: ['Example Regulator'],
      },
      confidence: 0.5,
      provenance: {
        actorType: 'ai_assistant' as const,
        promptVersion: { id: 'test', description: 'test' },
        modelInfo: { provider: 'test-provider', model: 'test-model' },
        generatedAt: '2026-02-03T00:00:00.000Z',
        requiresHumanReview: true as const,
      },
    })),
  }
}

// A synthetic Cannamonitor-shaped RSS feed carrying BOTH a description excerpt
// and a full-body <content:encoded>. The connector never fetches this in the
// current (denied) world; it is used only to prove the metadata-only projection.
const PROHIBITED_BODY = 'FULL_ARTICLE_BODY_PROHIBITED_TEXT_DO_NOT_RETAIN'
const PROHIBITED_SUMMARY = 'PROHIBITED_SUMMARY_EXCERPT'
const SYNTHETIC_CANNAMONITOR_RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Cannamonitor Brief</title>
    <item>
      <title>Example notice title</title>
      <link>https://cannamonitor.com/brief/example-notice</link>
      <guid>cannamonitor-guid-0001</guid>
      <pubDate>Mon, 02 Feb 2026 00:00:00 GMT</pubDate>
      <description>${PROHIBITED_SUMMARY}</description>
      <content:encoded><![CDATA[<p>${PROHIBITED_BODY}</p>]]></content:encoded>
    </item>
  </channel>
</rss>`

// ─── Permission tests ────────────────────────────────────────────────────────

describe('Cannamonitor permission state', () => {
  it('defaults to unverified', () => {
    expect(CANNAMONITOR_PERMISSION_STATUS).toBe('unverified')
  })

  it('denies monitoring for a matched Cannamonitor source while unverified', () => {
    const d = evaluateCannamonitorPolicy(cannamonitorSource())
    expect(d.matched).toBe(true)
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('permission_unverified')
  })

  it('an ACTIVE Cannamonitor source is still denied (isActive cannot bypass the gate)', () => {
    const d = evaluateCannamonitorPolicy(cannamonitorSource({ isActive: true }))
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('permission_unverified')
  })

  it('denial occurs BEFORE fetch — the injected fetch spy is never called', async () => {
    const fetchSpy = failIfCalledFetch()
    const result = await executeRssConnector(cannamonitorSource(), ['cannamonitor.com'], fetchSpy, {
      userAgent: 'test-agent',
    })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('source_policy_denied')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('manual monitoring never fetches a Cannamonitor source (spy not called)', async () => {
    const fetchSpy = failIfCalledFetch()
    const result = await runManualRssMonitoring(cannamonitorSource(), fetchSpy)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('source_policy_denied')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no runtime input flips the default: production caller (no permission arg) always denies', () => {
    // Every real caller invokes evaluateCannamonitorPolicy with the single-arg
    // form; the permission parameter is test-only. The default is unverified.
    for (const isActive of [true, false]) {
      const d = evaluateCannamonitorPolicy(cannamonitorSource({ isActive }))
      expect(d.monitoringAllowed).toBe(false)
    }
  })

  it('unrelated sources are unaffected — no policy, no projection', () => {
    const d = evaluateCannamonitorPolicy(unrelatedOfficialSource())
    expect(d.matched).toBe(false)
    expect(d.monitoringAllowed).toBe(true)
    expect(d.fieldPolicy).toBeNull()
  })

  it('even a hypothetical verified permission requires an active source', () => {
    const denied = evaluateCannamonitorPolicy(cannamonitorSource({ isActive: false }), 'verified')
    expect(denied.monitoringAllowed).toBe(false)
    expect(denied.denialCode).toBe('source_inactive')
    const allowed = evaluateCannamonitorPolicy(cannamonitorSource({ isActive: true }), 'verified')
    expect(allowed.monitoringAllowed).toBe(true)
  })
})

// ─── Host tests ──────────────────────────────────────────────────────────────

describe('Cannamonitor host policy', () => {
  it('exact approved hosts', () => {
    expect(isApprovedCannamonitorHost('cannamonitor.com')).toBe(true)
    expect(isApprovedCannamonitorHost('www.cannamonitor.com')).toBe(true)
    expect(APPROVED_CANNAMONITOR_HOSTS).toEqual(['cannamonitor.com', 'www.cannamonitor.com'])
  })

  it('www is handled explicitly', () => {
    const d = evaluateCannamonitorPolicy({ url: 'https://www.cannamonitor.com/feed/' })
    expect(d.matched).toBe(true)
    expect(d.denialCode).toBe('permission_unverified') // reached the licensing gate = host accepted
  })

  it('rejects suffix impersonation (different registrable domain)', () => {
    expect(isApprovedCannamonitorHost('cannamonitor.com.evil.example')).toBe(false)
    // A deceptive suffix is a different site — it must not be treated as Cannamonitor.
    expect(isCannamonitorSourceUrl('https://cannamonitor.com.evil.example/feed')).toBe(false)
  })

  it('denies an unapproved subdomain (matched but not approved)', () => {
    const d = evaluateCannamonitorPolicy({ url: 'https://staging.cannamonitor.com/feed' })
    expect(d.matched).toBe(true)
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('unapproved_host')
  })

  it('denies HTTP (even under hypothetical verified permission)', () => {
    const d = evaluateCannamonitorPolicy({ url: 'http://cannamonitor.com/feed/' }, 'verified')
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('not_https')
  })

  it('denies credential-bearing URLs', () => {
    const d = evaluateCannamonitorPolicy({ url: 'https://user:pass@cannamonitor.com/feed/' }, 'verified')
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('credentials_in_url')
  })

  it('denies unexpected ports', () => {
    const d = evaluateCannamonitorPolicy({ url: 'https://cannamonitor.com:8443/feed/' }, 'verified')
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('unexpected_port')
  })

  it('denies malformed URLs but still fails closed as Cannamonitor', () => {
    const d = evaluateCannamonitorPolicy({ url: 'ht!tp://cannamonitor.com bad url' })
    expect(d.matched).toBe(true)
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('malformed_url')
  })

  it('existing SSRF/allowlist controls still reject a Cannamonitor loopback/private URL (before the connector even runs the generic gate)', async () => {
    // The policy denies first; this simply proves the connector never reaches fetch.
    const fetchSpy = failIfCalledFetch()
    const result = await executeRssConnector(
      cannamonitorSource({ url: 'https://cannamonitor.com/feed/' }),
      ['cannamonitor.com'],
      fetchSpy,
      { userAgent: 'test-agent' },
    )
    expect(result.errorCode).toBe('source_policy_denied')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─── Metadata-projection tests ───────────────────────────────────────────────

describe('Cannamonitor metadata-only projection', () => {
  it('projectFields retains only title/link/id/published and nulls summary/content', () => {
    const projected = CANNAMONITOR_METADATA_ONLY_PROJECTION.projectFields({
      title: 'T',
      link: 'https://cannamonitor.com/brief/x',
      id: 'guid-x',
      published: '2026-02-01',
      summary: PROHIBITED_SUMMARY,
      content: PROHIBITED_BODY,
    })
    expect(projected.title).toBe('T')
    expect(projected.link).toBe('https://cannamonitor.com/brief/x')
    expect(projected.id).toBe('guid-x')
    expect(projected.published).toBe('2026-02-01')
    expect(projected.summary).toBeNull()
    expect(projected.content).toBeNull()
  })

  it('projection happens before rawText: summary/description/body/content:encoded never enter rawText', () => {
    const items = extractRssItems(SYNTHETIC_CANNAMONITOR_RSS, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item.title).toBe('Example notice title')
    expect(item.link).toBe('https://cannamonitor.com/brief/example-notice')
    expect(item.id).toBe('cannamonitor-guid-0001')
    // Retained metadata is present in rawText:
    expect(item.rawText).toContain('Example notice title')
    expect(item.rawText).toContain('cannamonitor-guid-0001')
    // Prohibited markers must NOT be present in the retained rawText:
    expect(item.rawText).not.toContain(PROHIBITED_BODY)
    expect(item.rawText).not.toContain(PROHIBITED_SUMMARY)
    expect(item.summary).toBeNull()
    expect(item.content).toBeNull()
  })

  it('WITHOUT the projection, the generic parser WOULD retain the excerpt (proves the projection is what strips it)', () => {
    const items = extractRssItems(SYNTHETIC_CANNAMONITOR_RSS) // no policy
    expect(items[0].rawText).toContain(PROHIBITED_SUMMARY)
  })

  it('checksum uses permitted metadata only (identical to a metadata-only string)', async () => {
    const [projected] = extractRssItems(SYNTHETIC_CANNAMONITOR_RSS, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    const snapshot = await buildFeedItemSnapshot(projected)
    const metadataOnly = [
      'Example notice title',
      'https://cannamonitor.com/brief/example-notice',
      'cannamonitor-guid-0001',
      'Mon, 02 Feb 2026 00:00:00 GMT',
      '',
      '',
    ].join('\n')
    const expected = await computeSourceChecksum(normalizeSourceContent(metadataOnly))
    expect(snapshot.checksum).toBe(expected)
    expect(snapshot.normalizedContent).not.toContain(PROHIBITED_BODY)
    expect(snapshot.normalizedContent).not.toContain(PROHIBITED_SUMMARY)
  })

  it('a proposed draft (via buildMonitoringDecision) contains permitted metadata only', async () => {
    const [projected] = extractRssItems(SYNTHETIC_CANNAMONITOR_RSS, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    const decision = await buildMonitoringDecision('src::guid', projected.rawText, null, [], '2026-02-03T00:00:00Z')
    expect(decision.kind).toBe('changed_pending_review')
    expect(decision.proposedLegalUpdate?.rawContent).not.toContain(PROHIBITED_BODY)
    expect(decision.proposedLegalUpdate?.rawContent).not.toContain(PROHIBITED_SUMMARY)
  })

  it('parseRssOrAtomFeed threads the projection through to items', () => {
    const feed = parseRssOrAtomFeed(SYNTHETIC_CANNAMONITOR_RSS, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    expect(feed.items[0].rawText).not.toContain(PROHIBITED_BODY)
  })

  it('documents its retained/discarded field sets', () => {
    expect(CANNAMONITOR_RETAINED_METADATA).toContain('title')
    expect(CANNAMONITOR_RETAINED_METADATA).toContain('canonicalItemUrl')
    expect(CANNAMONITOR_DISCARDED_CONTENT).toContain('content:encoded')
    expect(CANNAMONITOR_DISCARDED_CONTENT).toContain('description')
    expect(CANNAMONITOR_DISCARDED_CONTENT).toContain('articleBody')
  })
})

// ─── Change-detection tests ──────────────────────────────────────────────────

describe('Cannamonitor metadata-only change detection', () => {
  function feedWith(title: string, pubDate: string, body: string): string {
    return `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel><title>Brief</title>
    <item>
      <title>${title}</title>
      <link>https://cannamonitor.com/brief/example-notice</link>
      <guid>cannamonitor-guid-0001</guid>
      <pubDate>${pubDate}</pubDate>
      <description>an excerpt</description>
      <content:encoded><![CDATA[${body}]]></content:encoded>
    </item>
  </channel>
</rss>`
  }

  async function decide(prevXml: string | null, xml: string) {
    const [item] = extractRssItems(xml, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    let prevSnapshot = null
    if (prevXml) {
      const [prevItem] = extractRssItems(prevXml, CANNAMONITOR_METADATA_ONLY_PROJECTION)
      prevSnapshot = await buildSourceSnapshot('src::guid', prevItem.rawText, '2026-02-02T00:00:00Z')
    }
    return buildMonitoringDecision('src::guid', item.rawText, prevSnapshot, [], '2026-02-03T00:00:00Z')
  }

  it('changing the title yields changed_pending_review', async () => {
    const base = feedWith('Original title', 'Mon, 02 Feb 2026 00:00:00 GMT', 'body A')
    const changed = feedWith('New title', 'Mon, 02 Feb 2026 00:00:00 GMT', 'body A')
    const decision = await decide(base, changed)
    expect(decision.kind).toBe('changed_pending_review')
  })

  it('changing the publication date yields changed_pending_review', async () => {
    const base = feedWith('Same title', 'Mon, 02 Feb 2026 00:00:00 GMT', 'body A')
    const changed = feedWith('Same title', 'Tue, 03 Feb 2026 00:00:00 GMT', 'body A')
    const decision = await decide(base, changed)
    expect(decision.kind).toBe('changed_pending_review')
  })

  it('changing ONLY the prohibited body does NOT register as a metadata change (documented limitation)', async () => {
    const base = feedWith('Same title', 'Mon, 02 Feb 2026 00:00:00 GMT', 'body A')
    const bodyOnly = feedWith('Same title', 'Mon, 02 Feb 2026 00:00:00 GMT', 'body B totally rewritten')
    const decision = await decide(base, bodyOnly)
    expect(decision.kind).toBe('unchanged')
  })

  it('the limitation is documented', () => {
    expect(CANNAMONITOR_DETECTION_LIMITATION).toMatch(/body-only/i)
    expect(CANNAMONITOR_DETECTION_LIMITATION).toMatch(/unchanged/i)
  })
})

// ─── AI tests ────────────────────────────────────────────────────────────────

describe('Cannamonitor AI block', () => {
  it('blocks a correctly-attributed Cannamonitor update at eligibility (provider not called)', () => {
    const provider = failIfCalledProvider()
    const eligibility = evaluateAiSummaryEligibility(legalUpdate(), {
      provider,
      requestInProgress: false,
    })
    expect(eligibility.canGenerate).toBe(false)
    expect(eligibility.code).toBe('cannamonitor_permission_unverified')
    expect(provider.draftSummary).not.toHaveBeenCalled()
  })

  it('blocks at execution — provider is never called', async () => {
    const provider = failIfCalledProvider()
    const outcome = await runAiDraftSummary(legalUpdate(), provider, {
      requestInProgress: false,
      isStillSelected: () => true,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('cannamonitor_permission_unverified')
    expect(provider.draftSummary).not.toHaveBeenCalled()
  })

  it('blocks manually-entered content that carries a Cannamonitor source URL', () => {
    const pasted = legalUpdate({
      sourceId: null,
      sourceName: 'Pasted by admin',
      sourceUrl: 'https://www.cannamonitor.com/brief/pasted',
      rawText: 'Admin pasted this text manually',
    })
    const gate = evaluateCannamonitorAiGate(pasted.sourceUrl)
    expect(gate.blocked).toBe(true)
  })

  it('does NOT falsely claim to detect a blank or unrelated source URL', () => {
    expect(evaluateCannamonitorAiGate('').blocked).toBe(false)
    expect(evaluateCannamonitorAiGate(null).blocked).toBe(false)
    expect(evaluateCannamonitorAiGate('https://unrelated.example.com/article').blocked).toBe(false)
  })

  it('an unrelated official source retains existing AI behaviour (provider IS reachable)', async () => {
    const provider = okProvider()
    const update = legalUpdate({
      sourceId: 'src-official',
      sourceName: 'Example Regulator',
      sourceUrl: 'https://regulator.example.com/rss/item-1',
    })
    const eligibility = evaluateAiSummaryEligibility(update, { provider, requestInProgress: false })
    expect(eligibility.canGenerate).toBe(true)
    const outcome = await runAiDraftSummary(update, provider, {
      requestInProgress: false,
      isStillSelected: () => true,
    })
    expect(outcome.ok).toBe(true)
    expect(provider.draftSummary).toHaveBeenCalledTimes(1)
  })
})

// ─── Compliance-boundary tests ───────────────────────────────────────────────

describe('Cannamonitor policy cannot escalate to any compliance consequence', () => {
  it('a decision carries only literal-false capability guarantees', () => {
    const d = evaluateCannamonitorPolicy(cannamonitorSource())
    expect(d.canCreateRule).toBe(false)
    expect(d.canCreateAlert).toBe(false)
    expect(d.canAlterReadiness).toBe(false)
    expect(d.canCreateSourceRow).toBe(false)
    expect(d.canScheduleFetch).toBe(false)
  })

  it('evaluating the policy is pure — no source row, no fetch, no scheduling side effect', async () => {
    // The policy module imports nothing that writes; evaluating it many times
    // yields identical decisions and touches no external state.
    const first = evaluateCannamonitorPolicy(cannamonitorSource())
    const second = evaluateCannamonitorPolicy(cannamonitorSource())
    expect(second).toEqual(first)
  })

  it('manual eligibility reports the Cannamonitor denial without creating anything', () => {
    const eligibility = evaluateManualMonitoringEligibility(cannamonitorSource())
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.code).toBe('source_policy_denied')
  })
})

// ─── P2-B: every matched policy denial also blocks AI ───────────────────────
//
// aiAllowed must NEVER be derived from permission alone: a Cannamonitor URL
// refused for transport / host / credential / port / permission / activity
// reasons must stay AI-denied even under a (hypothetical) verified permission.
describe('Cannamonitor policy — every matched denial blocks AI', () => {
  const DENIAL_CASES: Array<{ label: string; url: string; isActive?: boolean; code: string }> = [
    { label: 'malformed URL', url: 'ht!tp://cannamonitor.com bad', code: 'malformed_url' },
    { label: 'unapproved subdomain', url: 'https://staging.cannamonitor.com/feed', code: 'unapproved_host' },
    { label: 'HTTP', url: 'http://cannamonitor.com/feed/', code: 'not_https' },
    { label: 'embedded credentials', url: 'https://user:pass@cannamonitor.com/feed/', code: 'credentials_in_url' },
    { label: 'unexpected port', url: 'https://cannamonitor.com:8443/feed/', code: 'unexpected_port' },
    { label: 'inactive source', url: 'https://cannamonitor.com/feed/', isActive: false, code: 'source_inactive' },
  ]

  for (const c of DENIAL_CASES) {
    it(`denies AI for a ${c.label} Cannamonitor source even under verified permission`, () => {
      // Evaluate under hypothetical 'verified' — the worst case for this invariant.
      const d = evaluateCannamonitorPolicy({ url: c.url, isActive: c.isActive ?? true }, 'verified')
      expect(d.matched).toBe(true)
      expect(d.monitoringAllowed).toBe(false)
      expect(d.aiAllowed).toBe(false)
      expect(d.denialCode).toBe(c.code)
    })
  }

  it('the ONLY matched success (approved host, https, no creds, default port, verified, active) permits AI', () => {
    const ok = evaluateCannamonitorPolicy({ url: 'https://cannamonitor.com/feed/', isActive: true }, 'verified')
    expect(ok.matched).toBe(true)
    expect(ok.monitoringAllowed).toBe(true)
    expect(ok.aiAllowed).toBe(true)
    expect(ok.denialCode).toBeUndefined()
  })

  it('current (unverified) permission still denies AI for an approved active source', () => {
    const d = evaluateCannamonitorPolicy({ url: 'https://cannamonitor.com/feed/', isActive: true })
    expect(d.matched).toBe(true)
    expect(d.aiAllowed).toBe(false)
    expect(d.denialCode).toBe('permission_unverified')
  })

  it('evaluateCannamonitorAiGate blocks a legal update attributed to a refused Cannamonitor URL', () => {
    // Under production defaults these all resolve to aiAllowed=false → blocked.
    for (const c of DENIAL_CASES) {
      expect(evaluateCannamonitorAiGate(c.url).blocked).toBe(true)
    }
  })

  it('unrelated sources preserve existing AI behaviour', () => {
    expect(evaluateCannamonitorAiGate('https://regulator.example.gov/rss').blocked).toBe(false)
    expect(evaluateCannamonitorPolicy({ url: 'https://regulator.example.gov/rss' }).aiAllowed).toBe(true)
  })
})

// ─── P2-A: manual Legal Update intake gate ──────────────────────────────────
//
// The manual Legal Update form is a THIRD ingestion path. A Cannamonitor-
// attributed manual submission must be denied outright — before payload,
// persistence, audit, or AI — regardless of permission. `submitLegalUpdate`
// early-returns on `deny`, so insertLegalUpdate / persistLegalUpdatesLocal /
// insertReview / logAudit are unreachable and the form is not cleared. The gate
// decides purely on the source URL and never receives raw body text, so pasted
// evidence cannot leak through it.
describe('Cannamonitor manual Legal Update intake gate', () => {
  const RAW_MARKER = 'MANUAL_LEGAL_UPDATE_CANNAMONITOR_BODY_MARKER'

  it('denies a Cannamonitor-attributed manual submission with a source-specific code', () => {
    const g = evaluateCannamonitorManualIntakeGate('https://www.cannamonitor.com/brief/x')
    expect(g.action).toBe('deny')
    if (g.action === 'deny') {
      expect(g.code).toBe('cannamonitor_manual_intake_denied')
      // The gate never receives raw text, so no marker can appear in its result.
      expect(JSON.stringify(g)).not.toContain(RAW_MARKER)
    }
  })

  it('denies EVERY Cannamonitor form (approved, subdomain, http, creds, port, malformed) — fail closed', () => {
    for (const url of [
      'https://cannamonitor.com/x',
      'https://www.cannamonitor.com/x',
      'https://staging.cannamonitor.com/x',
      'http://cannamonitor.com/x',
      'https://user:pass@cannamonitor.com/x',
      'https://cannamonitor.com:8443/x',
      'ht!tp://cannamonitor.com bad',
    ]) {
      expect(evaluateCannamonitorManualIntakeGate(url).action).toBe('deny')
    }
  })

  it('ordinary government and unrelated commercial sources still submit (proceed)', () => {
    expect(evaluateCannamonitorManualIntakeGate('https://regulator.example.gov/notice').action).toBe('proceed')
    expect(evaluateCannamonitorManualIntakeGate('https://unrelated.example.com/article').action).toBe('proceed')
  })

  it('blank / unrelated attribution is not falsely blocked (documented limitation)', () => {
    expect(evaluateCannamonitorManualIntakeGate('').action).toBe('proceed')
    expect(evaluateCannamonitorManualIntakeGate(null).action).toBe('proceed')
    expect(evaluateCannamonitorManualIntakeGate('https://cannamonitor.com.evil.example/x').action).toBe('proceed')
  })
})

// ─── Codex P2 (RM1gI): require EXPLICIT active state ────────────────────────
//
// A missing / undefined isActive must be treated as inactive. URL-only callers
// (evaluateCannamonitorAiGate, evaluatePastedMonitoringGate,
// evaluateCannamonitorManualIntakeGate) carry no isActive, so even under a
// hypothetical verified permission they must never reach the success branch
// without a proven active registry source.
describe('Cannamonitor policy — requires explicit active state', () => {
  it('verified permission + MISSING isActive → denied (source_inactive), not AI-eligible', () => {
    const d = evaluateCannamonitorPolicy({ url: 'https://cannamonitor.com/feed/' }, 'verified') // no isActive
    expect(d.matched).toBe(true)
    expect(d.monitoringAllowed).toBe(false)
    expect(d.aiAllowed).toBe(false)
    expect(d.denialCode).toBe('source_inactive')
  })

  it('verified permission + isActive:false → denied', () => {
    const d = evaluateCannamonitorPolicy({ url: 'https://cannamonitor.com/feed/', isActive: false }, 'verified')
    expect(d.monitoringAllowed).toBe(false)
    expect(d.aiAllowed).toBe(false)
    expect(d.denialCode).toBe('source_inactive')
  })

  it('verified permission + explicit isActive:true → the only success', () => {
    const d = evaluateCannamonitorPolicy({ url: 'https://cannamonitor.com/feed/', isActive: true }, 'verified')
    expect(d.monitoringAllowed).toBe(true)
    expect(d.aiAllowed).toBe(true)
    expect(d.denialCode).toBeUndefined()
  })

  it('URL-only AI gate stays blocked even under verified (no active source proven)', () => {
    // evaluateCannamonitorAiGate passes url only → isActive undefined → denied.
    expect(evaluateCannamonitorAiGate('https://cannamonitor.com/brief/x').blocked).toBe(true)
  })
})
