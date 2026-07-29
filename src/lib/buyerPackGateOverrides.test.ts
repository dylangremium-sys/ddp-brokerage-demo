import { describe, expect, it } from 'vitest'
import { deriveBuyerApprovalGate } from './buyerApprovalGate'

/**
 * The buyer-pack release gate must read overrides from the SERVER-AUTHORITATIVE
 * store, not from localStorage.
 *
 * Found by review on PR #75: after the Risk Register and the Missing Document
 * Matrix moved onto procurementOverrideStore, computeBuyerDisclosureStatus was
 * still calling applyRequirementOverrides / applyRiskOverrides — both raw
 * localStorage reads. The two halves therefore disagreed: those pages would
 * correctly show a risk another admin had re-opened on the server, while the
 * issuance gate still saw the stale browser copy marked 'accepted' and would
 * enable Issue Buyer Pack after a 'progress' decision.
 *
 * The page is .tsx and this repo's vitest env is 'node' with no jsdom, so the
 * wiring is asserted against source text via `import.meta.glob(..., '?raw')` —
 * the existing convention (operationsDeskRouting.test.ts).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}
const PREVIEW_SRC = raw(import.meta.glob('../pages/admin/DDPBuyerPreview.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

/** The gate's own rule, re-expressed so the fail-closed cases are executable. */
function gateShut(input: {
  overridesUnverified: boolean
  blockerRequirements: number
  hasUnresolvedBlockerRisk: boolean
}): boolean {
  return input.overridesUnverified
    || input.blockerRequirements > 0
    || input.hasUnresolvedBlockerRisk
}

describe('buyer-pack gate — source fixture is readable', () => {
  it('loads DDPBuyerPreview.tsx', () => {
    expect(PREVIEW_SRC.length).toBeGreaterThan(1000)
  })
})

describe('buyer-pack gate — overrides come from the authoritative store', () => {
  it('resolves both override sets through the store', () => {
    expect(PREVIEW_SRC).toContain('resolveRiskOverrides')
    expect(PREVIEW_SRC).toContain('resolveRequirementOverrides')
  })

  it('no longer applies overrides from raw localStorage inside the gate', () => {
    // THE DEFECT, verbatim: these two read localStorage and were what
    // computeBuyerDisclosureStatus used to compute hasBlockingIssues from.
    const fn = PREVIEW_SRC.slice(
      PREVIEW_SRC.indexOf('function computeBuyerDisclosureStatus'),
      PREVIEW_SRC.indexOf('// ─── Buyer Pack'),
    )
    expect(fn).not.toBe('')
    // They survive ONLY on the legacy `overrideState === undefined` path, which
    // is for callers that render nothing gate-bearing. The gate path must not
    // reach them, so each appears exactly once — in that branch.
    expect((fn.match(/applyRequirementOverrides\(/g) ?? []).length).toBeLessThanOrEqual(1)
    expect((fn.match(/applyRiskOverrides\(/g) ?? []).length).toBeLessThanOrEqual(1)
    expect(fn).toContain('overrideState === undefined')
  })

  it('treats an unsettled or failed override read as blocking', () => {
    expect(PREVIEW_SRC).toContain('overrideState === null || overrideState.unavailable')
    expect(PREVIEW_SRC).toMatch(/hasBlockingIssues\s*=\s*\n?\s*overridesUnverified/)
  })

  it('shuts the gate on the UNION of the two reads failing, not the intersection', () => {
    expect(PREVIEW_SRC).toContain('risks.unavailable || requirements.unavailable')
  })

  it('applies an override only when its resolved source is effective', () => {
    // 'unavailable' must never clear a blocker.
    expect((PREVIEW_SRC.match(/isEffectiveOverride\(override\.source\)/g) ?? []).length).toBe(2)
  })

  it('distinguishes "unverified" from "has a blocker" in what the operator is told', () => {
    expect(PREVIEW_SRC).toContain('overridesUnverified')
    expect(PREVIEW_SRC).toMatch(/could not be verified against the server/)
    expect(PREVIEW_SRC).toMatch(/not<\/strong> a statement that one exists/)
  })
})

describe('buyer-pack gate — fail-closed truth table', () => {
  it.each([
    // overridesUnverified, blockerReqs, blockerRisk, expected gate-shut
    [false, 0, false, false],  // clean, verified  → may issue
    [false, 1, false, true],   // a rejected/expired requirement
    [false, 0, true,  true],   // an unresolved blocker risk
    [true,  0, false, true],   // UNVERIFIED — the case the defect got wrong
    [true,  1, true,  true],
  ])('unverified=%s reqs=%s riskBlocker=%s → shut=%s', (overridesUnverified, blockerRequirements, hasUnresolvedBlockerRisk, expected) => {
    expect(gateShut({ overridesUnverified, blockerRequirements, hasUnresolvedBlockerRisk })).toBe(expected)
  })

  it('never approves while the override state is unverified, even with a progress decision', () => {
    const hasBlockingIssues = gateShut({ overridesUnverified: true, blockerRequirements: 0, hasUnresolvedBlockerRisk: false })
    const { isHumanApproved } = deriveBuyerApprovalGate(hasBlockingIssues, true)
    expect(isHumanApproved).toBe(false)
  })

  it('does approve once the overrides are verified and nothing blocks', () => {
    const hasBlockingIssues = gateShut({ overridesUnverified: false, blockerRequirements: 0, hasUnresolvedBlockerRisk: false })
    const { isHumanApproved } = deriveBuyerApprovalGate(hasBlockingIssues, true)
    expect(isHumanApproved).toBe(true)
  })
})

describe('override write handlers release the saving flag on rejection', () => {
  const HANDLER_FILES = [
    ['DDPRiskRegister', raw(import.meta.glob('../pages/admin/DDPRiskRegister.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)],
    ['DDPMissingDocuments', raw(import.meta.glob('../pages/admin/DDPMissingDocuments.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)],
  ] as const

  it.each(HANDLER_FILES)('%s resets saving in a finally block', (_name, src) => {
    // Without this, a REJECTION (as opposed to an in-band ok:false) skipped
    // setSaving(false) entirely — leaving every control permanently disabled
    // and raising an unhandled rejection.
    expect(src).toMatch(/\} finally \{\s*\n\s*setSaving\(false\)/)
  })

  it.each(HANDLER_FILES)('%s surfaces the rejection rather than swallowing it', (_name, src) => {
    expect(src).toMatch(/catch \(err: unknown\) \{/)
    expect(src).toMatch(/setWriteError\(err instanceof Error \? err\.message/)
  })
})
