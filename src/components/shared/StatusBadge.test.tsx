// @vitest-environment jsdom
//
// StatusBadge is the app's status vocabulary — the pills a reviewer reads to
// decide whether something is documented, rejected, expired or ready for a
// buyer. Its failure modes are all VISUAL, so a source regex cannot see them:
// a key with no label renders an empty pill, and a key pointing at a CSS class
// that does not exist renders an unstyled one. Both look like "no problem" to a
// text search and like a bug to a human.
//
// statusPendingClassMapping.test.ts already guards the `status-pending` orphan
// by regexing this file's source, and says outright it does so because the
// vocabulary is "not exported in a shape convenient to import". Rendering the
// component asserts the same property against what is actually produced, which
// is strictly stronger — the source guard is left in place, not replaced.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComplianceRuleImpact } from '../../lib/complianceRuleImpact'
import { NO_RULE_IMPACT_LABEL, SAFE_RULE_IMPACT_LABEL } from '../../lib/complianceTerminology'
import { ComplianceRuleCheckBadge, EvidenceBadge, StatusBadge, type StatusKey } from './StatusBadge'

afterEach(cleanup)

const ALL_KEYS: StatusKey[] = [
  'claimed', 'documented', 'reviewed', 'verified', 'missing', 'missing-evidence',
  'rejected', 'expired', 'hold', 'reject', 'buyer-ready', 'review-pending',
  'coa-received', 'coa-missing', 'progress',
]

function pill(container: HTMLElement): HTMLElement {
  return container.querySelector('.status-pill') as HTMLElement
}

describe('StatusBadge — every status a reviewer can be shown', () => {
  it('renders visible text for every key, in both languages', () => {
    for (const status of ALL_KEYS) {
      for (const lang of ['en', 'th'] as const) {
        const { container, unmount } = render(<StatusBadge status={status} lang={lang} />)
        const text = pill(container).textContent ?? ''
        expect(text.trim(), `${status}/${lang} rendered an empty pill`).not.toBe('')
        unmount()
      }
    }
  })

  it('renders a different label in Thai than in English for every key', () => {
    // A key added to the table by copy-paste, with the English left in the `th`
    // slot, is invisible to an English-speaking reviewer and to a source regex.
    for (const status of ALL_KEYS) {
      const en = render(<StatusBadge status={status} lang="en" />)
      const enText = pill(en.container).textContent
      en.unmount()
      const th = render(<StatusBadge status={status} lang="th" />)
      const thText = pill(th.container).textContent
      th.unmount()
      expect(thText, `${status} has no distinct Thai label`).not.toBe(enText)
    }
  })

  it('never renders the status-pending orphan, which has no CSS rule', () => {
    // The C2 defect: two mappings pointed at a class App.css never defined, so
    // the pill rendered unstyled. Asserted here on the produced class list.
    for (const status of ALL_KEYS) {
      const { container, unmount } = render(<StatusBadge status={status} />)
      const classes = [...pill(container).classList]
      expect(classes, `${status} rendered the orphan class`).not.toContain('status-pending')
      expect(classes).toContain('status-pill')
      expect(classes.length, `${status} rendered no status class`).toBeGreaterThan(1)
      unmount()
    }
  })

  it('maps review-pending to status-review-pending', () => {
    const { container } = render(<StatusBadge status="review-pending" />)
    expect([...pill(container).classList]).toContain('status-review-pending')
  })

  it('defaults to English when no language is given', () => {
    const { container } = render(<StatusBadge status="documented" />)
    expect(pill(container).textContent).toBe('Documented')
  })

  it('EvidenceBadge renders the same pill as StatusBadge for the same status', () => {
    const a = render(<EvidenceBadge status="documented" lang="th" />)
    const viaEvidence = pill(a.container).outerHTML
    a.unmount()
    const b = render(<StatusBadge status="documented" lang="th" />)
    expect(viaEvidence).toBe(pill(b.container).outerHTML)
  })
})

describe('ComplianceRuleCheckBadge — the "no impact" case is the dangerous one', () => {
  const impact = (over: Partial<ComplianceRuleImpact> = {}): ComplianceRuleImpact => ({
    hasImpact: true,
    safeStatusLabel: SAFE_RULE_IMPACT_LABEL.needsReview,
    ruleCode: 'R-14',
    ruleTitle: 'COA required for export',
    severity: 'high',
    isBlocking: false,
    reason: 'No COA recorded for this batch.',
    ...over,
  } as ComplianceRuleImpact)

  // The component's own comment says it must "never leave the cell visually
  // empty (which was easy to miss on screen)". That is a rendering guarantee and
  // nothing but a rendering test can hold it.
  it('renders a visible neutral badge when there is no impact, never an empty cell', () => {
    const { container } = render(<ComplianceRuleCheckBadge impact={null} />)
    const el = pill(container)
    expect(el).toBeTruthy()
    expect(el.textContent?.trim()).toBe(NO_RULE_IMPACT_LABEL)
    expect(container.textContent?.trim()).not.toBe('')
  })

  it('does not imply a passing or compliant state when there is no impact', () => {
    const { container } = render(<ComplianceRuleCheckBadge impact={null} />)
    expect(container.textContent).not.toMatch(/compliant|passed|approved|clear|verified|ok\b/iu)
  })

  it('shows the safe label and puts the rule detail in the tooltip', () => {
    const { container } = render(<ComplianceRuleCheckBadge impact={impact()} />)
    const el = pill(container)
    expect(el.textContent).toContain('needs review')
    expect(el.getAttribute('title')).toBe('R-14 — COA required for export: No COA recorded for this batch.')
  })

  it('carries the mapped class for each safe label', () => {
    const cases: Array<[ComplianceRuleImpact['safeStatusLabel'], string]> = [
      [SAFE_RULE_IMPACT_LABEL.blockedPendingLegalReview, 'status-reject'],
      [SAFE_RULE_IMPACT_LABEL.missingEvidence, 'status-missing'],
      [SAFE_RULE_IMPACT_LABEL.needsReview, 'status-review-pending'],
    ]
    for (const [label, cls] of cases) {
      const { container, unmount } = render(
        <ComplianceRuleCheckBadge impact={impact({ safeStatusLabel: label })} />,
      )
      expect([...pill(container).classList], `${label} mapped wrong`).toContain(cls)
      expect([...pill(container).classList]).not.toContain('status-pending')
      unmount()
    }
  })

  it('never renders the raw rule text as the visible label', () => {
    // Only the SAFE label is displayed; the rule's own wording stays in the
    // tooltip, so an unreviewed rule title cannot become on-screen guidance.
    render(<ComplianceRuleCheckBadge impact={impact({ ruleTitle: 'Batch is fully compliant' })} />)
    expect(screen.getByText(/Compliance Rule Check/u).textContent).not.toContain('fully compliant')
  })
})
