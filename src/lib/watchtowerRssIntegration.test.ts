import { describe, expect, it } from 'vitest'

// Static analysis of the Watchtower page source. There is no jsdom/testing-
// library in this project (node test env), so — following the existing
// convention of testing extracted lib logic + static source assertions — these
// checks prove the UI-level manual-invocation and wording guarantees against
// the .tsx source itself.
const RAW = import.meta.glob('../pages/admin/DDPComplianceWatchtower.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const SRC = Object.values(RAW)[0] ?? ''

/** Extracts the argument text of every `useEffect(...)` call via paren-depth
 *  matching, so we can assert none of them invoke the manual feed check. */
function useEffectBodies(src: string): string[] {
  const bodies: string[] = []
  const needle = 'useEffect('
  let from = 0
  for (;;) {
    const start = src.indexOf(needle, from)
    if (start === -1) break
    let depth = 0
    let i = start + needle.length - 1 // at the '('
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) { i++; break } }
    }
    bodies.push(src.slice(start, i))
    from = i
  }
  return bodies
}

describe('DDPComplianceWatchtower — manual RSS integration (static)', () => {
  it('has a non-empty source', () => {
    expect(SRC.length).toBeGreaterThan(1000)
  })

  it('wires the manual feed check through the orchestration + browser adapter', () => {
    expect(SRC).toMatch(/handleCheckSourceFeed/)
    expect(SRC).toMatch(/runManualRssMonitoring/)
    expect(SRC).toMatch(/createBrowserRssFetch/)
  })

  it('invokes the check only from a click handler, never on mount/effect', () => {
    // Bound to an onClick.
    expect(SRC).toMatch(/onClick=\{\(\)\s*=>\s*\{\s*void handleCheckSourceFeed\(source\)/)
    // Not invoked inside ANY useEffect body.
    for (const body of useEffectBodies(SRC)) {
      expect(body).not.toMatch(/handleCheckSourceFeed|runManualRssMonitoring|createBrowserRssFetch/)
    }
  })

  it('saves a technical baseline only from an explicit click handler, never on mount/effect', () => {
    expect(SRC).toMatch(/handleSaveBaseline/)
    expect(SRC).toMatch(/monitoringSnapshotRepo\.saveBaseline/)
    // The save button is bound to onClick.
    expect(SRC).toMatch(/onClick=\{\(\)\s*=>\s*\{\s*void handleSaveBaseline\(\)/)
    // Neither the save nor the repository write happens inside any useEffect.
    for (const body of useEffectBodies(SRC)) {
      expect(body).not.toMatch(/handleSaveBaseline|saveBaseline|buildBaselineCandidate/)
    }
  })

  it('states the technical baseline does not imply legal approval', () => {
    expect(SRC).toMatch(/stores technical feed checksums for future comparison/i)
    expect(SRC).toMatch(/does not approve a legal update,\s*\n?\s*regulation, compliance status, or rule/i)
    expect(SRC).toMatch(/not a record of legal review, approval, or compliance status/i)
  })

  it('guards against concurrent runs from repeated clicks', () => {
    expect(SRC).toMatch(/canStartManualRun\(rssCheckBusy\)/)
    expect(SRC).toMatch(/disabled=\{rssCheckBusy/)
  })

  it('introduces no timer/scheduler/polling in the page', () => {
    expect(SRC).not.toMatch(/setInterval|setTimeout/)
    expect(SRC).not.toMatch(/\bcron\b/)
  })

  it('states the read-only, non-enforcing nature and the human-review boundary', () => {
    expect(SRC).toMatch(/Change detected — pending human review/)
    expect(SRC).toMatch(/read-only/i)
    expect(SRC).toMatch(/does not approve, certify,\s*\n?\s*or enforce/i)
  })

  it('does not use prohibited overstating wording for detected changes', () => {
    expect(SRC).not.toMatch(/Legal change confirmed/i)
    expect(SRC).not.toMatch(/Compliance updated/i)
    expect(SRC).not.toMatch(/Rule approved/i)
    expect(SRC).not.toMatch(/Automatically compliant/i)
    expect(SRC).not.toMatch(/Regulation enforced/i)
  })
})
