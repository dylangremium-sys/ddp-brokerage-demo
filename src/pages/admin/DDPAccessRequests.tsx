import { useCallback, useEffect, useMemo, useState } from 'react'
import { runGuardedLoad } from '../../lib/asyncLoadGuard'
import {
  loadAccessRequests,
  setAccessRequestStatus,
  ACCESS_REQUEST_STATUS_LABELS,
  TRIAGE_ACTIONS,
  AccessRequestAdminError,
  type AccessRequestRow,
  type AccessRequestStatus,
} from '../../lib/accessRequestAdmin'

/**
 * Supplier enquiries — the administrator's view of the public intake queue.
 *
 * Migration 34 created this queue with an `admin triage` UPDATE policy and a
 * status CHECK allowing 'declined' and 'duplicate', but nothing ever drove them:
 * no application surface read the queue at all. So enquiries accumulated
 * unreadable and spam was undispositionable except through direct SQL, which the
 * production change freeze forbids. This page is that missing affordance.
 *
 * NO DELETE CONTROL, deliberately. Migration 34's "deliberately NO delete policy"
 * stands — an enquiry is a record of who asked for access. Spam is marked
 * 'declined' or 'duplicate' and filtered out of the default view, not erased.
 *
 * Authorization is the database's. Every read and write here runs as the signed-in
 * administrator under the existing policies; this component adds no privilege and
 * assumes none. A failed write is surfaced, never swallowed.
 */
export default function DDPAccessRequests() {
  // rows === null means "no successful load yet" — distinct from [], so an empty
  // queue is never shown before a load has actually succeeded.
  const [rows, setRows] = useState<AccessRequestRow[] | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})

  // Bumped to request a reload. An effect dependency rather than a direct call,
  // because setState inside an effect body is the cascading-render pattern
  // react-hooks/set-state-in-effect exists to catch — the same reason App.tsx
  // drives its admin loads this way.
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let active = true
    // runGuardedLoad drops a superseded or hung load, so a slow first fetch
    // cannot land on top of a newer one after the operator hits Refresh.
    // `void` marks a deliberately-unawaited promise. This is the repo-wide idiom
    // for it (36 uses in DDPComplianceWatchtower.tsx alone, plus eight other
    // files); dropping it here would leave an unmarked floating promise, and
    // changing the convention belongs in its own PR. (A `skipcq` directive was
    // tried here and does NOT suppress this rule, so the finding stays visible
    // on the PR rather than being silently hidden.)
    void runGuardedLoad(loadAccessRequests(), () => active, {
      onSuccess: loaded => {
        setRows(loaded)
        setLoadError(null)
        setLoadState('ready')
      },
      onError: err => {
        // rows is cleared, not kept: showing a stale queue beside an error
        // invites triaging a row that may already have been dispositioned.
        setRows(null)
        setLoadState('failed')
        setLoadError(
          err instanceof AccessRequestAdminError
            ? err.message
            : 'The supplier enquiry queue could not be loaded.',
        )
      },
    })
    return () => { active = false }
  }, [reloadToken])

  /** Event-handler reload: safe to set state synchronously here. */
  const refresh = useCallback(() => {
    setLoadState('loading')
    setLoadError(null)
    setReloadToken(t => t + 1)
  }, [])

  const visible = useMemo(() => {
    if (!rows) return []
    return showResolved ? rows : rows.filter(r => r.status === 'new' || r.status === 'contacted')
  }, [rows, showResolved])

  const openCount = useMemo(
    () => (rows ?? []).filter(r => r.status === 'new').length,
    [rows],
  )

  async function disposition(row: AccessRequestRow, status: AccessRequestStatus) {
    setBusyId(row.id)
    setActionError(null)
    try {
      await setAccessRequestStatus(row.id, status, (noteDraft[row.id] ?? '').trim())
      // Re-read rather than patching state locally: reviewed_by/reviewed_at are
      // set by a database trigger, so the server's row is the only truthful one.
      refresh()
    } catch (err) {
      setActionError(
        err instanceof AccessRequestAdminError
          ? err.message
          : 'The enquiry could not be updated.',
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="page">
      <header style={{ marginBottom: 20 }}>
        <h1>Supplier enquiries</h1>
        <p className="muted">
          Access requests submitted through the public supplier form. An enquiry is not an
          account: provisioning stays admin-only and happens by email invitation.
        </p>
      </header>

      {loadState === 'loading' && <p className="muted">Loading enquiries…</p>}

      {loadState === 'failed' && (
        <div role="alert" className="notice notice-error">
          <strong>The queue could not be loaded.</strong>
          <p>{loadError}</p>
          <button type="button" onClick={refresh}>Try again</button>
        </div>
      )}

      {loadState === 'ready' && (
        <>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            <span><strong>{openCount}</strong> awaiting first contact</span>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={showResolved}
                onChange={e => setShowResolved(e.target.checked)}
              />
              Show dispositioned enquiries
            </label>
            <button type="button" onClick={refresh}>Refresh</button>
          </div>

          {actionError && (
            <div role="alert" className="notice notice-error" style={{ marginBottom: 16 }}>
              {actionError}
            </div>
          )}

          {visible.length === 0 && (
            <p className="muted">
              {showResolved
                ? 'No supplier enquiries have been received.'
                : 'No open supplier enquiries. Tick “Show dispositioned enquiries” to see the rest.'}
            </p>
          )}

          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
            {visible.map(row => (
              <li key={row.id} className="card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <strong>{row.fullName || '(no name given)'}</strong>
                    <div className="muted">
                      {row.email} · {row.phone}
                      {row.province ? ` · ${row.province}` : ''}
                      {row.position ? ` · ${row.position}` : ''}
                    </div>
                  </div>
                  <div className="muted">
                    {ACCESS_REQUEST_STATUS_LABELS[row.status]}
                    {row.createdAt ? ` · ${new Date(row.createdAt).toLocaleDateString()}` : ''}
                  </div>
                </div>

                {row.note && <p style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{row.note}</p>}

                {row.reviewNote && (
                  <p className="muted" style={{ marginTop: 8 }}>
                    Review note: {row.reviewNote}
                  </p>
                )}

                <div style={{ marginTop: 12 }}>
                  <label htmlFor={`note-${row.id}`} className="muted">Review note (optional)</label>
                  <input
                    id={`note-${row.id}`}
                    type="text"
                    maxLength={2000}
                    value={noteDraft[row.id] ?? ''}
                    onChange={e => setNoteDraft(prev => ({ ...prev, [row.id]: e.target.value }))}
                    style={{ width: '100%', marginTop: 4 }}
                  />
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  {TRIAGE_ACTIONS.filter(s => s !== row.status).map(status => (
                    <button
                      key={status}
                      type="button"
                      disabled={busyId === row.id}
                      // deliberately-unawaited promise; repo-wide idiom, see above.
                      onClick={() => void disposition(row, status)}
                    >
                      {ACCESS_REQUEST_STATUS_LABELS[status]}
                    </button>
                  ))}
                </div>

                {/* Stated in the UI, not just in the migration, so the absence of a
                    delete button reads as a decision rather than an omission. */}
                <p className="muted" style={{ marginTop: 10, fontSize: '0.85em' }}>
                  Enquiries are never deleted — mark spam as Declined or Duplicate.
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
