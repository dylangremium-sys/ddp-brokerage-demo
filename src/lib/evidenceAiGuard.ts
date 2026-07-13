import {
  EVIDENCE_AI_CAPABILITIES,
  EVIDENCE_OWNER_TYPES,
  EVIDENCE_TYPES,
} from './evidenceAiTypes'
import type {
  EvidenceAiCapability,
  EvidenceClassificationDraft,
  EvidenceExtractionDraft,
  EvidenceReviewQuestionDraft,
  EvidenceSourceReference,
  EvidenceSummaryDraft,
  ExtractedEvidenceValue,
} from './evidenceAiTypes'
import type { EvidenceAnalysisInput } from './evidenceAiProvider'

// ─── Evidence Intelligence — request & output guards (Phase A) ──────────────
//
// Pure, dependency-free guards for the evidence-analysis pipeline. This module
// makes no network call, reads no environment, touches no database, and
// persists nothing. It has three jobs:
//
//   1. WORDING SAFETY — block AI-authored prose from asserting an approval /
//      certification / authentication / compliance claim that only a human
//      reviewer (never the AI) may make. Modelled on aiComplianceGuard.ts but
//      independently defined and independently testable, with an evidence-
//      specific term list.
//   2. REQUEST ELIGIBILITY — evidence present, size-bounded, provider present,
//      capability supported, no in-flight request.
//   3. STRUCTURED-OUTPUT VALIDATION — never trust the provider just because
//      TypeScript compiled. Reject null-where-disallowed, wrong item types,
//      unknown fields, missing required fields, invalid confidence, empty
//      mandatory values, unsupported evidence types/capabilities, unexplained
//      extracted values, and (via the wording guard) any output that tries to
//      make a decision.

export const DEFAULT_MAX_EVIDENCE_CHARS = 20000

// ─── 1. Wording safety guard ─────────────────────────────────────────────────
//
// Longest/most-specific phrases first so a match on a longer phrase is recorded
// once, not again for a shorter substring inside it (e.g. "legally compliant"
// vs "compliant", "eu approved" vs "approved"). Matches "approved" (a claim
// that approval occurred) but relies on negation handling so "no approved rule
// has been applied" reads as safe procedural language.

export const EVIDENCE_UNSAFE_TERMS = [
  'passes all requirements',
  'meets all regulations',
  'pharmaceutical grade',
  'authentic document',
  'genuine certificate',
  'legally compliant',
  'fit for export',
  'fit for market',
  'safe for sale',
  'export-ready',
  'export ready',
  'eu approved',
  'compliant',
  'certified',
  'guaranteed',
  'authentic',
  'approved',
  'verified',
] as const

// Negation / non-claim markers. If any appears in the short window immediately
// before a matched term, the match is treated as safe qualified language.
const NEGATION_MARKERS = [
  'not', 'no', 'non', 'never', 'without', 'cannot', "can't", 'can not',
  "isn't", 'is not', "aren't", 'are not', "doesn't", 'does not',
  "don't", 'do not', "wasn't", 'was not', "weren't", 'were not',
  'lack of', 'lacks', 'pending', 'unable', 'unverified', 'not yet',
]

const NEGATION_WINDOW_CHARS = 40

export interface EvidenceWordingFinding {
  term: string
  index: number
  context: string
}

export interface EvidenceWordingResult {
  isSafe: boolean
  findings: EvidenceWordingFinding[]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isNegatedContext(precedingText: string): boolean {
  return NEGATION_MARKERS.some(marker =>
    new RegExp(`\\b${escapeRegExp(marker)}\\b`, 'i').test(precedingText),
  )
}

/**
 * Scans AI-drafted evidence prose for unqualified approval / certification /
 * authentication / compliance claims. Returns every unsafe match (empty array
 * = safe). A match is excluded when a negation marker appears within a short
 * preceding window, so "not certified" / "unable to verify authenticity" /
 * "no approved rule has been applied" pass.
 */
export function guardEvidenceWording(text: string): EvidenceWordingResult {
  const lower = text.toLowerCase()
  const findings: EvidenceWordingFinding[] = []
  const consumed = new Set<number>()

  for (const term of EVIDENCE_UNSAFE_TERMS) {
    let searchFrom = 0
    while (searchFrom <= lower.length) {
      const idx = lower.indexOf(term, searchFrom)
      if (idx === -1) break
      searchFrom = idx + 1

      const positions = Array.from({ length: term.length }, (_, i) => idx + i)
      if (positions.some(pos => consumed.has(pos))) continue
      positions.forEach(pos => consumed.add(pos))

      const windowStart = Math.max(0, idx - NEGATION_WINDOW_CHARS)
      const precedingWindow = lower.slice(windowStart, idx)

      if (!isNegatedContext(precedingWindow)) {
        findings.push({
          term,
          index: idx,
          context: text.slice(windowStart, Math.min(text.length, idx + term.length + 20)),
        })
      }
    }
  }

  return { isSafe: findings.length === 0, findings }
}

export interface EvidenceWordingFieldFinding extends EvidenceWordingFinding {
  field: string
}

export interface EvidenceWordingFieldsResult {
  isSafe: boolean
  findings: EvidenceWordingFieldFinding[]
}

/**
 * Runs guardEvidenceWording() independently over each named field and
 * aggregates the findings. Fields are checked independently — never
 * concatenated — so a negation at the end of one field can never mask an
 * unsafe claim at the start of another. Empty/whitespace-only fields skipped.
 */
export function guardEvidenceWordingFields(fields: Record<string, string>): EvidenceWordingFieldsResult {
  const findings: EvidenceWordingFieldFinding[] = []
  for (const [field, text] of Object.entries(fields)) {
    if (!text || !text.trim()) continue
    for (const finding of guardEvidenceWording(text).findings) {
      findings.push({ ...finding, field })
    }
  }
  return { isSafe: findings.length === 0, findings }
}

// ─── 2. Request eligibility guard ────────────────────────────────────────────

export type EvidenceRequestGuardCode =
  | 'request_in_progress'
  | 'missing_evidence'
  | 'oversized_evidence'
  | 'provider_unconfigured'
  | 'unsupported_capability'

export type EvidenceRequestGuardDecision =
  | { action: 'allow' }
  | { action: 'reject'; code: EvidenceRequestGuardCode; reason: string }

export interface EvidenceRequestGuardOptions {
  providerAvailable: boolean
  requestInProgress: boolean
  maxEvidenceChars?: number
}

export function isSupportedEvidenceCapability(capability: string): capability is EvidenceAiCapability {
  return (EVIDENCE_AI_CAPABILITIES as readonly string[]).includes(capability)
}

/**
 * Pure eligibility gate. A request may proceed only when: no request is already
 * in flight, a provider is configured, the capability is one of the four
 * supported draft capabilities, and the evidence is present and size-bounded.
 */
export function assessEvidenceRequestEligibility(
  evidence: EvidenceAnalysisInput | null,
  capability: string,
  opts: EvidenceRequestGuardOptions,
): EvidenceRequestGuardDecision {
  if (opts.requestInProgress) {
    return { action: 'reject', code: 'request_in_progress', reason: 'An evidence analysis is already being generated.' }
  }
  if (!opts.providerAvailable) {
    return { action: 'reject', code: 'provider_unconfigured', reason: 'No AI provider is configured for this build.' }
  }
  if (!isSupportedEvidenceCapability(capability)) {
    return { action: 'reject', code: 'unsupported_capability', reason: `"${capability}" is not a supported evidence capability.` }
  }
  if (!evidence) {
    return { action: 'reject', code: 'missing_evidence', reason: 'No evidence was provided for analysis.' }
  }
  const content = (evidence.content ?? '').trim()
  if (content.length === 0) {
    return { action: 'reject', code: 'missing_evidence', reason: 'The supplied evidence has no content to analyse.' }
  }
  const max = opts.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
  if (content.length > max) {
    return { action: 'reject', code: 'oversized_evidence', reason: `Evidence content exceeds the ${max}-character limit for analysis.` }
  }
  return { action: 'allow' }
}

// ─── 3. Structured-output validation ─────────────────────────────────────────

export type EvidenceOutputValidationCode =
  | 'malformed_output'
  | 'empty_output'
  | 'invalid_confidence'
  | 'missing_provenance'
  | 'unknown_field'
  | 'unsupported_type'
  | 'missing_provenance_reference'

export type EvidenceValidation<T> =
  | { ok: true; value: T }
  | { ok: false; code: EvidenceOutputValidationCode; reason: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True only if `obj` has no keys outside `allowed` (rejects unknown fields). */
function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every(k => allowed.includes(k))
}

export function isValidConfidence(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

const PROVENANCE_KEYS = ['actorType', 'promptVersion', 'modelInfo', 'generatedAt', 'requiresHumanReview']
const PROMPT_VERSION_KEYS = ['id', 'description']
const MODEL_INFO_KEYS = ['provider', 'model', 'modelVersion']
const SOURCE_REFERENCE_KEYS = ['page', 'section', 'fieldLabel', 'excerpt']

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function validateProvenance(v: unknown): boolean {
  if (!isPlainObject(v) || !hasOnlyKeys(v, PROVENANCE_KEYS)) return false
  if (v.actorType !== 'ai_assistant') return false
  if (v.requiresHumanReview !== true) return false
  if (!isNonEmptyString(v.generatedAt)) return false
  if (!isPlainObject(v.promptVersion) || !hasOnlyKeys(v.promptVersion, PROMPT_VERSION_KEYS)) return false
  if (!isNonEmptyString(v.promptVersion.id) || typeof v.promptVersion.description !== 'string') return false
  if (!isPlainObject(v.modelInfo) || !hasOnlyKeys(v.modelInfo, MODEL_INFO_KEYS)) return false
  if (!isNonEmptyString(v.modelInfo.provider) || !isNonEmptyString(v.modelInfo.model)) return false
  if (v.modelInfo.modelVersion !== undefined && typeof v.modelInfo.modelVersion !== 'string') return false
  return true
}

/**
 * Validates the provider envelope (confidence + provenance) that wraps EVERY
 * draft, independently of the draft's own shape. Returns the inner `value` as
 * `unknown` for a capability-specific validator to check next.
 */
export function validateProviderEnvelope(
  output: unknown,
): EvidenceValidation<{ value: unknown; confidence: number }> {
  if (!isPlainObject(output) || !hasOnlyKeys(output, ['value', 'confidence', 'provenance'])) {
    return { ok: false, code: 'malformed_output', reason: 'Provider output is not a well-formed result envelope.' }
  }
  if (!('value' in output) || output.value === undefined || output.value === null) {
    return { ok: false, code: 'empty_output', reason: 'Provider output contained no draft value.' }
  }
  if (!isValidConfidence(output.confidence)) {
    return { ok: false, code: 'invalid_confidence', reason: 'Provider confidence must be a finite number between 0 and 1.' }
  }
  if (!validateProvenance(output.provenance)) {
    return { ok: false, code: 'missing_provenance', reason: 'Provider output is missing valid AI provenance.' }
  }
  return { ok: true, value: { value: output.value, confidence: output.confidence } }
}

function validateSourceReference(v: unknown): boolean {
  if (!isPlainObject(v) || !hasOnlyKeys(v, SOURCE_REFERENCE_KEYS)) return false
  if (v.page !== undefined && (typeof v.page !== 'number' || !Number.isFinite(v.page))) return false
  for (const key of ['section', 'fieldLabel', 'excerpt'] as const) {
    if (v[key] !== undefined && typeof v[key] !== 'string') return false
  }
  return true
}

/** Validates one AI-proposed extracted value. A non-null value MUST carry at
 *  least one source reference — no unexplained extracted values. */
export function validateExtractedValue(v: unknown): EvidenceValidation<ExtractedEvidenceValue<string>> {
  if (!isPlainObject(v) || !hasOnlyKeys(v, ['fieldKey', 'value', 'confidence', 'sourceReferences'])) {
    return { ok: false, code: 'malformed_output', reason: 'Extracted value is malformed.' }
  }
  if (!isNonEmptyString(v.fieldKey)) {
    return { ok: false, code: 'malformed_output', reason: 'Extracted value is missing a field key.' }
  }
  if (!(v.value === null || typeof v.value === 'string')) {
    return { ok: false, code: 'malformed_output', reason: 'Extracted value must be a string or null.' }
  }
  if (!isValidConfidence(v.confidence)) {
    return { ok: false, code: 'invalid_confidence', reason: 'Extracted value confidence must be between 0 and 1.' }
  }
  if (!Array.isArray(v.sourceReferences) || !v.sourceReferences.every(validateSourceReference)) {
    return { ok: false, code: 'malformed_output', reason: 'Extracted value has malformed source references.' }
  }
  if (v.value !== null && v.sourceReferences.length === 0) {
    return { ok: false, code: 'missing_provenance_reference', reason: `Extracted value "${v.fieldKey}" has no source reference.` }
  }
  return { ok: true, value: v as unknown as ExtractedEvidenceValue<string> }
}

function validateStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(item => typeof item === 'string')
}

export function validateClassificationDraft(v: unknown): EvidenceValidation<EvidenceClassificationDraft> {
  if (!isPlainObject(v) || !hasOnlyKeys(v, ['proposedType', 'proposedOwnerType', 'uncertaintyNote', 'alternativeTypes'])) {
    return { ok: false, code: 'malformed_output', reason: 'Classification draft is malformed or has unknown fields.' }
  }
  if (!(EVIDENCE_TYPES as readonly unknown[]).includes(v.proposedType)) {
    return { ok: false, code: 'unsupported_type', reason: `Proposed evidence type "${String(v.proposedType)}" is not supported.` }
  }
  if (!(EVIDENCE_OWNER_TYPES as readonly unknown[]).includes(v.proposedOwnerType)) {
    return { ok: false, code: 'unsupported_type', reason: `Proposed owner type "${String(v.proposedOwnerType)}" is not supported.` }
  }
  if (typeof v.uncertaintyNote !== 'string') {
    return { ok: false, code: 'malformed_output', reason: 'Classification uncertaintyNote must be a string.' }
  }
  if (!validateStringArray(v.alternativeTypes) || !v.alternativeTypes.every(t => (EVIDENCE_TYPES as readonly string[]).includes(t))) {
    return { ok: false, code: 'unsupported_type', reason: 'Classification alternativeTypes contains an unsupported type.' }
  }
  return { ok: true, value: v as unknown as EvidenceClassificationDraft }
}

export function validateExtractionDraft(v: unknown): EvidenceValidation<EvidenceExtractionDraft> {
  if (!isPlainObject(v) || !hasOnlyKeys(v, ['extractedValues', 'possibleRelationships'])) {
    return { ok: false, code: 'malformed_output', reason: 'Extraction draft is malformed or has unknown fields.' }
  }
  if (!Array.isArray(v.extractedValues) || !Array.isArray(v.possibleRelationships)) {
    return { ok: false, code: 'malformed_output', reason: 'Extraction draft arrays are malformed.' }
  }
  for (const ev of v.extractedValues) {
    const res = validateExtractedValue(ev)
    if (!res.ok) return res
  }
  for (const rel of v.possibleRelationships) {
    if (!isPlainObject(rel) || !hasOnlyKeys(rel, ['relatesToEvidenceId', 'natureOfRelationship'])) {
      return { ok: false, code: 'malformed_output', reason: 'A possible relationship is malformed.' }
    }
    if (!isNonEmptyString(rel.relatesToEvidenceId) || typeof rel.natureOfRelationship !== 'string') {
      return { ok: false, code: 'malformed_output', reason: 'A possible relationship has invalid fields.' }
    }
  }
  return { ok: true, value: v as unknown as EvidenceExtractionDraft }
}

export function validateSummaryDraft(v: unknown): EvidenceValidation<EvidenceSummaryDraft> {
  if (!isPlainObject(v) || !hasOnlyKeys(v, ['neutralSummary', 'observedUncertainties', 'sourceObservations'])) {
    return { ok: false, code: 'malformed_output', reason: 'Summary draft is malformed or has unknown fields.' }
  }
  if (typeof v.neutralSummary !== 'string' || typeof v.observedUncertainties !== 'string') {
    return { ok: false, code: 'malformed_output', reason: 'Summary draft prose fields must be strings.' }
  }
  if (!validateStringArray(v.sourceObservations)) {
    return { ok: false, code: 'malformed_output', reason: 'Summary draft sourceObservations must be an array of strings.' }
  }
  if (v.neutralSummary.trim().length === 0) {
    return { ok: false, code: 'empty_output', reason: 'Summary draft neutralSummary is empty.' }
  }
  return { ok: true, value: v as unknown as EvidenceSummaryDraft }
}

export function validateReviewQuestionDraft(v: unknown): EvidenceValidation<EvidenceReviewQuestionDraft> {
  if (!isPlainObject(v) || !hasOnlyKeys(v, ['reviewQuestions'])) {
    return { ok: false, code: 'malformed_output', reason: 'Review-question draft is malformed or has unknown fields.' }
  }
  const questions = v.reviewQuestions
  if (!validateStringArray(questions)) {
    return { ok: false, code: 'malformed_output', reason: 'reviewQuestions must be an array of strings.' }
  }
  if (questions.length === 0 || questions.every(q => q.trim().length === 0)) {
    return { ok: false, code: 'empty_output', reason: 'Review-question draft contained no questions.' }
  }
  return { ok: true, value: v as unknown as EvidenceReviewQuestionDraft }
}

/**
 * Collects every AI-AUTHORED prose string from a draft so the wording guard can
 * be run over it. Machine-readable enum values (proposedType, fieldKey) and
 * echoed identifiers are deliberately excluded — they are not free-text claims.
 */
export function collectDraftProse(
  capability: EvidenceAiCapability,
  draft: EvidenceClassificationDraft | EvidenceExtractionDraft | EvidenceSummaryDraft | EvidenceReviewQuestionDraft,
): Record<string, string> {
  switch (capability) {
    case 'classify_evidence': {
      const d = draft as EvidenceClassificationDraft
      return { uncertaintyNote: d.uncertaintyNote }
    }
    case 'extract_evidence': {
      const d = draft as EvidenceExtractionDraft
      const fields: Record<string, string> = {}
      d.extractedValues.forEach((ev, i) => {
        if (typeof ev.value === 'string') fields[`extractedValues[${i}].value`] = ev.value
      })
      d.possibleRelationships.forEach((rel, i) => {
        fields[`possibleRelationships[${i}].natureOfRelationship`] = rel.natureOfRelationship
      })
      return fields
    }
    case 'draft_evidence_summary': {
      const d = draft as EvidenceSummaryDraft
      return { neutralSummary: d.neutralSummary, observedUncertainties: d.observedUncertainties }
    }
    case 'suggest_review_questions': {
      const d = draft as EvidenceReviewQuestionDraft
      return { reviewQuestions: d.reviewQuestions.join('\n') }
    }
  }
}

// Re-exported so callers can validate a raw envelope value against a source
// reference without reaching into internals.
export type { EvidenceSourceReference }
