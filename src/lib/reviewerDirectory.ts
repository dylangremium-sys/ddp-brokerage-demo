import { supabase } from './supabase'

/**
 * Who a reviewer is, resolved once at the boundary.
 *
 * WHY THIS EXISTS. The evidence screen already wrote
 * `adminNames?.get(doc.reviewedBy) ?? doc.reviewedBy` — resolution with a
 * fallback to the raw id. It looked fixed. But `adminNames` is an optional prop
 * and `App.tsx` renders `<DDPDocumentReview />` with no props at all, so the map
 * was always undefined and the fallback always fired: every reviewer on the
 * live screen, and in the review history, is a bare UUID today.
 *
 * That is the shape this class of bug takes. The resolution is written, the
 * source of names is never wired, and reading the component tells you it works.
 * So the directory is loaded here, close to the data, and the render path is
 * given no way to fall back to an identifier — see `reviewerLabel`.
 *
 * A UUID is not a name. It cannot be read aloud, two of them cannot be told
 * apart, and on the one screen that constitutes DDP's chain of custody it
 * answers "who looked at this" with a string nobody can act on.
 */

export interface Reviewer {
  id: string
  /** Display name, or the email when a profile has no name recorded. */
  name: string
  /** 'ddp_admin' | 'farmer' | 'buyer' | 'pending' — shown beside the name. */
  role: string
}

export type ReviewerDirectory = ReadonlyMap<string, Reviewer>

/**
 * Every profile that could appear as a reviewer.
 *
 * Read from `profiles`, which carries display_name, email and role. RLS decides
 * what an admin may see; a caller who is refused gets an empty directory rather
 * than an exception, because a screen that cannot name its reviewers must still
 * render the decisions — it just has to say plainly that it could not.
 */
export async function loadReviewerDirectory(): Promise<ReviewerDirectory> {
  if (!supabase) return new Map()

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role')

  if (error || !data) return new Map()

  const directory = new Map<string, Reviewer>()
  for (const row of data as Array<{ id: string; display_name: string | null; email: string | null; role: string | null }>) {
    directory.set(row.id, {
      id: row.id,
      name: (row.display_name ?? '').trim() || (row.email ?? '').trim() || '',
      role: (row.role ?? '').trim(),
    })
  }
  return directory
}

/**
 * How a reviewer is written on screen.
 *
 * DELIBERATELY CANNOT RETURN AN IDENTIFIER. When the directory does not hold
 * the id, this says so in words rather than printing the UUID — because the
 * fallback-to-id is exactly the behaviour that put a UUID on the live screen
 * while the code appeared to resolve names.
 *
 * The id remains available to the caller for support and for a `title`
 * attribute; it is never the label.
 */
export function reviewerLabel(
  id: string | null | undefined,
  directory: ReviewerDirectory | null | undefined,
  unknownText = 'a reviewer whose name is not on file',
  unattributedText = 'an unrecorded reviewer',
): string {
  if (!id) return unattributedText
  const found = directory?.get(id)
  return found && found.name ? found.name : unknownText
}

/** The role, when there is one, for the line beneath the name. */
export function reviewerRole(
  id: string | null | undefined,
  directory: ReviewerDirectory | null | undefined,
): string | null {
  if (!id) return null
  const role = directory?.get(id)?.role
  if (!role) return null
  return role === 'ddp_admin' ? 'DDP administrator' : role
}
