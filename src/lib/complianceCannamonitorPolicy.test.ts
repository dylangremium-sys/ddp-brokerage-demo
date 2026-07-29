import { describe, it, expect, vi } from 'vitest'
import type { LegalUpdate, RegulatorySource } from '../types'
import {
  APPROVED_CANNAMONITOR_HOSTS,
  CANNAMONITOR_METADATA_ONLY_PROJECTION,
  CANNAMONITOR_PERMISSION_STATUS,
  evaluateCannamonitorPolicy,
  isApprovedCannamonitorHost,
  isCannamonitorSourceUrl,
} from './complianceCannamonitorPolicy'
import {
  buildRssMonitoringDecisions,
  executeRssConnector,
  parseRssOrAtomFeed,
  type RssFetchImpl,
} from './complianceRssConnector'
import { evaluateManualMonitoringEligibility, runManualRssMonitoring } from './complianceManualMonitoring'
import { evaluateAiSummaryEligibility, runAiDraftSummary } from './watchtowerAiSummary'
import type { ComplianceAiSummaryProvider } from './aiComplianceProvider'

// ─── Synthetic fixtures ──────────────────────────────────────────────────────
//
// NO REAL CANNAMONITOR TEXT APPEARS ANYWHERE IN THIS FILE. Every article-like
// string below is invented and carries a marker token so a test can assert it is
// absent. Article links point at reserved example domains. No test performs a
// live request — every fetch is an injected spy that fails the test if called.

const EXCERPT = 'PROHIBITED_DESCRIPTION_MARKER synthetic teaser text'
const BODY = 'PROHIBITED_FULLBODY_MARKER synthetic article body paragraph'
const PROHIBITED = [EXCERPT, BODY, 'PROHIBITED_DESCRIPTION_MARKER', 'PROHIBITED_FULLBODY_MARKER', '<p>', '<div']

function source(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    id: 'src-canna',
    name: 'Cannamonitor — international cannabis intelligence',
    jurisdiction: 'International — secondary commercial intelligence',
    sourceType: 'other',
    url: 'https://cannamonitor.com/feed/',
    isActive: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A synthetic RSS 2.0 feed shaped like the real one: description excerpt AND a
 *  content:encoded full body. Content is entirely invented. */
const CANNA_SHAPED_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Synthetic Intelligence Brief</title>
  <item>
    <title>Synthetic Regulatory Development Alpha</title>
    <link>https://example.com/brief/alpha</link>
    <guid isPermaLink="false">https://example.com/?p=101</guid>
    <pubDate>Fri, 10 Jul 2026 09:00:00 +0000</pubDate>
    <description><![CDATA[${EXCERPT}]]></description>
    <content:encoded><![CDATA[<div class="a"><p>${BODY}</p></div>]]></content:encoded>
  </item>
  <item>
    <title>Synthetic Regulatory Development Beta</title>
    <link>https://example.com/brief/beta</link>
    <guid isPermaLink="false">https://example.com/?p=102</guid>
    <pubDate>Fri, 03 Jul 2026 09:00:00 +0000</pubDate>
    <description><![CDATA[${EXCERPT}]]></description>
    <content:encoded><![CDATA[<p>${BODY}</p>]]></content:encoded>
  </item>
</channel>
</rss>`

/** A fetch impl that fails the test if it is ever called. */
const forbiddenFetch: RssFetchImpl = vi.fn(async () => {
  throw new Error('NETWORK CALL ATTEMPTED — the policy gate failed to stop retrieval')
}) as unknown as RssFetchImpl

function legalUpdate(overrides: Partial<LegalUpdate> = {}): LegalUpdate {
  return {
    id: 'lu-1',
    sourceId: 'src-canna',
    title: 'Synthetic Regulatory Development Alpha',
    jurisdiction: 'International',
    sourceName: 'Cannamonitor',
    sourceUrl: 'https://cannamonitor.com/brief/alpha',
    publishedAt: '2026-07-10T09:00:00.000Z',
    detectedAt: '2026-07-11T09:00:00.000Z',
    rawText: `Synthetic Regulatory Development Alpha\nhttps://example.com/brief/alpha`,
    summary: '',
    affectedAreas: [],
    aiRiskLevel: null,
    status: 'new',
    reviewerNotes: '',
    createdAt: '2026-07-11T09:00:00.000Z',
    updatedAt: '2026-07-11T09:00:00.000Z',
    ...overrides,
  }
}

// ═══ Default permission state ════════════════════════════════════════════════

describe('permission default', () => {
  it('is unverified — the shipped, fail-closed state', () => {
    expect(CANNAMONITOR_PERMISSION_STATUS).toBe('unverified')
  })
})

// ═══ Permission gate ═════════════════════════════════════════════════════════

describe('permission gate', () => {
  it('denies a matched Cannamonitor source while permission is unverified', () => {
    const d = evaluateCannamonitorPolicy(source({ isActive: true }))
    expect(d.matched).toBe(true)
    expect(d.permission).toBe('unverified')
    expect(d.monitoringAllowed).toBe(false)
    expect(d.aiAllowed).toBe(false)
    expect(d.denialCode).toBe('permission_unverified')
  })

  it('does NOT let isActive:true bypass the permission gate', () => {
    // The whole point: a developer flipping the registry's active flag must not
    // be able to enable retrieval on its own.
    const active = evaluateCannamonitorPolicy(source({ isActive: true }))
    const inactive = evaluateCannamonitorPolicy(source({ isActive: false }))
    expect(active.monitoringAllowed).toBe(false)
    expect(inactive.monitoringAllowed).toBe(false)
    expect(active.denialCode).toBe('permission_unverified')
  })

  it('still requires an active source even in the hypothetical verified world', () => {
    const d = evaluateCannamonitorPolicy(source({ isActive: false }), 'verified')
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('source_inactive')
  })

  it('permits metadata-only monitoring only when BOTH verified and active', () => {
    const d = evaluateCannamonitorPolicy(source({ isActive: true }), 'verified')
    expect(d.monitoringAllowed).toBe(true)
    expect(d.fieldPolicy).toBe(CANNAMONITOR_METADATA_ONLY_PROJECTION)
  })

  it('denies retrieval BEFORE the injected fetch is called (connector)', async () => {
    const spy = vi.fn(forbiddenFetch)
    const result = await executeRssConnector(source({ isActive: true }), ['cannamonitor.com'], spy, {
      userAgent: 'test',
    })
    expect(spy).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('source_policy_denied')
    expect(result.decisions).toEqual([])
  })

  it('denies retrieval BEFORE the injected fetch is called (manual monitoring)', async () => {
    const spy = vi.fn(forbiddenFetch)
    const result = await runManualRssMonitoring(source({ isActive: true }), spy)
    expect(spy).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('source_policy_denied')
    expect(result.items).toEqual([])
  })

  it('marks an active Cannamonitor source ineligible for a manual check', () => {
    const e = evaluateManualMonitoringEligibility(source({ isActive: true }))
    expect(e.eligible).toBe(false)
    expect(e.code).toBe('source_policy_denied')
    expect(e.reason).toMatch(/permission/i)
  })

  it('leaves unrelated sources completely unaffected', async () => {
    const gov = source({
      id: 'src-gov',
      name: 'Example Regulator',
      url: 'https://feeds.example.gov/rss',
      sourceType: 'government_regulator',
      isActive: true,
    })
    const policy = evaluateCannamonitorPolicy(gov)
    expect(policy.matched).toBe(false)
    expect(policy.monitoringAllowed).toBe(true)
    expect(policy.fieldPolicy).toBeNull()

    // An unrelated source remains eligible and still reaches the fetch layer.
    expect(evaluateManualMonitoringEligibility(gov).eligible).toBe(true)

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n === 'content-type' ? 'application/rss+xml' : null) },
      text: async () => CANNA_SHAPED_FEED,
    })) as unknown as RssFetchImpl
    const result = await runManualRssMonitoring(gov, fetchImpl)
    expect(result.ok).toBe(true)
    // Unchanged legacy behaviour: a non-Cannamonitor feed still carries its
    // description through, exactly as before this policy existed.
    expect(result.decisions[0].proposedLegalUpdate?.rawContent).toContain('PROHIBITED_DESCRIPTION_MARKER')
  })
})

// ═══ Host controls ═══════════════════════════════════════════════════════════

describe('host controls', () => {
  it('accepts the exact approved hosts', () => {
    expect(isApprovedCannamonitorHost('cannamonitor.com')).toBe(true)
    expect(isApprovedCannamonitorHost('www.cannamonitor.com')).toBe(true)
    expect(APPROVED_CANNAMONITOR_HOSTS).toEqual(['cannamonitor.com', 'www.cannamonitor.com'])
  })

  it('treats www as approved and explicitly supported', () => {
    const d = evaluateCannamonitorPolicy(source({ url: 'https://www.cannamonitor.com/feed/', isActive: true }), 'verified')
    expect(d.matched).toBe(true)
    expect(d.monitoringAllowed).toBe(true)
  })

  it('rejects a suffix impersonation domain — it never inherits Cannamonitor permission', () => {
    const evil = 'https://cannamonitor.com.evil.example/feed/'
    expect(isApprovedCannamonitorHost('cannamonitor.com.evil.example')).toBe(false)
    expect(isCannamonitorSourceUrl(evil)).toBe(false)
    // Even in the verified world, the deceptive domain is not Cannamonitor and
    // is never granted its permission or its policy identity.
    const d = evaluateCannamonitorPolicy(source({ url: evil, isActive: true }), 'verified')
    expect(d.matched).toBe(false)
    expect(d.fieldPolicy).toBeNull()
  })

  it('rejects an unapproved Cannamonitor subdomain (matched, but denied)', () => {
    const d = evaluateCannamonitorPolicy(source({ url: 'https://staging.cannamonitor.com/feed/', isActive: true }), 'verified')
    expect(d.matched).toBe(true) // still Cannamonitor-owned — must not fall through to the generic path
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('unapproved_subdomain')
  })

  it('rejects http', () => {
    const d = evaluateCannamonitorPolicy(source({ url: 'http://cannamonitor.com/feed/', isActive: true }), 'verified')
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('not_https')
  })

  it('rejects an unexpected port', () => {
    const d = evaluateCannamonitorPolicy(source({ url: 'https://cannamonitor.com:8443/feed/', isActive: true }), 'verified')
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('unexpected_port')
  })

  it('rejects credentials embedded in the URL', () => {
    const d = evaluateCannamonitorPolicy(source({ url: 'https://user:pass@cannamonitor.com/feed/', isActive: true }), 'verified')
    expect(d.matched).toBe(true)
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('credentials_in_url')
  })

  it('fails closed on a malformed URL that still names cannamonitor', () => {
    const d = evaluateCannamonitorPolicy(source({ url: 'ht!tp:/cannamonitor.com/feed', isActive: true }), 'verified')
    expect(d.matched).toBe(true)
    expect(d.monitoringAllowed).toBe(false)
    expect(d.denialCode).toBe('malformed_url')
  })

  it('denies a NON-FEED Cannamonitor page and does not fall through to generic HTML handling', async () => {
    // The consulting-services page infers connector kind 'html', not 'rss'. It
    // must be caught by the Cannamonitor policy — NOT merely by the generic
    // "unsupported connector" path, which would be an accident of URL shape
    // rather than a permission decision.
    const page = source({
      url: 'https://cannamonitor.com/cannabis-consulting-services/',
      isActive: true,
    })

    const policy = evaluateCannamonitorPolicy(page)
    expect(policy.matched).toBe(true)
    expect(policy.permission).toBe('unverified')
    expect(policy.monitoringAllowed).toBe(false)
    expect(policy.denialCode).toBe('permission_unverified')

    // Cannot be manually checked, and the denial is the POLICY's, not the
    // generic connector-kind rejection.
    const eligibility = evaluateManualMonitoringEligibility(page)
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.code).toBe('source_policy_denied')
    expect(eligibility.code).not.toBe('unsupported_connector')

    // And no fetch is attempted.
    const spy = vi.fn(forbiddenFetch)
    const result = await runManualRssMonitoring(page, spy)
    expect(spy).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('source_policy_denied')
  })

  it('leaves the existing SSRF and redirect safeguards intact for other sources', async () => {
    // Loopback / private / metadata hosts are still rejected by the existing
    // runtime guard, which this policy does not touch or weaken.
    for (const url of [
      'https://127.0.0.1/feed',
      'https://10.0.0.5/feed',
      'https://169.254.169.254/feed',
      'https://localhost/feed',
    ]) {
      const s = source({ id: 'src-x', url, isActive: true })
      const spy = vi.fn(forbiddenFetch)
      const r = await executeRssConnector(s, [new URL(url).hostname], spy, { userAgent: 'test' })
      expect(spy).not.toHaveBeenCalled()
      expect(r.ok).toBe(false)
      expect(r.errorCode).toBe('url_unsafe')
    }

    // A redirect is still refused rather than followed.
    const redirecting = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: 'https://elsewhere.example/feed',
      redirected: true,
      headers: { get: () => 'application/rss+xml' },
      text: async () => CANNA_SHAPED_FEED,
    })) as unknown as RssFetchImpl
    const r = await executeRssConnector(
      source({ id: 'src-gov', url: 'https://feeds.example.gov/rss', isActive: true }),
      ['feeds.example.gov'],
      redirecting,
      { userAgent: 'test' },
    )
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('redirect_blocked')
  })
})

// ═══ Content minimisation ════════════════════════════════════════════════════

describe('content minimisation', () => {
  it('strips description, summary, content and HTML before rawText is built', () => {
    const feed = parseRssOrAtomFeed(CANNA_SHAPED_FEED, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    expect(feed.items).toHaveLength(2)
    for (const item of feed.items) {
      expect(item.summary).toBeNull()
      expect(item.content).toBeNull()
      for (const marker of PROHIBITED) {
        expect(item.rawText).not.toContain(marker)
      }
      // Permitted metadata survives — asserted against the expected synthetic
      // titles, so this fails if the projection drops or mangles the title.
      expect(item.title).toMatch(/^Synthetic Regulatory Development (Alpha|Beta)$/)
      expect(item.rawText).toContain('Synthetic Regulatory Development')
      expect(item.rawText).toContain('https://example.com/brief/')
    }
    expect(feed.items.map(i => i.title)).toEqual([
      'Synthetic Regulatory Development Alpha',
      'Synthetic Regulatory Development Beta',
    ])
  })

  it('excludes content:encoded even if the parser later learns to read it', () => {
    // Simulate a FUTURE parser that successfully extracts the full article body
    // into `content`. The projection must still discard it — this is the
    // regression guard against a well-meaning parser "improvement".
    const futureFields = {
      title: 'Synthetic Regulatory Development Alpha',
      link: 'https://example.com/brief/alpha',
      id: 'https://example.com/?p=101',
      published: 'Fri, 10 Jul 2026 09:00:00 +0000',
      summary: EXCERPT,
      content: `<div><p>${BODY}</p></div>`, // content:encoded, fully parsed
    }
    const projected = CANNAMONITOR_METADATA_ONLY_PROJECTION.projectFields(futureFields)
    expect(projected.summary).toBeNull()
    expect(projected.content).toBeNull()
    expect(projected.title).toBe(futureFields.title)
    expect(projected.link).toBe(futureFields.link)
    expect(projected.id).toBe(futureFields.id)
    expect(projected.published).toBe(futureFields.published)
    expect(JSON.stringify(projected)).not.toContain('PROHIBITED_FULLBODY_MARKER')
  })

  it('lets only permitted metadata reach the checksum and the monitoring decision', async () => {
    const feed = parseRssOrAtomFeed(CANNA_SHAPED_FEED, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    const decisions = await buildRssMonitoringDecisions(source(), feed, new Map(), '2026-07-14T00:00:00.000Z')

    expect(decisions).toHaveLength(2)
    for (const d of decisions) {
      const serialized = JSON.stringify(d)
      for (const marker of PROHIBITED) {
        expect(serialized).not.toContain(marker)
      }
      expect(d.snapshot?.checksum).toMatch(/^[0-9a-f]{64}$/)
    }

    // The checksum basis is EXACTLY the permitted metadata — asserted literally,
    // so any field creeping back into the hash breaks this test.
    expect(decisions[0].snapshot?.normalizedContent).toBe(
      'Synthetic Regulatory Development Alpha https://example.com/brief/alpha https://example.com/?p=101 Fri, 10 Jul 2026 09:00:00 +0000',
    )
  })

  it('lets only permitted metadata reach a proposed draft, always at status new', async () => {
    const feed = parseRssOrAtomFeed(CANNA_SHAPED_FEED, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    const decisions = await buildRssMonitoringDecisions(source(), feed, new Map(), '2026-07-14T00:00:00.000Z')

    const proposals = decisions.map(d => d.proposedLegalUpdate).filter(Boolean)
    expect(proposals.length).toBeGreaterThan(0)
    for (const p of proposals) {
      expect(p!.status).toBe('new')
      for (const marker of PROHIBITED) {
        expect(p!.rawContent).not.toContain(marker)
        expect(p!.normalizedContent).not.toContain(marker)
      }
    }
  })

  it('cannot carry prohibited content into anything persistable', async () => {
    // The value that would be handed to repo.insertLegalUpdate is
    // proposedLegalUpdate.rawContent. Prove it is metadata-only.
    const feed = parseRssOrAtomFeed(CANNA_SHAPED_FEED, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    const decisions = await buildRssMonitoringDecisions(source(), feed, new Map(), '2026-07-14T00:00:00.000Z')
    const persistable = decisions.map(d => d.proposedLegalUpdate?.rawContent ?? '').join('\n')
    for (const marker of PROHIBITED) {
      expect(persistable).not.toContain(marker)
    }
  })

  it('DOES detect a permitted-metadata change (title / publication date)', async () => {
    // The necessary complement to the body-only test below. Together they pin the
    // exact detection envelope: permitted metadata IS compared, prohibited body
    // content is NOT. Without this test, a projection bug that nulled *every*
    // field would still satisfy the body-only test and pass silently.
    const before = parseRssOrAtomFeed(CANNA_SHAPED_FEED, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    const d1 = await buildRssMonitoringDecisions(source(), before, new Map(), '2026-07-14T00:00:00.000Z')
    const prev = new Map(d1.filter(d => d.snapshot).map(d => [d.sourceId, d.snapshot!]))

    // Change ONE permitted metadata field (the title) and, separately, the date.
    // The prohibited body/description is left untouched — it is irrelevant to the
    // result either way, which is precisely what we are asserting.
    const retitled = CANNA_SHAPED_FEED.replace(
      '<title>Synthetic Regulatory Development Alpha</title>',
      '<title>Synthetic Regulatory Development Alpha (Amended)</title>',
    )
    const redated = CANNA_SHAPED_FEED.replace(
      '<pubDate>Fri, 10 Jul 2026 09:00:00 +0000</pubDate>',
      '<pubDate>Mon, 13 Jul 2026 09:00:00 +0000</pubDate>',
    )

    for (const [label, xml] of [['title', retitled], ['pubDate', redated]] as const) {
      const after = parseRssOrAtomFeed(xml, CANNAMONITOR_METADATA_ONLY_PROJECTION)
      const decisions = await buildRssMonitoringDecisions(source(), after, prev, '2026-07-15T00:00:00.000Z')

      const changed = decisions.filter(d => d.kind === 'changed_pending_review')
      expect(changed.length, `a ${label} change must be detected`).toBeGreaterThan(0)

      // The proposal still carries ONLY permitted metadata — detection does not
      // smuggle prohibited content back in.
      for (const d of changed) {
        expect(d.proposedLegalUpdate?.status).toBe('new')
        for (const marker of PROHIBITED) {
          expect(d.proposedLegalUpdate?.rawContent).not.toContain(marker)
          expect(d.proposedLegalUpdate?.normalizedContent).not.toContain(marker)
        }
      }
      expect(JSON.stringify(decisions)).not.toContain('PROHIBITED_DESCRIPTION_MARKER')
      expect(JSON.stringify(decisions)).not.toContain('PROHIBITED_FULLBODY_MARKER')
    }
  })

  it('documents that a body-only edit is NOT detected (accepted trade-off)', async () => {
    const editedBody = CANNA_SHAPED_FEED.replace(BODY, 'COMPLETELY_DIFFERENT_SYNTHETIC_BODY')
    const before = parseRssOrAtomFeed(CANNA_SHAPED_FEED, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    const after = parseRssOrAtomFeed(editedBody, CANNAMONITOR_METADATA_ONLY_PROJECTION)

    const d1 = await buildRssMonitoringDecisions(source(), before, new Map(), '2026-07-14T00:00:00.000Z')
    const prev = new Map(d1.filter(d => d.snapshot).map(d => [d.sourceId, d.snapshot!]))
    const d2 = await buildRssMonitoringDecisions(source(), after, prev, '2026-07-15T00:00:00.000Z')

    // Metadata unchanged ⇒ reported unchanged, even though the body changed.
    expect(d2.every(d => d.kind === 'unchanged')).toBe(true)
  })
})

// ═══ AI blocking ═════════════════════════════════════════════════════════════

describe('AI boundary', () => {
  const provider = {
    draftSummary: vi.fn(async () => {
      throw new Error('AI PROVIDER CALLED — the Cannamonitor AI gate failed')
    }),
  } as unknown as ComplianceAiSummaryProvider

  it('blocks AI eligibility for a Cannamonitor-derived update', () => {
    const e = evaluateAiSummaryEligibility(legalUpdate(), { provider, requestInProgress: false })
    expect(e.canGenerate).toBe(false)
    expect(e.code).toBe('cannamonitor_permission_unverified')
  })

  it('blocks the AI run without ever calling the provider', async () => {
    const spy = vi.fn(async () => {
      throw new Error('AI PROVIDER CALLED — the Cannamonitor AI gate failed')
    })
    const p = { draftSummary: spy } as unknown as ComplianceAiSummaryProvider
    const outcome = await runAiDraftSummary(legalUpdate(), p, {
      requestInProgress: false,
      isStillSelected: () => true,
    })
    expect(spy).not.toHaveBeenCalled()
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('cannamonitor_permission_unverified')
  })

  it('blocks content that entered by a NON-RSS path when the update carries a Cannamonitor sourceUrl', async () => {
    // The text never went through the RSS parser or the projection — e.g. an
    // admin pasted it into the manual form, or the row predates this policy.
    // The gate still holds, BECAUSE the update's sourceUrl names Cannamonitor.
    // That precondition is the point, and the next test pins its converse.
    const pasted = legalUpdate({
      sourceUrl: 'https://cannamonitor.com/brief/alpha',
      rawText: `${EXCERPT}\n${BODY}`,
    })
    const spy = vi.fn(async () => ({}) as never)
    const p = { draftSummary: spy } as unknown as ComplianceAiSummaryProvider

    expect(evaluateAiSummaryEligibility(pasted, { provider: p, requestInProgress: false }).canGenerate).toBe(false)
    const outcome = await runAiDraftSummary(pasted, p, { requestInProgress: false, isStillSelected: () => true })
    expect(spy).not.toHaveBeenCalled()
    expect(outcome.ok).toBe(false)
  })

  it('LIMITATION: does NOT identify Cannamonitor content when sourceUrl is blank or unrelated', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // This test PINS A KNOWN GOVERNANCE DEPENDENCY. It does not endorse
    // incorrect source attribution — it makes the consequence of it visible.
    //
    // The source-specific gate identifies Cannamonitor by `sourceUrl`, NOT by
    // inspecting content. Content-sniffing is deliberately not used: it would
    // miss paraphrased/reformatted material while falsely flagging unrelated
    // regulatory text, producing false confidence rather than real protection.
    //
    // Consequence: if an administrator records a blank or unrelated sourceUrl on
    // an update whose text actually came from Cannamonitor, the gate cannot
    // recognise it and the update proceeds through ORDINARY AI eligibility.
    // Administrators must therefore record the correct canonical Cannamonitor
    // source URL. This is a process control, not an automated one.
    //
    // Note the automated ingestion path is unaffected: retrieval is denied and
    // the metadata-only projection applies regardless of this test.
    // ─────────────────────────────────────────────────────────────────────────
    const misattributed = [
      legalUpdate({ sourceUrl: '', rawText: `${EXCERPT}\n${BODY}` }),
      legalUpdate({ sourceUrl: 'https://www.example.gov/notice/9', rawText: `${EXCERPT}\n${BODY}` }),
    ]

    for (const update of misattributed) {
      // Not classified as Cannamonitor by the source-specific gate...
      expect(isCannamonitorSourceUrl(update.sourceUrl)).toBe(false)
      expect(evaluateCannamonitorPolicy({ url: update.sourceUrl }).matched).toBe(false)

      // ...so it falls through to ORDINARY AI eligibility. With no provider
      // configured it is refused as provider_unconfigured — the generic guard's
      // decision, NOT a Cannamonitor block. Nothing is sent anywhere.
      const e = evaluateAiSummaryEligibility(update, { provider: null, requestInProgress: false })
      expect(e.canGenerate).toBe(false)
      expect(e.code).toBe('provider_unconfigured')
      expect(e.code).not.toBe('cannamonitor_permission_unverified')
    }
  })

  it('does not block AI for unrelated sources (source-specific only)', () => {
    const gov = legalUpdate({ sourceUrl: 'https://www.example.gov/notice/1', sourceName: 'Example Regulator' })
    const e = evaluateAiSummaryEligibility(gov, { provider: null, requestInProgress: false })
    // Falls through to the EXISTING generic guard — provider_unconfigured, not
    // a Cannamonitor block. Proves unrelated behaviour is untouched.
    expect(e.code).toBe('provider_unconfigured')
  })
})

// ═══ Compliance boundary ═════════════════════════════════════════════════════

describe('compliance boundary', () => {
  it('can propose at most a draft with status new, and nothing else', async () => {
    const feed = parseRssOrAtomFeed(CANNA_SHAPED_FEED, CANNAMONITOR_METADATA_ONLY_PROJECTION)
    const decisions = await buildRssMonitoringDecisions(source(), feed, new Map(), '2026-07-14T00:00:00.000Z')

    for (const d of decisions) {
      if (d.proposedLegalUpdate) expect(d.proposedLegalUpdate.status).toBe('new')
      // No rule / alert / readiness / entity field can exist on a decision.
      const keys = Object.keys(d)
      expect(keys).not.toContain('rule')
      expect(keys).not.toContain('alert')
      expect(keys).not.toContain('readiness')
      const serialized = JSON.stringify(d).toLowerCase()
      for (const forbidden of ['"approved"', '"active"', 'exportready', 'batchid', 'buyerid', 'coaid', 'shipmentid']) {
        expect(serialized).not.toContain(forbidden)
      }
    }
  })

  it('exposes literal-false capability guarantees on the policy decision', () => {
    const d = evaluateCannamonitorPolicy(source())
    expect(d.canCreateRule).toBe(false)
    expect(d.canCreateAlert).toBe(false)
    expect(d.canAlterReadiness).toBe(false)
  })

  it('the connector reports no persistence / rule / AI capability', async () => {
    const r = await executeRssConnector(source({ isActive: true }), ['cannamonitor.com'], forbiddenFetch, {
      userAgent: 'test',
    })
    expect(r.performsPersistence).toBe(false)
    expect(r.canCreateLegalUpdate).toBe(false)
    expect(r.canCreateRule).toBe(false)
    expect(r.canCallAI).toBe(false)
  })
})
