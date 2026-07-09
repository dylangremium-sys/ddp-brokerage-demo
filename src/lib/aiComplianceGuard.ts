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

const NEGATION_MARKERS = [
  'not', 'no', 'non', 'never', 'without', 'cannot', "can't", 'can not',
  "isn't", 'is not', "aren't", 'are not', "doesn't", 'does not',
  "don't", 'do not', "wasn't", 'was not', "weren't", 'were not',
  'lack of', 'lacks', 'pending',
]

const NEGATION_WINDOW_CHARS = 40

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isNegatedContext(precedingText: string): boolean {
  return NEGATION_MARKERS.some(marker => new RegExp(`\\b${escapeRegExp(marker)}\\b`, 'i').test(precedingText))
}

/**
 * Scans AI-drafted text for unqualified compliance/certification/approval
 * claims. Returns every unsafe match found (empty array = safe). A match is
 * excluded when a negation marker appears within a short preceding window,
 * so "not compliant" / "pending review" style phrasing passes.
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
