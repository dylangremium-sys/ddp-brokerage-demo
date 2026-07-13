import {
  EVIDENCE_REQUEST_SAFETY_GUARANTEES,
  EVIDENCE_RESULT_SAFETY_GUARANTEES,
} from './evidenceAiTypes'
import type {
  EvidenceAiCapability,
  EvidenceAiDraft,
  EvidenceAiProviderOutput,
  EvidenceResultSafetyGuarantees,
} from './evidenceAiTypes'
import type {
  EvidenceAiProvider,
  EvidenceAnalysisInput,
  EvidenceClassificationRequest,
  EvidenceExtractionRequest,
  EvidenceReviewQuestionRequest,
  EvidenceSummaryRequest,
} from './evidenceAiProvider'
import {
  assessEvidenceRequestEligibility,
  collectDraftProse,
  guardEvidenceWordingFields,
  validateClassificationDraft,
  validateExtractionDraft,
  validateProviderEnvelope,
  validateReviewQuestionDraft,
  validateSummaryDraft,
} from './evidenceAiGuard.js'
import type {
  EvidenceOutputValidationCode,
  EvidenceRequestGuardCode,
  EvidenceValidation,
} from './evidenceAiGuard'

// ─── Evidence Intelligence — analysis orchestration (Phase A) ───────────────
//
// The single, pure entry point that turns an untrusted evidence item + a
// requested capability + an INJECTED provider into a clearly-labelled,
// transient DRAFT — or a safe coded error. It:
//
//   • constructs no provider and imports no vendor SDK;
//   • makes no network call, reads no environment, touches no database;
//   • persists NOTHING (the draft is returned, never stored);
//   • never approves, certifies, enforces, releases inventory, creates a rule,
//     or issues a Buyer Pack.
//
// Fixed sequence (every step below is enforced):
//   eligibility guard → capability validation → input bounds
//   → construct restricted request → provider call → output shape validation
//   → safety-capability validation → wording guard → provenance validation
//   → labelled transient draft

export const EVIDENCE_DRAFT_LABEL =
  'AI-generated evidence draft — requires human review; no determination has been made'

export interface EvidenceAnalysisOptions {
  requestInProgress: boolean
  maxEvidenceChars?: number
  /** Optional field-key hints for the extract_evidence capability. */
  requestedFieldKeys?: string[]
}

export type EvidenceAnalysisResultCode =
  | EvidenceRequestGuardCode
  | EvidenceOutputValidationCode
  | 'provider_error'
  | 'provider_timeout'
  | 'unsafe_output'

export interface EvidenceAnalysisDraft extends EvidenceResultSafetyGuarantees {
  evidenceId: string
  capability: EvidenceAiCapability
  providerId: string
  modelId: string
  promptVersion: string
  generatedAt: string
  confidence: number
  draft: EvidenceAiDraft
  status: 'draft_generated'
  label: string
}

export type EvidenceAnalysisResult =
  | { ok: true; draft: EvidenceAnalysisDraft }
  | { ok: false; code: EvidenceAnalysisResultCode; reason: string }

// Validate the capability-specific draft shape after the envelope is trusted.
function validateDraftForCapability(
  capability: EvidenceAiCapability,
  value: unknown,
): EvidenceValidation<EvidenceAiDraft> {
  switch (capability) {
    case 'classify_evidence':
      return validateClassificationDraft(value)
    case 'extract_evidence':
      return validateExtractionDraft(value)
    case 'draft_evidence_summary':
      return validateSummaryDraft(value)
    case 'suggest_review_questions':
      return validateReviewQuestionDraft(value)
  }
}

// Dispatch to the injected provider. Restricted requests are constructed HERE,
// from trusted constants — never from evidence content — so no injected
// instruction can widen what is asked for.
async function callProvider(
  provider: EvidenceAiProvider,
  capability: EvidenceAiCapability,
  evidence: EvidenceAnalysisInput,
  options: EvidenceAnalysisOptions,
): Promise<EvidenceAiProviderOutput<unknown>> {
  switch (capability) {
    case 'classify_evidence': {
      const request: EvidenceClassificationRequest = {
        ...EVIDENCE_REQUEST_SAFETY_GUARANTEES,
        capability: 'classify_evidence',
        evidence,
      }
      return provider.classifyEvidence(request)
    }
    case 'extract_evidence': {
      const request: EvidenceExtractionRequest = {
        ...EVIDENCE_REQUEST_SAFETY_GUARANTEES,
        capability: 'extract_evidence',
        evidence,
        requestedFieldKeys: options.requestedFieldKeys,
      }
      return provider.extractEvidence(request)
    }
    case 'draft_evidence_summary': {
      const request: EvidenceSummaryRequest = {
        ...EVIDENCE_REQUEST_SAFETY_GUARANTEES,
        capability: 'draft_evidence_summary',
        evidence,
      }
      return provider.draftEvidenceSummary(request)
    }
    case 'suggest_review_questions': {
      const request: EvidenceReviewQuestionRequest = {
        ...EVIDENCE_REQUEST_SAFETY_GUARANTEES,
        capability: 'suggest_review_questions',
        evidence,
      }
      return provider.suggestReviewQuestions(request)
    }
  }
}

/**
 * Generate a transient evidence-intelligence draft. Returns a safe coded error
 * for every failure mode — missing/oversized/absent evidence, absent provider,
 * unsupported capability, in-flight request, provider error/timeout, malformed
 * or empty output, invalid confidence, missing provenance, and any output that
 * makes an unqualified approval/certification/authentication claim. Persists
 * nothing.
 */
export async function generateEvidenceIntelligenceDraft(
  evidence: EvidenceAnalysisInput | null,
  capability: EvidenceAiCapability,
  provider: EvidenceAiProvider | null,
  options: EvidenceAnalysisOptions,
): Promise<EvidenceAnalysisResult> {
  // eligibility guard → capability validation → input bounds
  const eligibility = assessEvidenceRequestEligibility(evidence, capability, {
    providerAvailable: !!provider,
    requestInProgress: options.requestInProgress,
    maxEvidenceChars: options.maxEvidenceChars,
  })
  if (eligibility.action === 'reject') {
    return { ok: false, code: eligibility.code, reason: eligibility.reason }
  }

  // The guard guarantees both are non-null and the capability is supported.
  const activeEvidence = evidence as EvidenceAnalysisInput
  const activeProvider = provider as EvidenceAiProvider

  // construct restricted request → provider call
  let output: EvidenceAiProviderOutput<unknown>
  try {
    output = await callProvider(activeProvider, capability, activeEvidence, options)
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? 'provider_timeout' : 'provider_error',
      reason: aborted ? 'The AI provider timed out.' : 'The AI provider could not complete the request.',
    }
  }

  // output shape validation (envelope: value present + valid confidence + provenance)
  const envelope = validateProviderEnvelope(output)
  if (!envelope.ok) {
    return { ok: false, code: envelope.code, reason: envelope.reason }
  }

  // safety-capability validation (draft shape + supported enums + provenance refs)
  const draftResult = validateDraftForCapability(capability, envelope.value.value)
  if (!draftResult.ok) {
    return { ok: false, code: draftResult.code, reason: draftResult.reason }
  }

  // wording guard — over AI-AUTHORED prose only (enum values / echoed ids excluded)
  const wording = guardEvidenceWordingFields(collectDraftProse(capability, draftResult.value))
  if (!wording.isSafe) {
    return {
      ok: false,
      code: 'unsafe_output',
      reason: 'The AI draft made an unqualified approval/certification/authentication claim and was blocked before display.',
    }
  }

  // labelled transient draft (constructed from trusted result guarantees)
  const draft: EvidenceAnalysisDraft = {
    ...EVIDENCE_RESULT_SAFETY_GUARANTEES,
    evidenceId: activeEvidence.evidenceId,
    capability,
    providerId: output.provenance.modelInfo.provider,
    modelId: output.provenance.modelInfo.model,
    promptVersion: output.provenance.promptVersion.id,
    generatedAt: output.provenance.generatedAt,
    confidence: envelope.value.confidence,
    draft: draftResult.value,
    status: 'draft_generated',
    label: EVIDENCE_DRAFT_LABEL,
  }
  return { ok: true, draft }
}
