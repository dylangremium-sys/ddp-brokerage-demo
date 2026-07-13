// ─── AI Compliance Agent — wording safety guard (Phase 0A) ──────────────────
//
// Blocks AI-drafted text from asserting a compliance/certification/approval
// claim that only a human reviewer is authorised to make. Safe negations
// ("not compliant", "not certified", "not verified") and non-claim phrasing
// ("pending review", "requires human approval") must pass — this guard
// exists to catch unqualified overclaims, not to reject every mention of
// these words.
//
// This module makes no network calls and writes nothing itself — it is a
// pure text check. As of Phase 0B, DDPComplianceWatchtower.tsx calls
// guardAiDraftedFields() at the top of its manual legal-update intake
// submit handler, before any Supabase/local write or audit-log entry, and
// blocks submission entirely on an unsafe finding. It still enforces
// nothing beyond that single intake gate — no rule/alert/enforcement logic
// is touched by this module.

export interface AIComplianceGuardFinding {
  term: string
  index: number
  context: string
}

export interface AIComplianceGuardResult {
  isSafe: boolean
  findings: AIComplianceGuardFinding[]
}

// Longest/most specific phrases first so a match on a longer phrase is
// recorded once, not once for the phrase and again for a shorter substring
// inside it (e.g. "legally compliant" vs "compliant"). Deliberately matches
// "approved" and not "approval" — "requires human approval" must read as
// safe procedural language, not as a claim that approval has occurred.
const UNSAFE_TERMS = [
  'legally compliant',
  'export-ready',
  'export ready',
  'compliant',
  'certified',
  'verified',
  'guaranteed',
  'approved',
]

// Negation is evaluated per-TOKEN against the words immediately preceding the
// unsafe term, not by scanning a character window. Multi-word markers such as
// "is not" / "does not" / "lack of" are covered by their negating token ("not",
// "lack"); the auxiliary half is a scope filler below.
const NEGATION_TOKENS = [
  'not', 'no', 'non', 'never', 'without', 'cannot', "can't",
  "isn't", "aren't", "doesn't", "don't", "wasn't", "weren't",
  'lack', 'lacks', 'pending',
]

// Words that may sit between a negation/non-assertive marker and the unsafe
// term without breaking the marker's scope (auxiliaries, hedges, determiners).
// Any word NOT in this list terminates the scope — that is what stops "no" in
// "there is no doubt this batch is compliant" from reaching "compliant".
const SCOPE_FILLERS = [
  'of', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had', 'it', 'this', 'that', 'to', 'yet', 'still',
  'fully', 'currently', 'actually', 'considered', 'deemed',
  'necessarily', 'entirely', 'therefore',
]

// Subordinators/modals that make the clause conditional or prospective rather
// than an assertion of present fact. "…until it is legally compliant" states a
// condition, not a claim, and must pass.
const NON_ASSERTIVE_TOKENS = [
  'until', 'unless', 'if', 'when', 'whether', 'once', 'before',
  'requires', 'require', 'required', 'must', 'should', 'shall', 'would',
]

// How many preceding tokens the marker scope may span before we give up and
// treat the term as asserted. Generous enough for "has not yet been", short
// enough that a marker in a previous clause cannot reach the term.
const MAX_SCOPE_TOKENS = 8

// Display only: how much text preceding a finding is echoed back in
// AIComplianceGuardFinding.context. Unchanged from the previous
// implementation, so finding.context output is identical.
const CONTEXT_WINDOW_CHARS = 40

/**
 * Decides whether the unsafe term at the end of `precedingText` is inside the
 * scope of a negation or a non-assertive (conditional) marker.
 *
 * Walks backwards token-by-token from the term:
 *   • scope fillers are skipped,
 *   • a non-assertive marker ⇒ not an assertion ⇒ safe,
 *   • negation markers are counted (so a double negative, "not non-compliant",
 *     reads as an affirmative claim and is correctly flagged),
 *   • any other word terminates the scope ⇒ the term is asserted ⇒ unsafe.
 *
 * This replaces an earlier character-window check that treated a negation
 * ANYWHERE in the preceding 40 characters as negating the term, which let
 * "There is no doubt this batch is compliant" pass as safe.
 */
function isNegatedContext(precedingText: string): boolean {
  // Scope never crosses a clause boundary: a negation in a previous clause
  // ("The farm is not certified, but the batch is compliant") must not reach
  // the term in this one.
  const clause = precedingText.toLowerCase().split(/[.;:,!?—–]/).pop() ?? ''
  const tokens = clause.match(/[a-z']+/g) ?? []

  // A subordinator/modal governs its ENTIRE clause, not just the words next to
  // the term ("…unless the farm is certified" — 'farm' sits between the marker
  // and the term). So it is matched clause-wide, unlike negation below.
  if (tokens.some(t => NON_ASSERTIVE_TOKENS.includes(t))) return true

  // Negation, by contrast, binds tightly: walk backwards from the term, skipping
  // only auxiliaries/hedges. Any content word ends the negation's scope.
  let negations = 0
  for (let i = tokens.length - 1, seen = 0; i >= 0 && seen < MAX_SCOPE_TOKENS; i--, seen++) {
    const token = tokens[i]
    if (SCOPE_FILLERS.includes(token)) continue
    if (NEGATION_TOKENS.includes(token)) {
      negations++
      continue
    }
    break // a content word ends the negation's scope
  }

  // Odd number of negations ⇒ negated. Zero or an even number ("not
  // non-compliant") ⇒ the term is asserted.
  return negations % 2 === 1
}

/**
 * Scans AI-drafted text for unqualified compliance/certification/approval
 * claims. Returns every unsafe match found (empty array = safe). A match is
 * excluded when the term falls inside the scope of a negation or a
 * non-assertive marker (see isNegatedContext), so "not compliant" and
 * "…until it is legally compliant" style phrasing passes.
 */
export function guardAiDraftedText(text: string): AIComplianceGuardResult {
  const lower = text.toLowerCase()
  const findings: AIComplianceGuardFinding[] = []
  const consumed = new Set<number>()

  for (const term of UNSAFE_TERMS) {
    let searchFrom = 0
    while (searchFrom <= lower.length) {
      const idx = lower.indexOf(term, searchFrom)
      if (idx === -1) break
      searchFrom = idx + 1

      const positions = Array.from({ length: term.length }, (_, i) => idx + i)
      if (positions.some(pos => consumed.has(pos))) continue
      positions.forEach(pos => consumed.add(pos))

      // Scope analysis reads the FULL preceding text (a fixed character window
      // could truncate a word mid-token and fabricate a marker); the character
      // window below is only ever used to build the human-readable context.
      const windowStart = Math.max(0, idx - CONTEXT_WINDOW_CHARS)

      if (!isNegatedContext(lower.slice(0, idx))) {
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

/**
 * Throws if guardAiDraftedText finds any unsafe claim. Convenience for call
 * sites that want to fail fast rather than inspect the result.
 */
export function assertSafeAiDraftedText(text: string): void {
  const result = guardAiDraftedText(text)
  if (!result.isSafe) {
    const terms = result.findings.map(f => `"${f.term}"`).join(', ')
    throw new Error(`AI-drafted text contains unsafe unqualified claim(s): ${terms}`)
  }
}

export interface AIComplianceFieldFinding extends AIComplianceGuardFinding {
  field: string
}

export interface AIComplianceFieldsGuardResult {
  isSafe: boolean
  findings: AIComplianceFieldFinding[]
}

/**
 * Runs guardAiDraftedText() independently over each named field and
 * aggregates the findings, tagging each with which field it came from.
 * Fields are checked independently — never concatenated — so a negation
 * marker at the end of one field can never mask an unsafe claim at the
 * start of another. Empty/whitespace-only fields are skipped.
 */
export function guardAiDraftedFields(fields: Record<string, string>): AIComplianceFieldsGuardResult {
  const findings: AIComplianceFieldFinding[] = []
  for (const [field, text] of Object.entries(fields)) {
    if (!text || !text.trim()) continue
    for (const finding of guardAiDraftedText(text).findings) {
      findings.push({ ...finding, field })
    }
  }
  return { isSafe: findings.length === 0, findings }
}
