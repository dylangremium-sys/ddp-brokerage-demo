// ─── Source-bound preliminary suggestions (Gate P0 — issue #77) ─────────────
//
// Enforces the gate's central rule in code rather than in convention:
//
//     No verified source retrieval = no regulatory suggestion.
//
// A suggestion may exist ONLY when it is technically bound to a source version
// that was actually retrieved and persisted — identified by that version's id
// and content fingerprint, not by a free-text citation someone typed. A
// suggestion that cites nothing is REJECTED; one that cites a source version
// which failed, is unknown, or has no fingerprint is QUARANTINED, so it is
// retained for inspection but can never be displayed as guidance.
//
// The suggestion text itself is assembled deterministically from observations
// that already exist — the document's own findings and the retrieved source's
// own words. It states what was observed and what an administrator should
// examine. It never concludes that anything is compliant, legal, approved,
// safe or saleable; `assertNoConclusion` rejects such text outright, so an
// operational decision cannot be smuggled in through a suggestion.

import type { CoaFinding } from './coaFindings.js'
import type { SourceRetrievalStatus } from './serverSourceRetrieval.js'

export type SuggestionState = 'bound' | 'quarantined' | 'rejected'

/** A source version as it exists AFTER being persisted. */
export interface PersistedSourceVersion {
  sourceVersionId: string
  authority: string
  jurisdiction: string
  url: string
  retrievalStatus: SourceRetrievalStatus
  /** SHA-256 of the retrieved bytes. Null when retrieval did not succeed. */
  contentFingerprint: string | null
  retrievedAt: string
  /** The verbatim passage stored from the source. */
  section: string
}

export interface PreliminarySuggestionDraft {
  coaDocumentId: string
  /** The source version this suggestion claims to rest on. */
  sourceVersionId: string | null
  text: string
}

export interface BoundSuggestion {
  coaDocumentId: string
  sourceVersionId: string
  sourceContentFingerprint: string
  sourceUrl: string
  sourceAuthority: string
  sourceJurisdiction: string
  sourceRetrievedAt: string
  text: string
  state: 'bound'
}

export interface SuggestionBindingResult {
  state: SuggestionState
  suggestion: BoundSuggestion | null
  /** Why the suggestion was quarantined or rejected. Null when bound. */
  reason: string | null
}

/**
 * Language that would turn an advisory note into an operational decision.
 * Only a human administrator may reach any of these positions.
 */
const FORBIDDEN_CONCLUSIONS = [
  /\bis (?:fully )?compliant\b/i,
  /\bis non-?compliant\b/i,
  /\bcomplies with\b/i,
  /\b(?:is|are) approved\b/i,
  /\bapprove(?:d|s)? for (?:sale|export|release)\b/i,
  /\b(?:is|are) rejected\b/i,
  /\bsafe (?:to sell|for sale|for consumption)\b/i,
  /\b(?:is|are) legal\b/i,
  /\b(?:is|are) illegal\b/i,
  /\bpasses? (?:all )?(?:compliance|regulatory) (?:checks?|requirements?)\b/i,
  /\bcertif(?:y|ies|ied) (?:as )?(?:compliant|authentic|genuine)\b/i,
  /\bauthentic(?:ated)?\b/i,
  /\bcleared for\b/i,
]

/**
 * Reject text that states a conclusion the system is not permitted to reach.
 * Returns the offending phrase, or null when the text is acceptable.
 */
export function assertNoConclusion(text: string): string | null {
  for (const pattern of FORBIDDEN_CONCLUSIONS) {
    const match = text.match(pattern)
    if (match) return match[0]
  }
  return null
}

/** A source version is usable only if it was genuinely retrieved and fingerprinted. */
export function isUsableSourceVersion(version: PersistedSourceVersion): boolean {
  return version.retrievalStatus === 'retrieved' && !!version.contentFingerprint
}

/**
 * Bind a draft suggestion to a persisted source version, or refuse it.
 *
 * This is the only sanctioned way to produce a displayable suggestion. It is
 * pure and total: every rejection path returns a reason rather than throwing,
 * so the caller can persist the quarantined record for audit.
 */
export function bindSuggestionToSource(
  draft: PreliminarySuggestionDraft,
  persistedVersions: PersistedSourceVersion[],
): SuggestionBindingResult {
  const text = draft.text.trim()

  if (text.length === 0) {
    return { state: 'rejected', suggestion: null, reason: 'the suggestion is empty' }
  }

  // ── Uncited suggestions are rejected outright ─────────────────────────────
  if (!draft.sourceVersionId) {
    return {
      state: 'rejected',
      suggestion: null,
      reason: 'the suggestion cites no source version; an uncited regulatory suggestion is not permitted',
    }
  }

  const version = persistedVersions.find((v) => v.sourceVersionId === draft.sourceVersionId)

  // ── Cited but unresolvable / unverified: quarantine, do not display ───────
  if (!version) {
    return {
      state: 'quarantined',
      suggestion: null,
      reason: `the cited source version "${draft.sourceVersionId}" is not on file`,
    }
  }

  if (version.retrievalStatus !== 'retrieved') {
    return {
      state: 'quarantined',
      suggestion: null,
      reason: `the cited source was not successfully retrieved (status "${version.retrievalStatus}"); no regulatory suggestion may rest on an unverified source`,
    }
  }

  if (!version.contentFingerprint) {
    return {
      state: 'quarantined',
      suggestion: null,
      reason: 'the cited source version has no content fingerprint, so the exact retrieved version cannot be identified',
    }
  }

  // ── The text may not state a conclusion ───────────────────────────────────
  const conclusion = assertNoConclusion(text)
  if (conclusion) {
    return {
      state: 'rejected',
      suggestion: null,
      reason: `the suggestion states a conclusion ("${conclusion}") that only an authorized administrator may reach`,
    }
  }

  return {
    state: 'bound',
    reason: null,
    suggestion: {
      coaDocumentId: draft.coaDocumentId,
      sourceVersionId: version.sourceVersionId,
      sourceContentFingerprint: version.contentFingerprint,
      sourceUrl: version.url,
      sourceAuthority: version.authority,
      sourceJurisdiction: version.jurisdiction,
      sourceRetrievedAt: version.retrievedAt,
      text,
      state: 'bound',
    },
  }
}

/**
 * Compose the preliminary suggestion text.
 *
 * Deterministic and strictly descriptive. It restates what the document showed,
 * names the authority page that was retrieved, and asks the administrator to
 * carry out the comparison — because comparing a result against a legal limit
 * is exactly the judgement this system must not make on its own.
 */
export function composePreliminarySuggestion(params: {
  sampleName: string | null
  reportNumber: string | null
  findings: CoaFinding[]
  version: PersistedSourceVersion
}): string {
  const { sampleName, reportNumber, findings, version } = params

  const subject = [sampleName, reportNumber].filter(Boolean).join(' / ') || 'this COA'
  const lines: string[] = []

  lines.push(
    `Preliminary, source-bound note for ${subject}. This is not a compliance determination and carries no operational effect.`,
  )

  if (findings.length === 0) {
    lines.push('Deterministic document checks raised no findings: identifiers, dates and all expected panels were readable.')
  } else {
    const bySeverity = findings.filter((f) => f.severity === 'critical' || f.severity === 'high')
    lines.push(
      `Deterministic document checks raised ${findings.length} finding(s)` +
        (bySeverity.length > 0 ? `, including ${bySeverity.length} at high or critical severity:` : ':'),
    )
    for (const finding of findings.slice(0, 5)) {
      const page = finding.pageNumber ? ` (page ${finding.pageNumber})` : ''
      lines.push(`  • [${finding.severity}] ${finding.title}${page}`)
    }
    if (findings.length > 5) lines.push(`  • …and ${findings.length - 5} more.`)
  }

  lines.push(
    `Retrieved authority source: ${version.authority} (${version.jurisdiction}) — ${version.url}, retrieved ${version.retrievedAt}, version ${version.contentFingerprint?.slice(0, 16) ?? 'unknown'}.`,
  )
  lines.push(
    'An authorized administrator should compare the extracted results against the requirements published at that source and record a decision. The system has not evaluated the document against any legal threshold.',
  )

  return lines.join('\n')
}
