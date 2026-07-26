// ─── Operator-facing database error reporting ───────────────────────────────
//
// THE DEFECT (audit F8). onDbError stored err.message and the banner rendered it
// unmodified. Those messages originate in src/lib/db.ts, which rethrows the
// Postgres/PostgREST message directly — text like:
//
//   new row violates row-level security policy for table "inventory_batches"
//   duplicate key value violates unique constraint "buyer_pack_snapshots_pack_id_version_key"
//   column "coa_storage_path" of relation "inventory_batches" does not exist
//
// So policy, table, column and constraint names were shown verbatim to end
// users, farmers included. That is a schema disclosure to an audience that
// cannot act on it, in place of an instruction they could.
//
// THE FIX, copied from the server-side pattern that already exists here
// (api/compliance/ai-summary.ts:100-113 + observability.ts): map to a stable
// operator-facing message plus a correlation id, keep the raw text in
// console.error where it already went, and emit one structured safe log line
// carrying the same id. A user reporting "reference a1b2c3d4" is then matchable
// to a console line without the message itself ever carrying schema detail.
//
// The safety here is STRUCTURAL, not a scrub. Every returned message is a
// literal from the closed table below; err.message is never interpolated,
// concatenated, or passed through on any branch — including the default. There
// is no code path that puts database text into the banner.

import { newRequestId, logClientError } from './observability'

/** The closed set of things an operator can be told. Codes, never messages. */
export type DbErrorCategory =
  | 'permission_denied'
  | 'duplicate_record'
  | 'related_record_missing'
  | 'invalid_value'
  | 'not_found'
  | 'connection_failed'
  | 'internal_error'

/**
 * The ONLY strings that can reach the banner. Each says what happened and what
 * to do; none names a policy, table, column, constraint or function.
 */
const MESSAGES: Record<DbErrorCategory, string> = {
  permission_denied:
    'You do not have permission to make this change. If you believe you should, contact DDP support with the reference below.',
  duplicate_record:
    'This record already exists and cannot be created twice. Refresh the page to see the current version.',
  related_record_missing:
    'This change refers to a record that no longer exists. Refresh the page and try again.',
  invalid_value:
    'Some of the submitted details could not be accepted. Check the form for missing or out-of-range values and try again.',
  not_found:
    'The requested record could not be found. It may have been changed or removed since this page was loaded.',
  connection_failed:
    'Could not reach the DDP service. Check your connection and try again.',
  internal_error:
    'The change could not be saved. Nothing has been altered. Please try again, and contact DDP support with the reference below if it persists.',
}

export interface DbErrorReport {
  /** Safe, operator-facing. Always a literal from MESSAGES. */
  message: string
  /** Correlation id, shown to the user and present on the console line. */
  reference: string
  /** Machine code for the log line. Never rendered as prose. */
  category: DbErrorCategory
}

/**
 * SQLSTATE / PostgREST codes worth distinguishing. Anything unlisted is
 * 'internal_error' — a deliberately dull default, because guessing wrongly at a
 * cause is worse than declining to guess.
 */
function categoryFromCode(code: string): DbErrorCategory | null {
  switch (code) {
    case '42501':               // insufficient_privilege (incl. RLS refusals)
    case 'PGRST301':            // JWT / role not permitted
      return 'permission_denied'
    case '23505':               // unique_violation
      return 'duplicate_record'
    case '23503':               // foreign_key_violation
      return 'related_record_missing'
    case '23502':               // not_null_violation
    case '23514':               // check_violation
    case '22P02':               // invalid_text_representation
    case '22001':               // string_data_right_truncation
      return 'invalid_value'
    case 'PGRST116':            // no rows where exactly one was expected
      return 'not_found'
    default:
      return null
  }
}

/**
 * Classifies WITHOUT quoting. The message is inspected only to pick a category
 * — its text never leaves this function.
 *
 * Kept narrow on purpose: RLS refusals arrive from PostgREST as a 42501 code in
 * most paths, but db.ts rethrows `new Error(error.message)` (db.ts:28-55), which
 * discards the code, so the phrase test is the only signal left for those. The
 * patterns match Postgres's own fixed wording, not user data.
 */
function categoryFromMessage(message: string): DbErrorCategory {
  const m = message.toLowerCase()
  if (m.includes('row-level security') || m.includes('permission denied') || m.includes('insufficient_privilege')) {
    return 'permission_denied'
  }
  if (m.includes('duplicate key value') || m.includes('already exists and cannot be overwritten')) {
    return 'duplicate_record'
  }
  if (m.includes('violates foreign key constraint')) return 'related_record_missing'
  if (m.includes('violates not-null constraint') || m.includes('violates check constraint') || m.includes('invalid input syntax')) {
    return 'invalid_value'
  }
  if (m.includes('failed to fetch') || m.includes('fetch failed') || m.includes('networkerror') || m.includes('load failed')) {
    return 'connection_failed'
  }
  return 'internal_error'
}

/**
 * Total by construction. This runs on the failure path, so it must never throw
 * or return a non-string — JSON.stringify(undefined) returns undefined, and a
 * symbol throws on String() coercion in some engines. A crash here would
 * replace a handled database error with an unhandled one.
 */
function rawText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    const json = JSON.stringify(err)
    if (typeof json === 'string') return json
  } catch {
    // fall through to the coercion below
  }
  try {
    return String(err)
  } catch {
    return 'unserialisable error value'
  }
}

/** A PostgREST error object may travel as a plain object rather than an Error. */
function codeOf(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return null
}

/**
 * Turns any thrown value into something an operator can be shown.
 *
 * Side effects, both deliberate and both retained from the previous behaviour:
 *   • console.error keeps the RAW text, so a developer with a console loses
 *     nothing. It is prefixed with the reference so the two are matchable.
 *   • logClientError emits one structured, schema-free line carrying the same
 *     reference — the searchable record, safe to ship anywhere.
 */
export function reportDbError(err: unknown, route = 'app'): DbErrorReport {
  const reference = newRequestId()
  const raw = rawText(err)
  const code = codeOf(err)
  const category = (code ? categoryFromCode(code) : null) ?? categoryFromMessage(raw)

  // Raw text stays here and ONLY here.
  console.error(`Supabase error [${reference}]:`, raw)
  logClientError({ event: 'db_error', requestId: reference, category, route })

  return { message: MESSAGES[category], reference, category }
}

/** For messages the app authors itself, which need a reference but no mapping. */
export function reportAppMessage(message: string): DbErrorReport {
  const reference = newRequestId()
  logClientError({ event: 'app_notice', requestId: reference, category: 'internal_error', route: 'app' })
  return { message, reference, category: 'internal_error' }
}
