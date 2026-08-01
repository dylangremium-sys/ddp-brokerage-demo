import type { LegalUpdate } from '../types'
import { guardAiDraftedFields } from './aiComplianceGuard.js'
import { verifySourceReferences } from './aiSourceReferenceGuard.js'
import { evaluateCannamonitorAiGate } from './complianceCannamonitorPolicy.js'
import type {
  AiDraftSummarySections,
  AiSummaryProviderInput,
  ComplianceAiSummaryProvider,
} from './aiComplianceProvider'

// ─── Guarded AI draft summarisation — orchestration (Phase 2G) ──────────────
//
// Lets a human request a DRAFT AI summary of an existing legal update's source
// evidence. Everything here is pure or depends only on an injected provider —
// this module never imports a vendor SDK, never opens a socket, never persists,
// never writes to Supabase, never creates/approves a rule, and never approves,
// certifies, enforces, or overwrites anything. Its output is a clearly-labelled
// draft that always requires human legal review.
//
// Two guards apply, both reused/complementary — neither is bypassed or
// re-implemented in the UI:
//   1. guardAiSummarisationRequest (here): a REQUEST/eligibility gate — draft
//      only, no approval/rule/enforce capability, evidence present, eligible
//      status, provider configured, not already running, size-bounded.
//   2. guardAiDraftedFields (aiComplianceGuard.ts): the existing WORDING guard,
//      run over the AI OUTPUT prose so an unqualified compliance/approval claim
//      is blocked before a human ever sees it.

export const DEFAULT_MAX_EVIDENCE_CHARS = 20000

// ─── Request (minimal evidence + capability guarantees) ──────────────────────

export interface AiSummaryRequest extends AiSummaryProviderInput {
  // Capability guarantees (literal), asserted by the guard: this request can
  // only ever ask for a draft, and can never ask to approve/rule/enforce or
  // make a buyer-facing decision.
  isDraftOnly: true
  requiresHumanReview: true
  canApprove: false
  canCreateRule: false
  canEnforce: false
  makesBuyerFacingDecision: false
}

/** Extracts ONLY the permitted evidence fields from a legal update. Carries no
 *  secrets/tokens/cookies/buyer/farmer/personal data (the model holds none). */
export function buildAiSummaryRequest(update: LegalUpdate): AiSummaryRequest {
  const checksumMatch = /Checksum:\s*([0-9a-f]{64})/i.exec(update.reviewerNotes ?? '')
  return {
    legalUpdateId: update.id,
    sourceName: update.sourceName,
    sourceUrl: update.sourceUrl,
    jurisdiction: update.jurisdiction,
    itemTitle: update.title,
    publishedAt: update.publishedAt ?? null,
    rawEvidence: update.rawText,
    provenanceChecksum: checksumMatch ? checksumMatch[1] : null,
    status: update.status,
    isDraftOnly: true,
    requiresHumanReview: true,
    canApprove: false,
    canCreateRule: false,
    canEnforce: false,
    makesBuyerFacingDecision: false,
  }
}

// ─── Request guard ───────────────────────────────────────────────────────────

export type AiSummaryGuardCode =
  | 'request_in_progress'
  | 'missing_update'
  | 'provider_unconfigured'
  | 'unsupported_status'
  | 'missing_evidence'
  | 'oversized_evidence'

export type AiSummaryGuardDecision =
  | { action: 'allow'; request: AiSummaryRequest }
  | { action: 'reject'; code: AiSummaryGuardCode; reason: string }

export interface AiSummaryGuardOptions {
  providerAvailable: boolean
  requestInProgress: boolean
  maxEvidenceChars?: number
}

/**
 * Pure eligibility gate. Only a draft legal update (status 'new') with present,
 * size-bounded source evidence, a configured provider, and no in-flight request
 * may be summarised. A reviewed / rule-suggested / sent-to-legal / archived /
 * rejected update is treated as locked (unsupported_status) — the AI never runs
 * against an already-actioned update.
 */
export function guardAiSummarisationRequest(
  update: LegalUpdate | null,
  opts: AiSummaryGuardOptions,
): AiSummaryGuardDecision {
  if (opts.requestInProgress) {
    return { action: 'reject', code: 'request_in_progress', reason: 'An AI draft summary is already being generated.' }
  }
  if (!update) {
    return { action: 'reject', code: 'missing_update', reason: 'No legal update is selected.' }
  }
  if (!opts.providerAvailable) {
    return { action: 'reject', code: 'provider_unconfigured', reason: 'No AI provider is configured for this build.' }
  }
  if (update.status !== 'new') {
    return { action: 'reject', code: 'unsupported_status', reason: `This legal update is "${update.status}", not an editable draft — AI summarisation is only available for new drafts.` }
  }
  const evidence = (update.rawText ?? '').trim()
  if (evidence.length === 0) {
    return { action: 'reject', code: 'missing_evidence', reason: 'This legal update has no source evidence to summarise.' }
  }
  const max = opts.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
  if (evidence.length > max) {
    return { action: 'reject', code: 'oversized_evidence', reason: `Source evidence exceeds the ${max}-character limit for AI summarisation.` }
  }
  return { action: 'allow', request: buildAiSummaryRequest(update) }
}

// ─── Draft output model ──────────────────────────────────────────────────────

export const AI_DRAFT_LABEL = 'AI-generated draft — requires human legal review'

export interface AiDraftSummary {
  legalUpdateId: string
  providerId: string
  modelId: string
  generatedAt: string
  draftSummary: string
  possibleSignificance: string
  uncertainties: string
  reviewQuestions: string[]
  /** Only references the reference guard could ground in the recorded evidence.
   *  Never the raw model list. */
  sourceReferences: string[]
  /** How many model-returned references this pass discarded as ungrounded. */
  droppedSourceReferences: number
  guardDecision: 'allowed'
  status: 'draft_generated'
  requiresHumanReview: true
  label: string
  // Capability guarantees (literal false): a draft, nothing more.
  approvesUpdate: false
  createsRule: false
  enforces: false
  certifiesCompliance: false
}

export type AiSummaryResultCode =
  | AiSummaryGuardCode
  | 'provider_error'
  /** The provider rejected the request shape (bad model, unsupported
   *  parameter) — a configuration fault, not a transient outage. */
  | 'provider_rejected'
  | 'provider_timeout'
  | 'malformed_output'
  | 'empty_output'
  | 'unsafe_output'
  /** A source-specific policy (today: Cannamonitor) denied AI processing in the
   *  shared execution layer — the authoritative gate for BOTH the client
   *  controller and the server endpoint. */
  | 'cannamonitor_permission_unverified'

export type AiSummaryResult =
  | { ok: true; draft: AiDraftSummary }
  | { ok: false; code: AiSummaryResultCode; reason: string }

function isSectionsShape(v: unknown): v is AiDraftSummarySections {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.draftSummary === 'string' &&
    typeof o.possibleSignificance === 'string' &&
    typeof o.uncertainties === 'string' &&
    Array.isArray(o.reviewQuestions) && o.reviewQuestions.every(q => typeof q === 'string') &&
    Array.isArray(o.sourceReferences) && o.sourceReferences.every(r => typeof r === 'string')
  )
}

/**
 * The single orchestration entry point. Guards the request, calls the injected
 * provider, validates the shape, runs the wording guard over the AI-authored
 * prose and the reference guard over the AI-returned citations, and returns a
 * labelled draft. It performs no persistence and never overwrites the legal
 * update's summary.
 */
export async function generateAiDraftSummary(
  update: LegalUpdate | null,
  provider: ComplianceAiSummaryProvider | null,
  opts: { requestInProgress: boolean; maxEvidenceChars?: number },
): Promise<AiSummaryResult> {
  // Authoritative source-policy gate (Cannamonitor). Enforced HERE — in the
  // shared execution layer that every caller funnels through — so no path can
  // reach the provider for a correctly-attributed Cannamonitor source while
  // permission is unverified: not the client controller (watchtowerAiSummary.ts,
  // which keeps its own gate as defence-in-depth) and not the server endpoint
  // (serverAiSummary.ts → handleAiSummaryRequest, which calls this function
  // directly). Runs before request preparation, prompt construction, provider
  // selection, and provider invocation, so no Cannamonitor raw text is ever
  // built into a request or sent to the provider. Attribution is by the
  // recorded source URL only (see evaluateCannamonitorAiGate's documented
  // limitation); no content-sniffing is added.
  const cannamonitorGate = evaluateCannamonitorAiGate(update?.sourceUrl)
  if (cannamonitorGate.blocked) {
    return { ok: false, code: 'cannamonitor_permission_unverified', reason: cannamonitorGate.reason }
  }

  const guard = guardAiSummarisationRequest(update, {
    providerAvailable: !!provider,
    requestInProgress: opts.requestInProgress,
    maxEvidenceChars: opts.maxEvidenceChars,
  })
  if (guard.action === 'reject') {
    return { ok: false, code: guard.code, reason: guard.reason }
  }

  // update + provider are non-null here (guard enforced both).
  const request = guard.request
  const activeUpdate = update as LegalUpdate
  const activeProvider = provider as ComplianceAiSummaryProvider

  let output
  try {
    output = await activeProvider.draftSummary(request)
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError') {
      return { ok: false, code: 'provider_timeout', reason: 'The AI provider timed out.' }
    }
    if (name === 'AiProviderRequestRejectedError') {
      // The provider rejected the request itself rather than failing to serve
      // it — a configuration fault (unknown model, unsupported parameter),
      // which retrying will not fix. Separated from provider_error so the
      // server log distinguishes "misconfigured" from "vendor unavailable".
      return {
        ok: false,
        code: 'provider_rejected',
        reason: 'The AI provider rejected the request. The configured model or request settings are not valid.',
      }
    }
    return { ok: false, code: 'provider_error', reason: 'The AI provider could not complete the request.' }
  }

  const sections = output?.value
  if (!isSectionsShape(sections)) {
    return { ok: false, code: 'malformed_output', reason: 'The AI provider returned a malformed draft summary.' }
  }
  if (sections.draftSummary.trim().length === 0) {
    return { ok: false, code: 'empty_output', reason: 'The AI provider returned an empty draft summary.' }
  }

  // Wording guard over AI-AUTHORED prose only. Source references are excluded
  // here because a quoted regulation may legitimately contain "certified" or
  // "approved" — they get their own, stricter treatment below, where an
  // ungrounded reference is discarded outright.
  const wording = guardAiDraftedFields({
    draftSummary: sections.draftSummary,
    possibleSignificance: sections.possibleSignificance,
    uncertainties: sections.uncertainties,
    reviewQuestions: sections.reviewQuestions.join('\n'),
  })
  if (!wording.isSafe) {
    return { ok: false, code: 'unsafe_output', reason: 'The AI draft made an unqualified compliance/approval claim and was blocked before display.' }
  }

  // Reference guard over the model's citations. Unlike the wording guard an
  // ungrounded reference does not fail the whole draft — the prose may be
  // perfectly good — it is discarded, and the count is carried so a reviewer
  // can see the model cited something we could not find.
  //
  // It runs where the AUTHORITATIVE evidence is, and only there. The server
  // reads the stored row; the browser holds a copy that can be stale. Re-running
  // the guard in the browser over a server-verified list adds no security — the
  // server already checked it against the real text — and can only produce
  // false drops: a reviewer would be shown zero citations and told some were
  // discarded, which reads as "the model cited things it could not support"
  // when the opposite happened. `upstreamDroppedReferences` being present is
  // the signal that a layer with authoritative evidence has already decided.
  //
  // The WORDING guard above is different and still runs at both layers: it
  // reads the model's prose, which the browser has in full.
  const upstream = output.provenance.upstreamDroppedReferences
  const references =
    upstream === undefined
      ? verifySourceReferences(sections.sourceReferences, {
          sourceName: request.sourceName,
          sourceUrl: request.sourceUrl,
          itemTitle: request.itemTitle,
          rawEvidence: request.rawEvidence,
        })
      : { verified: sections.sourceReferences, droppedCount: upstream }

  const draft: AiDraftSummary = {
    legalUpdateId: activeUpdate.id,
    providerId: output.provenance.modelInfo.provider,
    modelId: output.provenance.modelInfo.model,
    generatedAt: output.provenance.generatedAt,
    draftSummary: sections.draftSummary,
    possibleSignificance: sections.possibleSignificance,
    uncertainties: sections.uncertainties,
    reviewQuestions: sections.reviewQuestions,
    sourceReferences: references.verified,
    droppedSourceReferences: references.droppedCount,
    guardDecision: 'allowed',
    status: 'draft_generated',
    requiresHumanReview: true,
    label: AI_DRAFT_LABEL,
    approvesUpdate: false,
    createsRule: false,
    enforces: false,
    certifiesCompliance: false,
  }
  return { ok: true, draft }
}
