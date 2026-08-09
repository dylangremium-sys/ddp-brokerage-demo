// ─── Leak canary ────────────────────────────────────────────────────────────
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT
//   The publishing path cannot READ internal compliance data — that is enforced
//   structurally, by the pipeline being a filesystem read with no client and no
//   credentials, and asserted by the import-graph test in
//   publishingBoundary.test.ts.
//
//   This catches the other way internal data reaches a public page: a person
//   pastes it in. The realistic accident is not a wired-up integration, it is
//   three paragraphs copied out of an internal report into a draft entry, with
//   a batch id or a supplier licence number still in them.
//
//   IT IS A CANARY, NOT A GATE. It matches SHAPES that only internal records
//   have. It will not catch a determined author, it will not catch a licence
//   number written in prose without its usual formatting, and nothing automated
//   would. It is worth having because it turns the most likely mistake from
//   invisible into a failed build, and worth being honest about because
//   treating it as proof of safety is how the real gate — a person reading the
//   diff — gets skipped.
//
// FALSE POSITIVES ARE THE POINT
//   Every pattern here will occasionally match something innocent. That is the
//   correct trade for this content: a regulatory update that has to be reworded
//   costs minutes, and a published supplier licence number costs a relationship
//   and possibly a licence. When a match is genuinely innocent the fix is to
//   reword, not to add an exception — an exception list is a hole that grows.

export interface LeakFinding {
  pattern: string
  match: string
  why: string
}

interface CanaryPattern {
  name: string
  regex: RegExp
  why: string
}

const PATTERNS: CanaryPattern[] = [
  {
    name: 'uuid',
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    why: 'a UUID is a database identifier; nothing a reader needs is identified this way',
  },
  {
    name: 'batch-id',
    regex: /\b[A-Z]{1,3}\d-\d{6}\b/g,
    why: 'matches the batch id format used in this system (e.g. F4-122025)',
  },
  {
    name: 'email-address',
    regex: /\b[\w.+-]+@(?!ddpbrokerage\.com\b)[\w-]+\.[\w.]{2,}\b/g,
    why: 'an address outside the company domain is likely a counterparty contact',
  },
  {
    name: 'thai-licence-number',
    regex: /\b\d{2}\/\d{4}\b/g,
    why: 'matches the shape Thai licence references are usually written in',
  },
  {
    name: 'internal-table-name',
    regex: /\b(?:watchtower_\w+|inventory_batches|counterparty_organisations|compliance_audit_log|status_history|buyer_pack\w*)\b/gi,
    why: 'an internal table name has no business in published copy',
  },
  {
    name: 'bearer-or-key',
    regex: /\b(?:eyJ[\w-]{10,}|sk-[\w-]{10,}|Bearer\s+[\w.-]{10,})/g,
    why: 'looks like a token or key',
  },
  {
    name: 'coordinates',
    regex: /\b-?\d{1,2}\.\d{4,},\s*-?\d{1,3}\.\d{4,}\b/g,
    why: 'precise coordinates would identify a specific farm site',
  },
]

/**
 * Every shape in `text` that looks like an internal record.
 *
 * Returns findings rather than throwing so a caller can report all of them at
 * once — a build that fails one problem at a time wastes the author's day.
 */
export function findLeaks(text: string): LeakFinding[] {
  const findings: LeakFinding[] = []

  for (const { name, regex, why } of PATTERNS) {
    // A fresh regex per call: a shared /g regex carries lastIndex between
    // calls and silently skips matches on the second document scanned.
    for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
      findings.push({ pattern: name, match: match[0], why })
    }
  }

  return findings
}

/** The names of every shape checked, for tests and for error messages. */
export function canaryPatternNames(): string[] {
  return PATTERNS.map((p) => p.name)
}
