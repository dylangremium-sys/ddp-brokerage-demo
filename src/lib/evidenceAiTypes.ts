// ─── Evidence Intelligence — foundation types (Phase A) ─────────────────────
//
// Type contracts for AI-assisted analysis of supplier / laboratory evidence
// (CoAs, batch records, licences, certificates, traceability, images, …).
//
// This capability is DELIBERATELY SEPARATE from the legal-update summarisation
// agent in aiComplianceTypes.ts / aiComplianceProvider.ts. It is not an
// enlargement of the legal-summary prompt into a general document agent — it is
// a narrow, draft-only evidence-analysis contract with its own guards, its own
// wording safety check, and its own orchestration.
//
// Nothing in this file (or anywhere in Phase A) calls an AI provider, opens a
// socket, reads an environment variable, touches Supabase, persists anything,
// or changes any existing Compliance Watchtower / Buyer Pack behaviour. Every
// contract here is a machine DRAFT: it always still requires human review and
// can never approve, certify, enforce, release inventory, create a rule, or
// issue a Buyer Pack.
//
// Governing principle:
//   AI detects → AI extracts → AI compares → AI summarises →
//   Human reviews → Human decides → Approved system rule enforces

// ─── Capability model ────────────────────────────────────────────────────────

/**
 * The four — and only four — narrow things the evidence AI may be asked to do.
 * Every capability is draft-only. There is deliberately no "approve",
 * "certify", "release", or "decide" capability: those are human/deterministic
 * responsibilities and cannot be requested through this contract at all.
 */
export type EvidenceAiCapability =
  | 'classify_evidence'
  | 'extract_evidence'
  | 'draft_evidence_summary'
  | 'suggest_review_questions'

export const EVIDENCE_AI_CAPABILITIES: readonly EvidenceAiCapability[] = [
  'classify_evidence',
  'extract_evidence',
  'draft_evidence_summary',
  'suggest_review_questions',
]

// ─── Evidence categories ─────────────────────────────────────────────────────

export type EvidenceType =
  | 'coa'
  | 'batch_record'
  | 'licence'
  | 'certificate'
  | 'traceability_record'
  | 'cultivar_dossier'
  | 'sampling_record'
  | 'storage_record'
  | 'transport_record'
  | 'image'
  | 'other'

export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  'coa',
  'batch_record',
  'licence',
  'certificate',
  'traceability_record',
  'cultivar_dossier',
  'sampling_record',
  'storage_record',
  'transport_record',
  'image',
  'other',
]

/** Who owns / issued a piece of evidence. Used by deterministic ownership
 *  mismatch checks; the AI may only PROPOSE one of these, never assert it. */
export type EvidenceOwnerType =
  | 'supplier'
  | 'laboratory'
  | 'buyer'
  | 'regulator'
  | 'certification_body'
  | 'logistics_provider'
  | 'third_party'
  | 'unknown'

export const EVIDENCE_OWNER_TYPES: readonly EvidenceOwnerType[] = [
  'supplier',
  'laboratory',
  'buyer',
  'regulator',
  'certification_body',
  'logistics_provider',
  'third_party',
  'unknown',
]

// ─── Provenance ──────────────────────────────────────────────────────────────

/**
 * Identifies which prompt template produced an AI output, so a prompt
 * change/regression can be traced back to the outputs it produced.
 */
export interface EvidenceAiPromptVersion {
  id: string
  description: string
}

export interface EvidenceAiModelInfo {
  provider: string
  model: string
  modelVersion?: string
}

/**
 * 0..1. Callers must never treat any value here — including 1 — as certainty
 * or as a substitute for human review. It is a hint for prioritising a review
 * queue, nothing more.
 */
export type EvidenceAiConfidenceScore = number

export interface EvidenceAiProvenance {
  actorType: 'ai_assistant'
  promptVersion: EvidenceAiPromptVersion
  modelInfo: EvidenceAiModelInfo
  generatedAt: string
  /** Always true. Exists so no consumer of an AI output can silently omit that
   *  the result is never enforceable, never buyer-visible, and never a
   *  substitute for human review. */
  requiresHumanReview: true
}

/**
 * A single provider result: the drafted value plus its confidence and
 * provenance — never returned bare, so a caller can never accidentally treat a
 * drafted value as if it had no AI origin.
 */
export interface EvidenceAiProviderOutput<T> {
  value: T
  confidence: EvidenceAiConfidenceScore
  provenance: EvidenceAiProvenance
}

// ─── Provenance of an extracted value ────────────────────────────────────────

/** Where in the source document a proposed value was read from. */
export interface EvidenceSourceReference {
  page?: number
  section?: string
  fieldLabel?: string
  excerpt?: string
}

/**
 * A single AI-proposed extracted value. `value` may be null (the model could
 * not read it), but confidence and at least one source reference are still
 * required so there are no unexplained extracted values.
 */
export interface ExtractedEvidenceValue<T> {
  /** Machine-readable label for what this value is (e.g. "batch_identifier"). */
  fieldKey: string
  value: T | null
  confidence: EvidenceAiConfidenceScore
  sourceReferences: EvidenceSourceReference[]
}

// ─── Draft output shapes (one per capability) ────────────────────────────────
//
// Each is a NEUTRAL draft: proposals, extracted candidates, uncertainty, and
// questions. None contains a pass/fail, an approval, a legal conclusion, or an
// authentication claim — the guard rejects any output that tries to.

/** classify_evidence → a proposed type and owner, with uncertainty. */
export interface EvidenceClassificationDraft {
  proposedType: EvidenceType
  proposedOwnerType: EvidenceOwnerType
  /** The model's own note on what makes this uncertain. Neutral prose only. */
  uncertaintyNote: string
  /** Alternative types the model considered but did not rank first. */
  alternativeTypes: EvidenceType[]
}

/** A relationship the model *suspects* between two evidence items. It is a
 *  candidate for a human/deterministic check, never an asserted fact. */
export interface EvidenceRelationshipHint {
  relatesToEvidenceId: string
  natureOfRelationship: string
}

/** extract_evidence → proposed field values + suspected relationships. */
export interface EvidenceExtractionDraft {
  extractedValues: ExtractedEvidenceValue<string>[]
  possibleRelationships: EvidenceRelationshipHint[]
}

/** draft_evidence_summary → a neutral, reviewer-facing summary. */
export interface EvidenceSummaryDraft {
  neutralSummary: string
  observedUncertainties: string
  /** Verbatim-ish pointers back into the source ("the source document states…"). */
  sourceObservations: string[]
}

/** suggest_review_questions → questions FOR a human reviewer to consider. */
export interface EvidenceReviewQuestionDraft {
  reviewQuestions: string[]
}

/** Union of every draft a provider may return, keyed by capability. */
export type EvidenceAiDraft =
  | EvidenceClassificationDraft
  | EvidenceExtractionDraft
  | EvidenceSummaryDraft
  | EvidenceReviewQuestionDraft

// ─── Literal safety guarantees ───────────────────────────────────────────────
//
// These are constructed ONLY by trusted code (buildEvidenceRequest / the
// analysis orchestrator). They are never read from provider or caller input, so
// no evidence content and no future client can grant a capability by supplying
// a field. See evidenceAiGuard.ts, which re-asserts every one of them.

/** Attached to a REQUEST: this request can only ever ask for a draft. */
export interface EvidenceRequestSafetyGuarantees {
  isDraftOnly: true
  requiresHumanReview: true
  canApprove: false
  canCreateRule: false
  canEnforce: false
  canIssueBuyerPack: false
  canChangeInventory: false
  makesBuyerFacingDecision: false
}

/** Attached to a RESULT: this draft did none of the forbidden things. */
export interface EvidenceResultSafetyGuarantees {
  requiresHumanReview: true
  approvesEvidence: false
  createsRule: false
  enforces: false
  issuesBuyerPack: false
  changesInventory: false
  makesBuyerFacingDecision: false
}

export const EVIDENCE_REQUEST_SAFETY_GUARANTEES: EvidenceRequestSafetyGuarantees = {
  isDraftOnly: true,
  requiresHumanReview: true,
  canApprove: false,
  canCreateRule: false,
  canEnforce: false,
  canIssueBuyerPack: false,
  canChangeInventory: false,
  makesBuyerFacingDecision: false,
}

export const EVIDENCE_RESULT_SAFETY_GUARANTEES: EvidenceResultSafetyGuarantees = {
  requiresHumanReview: true,
  approvesEvidence: false,
  createsRule: false,
  enforces: false,
  issuesBuyerPack: false,
  changesInventory: false,
  makesBuyerFacingDecision: false,
}
