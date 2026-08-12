/**
 * How a farm or batch is named on screen when the record has no name.
 *
 * Standing rule 4 of the design handoff: identifiers go in mono, names in body
 * type, and a UUID must never serve as a record title. Measured on production,
 * 11 of 24 Operations Desk matters rendered their farm as
 * `b1f4182c-3a2b-419b-b050-84609ac13492`, and one as `BIG HAIRY ASS ·` — a
 * dangling separator where the farm name should have been.
 *
 * An identifier cannot be a title: an operator cannot tell two of those rows
 * apart, and cannot read one aloud to a colleague. The id is kept, demoted to
 * metadata, and the row says what is actually wrong.
 *
 * Shared by the Operations Desk and the farm portal so the two cannot drift —
 * the same absent name must read the same way on both sides of the product.
 *
 * Pure and DOM-free.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True when a value is an identifier rather than a name.
 *
 * Exported so callers that need the same judgement — the Operations Desk asks it
 * of a farm record it holds — ask it of this module instead of keeping a second
 * copy of the pattern. Two copies is how the desk came to miss #212/#213.
 */
export function isIdentifier(value: string): boolean {
  return UUID.test((value ?? '').trim())
}

export interface DisplayedName {
  /** What to render as the title. Never a UUID, never empty. */
  name: string
  /** The identifier, when it is all the record actually has. Render in mono, small. */
  identifier?: string
  /** True when there is no real name — the caller marks it as needing a person. */
  unnamed: boolean
}

/**
 * @param label   the label the source built, which may be a UUID or have a
 *                dangling separator from an empty join
 * @param unnamedText  the localised "no name on file" wording
 * @param fallbackId   an id to fall back to when the label carries none
 */
export function displayName(
  label: string,
  unnamedText: string,
  fallbackId?: string,
): DisplayedName {
  // Sources join parts with " · " — product · farm, and older callers type · id.
  // Judge each PART, not the joined string: a composite is not a bare identifier,
  // so a whole-string test passes "farm · b1f4182c-…" through and prints the id
  // as a title. Splitting also disposes of a dangling separator from an empty
  // join, at either end, without a second rule for it.
  const parts = (label ?? '').split('·').map(part => part.trim()).filter(Boolean)
  const named = parts.filter(part => !UUID.test(part))
  // Any identifier among the parts is kept as metadata — demoted, not discarded.
  const carried = parts.find(part => UUID.test(part))

  if (named.length > 0) return { name: named.join(' · '), identifier: carried, unnamed: false }

  return { name: unnamedText, identifier: carried ?? fallbackId, unnamed: true }
}

/** Shortened for display. The full value stays in the record, never on screen. */
export function shortIdentifier(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/**
 * Whole days between a recorded timestamp and now.
 *
 * `now` is injectable so ordering and age are deterministic under test — the
 * same reason `buildOperationsDeskItems` takes one — and so the clock is read
 * here rather than during a component's render, which this codebase's lint
 * rules forbid.
 */
export function daysOpen(iso: string, now: Date = new Date()): number | null {
  const started = new Date(iso)
  if (Number.isNaN(started.getTime())) return null
  return Math.max(0, Math.floor((now.getTime() - started.getTime()) / 86_400_000))
}
