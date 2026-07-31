// ─── AI source-reference verification guard ─────────────────────────────────
//
// The model returns `sourceReferences: string[]`. Nothing in the response is
// evidence of anything — the model can invent a clause number, a section
// heading, or a whole document, and until this guard existed those inventions
// were rendered to a legal reviewer under the heading "Source references",
// where they read as citations. A fabricated citation in a compliance draft is
// worse than no citation: it looks like provenance.
//
// Two rules govern this file.
//
//   MATCH: a reference is kept only if it can be shown to occur in material we
//   actually hold — it is the recorded source name, source URL, or item title,
//   or it is a verbatim quotation from the recorded raw evidence.
//
//   DISPLAY: what a reviewer sees is always OUR text, never the model's. An
//   exact metadata match renders the recorded value; a quotation renders the
//   enclosing sentence read back out of the recorded evidence. This is not
//   cosmetic. Echoing the model's own string back would let a matched span
//   invert the meaning of its source — "would not require certification of
//   exports" contains the verbatim span "require certification of exports" —
//   and would let a case-variant URL that resolves elsewhere display as if it
//   were the recorded one. Reading the surrounding sentence back out of the
//   evidence defeats both without needing to understand the text.
//
// That is a narrower guarantee than a validated span into the primary
// legislative text, and deliberately so: the ingestion path records the source
// URL but never fetches it (complianceRssConnector.ts builds rawText from feed
// fields only), so the primary text is not held here and cannot be cited
// against. What this guard guarantees is that every reference a reviewer sees
// is traceable to stored evidence, and that the model cannot manufacture
// provenance.
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
  /** References grounded in the recorded evidence, in the model's order,
   *  de-duplicated, and capped. Text is read from `context`, not from the
   *  model. */
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

/** Longest sentence we will render for one quotation before truncating. */
export const MAX_REFERENCE_CONTEXT_CHARS = 320

/** How far either side of a matched span we look for a sentence boundary.
 *  Bounds the cost of a match inside a wall of unpunctuated text. */
const SENTENCE_SEARCH_WINDOW = 160

/** Quote marks, brackets and terminal punctuation carry no matching signal at
 *  the edges of a reference, and models routinely add them ("…s.12…", 'Act.').
 *  Stripping them at the edges only — never inside — is what stops a correct
 *  quotation from being discarded for its typography. */
const EDGE_NOISE_RE = /^[\s"'‘’“”«»([.,;:!?…\-–—]+|[\s"'‘’“”«»)\].,;:!?…\-–—]+$/gu

const SENTENCE_TERMINATOR_RE = /[.!?\n]/u

/** Case-folds and collapses whitespace. Used for both sides of a comparison so
 *  a quotation is matched on its text rather than its typography. */
function collapse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** Collapse plus edge-noise stripping. Applied to references and to the
 *  recorded metadata they are compared against. */
function normalize(value: string): string {
  return collapse(value).replace(EDGE_NOISE_RE, '').trim()
}

/**
 * Collapses `value` the same way `collapse` does, while recording, for each
 * character of the result, the index it came from in `value`. That mapping is
 * what lets a match found in collapsed space be read back out of the original
 * text with its real spacing and casing intact.
 */
function collapseWithSourceMap(value: string): { text: string; sourceIndex: number[] } {
  const out: string[] = []
  const sourceIndex: number[] = []
  let pendingSpace = false

  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (/\s/u.test(char)) {
      pendingSpace = out.length > 0
      continue
    }
    if (pendingSpace) {
      out.push(' ')
      sourceIndex.push(i)
      pendingSpace = false
    }
    out.push(char.toLowerCase())
    sourceIndex.push(i)
  }

  return { text: out.join(''), sourceIndex }
}

/**
 * Expands `[start, end)` in `evidence` out to its enclosing sentence and
 * returns that text. This is what puts a negation back in front of a span that
 * omitted it, so a reviewer reads "would not require certification" rather than
 * the model's chosen fragment.
 */
function enclosingSentence(evidence: string, start: number, end: number): string {
  const leftLimit = Math.max(0, start - SENTENCE_SEARCH_WINDOW)
  let from = start
  while (from > leftLimit && !SENTENCE_TERMINATOR_RE.test(evidence[from - 1])) from--

  const rightLimit = Math.min(evidence.length, end + SENTENCE_SEARCH_WINDOW)
  let to = end
  while (to < rightLimit && !SENTENCE_TERMINATOR_RE.test(evidence[to])) to++
  if (to < rightLimit) to++ // keep the terminator itself

  const text = evidence.slice(from, to).replace(/\s+/gu, ' ').trim()
  return text.length > MAX_REFERENCE_CONTEXT_CHARS
    ? `${text.slice(0, MAX_REFERENCE_CONTEXT_CHARS).trimEnd()}…`
    : text
}

/**
 * Filters model-returned references down to those grounded in `context`, and
 * replaces each surviving one with the corresponding recorded text.
 *
 * Idempotent: re-running over its own output drops nothing, because every
 * value it emits is itself either a recorded metadata value or a verbatim
 * sentence of the evidence. The orchestration relies on this — it runs at the
 * server endpoint and again in the browser over the server's filtered list.
 *
 * Never throws; a non-string entry cannot reach here (the orchestration's shape
 * check runs first) but is dropped defensively if it does.
 */
export function verifySourceReferences(
  references: readonly string[],
  context: SourceReferenceContext,
): SourceReferenceVerification {
  const evidence = collapseWithSourceMap(context.rawEvidence)

  // Normalised recorded value -> the recorded value as we will display it.
  const recorded = new Map<string, string>()
  for (const value of [context.sourceName, context.sourceUrl, context.itemTitle]) {
    const key = normalize(value)
    if (key.length > 0 && !recorded.has(key)) recorded.set(key, value.trim())
  }

  const verified: string[] = []
  const seen = new Set<string>()
  let droppedCount = 0

  for (const reference of references) {
    if (typeof reference !== 'string') {
      droppedCount++
      continue
    }

    const normalized = normalize(reference)
    if (normalized.length === 0 || seen.has(normalized) || verified.length >= MAX_SOURCE_REFERENCES) {
      droppedCount++
      continue
    }

    const exact = recorded.get(normalized)
    let display: string | null = exact ?? null

    if (display === null && normalized.length >= MIN_QUOTED_REFERENCE_CHARS) {
      const at = evidence.text.indexOf(normalized)
      if (at !== -1) {
        const start = evidence.sourceIndex[at]
        const endInclusive = evidence.sourceIndex[at + normalized.length - 1]
        display = enclosingSentence(context.rawEvidence, start, endInclusive + 1)
      }
    }

    if (display === null || display.length === 0) {
      droppedCount++
      continue
    }

    // De-duplicate on what will actually be shown as well as on what the model
    // sent: two different fragments of one sentence expand to the same text.
    const displayKey = collapse(display)
    if (seen.has(displayKey)) {
      droppedCount++
      continue
    }

    seen.add(normalized)
    seen.add(displayKey)
    verified.push(display)
  }

  return { verified, droppedCount }
}
