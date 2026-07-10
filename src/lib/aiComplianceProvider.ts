import type { ComplianceSeverity, LegalUpdateAffectedArea } from '../types'
import type {
  AICompliancePromptVersion,
  AIComplianceModelInfo,
  AIComplianceOutput,
  AIComplianceAnalysisResult,
} from './aiComplianceTypes'

// ─── AI Compliance Agent — provider abstraction (Phase 0A) ──────────────────
//
// Defines the contract a future AI compliance provider must implement. No
// implementation exists yet in this codebase — no AI API is called, no
// network request is made, and nothing here is wired into Compliance
// Watchtower. Every method returns a draft only: callers remain responsible
// for running it through aiComplianceGuard.ts, and a suggestion becomes a
// legal_update / compliance_rule only after a human reviewer acts through
// the existing Review Queue workflow in DDPComplianceWatchtower.tsx — this
// abstraction does not change that.

export interface ComplianceAIProvider {
  readonly modelInfo: AIComplianceModelInfo
  readonly promptVersion: AICompliancePromptVersion

  /** Draft a human-readable summary of a raw legal/regulatory text. */
  summariseLegalUpdate(rawText: string): Promise<AIComplianceOutput<string>>

  /** Draft a risk-severity classification for a raw legal/regulatory text. */
  classifyRisk(rawText: string): Promise<AIComplianceOutput<ComplianceSeverity>>

  /** Draft the set of affected areas a raw legal/regulatory text touches. */
  extractAffectedAreas(rawText: string): Promise<AIComplianceOutput<LegalUpdateAffectedArea[]>>

  /** Draft the jurisdiction(s) a raw legal/regulatory text applies to. */
  detectJurisdictions(rawText: string): Promise<AIComplianceOutput<string[]>>
}

/**
 * Runs all four ComplianceAIProvider calls against one raw text and
 * aggregates them. Pure orchestration over an injected provider — makes no
 * network call itself, since it never constructs a provider, only calls the
 * one it's given.
 */
export async function runComplianceAnalysis(
  provider: ComplianceAIProvider,
  rawText: string,
): Promise<AIComplianceAnalysisResult> {
  const [summary, riskLevel, affectedAreas, jurisdictions] = await Promise.all([
    provider.summariseLegalUpdate(rawText),
    provider.classifyRisk(rawText),
    provider.extractAffectedAreas(rawText),
    provider.detectJurisdictions(rawText),
  ])
  return { summary, riskLevel, affectedAreas, jurisdictions }
}

// ─── Structured draft-summary provider (Phase 2G) ───────────────────────────
//
// A narrow, complementary provider interface for producing a STRUCTURED draft
// summary of a single legal update's source evidence, for human legal review.
// It reuses AIComplianceOutput (value + confidence + provenance, with
// requiresHumanReview: true) rather than duplicating that contract. Like the
// rest of this file it declares only a contract — no implementation here calls
// a real AI service, opens a socket, or imports a vendor SDK. A caller injects
// a provider; there is no production provider configured in this repository.
//
// The five sections mirror the review-oriented output model: the AI drafts
// facts and questions, never a legal conclusion, certification, approval, rule,
// or enforcement — the guarded orchestration (complianceAiSummarisation.ts)
// and the wording guard (aiComplianceGuard.ts) enforce that.

export interface AiDraftSummarySections {
  draftSummary: string
  possibleSignificance: string
  uncertainties: string
  reviewQuestions: string[]
  sourceReferences: string[]
}

/** Minimal evidence a summary provider is given. Contains no secrets, tokens,
 *  cookies, or buyer/farmer/personal data — only what the guard permits. */
export interface AiSummaryProviderInput {
  legalUpdateId: string
  sourceName: string
  sourceUrl: string
  jurisdiction: string
  itemTitle: string
  publishedAt: string | null
  rawEvidence: string
  provenanceChecksum: string | null
}

export interface ComplianceAiSummaryProvider {
  /** Draft a structured, human-review-oriented summary. Returns a draft only. */
  draftSummary(input: AiSummaryProviderInput): Promise<AIComplianceOutput<AiDraftSummarySections>>
}
