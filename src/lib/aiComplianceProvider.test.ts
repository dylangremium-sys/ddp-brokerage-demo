import { describe, expect, it } from 'vitest'
import type { ComplianceSeverity, LegalUpdateAffectedArea } from '../types'
import { isEnforcedRuleStatus } from './complianceRules'
import { runComplianceAnalysis } from './aiComplianceProvider'
import type { ComplianceAIProvider } from './aiComplianceProvider'
import type { AIComplianceModelInfo, AICompliancePromptVersion, AIComplianceOutput } from './aiComplianceTypes'

function makeOutput<T>(value: T): AIComplianceOutput<T> {
  return {
    value,
    confidence: 0.5,
    provenance: {
      actorType: 'ai_assistant',
      promptVersion: { id: 'test-prompt-v0', description: 'test stub' },
      modelInfo: { provider: 'test', model: 'stub' },
      generatedAt: new Date().toISOString(),
      requiresHumanReview: true,
    },
  }
}

// Compile-time proof that ComplianceAIProvider is implementable as specified
// — a type error here would fail `npm run build` / `npx tsc -b`, not just
// this test file.
class StubComplianceAIProvider implements ComplianceAIProvider {
  readonly modelInfo: AIComplianceModelInfo = { provider: 'test', model: 'stub' }
  readonly promptVersion: AICompliancePromptVersion = { id: 'test-prompt-v0', description: 'test stub' }

  async summariseLegalUpdate(rawText: string): Promise<AIComplianceOutput<string>> {
    return makeOutput(`Summary of: ${rawText.slice(0, 20)}`)
  }

  async classifyRisk(): Promise<AIComplianceOutput<ComplianceSeverity>> {
    return makeOutput<ComplianceSeverity>('medium')
  }

  async extractAffectedAreas(): Promise<AIComplianceOutput<LegalUpdateAffectedArea[]>> {
    return makeOutput<LegalUpdateAffectedArea[]>(['COA/testing'])
  }

  async detectJurisdictions(): Promise<AIComplianceOutput<string[]>> {
    return makeOutput<string[]>(['Thailand'])
  }
}

describe('ComplianceAIProvider — interface compiles and composes', () => {
  it('a concrete provider satisfies the interface and runComplianceAnalysis composes all four calls', async () => {
    const provider = new StubComplianceAIProvider()
    const result = await runComplianceAnalysis(provider, 'Example raw legal text')

    expect(result.summary.value).toContain('Summary of')
    expect(result.riskLevel.value).toBe('medium')
    expect(result.affectedAreas.value).toEqual(['COA/testing'])
    expect(result.jurisdictions.value).toEqual(['Thailand'])

    // Every output must carry provenance that marks it as AI-originated and
    // still requiring human review — never silently omitted.
    expect(result.summary.provenance.actorType).toBe('ai_assistant')
    expect(result.summary.provenance.requiresHumanReview).toBe(true)
  })
})

describe('Phase 0A does not change existing Compliance Watchtower behaviour', () => {
  // This module is deliberately not imported by DDPComplianceWatchtower.tsx
  // or complianceRepository.ts yet — Phase 0A ships the AI abstraction and
  // safety guard only, with no UI or enforcement wiring. That absence of
  // wiring is verified structurally (git status shows only new files added
  // in this change, nothing existing modified), not by this test suite.
  it('existing rule-enforcement gate logic (isEnforcedRuleStatus) is unchanged', () => {
    expect(isEnforcedRuleStatus('draft')).toBe(false)
    expect(isEnforcedRuleStatus('suggested')).toBe(false)
    expect(isEnforcedRuleStatus('paused')).toBe(false)
    expect(isEnforcedRuleStatus('retired')).toBe(false)
    expect(isEnforcedRuleStatus('rejected')).toBe(false)
    expect(isEnforcedRuleStatus('approved')).toBe(true)
    expect(isEnforcedRuleStatus('active')).toBe(true)
  })
})
