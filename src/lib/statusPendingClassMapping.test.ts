import { describe, expect, it } from 'vitest'
import { RULE_IMPACT_LABEL_CLASS, SAFE_RULE_IMPACT_LABEL } from './complianceTerminology'

// C2 — `status-pending` was an orphaned class: referenced by two live runtime
// mappings but defined nowhere in App.css, so an *open* compliance alert and a
// *needs review* rule impact rendered as an unstyled pill. Both mappings now
// point at the already-defined `status-review-pending`. This guard prevents a
// regression back to the orphan.
//
// The Watchtower's ALERT_STATUS_CLASS and the StatusBadge vocabulary are not
// exported in a shape convenient to import; rather than widen the app's public
// surface just for a test, they are asserted against source via `import.meta.glob`
// with `?raw`, following the existing source-contract convention
// (see watchtowerAiSummaryIntegration.test.ts). (App.css itself cannot be read
// this way — vitest stubs CSS to empty — so the replacement's membership in the
// status system is proven via StatusBadge, the authoritative status vocabulary,
// which maps the `review-pending` key to `status-review-pending`; the CSS rule is
// defined at App.css `.status-review-pending`, mechanically confirmed in the C2 audit.)
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}
const WATCHTOWER_SRC = raw(
  import.meta.glob('../pages/admin/DDPComplianceWatchtower.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
)
const STATUS_BADGE_SRC = raw(
  import.meta.glob('../components/shared/StatusBadge.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
)

describe('C2 — pending-review status class mapping', () => {
  it('has readable source fixtures', () => {
    expect(WATCHTOWER_SRC.length).toBeGreaterThan(1000)
    expect(STATUS_BADGE_SRC.length).toBeGreaterThan(200)
  })

  it('maps the needsReview rule impact to status-review-pending, not the status-pending orphan', () => {
    expect(RULE_IMPACT_LABEL_CLASS[SAFE_RULE_IMPACT_LABEL.needsReview]).toBe('status-review-pending')
    expect(Object.values(RULE_IMPACT_LABEL_CLASS)).not.toContain('status-pending')
  })

  it('maps the Watchtower open alert status to status-review-pending, not status-pending', () => {
    expect(WATCHTOWER_SRC).toMatch(/open:\s*'status-review-pending'/)
    expect(WATCHTOWER_SRC).not.toMatch(/open:\s*'status-pending'/)
  })

  it('resolves the replacement to a class the shared status vocabulary already defines (StatusBadge), not the orphan', () => {
    // StatusBadge is the authoritative status vocabulary; it maps the
    // review-pending key to `status-review-pending`, so the replacement is a
    // first-class member of the existing status system — and never `status-pending`.
    expect(STATUS_BADGE_SRC).toMatch(/cls:\s*'status-review-pending'/)
    expect(STATUS_BADGE_SRC).not.toMatch(/'status-pending'/)
  })
})
