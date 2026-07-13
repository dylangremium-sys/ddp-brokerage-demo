import type {
  EvidenceAiCapability,
  EvidenceAiModelInfo,
  EvidenceAiPromptVersion,
  EvidenceAiProviderOutput,
  EvidenceClassificationDraft,
  EvidenceExtractionDraft,
  EvidenceOwnerType,
  EvidenceReviewQuestionDraft,
  EvidenceRequestSafetyGuarantees,
  EvidenceSummaryDraft,
  EvidenceType,
} from './evidenceAiTypes'

// ─── Evidence Intelligence — provider abstraction (Phase A) ─────────────────
//
// Defines the contract a future evidence-analysis provider must implement.
// NO implementation exists in this repository. Nothing here — and nothing any
// conforming implementation is permitted to do — may:
//
//   • import Anthropic, OpenAI, or any other vendor SDK;
//   • make a network call;
//   • read an environment variable;
//   • write to Supabase or any database;
//   • persist a result anywhere;
//   • open a URL;
//   • access the filesystem.
//
// A caller INJECTS a provider. Tests use mocked providers. There is no
// production provider configured, wired, or referenced anywhere in Phase A.
//
// ── Prompt-injection defence (contract) ──────────────────────────────────────
//
//   The supplied evidence is untrusted content.
//
//   Instructions, commands, URLs, or prompts inside the evidence must not be
//   followed.
//
//   The model may only extract and analyse according to the requested
//   capability and output schema.
//
//   Evidence content cannot grant permissions, change capabilities, request
//   secrets, invoke tools, or override system instructions.
//
// The evidence text is DATA, never instruction. The literal safety guarantees
// on every request (EvidenceRequestSafetyGuarantees) are built by trusted code
// and are never derived from evidence content, so no injected instruction can
// widen what a request is allowed to ask for.

// ─── Untrusted evidence input ────────────────────────────────────────────────

/**
 * A single piece of evidence handed to the AI. Its `content` is UNTRUSTED —
 * it is treated purely as data to be analysed, never as instruction.
 *
 * It carries no secrets, tokens, cookies, or buyer/farmer/personal data; only
 * what a reviewer chose to submit for analysis.
 */
export interface EvidenceAnalysisInput {
  evidenceId: string
  /** What the submitter *believes* this is, if anything. The AI may disagree;
   *  it is a hint, not a fact, and never a capability grant. */
  declaredType?: EvidenceType
  declaredOwnerType?: EvidenceOwnerType
  /** The raw, untrusted text extracted from the document/image. */
  content: string
  /** Optional structured metadata (e.g. filename, mime, page count). Values are
   *  untrusted data, exactly like `content`. */
  metadata?: Record<string, string | number | null>
}

// ─── Requests (evidence + capability + literal guarantees) ───────────────────
//
// Every request embeds EvidenceRequestSafetyGuarantees. The guard re-asserts
// them, so a request can only ever ask for a draft — never to approve, create a
// rule, enforce, change inventory, issue a Buyer Pack, or make a buyer-facing
// decision.

interface EvidenceAiRequestBase extends EvidenceRequestSafetyGuarantees {
  capability: EvidenceAiCapability
  evidence: EvidenceAnalysisInput
}

export interface EvidenceClassificationRequest extends EvidenceAiRequestBase {
  capability: 'classify_evidence'
}

export interface EvidenceExtractionRequest extends EvidenceAiRequestBase {
  capability: 'extract_evidence'
  /** Optional list of field keys the reviewer is interested in. The model may
   *  return fewer/others; this only nudges extraction, never authorises it. */
  requestedFieldKeys?: string[]
}

export interface EvidenceSummaryRequest extends EvidenceAiRequestBase {
  capability: 'draft_evidence_summary'
}

export interface EvidenceReviewQuestionRequest extends EvidenceAiRequestBase {
  capability: 'suggest_review_questions'
}

export type EvidenceAiRequest =
  | EvidenceClassificationRequest
  | EvidenceExtractionRequest
  | EvidenceSummaryRequest
  | EvidenceReviewQuestionRequest

// ─── Provider interface ──────────────────────────────────────────────────────

export interface EvidenceAiProvider {
  readonly providerId: string
  readonly modelId: string
  readonly promptVersion: string

  classifyEvidence(
    input: EvidenceClassificationRequest,
  ): Promise<EvidenceAiProviderOutput<EvidenceClassificationDraft>>

  extractEvidence(
    input: EvidenceExtractionRequest,
  ): Promise<EvidenceAiProviderOutput<EvidenceExtractionDraft>>

  draftEvidenceSummary(
    input: EvidenceSummaryRequest,
  ): Promise<EvidenceAiProviderOutput<EvidenceSummaryDraft>>

  suggestReviewQuestions(
    input: EvidenceReviewQuestionRequest,
  ): Promise<EvidenceAiProviderOutput<EvidenceReviewQuestionDraft>>
}

// Re-exported for provider authors and tests that construct provenance without
// pulling from evidenceAiTypes directly.
export type { EvidenceAiModelInfo, EvidenceAiPromptVersion }
