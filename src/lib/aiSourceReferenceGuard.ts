// ─── AI source-reference verification guard ─────────────────────────────────
//
// The model returns `sourceReferences: string[]`. Nothing in the response is
// evidence of anything — the model can invent a clause number, a section
// heading, or a whole document, and until this guard existed those inventions
// were rendered to a legal reviewer under the heading "Source references",
// where they read as citations. A fabricated citation in a compliance draft is
// worse than no citation: it looks like provenance.
//
// This guard keeps a reference ONLY when it can be shown to occur in material
// we actually hold. Two grounds qualify:
//
//   1. It is the recorded source name, source URL, or item title — the
//      metadata the connector captured, not something the model produced.
//   2. It is a verbatim quotation from the recorded raw evidence.
//
// Anything else is discarded. That is a narrower guarantee than a validated
// span into the primary legislative text, and deliberately so: the ingestion
// path records the source URL but never fetches it (complianceRssConnector.ts
// builds rawText from feed fields only), so the primary text is not held here
// and cannot be cited against. What this guard does guarantee is that every
// reference a reviewer sees is traceable to stored evidence, and that the model
// cannot manufacture provenance.
//
// Pure: no network, no persistence, no vendor SDK.

/** The evidence a reference may be checked against. All fields are recorded
 *  values from the ingestion path — never model output. */
export interface SourceReferenceContext {
  sourceName: string
  sourceUrl: string
  itemTitle: string
  rawEvidence: string
}

export interface SourceReferenceVerification {
  /** References that occur in the recorded evidence, in the model's order,
   *  de-duplicated, and capped. Display text is the trimmed original. */
  verified: string[]
  /** How many the model returned that could not be grounded (includes
   *  duplicates and any beyond the cap). Zero is the expected steady state. */
  droppedCount: number
}

/**
 * A quotation shorter than this is not evidence of anything — "the", "Act",
 * "s 4" occur in almost any text, so a substring match on them would launder a
 * guess into a citation. Exact metadata matches bypass the floor because they
 * are checked against a specific recorded field, not scanned for.
 */
export const MIN_QUOTED_REFERENCE_CHARS = 12

/** Bounds what a single draft can render. A model that returns hundreds of
 *  references is malfunctioning; the excess is dropped, not silently kept. */
export const MAX_SOURCE_REFERENCES = 20

/** Case-folds, collapses whitespace, and strips surrounding quote marks so a
 *  quotation is compared on its text rather than on its typography. Straight
 *  and curly quotes are both stripped — models emit either. */
function normalize(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'‘’“”]+/, '')
    .replace(/["'‘’“”]+$/, '')
    .trim()
    .toLowerCase()
}

/**
 * Filters model-returned references down to those grounded in `context`.
 * Never throws; a non-string entry cannot reach here (the orchestration's shape
 * check runs first) but is dropped defensively if it does.
 */
export function verifySourceReferences(
  references: readonly string[],
  context: SourceReferenceContext,
): SourceReferenceVerification {
  const normalizedEvidence = normalize(context.rawEvidence)
  const exactMatches = new Set(
    [context.sourceName, context.sourceUrl, context.itemTitle]
      .map(normalize)
      .filter(v => v.length > 0),
  )

  const verified: string[] = []
  const seen = new Set<string>()
  let droppedCount = 0

  for (const reference of references) {
    if (typeof reference !== 'string') {
      droppedCount++
      continue
    }
    const display = reference.trim()
    const normalized = normalize(reference)

    const grounded =
      normalized.length > 0 &&
      (exactMatches.has(normalized) ||
        (normalized.length >= MIN_QUOTED_REFERENCE_CHARS && normalizedEvidence.includes(normalized)))

    if (!grounded || seen.has(normalized) || verified.length >= MAX_SOURCE_REFERENCES) {
      droppedCount++
      continue
    }

    seen.add(normalized)
    verified.push(display)
  }

  return { verified, droppedCount }
}
