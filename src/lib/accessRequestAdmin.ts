// ─── Farmer access requests — administrator triage (audit R5, second-order) ──
//
// Migration 34 created the intake queue with an `admin triage` UPDATE policy and
// a status CHECK allowing 'declined' and 'duplicate' — but nothing in the
// application ever read the queue or drove that policy. So an administrator could
// neither work the queue nor disposition spam, and migration 34's
// "deliberately NO delete policy" meant the only alternative was direct SQL,
// which the production change freeze forbids.
//
// This module is the data layer for that. It adds no privilege: reads and writes
// are the caller's own, under the existing `admin read` / `admin triage` policies,
// and a non-administrator gets nothing back.
//
// NO HARD DELETE. An enquiry is a record of who asked for access. Spam is
// dispositioned, not erased.

import { supabase, isSupabaseConfigured } from './supabase'

/** The workflow states migration 34's CHECK allows. */
export const ACCESS_REQUEST_STATUSES = ['new', 'contacted', 'invited', 'declined', 'duplicate'] as const
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number]

/**
 * The dispositions an administrator can apply, with the labels the UI renders.
 *
 * Deriving the UI's options from this record — rather than listing them in the
 * component — is what makes a UI option the database rejects impossible: the
 * keys are exactly the AccessRequestStatus union, enforced by the type.
 */
export const ACCESS_REQUEST_STATUS_LABELS: Record<AccessRequestStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  invited: 'Invited',
  declined: 'Declined',
  duplicate: 'Duplicate',
}

/** Dispositions offered as triage actions (everything except the initial state). */
export const TRIAGE_ACTIONS: AccessRequestStatus[] = ['contacted', 'invited', 'declined', 'duplicate']

export interface AccessRequestRow {
  id: string
  fullName: string
  email: string
  phone: string
  province: string
  position: string
  preferredLanguage: string
  note: string
  status: AccessRequestStatus
  reviewNote: string
  reviewedAt: string | null
  createdAt: string
}

export type AccessRequestAdminErrorCode =
  | 'not_configured'
  /** The intake table is absent — migration 34 has not reached this environment. */
  | 'backend_unavailable'
  | 'forbidden'
  | 'load_failed'
  | 'update_failed'

export class AccessRequestAdminError extends Error {
  readonly code: AccessRequestAdminErrorCode
  constructor(code: AccessRequestAdminErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'AccessRequestAdminError'
  }
}

/** PostgREST: the table is absent from the schema cache. */
const MISSING_TABLE_PGRST = 'PGRST205'
/** Postgres: undefined_table. */
const UNDEFINED_TABLE = '42P01'
/** Postgres: insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501'

function isTableMissing(error: { code?: string; message?: string }): boolean {
  const code = error.code
  if (code) return code === UNDEFINED_TABLE || code === MISSING_TABLE_PGRST
  const message = error.message ?? ''
  return /does not exist|could not find the table|schema cache/i.test(message)
    && /farmer_access_requests/i.test(message)
}

function isRow(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function toStatus(v: unknown): AccessRequestStatus {
  const candidate = asString(v)
  return (ACCESS_REQUEST_STATUSES as readonly string[]).includes(candidate)
    ? (candidate as AccessRequestStatus)
    : 'new'
}

export function mapAccessRequestRow(raw: unknown): AccessRequestRow | null {
  if (!isRow(raw)) return null
  const id = asString(raw.id)
  if (!id) return null
  return {
    id,
    fullName: asString(raw.full_name),
    email: asString(raw.email),
    phone: asString(raw.phone),
    province: asString(raw.province),
    position: asString(raw.position),
    preferredLanguage: asString(raw.preferred_language) || 'en',
    note: asString(raw.note),
    status: toStatus(raw.status),
    reviewNote: asString(raw.review_note),
    reviewedAt: typeof raw.reviewed_at === 'string' ? raw.reviewed_at : null,
    createdAt: asString(raw.created_at),
  }
}

/**
 * Load the queue.
 *
 * Readable only by an administrator, under migration 34's `admin read` policy.
 * A non-administrator does not get an error — RLS simply returns no rows — so
 * the caller must not present an empty result as "no enquiries" without knowing
 * the viewer is an admin. The admin page is only reachable by an admin.
 */
export async function loadAccessRequests(): Promise<AccessRequestRow[]> {
  if (!supabase || !isSupabaseConfigured) {
    throw new AccessRequestAdminError('not_configured', 'Supabase is not configured.')
  }

  const { data, error } = await supabase
    .from('farmer_access_requests')
    .select('id, full_name, email, phone, province, position, preferred_language, note, status, review_note, reviewed_at, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    if (isTableMissing(error)) {
      throw new AccessRequestAdminError(
        'backend_unavailable',
        'The supplier enquiry queue is not available in this environment yet.',
      )
    }
    throw new AccessRequestAdminError('load_failed', 'The supplier enquiry queue could not be loaded.')
  }

  return (data ?? []).map(mapAccessRequestRow).filter((r): r is AccessRequestRow => r !== null)
}

/**
 * Disposition one enquiry.
 *
 * `reviewed_by` and `reviewed_at` are NOT sent: migration 34's
 * stamp_farmer_access_request_review() trigger sets them from auth.uid(), and it
 * REFUSES a status change with no authenticated actor. Sending them from the
 * client would be a false-attribution vector, and the trigger would overwrite
 * them anyway.
 */
export async function setAccessRequestStatus(
  id: string,
  status: AccessRequestStatus,
  reviewNote = '',
): Promise<void> {
  if (!supabase || !isSupabaseConfigured) {
    throw new AccessRequestAdminError('not_configured', 'Supabase is not configured.')
  }
  if (!(ACCESS_REQUEST_STATUSES as readonly string[]).includes(status)) {
    throw new AccessRequestAdminError('update_failed', `"${status}" is not a valid disposition.`)
  }
  if (reviewNote.length > 2000) {
    throw new AccessRequestAdminError('update_failed', 'The review note is too long (2000 characters maximum).')
  }

  const { error } = await supabase
    .from('farmer_access_requests')
    .update({ status, review_note: reviewNote })
    .eq('id', id)

  if (error) {
    if (isTableMissing(error)) {
      throw new AccessRequestAdminError(
        'backend_unavailable',
        'The supplier enquiry queue is not available in this environment yet.',
      )
    }
    if (error.code === INSUFFICIENT_PRIVILEGE) {
      throw new AccessRequestAdminError(
        'forbidden',
        'You do not have permission to triage supplier enquiries.',
      )
    }
    throw new AccessRequestAdminError('update_failed', 'The enquiry could not be updated.')
  }
}
