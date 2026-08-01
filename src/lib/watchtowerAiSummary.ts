import type { LegalUpdate } from '../types'
import type { ComplianceAiSummaryProvider } from './aiComplianceProvider'
import {
  generateAiDraftSummary,
  guardAiSummarisationRequest,
} from './complianceAiSummarisation'
import type {
  AiDraftSummary,
  AiSummaryGuardCode,
  AiSummaryResultCode,
} from './complianceAiSummarisation'
import { evaluateCannamonitorAiGate } from './complianceCannamonitorPolicy'

// ─── Watchtower AI draft-summary controller (Phase 2H) ──────────────────────
//
// A thin, framework-agnostic controller the admin Compliance Watchtower uses to
// offer a MANUAL "Generate AI Draft Summary" action against a single draft legal
// update. It does not implement summarisation itself — it reuses the existing
// guarded orchestration (complianceAiSummarisation.ts): guard →
// provider → shape check → wording guard → labelled transient draft. This module
// adds only three UI-support concerns, none of which duplicate the guard:
//   1. evaluateAiSummaryEligibility — turns the SAME guard into a button
//      enabled/disabled state + a human reason, so the UI never guesses.
//   2. runAiDraftSummary — calls generateAiDraftSummary and layers a
//      stale-selection check (the admin changed the selected update while the
//      provider was running), so a late result is discarded, never shown against
//      the wrong update.
//   3. safe user-facing messages keyed by the orchestration's diagnostic codes,
//      with the codes preserved separately for tests/telemetry.
//
// This module imports no React, opens no socket, calls no fetch, imports no
// vendor AI SDK, and never persists — it returns transient values only. The AI
// can only ever produce a draft that requires human legal review; it cannot
// approve, certify, create a rule, or enforce anything (the orchestration and
// wording guard enforce that upstream).

// ─── Source-policy AI gate (Cannamonitor defence-in-depth) ──────────────────
//
// The metadata-only projection in complianceCannamonitorPolicy.ts already stops
// prohibited Cannamonitor text from entering `rawText` on the automated RSS
// ingestion path. This gate is independent, because the AI call consumes
// `update.rawText` regardless of how it got there:
//
//   • an admin can paste text straight into the manual legal-update form, which
//     never touches the RSS parser or the projection;
//   • a legal_update row created before this policy existed still carries
//     whatever raw text it was created with;
//   • a future parser/wiring regression could reintroduce body text upstream.
//
// A projection guards INGESTION; this guards CONSUMPTION — keyed on the update's
// own sourceUrl, whatever the provenance. Sending prohibited text to a
// third-party AI provider is an irreversible disclosure, which warrants a
// second, independent control. It is strictly source-specific: a
// non-Cannamonitor update is evaluated exactly as before, and no provider
// configuration, model, prompt, or general AI behaviour is changed.

export type AiSummaryOutcomeCode = AiSummaryResultCode | 'stale_selection' | 'cannamonitor_permission_unverified'

/** Whether an AI provider is wired in. `null` provider ⇒ unavailable (the
 *  production app injects null: no provider is configured in this repository). */
export function isAiSummaryProviderAvailable(
  provider: ComplianceAiSummaryProvider | null,
): boolean {
  return provider !== null
}

export interface AiSummaryEligibility {
  canGenerate: boolean
  /** 'ok' when allowed, otherwise the guard's (or source policy's) rejection code. */
  code: 'ok' | AiSummaryGuardCode | 'cannamonitor_permission_unverified'
  /** Human-readable reason (safe to show in a tooltip / disabled-button title). */
  reason: string
}

/**
 * Returns a rejection when the update's source is policy-blocked from AI
 * processing, or null when the source policy permits it. Pure; source-specific.
 */
function sourcePolicyAiRejection(
  update: LegalUpdate | null,
): { code: 'cannamonitor_permission_unverified'; reason: string } | null {
  if (!update) return null
  const gate = evaluateCannamonitorAiGate(update.sourceUrl)
  if (gate.blocked) {
    return { code: 'cannamonitor_permission_unverified', reason: gate.reason }
  }
  return null
}

export interface AiSummaryEligibilityOptions {
  provider: ComplianceAiSummaryProvider | null
  requestInProgress: boolean
  maxEvidenceChars?: number
}

/**
 * Pure button-state evaluator. Delegates entirely to guardAiSummarisationRequest
 * — it never re-implements or weakens any eligibility rule — and maps the guard
 * decision to a canGenerate flag. Enabled only when the guard would allow the
 * request (new draft, evidence present + size-bounded, provider available, none
 * already running).
 */
export function evaluateAiSummaryEligibility(
  update: LegalUpdate | null,
  opts: AiSummaryEligibilityOptions,
): AiSummaryEligibility {
  // Source-policy gate first: a policy-blocked source can never be summarised,
  // whatever the generic guard would say.
  const blocked = sourcePolicyAiRejection(update)
  if (blocked) {
    return { canGenerate: false, code: blocked.code, reason: blocked.reason }
  }

  const decision = guardAiSummarisationRequest(update, {
    providerAvailable: isAiSummaryProviderAvailable(opts.provider),
    requestInProgress: opts.requestInProgress,
    maxEvidenceChars: opts.maxEvidenceChars,
  })
  if (decision.action === 'allow') {
    return { canGenerate: true, code: 'ok', reason: 'Generate a draft AI summary for human legal review.' }
  }
  return { canGenerate: false, code: decision.code, reason: decision.reason }
}

// Safe, human-facing messages. Deliberately contain no compliance/approval/
// certification claims and never imply the AI performed legal review. The
// diagnostic code is returned alongside so tests/telemetry can assert the exact
// failure without parsing prose.
export const AI_SUMMARY_MESSAGES: Record<AiSummaryOutcomeCode, string> = {
  request_in_progress: 'An AI draft summary is already being generated. Please wait for it to finish.',
  missing_update: 'Select a draft legal update first.',
  provider_unconfigured: 'No AI provider is configured for this build.',
  unsupported_status: 'AI draft summary is only available for a new, unreviewed draft legal update.',
  missing_evidence: 'This legal update has no source evidence to summarise.',
  oversized_evidence: 'The source evidence is too large for AI draft summarisation.',
  provider_error: 'The AI provider could not complete the request. No draft was produced.',
  request_invalid:
    'The request was rejected before it reached the AI provider, so nothing was sent and no draft was produced. Check the request, your permissions, or the stored legal update — this is not an AI provider fault.',
  provider_rejected: 'The AI provider rejected the request — the configured model or settings are not valid. This needs an administrator, not a retry.',
  provider_timeout: 'The AI provider timed out. No draft was produced.',
  malformed_output: 'The AI provider returned an unreadable draft. It was discarded.',
  empty_output: 'The AI provider returned an empty draft. It was discarded.',
  unsafe_output: 'The AI draft was blocked because it made an unqualified claim, and was discarded before display.',
  stale_selection: 'The selected legal update changed before the draft finished — the draft was discarded.',
  cannamonitor_permission_unverified:
    'AI processing is blocked for Cannamonitor-attributed updates while commercial permission is unverified. Cannamonitor content may not be sent to an AI provider.',
}

export function messageForAiSummaryCode(code: AiSummaryOutcomeCode): string {
  return AI_SUMMARY_MESSAGES[code]
}

export interface RunAiDraftSummaryOptions {
  requestInProgress: boolean
  maxEvidenceChars?: number
  /**
   * Called with the draft's legalUpdateId AFTER the provider resolves. Returns
   * false if the admin has since changed the selected update, so a late draft is
   * discarded rather than shown against the wrong update. Pure predicate — the
   * caller reads whatever "currently selected" reference it holds.
   */
  isStillSelected: (legalUpdateId: string) => boolean
}

export type RunAiDraftSummaryOutcome =
  | { ok: true; draft: AiDraftSummary }
  | { ok: false; code: AiSummaryOutcomeCode; message: string }

/**
 * The single UI entry point. Runs the guarded orchestration, then applies the
 * stale-selection check. Returns a transient draft or a safe, coded failure —
 * it persists nothing and never mutates the legal update.
 */
export async function runAiDraftSummary(
  update: LegalUpdate | null,
  provider: ComplianceAiSummaryProvider | null,
  opts: RunAiDraftSummaryOptions,
): Promise<RunAiDraftSummaryOutcome> {
  // Enforced here too, not only in evaluateAiSummaryEligibility — the eligibility
  // check drives button state, and a UI that forgot to consult it must still not
  // be able to reach the provider. This returns BEFORE generateAiDraftSummary, so
  // no request is ever constructed and the provider is never called.
  const blocked = sourcePolicyAiRejection(update)
  if (blocked) {
    return { ok: false, code: blocked.code, message: blocked.reason }
  }

  const result = await generateAiDraftSummary(update, provider, {
    requestInProgress: opts.requestInProgress,
    maxEvidenceChars: opts.maxEvidenceChars,
  })
  if (!result.ok) {
    return { ok: false, code: result.code, message: messageForAiSummaryCode(result.code) }
  }
  if (!opts.isStillSelected(result.draft.legalUpdateId)) {
    return { ok: false, code: 'stale_selection', message: messageForAiSummaryCode('stale_selection') }
  }
  return { ok: true, draft: result.draft }
}
