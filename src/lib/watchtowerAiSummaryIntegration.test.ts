import { describe, expect, it } from 'vitest'

// ─── Phase 2H — Watchtower AI draft-summary integration (static) ────────────
//
// There is no jsdom/testing-library in this project (node test env), so —
// following the existing convention (watchtowerRssIntegration.test.ts) — these
// checks prove the UI-level manual-invocation, transient-output, and wording
// guarantees against the .tsx source itself. Behavioural logic (guard, provider,
// stale selection, error mapping) is covered with mock providers in
// watchtowerAiSummary.test.ts.
const RAW = import.meta.glob('../pages/admin/DDPComplianceWatchtower.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const SRC = Object.values(RAW)[0] ?? ''

/** Extracts the argument text of every `useEffect(...)` call via paren-depth
 *  matching, so we can assert none of them invoke the AI summary. */
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

describe('DDPComplianceWatchtower — manual AI draft-summary integration (static)', () => {
  it('has a non-empty source', () => {
    expect(SRC.length).toBeGreaterThan(1000)
  })

  it('wires the AI draft summary through the reused controller + orchestration, not a vendor SDK', () => {
    expect(SRC).toMatch(/handleGenerateAiDraftSummary/)
    expect(SRC).toMatch(/runAiDraftSummary/)
    expect(SRC).toMatch(/evaluateAiSummaryEligibility/)
    // The provider is injected and null in this build (no vendor SDK in React).
    expect(SRC).toMatch(/AI_SUMMARY_PROVIDER: ComplianceAiSummaryProvider \| null = null/)
  })

  it('invokes the AI summary ONLY from a click handler, never on mount/effect/selection', () => {
    // Bound to an onClick.
    expect(SRC).toMatch(/onClick=\{\(\)\s*=>\s*\{\s*void handleGenerateAiDraftSummary\(update\)/)
    // Never invoked inside ANY useEffect body (no auto-run on mount/selection/refresh).
    for (const body of useEffectBodies(SRC)) {
      expect(body).not.toMatch(/handleGenerateAiDraftSummary|runAiDraftSummary|draftSummary/)
    }
  })

  it('guards against concurrent AI runs from repeated clicks', () => {
    // The handler early-returns while busy, and the button is disabled while busy.
    expect(SRC).toMatch(/if \(aiDraftBusy\) return/)
    expect(SRC).toMatch(/disabled=\{busy \|\| aiDraftBusy \|\| !aiEligibility\.canGenerate\}/)
  })

  it('introduces no timer/scheduler/polling for the AI feature (page-wide)', () => {
    expect(SRC).not.toMatch(/setInterval|setTimeout/)
    expect(SRC).not.toMatch(/\bcron\b/)
  })

  it('calls no vendor AI SDK and no direct fetch/network for AI in the component', () => {
    expect(SRC).not.toMatch(/from ['"]openai['"]|from ['"]@anthropic/i)
    // The only fetch wiring in this page is the RSS browser adapter (createBrowserRssFetch);
    // the AI path must never introduce a raw fetch/XHR/WebSocket.
    expect(SRC).not.toMatch(/new WebSocket|new XMLHttpRequest/)
  })

  it('labels output as a draft that requires human legal review', () => {
    expect(SRC).toMatch(/AI-generated draft — requires human legal review/)
    expect(SRC).toMatch(/Draft only/)
    expect(SRC).toMatch(/Questions for human legal review/)
    expect(SRC).toMatch(/Possible significance/)
    expect(SRC).toMatch(/Uncertainties/)
  })

  it('keeps the draft transient — no summary overwrite, no persistence, discardable', () => {
    // Discard clears transient state only.
    expect(SRC).toMatch(/function handleDiscardAiDraft/)
    expect(SRC).toMatch(/onClick=\{\(\)\s*=>\s*\{\s*handleDiscardAiDraft\(\)/)
    expect(SRC).toMatch(/This draft is transient — it is not saved/)
    // Isolate the AI handler block and assert it performs no persistence and
    // never writes legalUpdate.summary or touches rules/enforcement.
    const start = SRC.indexOf('async function handleGenerateAiDraftSummary')
    const end = SRC.indexOf('function handleDiscardAiDraft')
    const handler = SRC.slice(start, end)
    expect(handler.length).toBeGreaterThan(200)
    expect(handler).not.toMatch(/persistLegalUpdatesLocal|saveStored|insertLegalUpdate|updateLegalUpdateStatus/)
    expect(handler).not.toMatch(/\.summary\s*=/)
    expect(handler).not.toMatch(/insertRule|updateRuleStatus|createRule|approveRule|enforceRule/)
    expect(handler).not.toMatch(/logAudit/)
  })

  it('renders the transient draft only while its update is still a new draft (stale invalidation)', () => {
    expect(SRC).toMatch(/legalUpdates\.find\(item => item\.id === aiDraft\.legalUpdateId && item\.status === 'new'\)/)
    expect(SRC).toMatch(/aiDraft && aiDraftUpdate/)
  })

  it('offers the Generate action only for a new draft legal update', () => {
    expect(SRC).toMatch(/update && update\.status === 'new'\s*\n?\s*\?\s*evaluateAiSummaryEligibility/)
  })

  it('uses no prohibited certification/approval wording for the AI feature', () => {
    // Scope the check to the AI draft panel region so unrelated review buttons
    // ("Approve rule", audit action 'rule_approved') are not misread.
    const panelStart = SRC.indexOf('AI-generated draft — requires human legal review')
    const panelEnd = SRC.indexOf('Generated:', panelStart)
    const panel = SRC.slice(panelStart, panelEnd > panelStart ? panelEnd + 40 : panelStart + 2000)
    expect(panel.length).toBeGreaterThan(200)
    expect(panel).not.toMatch(/AI-approved|legally confirmed|compliance verified|certified compliant|regulation validated|rule approved|ready for enforcement/i)
  })
})
