// ─── Regulatory update entries ──────────────────────────────────────────────
//
// THE PUBLISHING PATH, AND WHY IT IS THIS SHAPE
//   Publishing is a deliberate authored step: a markdown file in the repo,
//   reviewed in a pull request. Nothing here reads a database, opens a network
//   connection, or holds a credential. There is no path from the internal
//   compliance system to a public route because there is nothing in this module
//   capable of opening one — asserted by publishingBoundary.test.ts, which
//   walks the import graph from here and fails if it reaches Supabase, the
//   services layer or api/.
//
//   The second half of the boundary is that no FIELD here could hold an
//   internal record. ALLOWED_FIELDS is the whole vocabulary, unknown keys are a
//   parse error, and every value plus the body is run past the leak canary.
//
// WHY THE URL CARRIES THE DATE
//   Entries accumulate as individual pages and must never churn on one URL. A
//   dated slug makes that structural: two updates cannot collide, and a link
//   shared today still resolves years later.
//
//   The date is YEAR-MONTH, not year-month-day:
//
//       /regulatory-updates/2026-08-thai-licence-sunset
//
//   A full date pins a URL to the day an entry happened to ship, so an entry
//   drafted on the 13th and published on the 14th either carries a wrong date
//   or needs its filename changed. Year-month is precise enough to establish
//   when the guidance is from, which is what a reader is judging.
//
//   NO TRAILING SLASH. Every other URL on this site has none — /about, /de,
//   /cs, /th/suppliers. Vercel serves a directory index at both forms, so a
//   trailing slash would not be doing work; it would be a second URL shape for
//   the same page, separated only by a canonical tag.

import { parseFrontmatter, FrontmatterError } from './frontmatter'
import { findLeaks } from './leakCanary'
import { renderMarkdown } from './markdown'

/**
 * Every field an entry may declare. Deliberately small.
 *
 * There is no field for a supplier, a licence number, a counterparty, a batch
 * or a COA. That is the boundary expressed as a schema: an internal record has
 * nowhere to be written, so it cannot be carried into a public page by a field
 * nobody validated.
 */
export const ALLOWED_FIELDS = [
  'title',
  'description',
  'published',
  'updated',
  'lastVerified',
  'reviewer',
] as const

/** Used when an entry names no individual reviewer. */
export const DEFAULT_REVIEWER = 'DDP Brokerage — Compliance & Operations'

export interface RegulatoryEntry {
  /** Dated slug, e.g. `2026-08-14-eu-gacp-guidance`. Also the URL segment. */
  slug: string
  title: string
  description: string
  /** YYYY-MM-DD. */
  published: string
  updated: string
  /** When a person last confirmed the entry is still accurate. */
  lastVerified: string
  /** A named individual where one is given; otherwise the team. */
  reviewer: string
  /** Rendered HTML body. */
  html: string
  canonicalPath: string
}

export class ContentError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A real calendar date, not merely date-shaped.
 *
 * The NaN guard is load-bearing rather than defensive: `new Date('2026-08-32')`
 * is an Invalid Date, and calling toISOString() on one THROWS. Without the
 * guard a typo in a frontmatter date crashed the build with a RangeError from
 * deep inside a date call, instead of naming the file and the field.
 */
const isRealDate = (value: string) => {
  if (!DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** The markdown sources, read at build time. Filesystem only — see the header. */
const SOURCES = import.meta.glob('/content/regulatory/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Turns one file into an entry, or explains precisely why it cannot. */
export function parseEntry(path: string, source: string): RegulatoryEntry {
  const filename = path.split('/').pop() ?? path
  const slug = filename.replace(/\.md$/, '')

  const fail = (message: string): never => {
    throw new ContentError(`${filename}: ${message}`)
  }

  if (!/^\d{4}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    fail('filename must be YYYY-MM-lower-case-slug.md — the year and month are part of the URL')
  }

  let parsed
  try {
    parsed = parseFrontmatter(source, ALLOWED_FIELDS)
  } catch (error) {
    fail(error instanceof FrontmatterError ? error.message : String(error))
  }

  const { fields, body } = parsed!

  for (const required of ['title', 'description', 'published', 'lastVerified'] as const) {
    if (!fields[required]) fail(`"${required}" is required`)
  }

  for (const dated of ['published', 'updated', 'lastVerified'] as const) {
    const value = fields[dated]
    if (value && !isRealDate(value)) fail(`"${dated}" must be a real YYYY-MM-DD date, got "${value}"`)
  }

  // The URL claims a month; the frontmatter claims a date. If they disagree,
  // the date a reader sees is not the one in the link they were sent.
  if (fields.published.slice(0, 7) !== slug.slice(0, 7)) {
    fail(
      `"published" (${fields.published}) is not in the month named by the filename (${slug.slice(0, 7)})`,
    )
  }

  if (fields.description.length > 160) {
    fail(`"description" is ${fields.description.length} characters; a result snippet shows about 160`)
  }

  // Verifying an entry before it was published is not a claim anyone can make.
  if (fields.lastVerified < fields.published) {
    fail(`"lastVerified" (${fields.lastVerified}) is before "published" (${fields.published})`)
  }

  // THE CANARY. Field values as well as the body: a title is just as public.
  const findings = findLeaks([...Object.values(fields), body].join('\n'))
  if (findings.length > 0) {
    const detail = findings
      .map((f) => `  ${f.pattern}: "${f.match}" — ${f.why}`)
      .join('\n')
    fail(
      `looks like it contains internal data and will not be published:\n${detail}\n` +
        '  If a match is genuinely innocent, reword it. Do not add an exception — see leakCanary.ts.',
    )
  }

  return {
    slug,
    title: fields.title,
    description: fields.description,
    published: fields.published,
    updated: fields.updated ?? fields.published,
    lastVerified: fields.lastVerified,
    reviewer: fields.reviewer ?? DEFAULT_REVIEWER,
    html: renderMarkdown(body),
    canonicalPath: `/regulatory-updates/${slug}`,
  }
}

/** Every entry, newest first. Throws if any single file is unpublishable. */
export function regulatoryEntries(): RegulatoryEntry[] {
  const entries = Object.entries(SOURCES).map(([path, source]) => parseEntry(path, source))

  const slugs = new Set<string>()
  for (const entry of entries) {
    if (slugs.has(entry.slug)) throw new ContentError(`duplicate entry slug: ${entry.slug}`)
    slugs.add(entry.slug)
  }

  return entries.sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : a.slug < b.slug ? 1 : -1))
}

/** The entry a public path names, or undefined. Trailing slash tolerated. */
export function entryForPath(pathname: string): RegulatoryEntry | undefined {
  const normalised = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return regulatoryEntries().find((entry) => entry.canonicalPath === normalised)
}
