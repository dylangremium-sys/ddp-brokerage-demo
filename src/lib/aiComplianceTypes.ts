import type { ComplianceSeverity, LegalUpdateAffectedArea } from '../types'

// ─── AI Compliance Agent — foundation types (Phase 0A) ──────────────────────
//
// These types exist so any future AI-assisted compliance analysis has a
// place to declare, unambiguously, that it is a machine draft: which prompt
// produced it, which model ran it, how confident it claims to be, and that
// it always still requires human review. Nothing in this file calls an AI
// provider, writes to Supabase, or changes any existing Compliance
// Watchtower behaviour — see aiComplianceProvider.ts for the (currently
// unimplemented) provider abstraction, and aiComplianceGuard.ts for the
// wording safety check every AI-drafted string should pass before a human
// reviewer ever sees it.

/**
 * Identifies which prompt template produced an AI output, so a prompt
 * change/regression can be traced back to the specific outputs it produced.
 */
export interface AICompliancePromptVersion {
  id: string
  description: string
}

export interface AIComplianceModelInfo {
  provider: string
  model: string
  modelVersion?: string
}

/**
 * 0..1. Callers must never treat any value here — including 1 — as
 * certainty or as a substitute for human review. It is a hint for
 * prioritising the review queue, nothing more.
 */
export type AIComplianceConfidenceScore = number

export interface AIComplianceProvenance {
  actorType: 'ai_assistant'
  promptVersion: AICompliancePromptVersion
  modelInfo: AIComplianceModelInfo
  generatedAt: string
  /**
   * Always true. Exists so every consumer of an AI output is forced to read
   * (and cannot silently omit) that an AI-drafted result is never
   * enforceable, never buyer-visible, and never a substitute for human
   * review — see ComplianceAIProvider in aiComplianceProvider.ts.
   */
  requiresHumanReview: true
  /**
   * References an EARLIER layer already discarded as ungrounded, when this
   * output reached us through one (the browser receives sections the server
   * has already filtered). Without it the count is lost at the wire and the
   * browser reports zero discards for a draft the server pruned — telling a
   * reviewer the model cited nothing it could not support, which is the
   * opposite of what happened. Undefined when nothing upstream filtered.
   */
  upstreamDroppedReferences?: number
}

/**
 * A single AI-drafted value, always paired with its confidence and
 * provenance — never returned bare, so a caller can never accidentally
 * treat a drafted value as if it had no AI origin.
 */
export interface AIComplianceOutput<T> {
  value: T
  confidence: AIComplianceConfidenceScore
  provenance: AIComplianceProvenance
}

/**
 * The four ComplianceAIProvider calls run together against one raw legal
 * update text. A convenience aggregate only — carries no data beyond what
 * the four individual provider methods already return.
 */
export interface AIComplianceAnalysisResult {
  summary: AIComplianceOutput<string>
  riskLevel: AIComplianceOutput<ComplianceSeverity>
  affectedAreas: AIComplianceOutput<LegalUpdateAffectedArea[]>
  jurisdictions: AIComplianceOutput<string[]>
}
