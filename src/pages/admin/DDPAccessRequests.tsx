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
import { inviteFarmer, resendInvitation } from '../../services/adminProvisioning'
import { resolveProvisionDecision } from '../../lib/accessRequestProvisioning'

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
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // A one-time invitation link the provider declined to email, scoped to the row
  // it belongs to. Held in memory only — never written to storage and never
  // logged, because anyone holding it can set that supplier's password.
  const [resendLink, setResendLink] = useState<{ rowId: string; url: string } | null>(null)
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

  /**
   * Create the supplier's account, then record the enquiry as invited.
   *
   * Order is load-bearing. The account is created FIRST and the status is only
   * written once one exists, so a failed invitation can never leave an enquiry
   * that claims to have been invited. Before this existed, "Invited" was a bare
   * label: it wrote the status and created nothing.
   */
  async function provision(row: AccessRequestRow) {
    setBusyId(row.id)
    setActionError(null)
    setActionNotice(null)

    // One try/finally around the WHOLE body, including the invite call. An
    // unexpected throw before the status write would otherwise leave busyId set
    // and the row's buttons disabled until a reload.
    try {
      const decision = resolveProvisionDecision(
        await inviteFarmer({
          email: row.email,
          displayName: row.fullName,
          province: row.province,
          phoneNumber: row.phone,
        }),
      )

      if (!decision.markInvited) {
        setActionError(decision.message)
        return
      }

      try {
        await setAccessRequestStatus(row.id, 'invited', (noteDraft[row.id] ?? '').trim())
        setActionNotice(decision.message)
        refresh()
      } catch (err) {
        // The account DOES exist at this point. Say so, rather than reporting a
        // bare failure that would invite a second provisioning attempt.
        setActionError(
          `${decision.message} However the enquiry status could not be updated: ${
            err instanceof AccessRequestAdminError ? err.message : 'the update was rejected'
          }. Do not re-invite — mark it invited manually.`,
        )
      }
    } catch {
      setActionError('The account could not be created. Please try again.')
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Re-issue an invitation whose link expired before the supplier opened it.
   *
   * Changes no enquiry status: the enquiry is already 'invited' and still is —
   * nothing about the triage decision has changed, only the delivery. Writing a
   * status here would be recording an event that did not happen.
   */
  async function resend(row: AccessRequestRow) {
    setBusyId(row.id)
    setActionError(null)
    setActionNotice(null)
    setResendLink(null)

    try {
      const result = await resendInvitation(row.email)
      if (!result.ok) {
        setActionError(result.error)
        return
      }
      if (result.delivered === 'link') {
        setResendLink({ rowId: row.id, url: result.actionLink })
        setActionNotice(`A new invitation link was created for ${row.email}. Send it to them yourself — see below.`)
        return
      }
      setActionNotice(`A new invitation email has been sent to ${row.email}.`)
    } catch {
      setActionError('The invitation could not be re-issued. Please try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function disposition(row: AccessRequestRow, status: AccessRequestStatus) {
    setBusyId(row.id)
    setActionError(null)
    setActionNotice(null)
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
    // `page-wrap ddp-wrap`, matching every sibling admin page. This page was the
    // only one using `className="page"` — a class that is not defined anywhere in
    // App.css — so it never picked up the light admin panel's typography and
    // inherited the dark-theme text colour (rgb(237,241,245)) instead. On the
    // cream panel that renders as near-invisible text: the heading, the counts,
    // the checkbox label, the empty state and every success/error notice were all
    // unreadable in production.
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — SUPPLIER ENQUIRIES</div>
        <h1 className="page-title">Supplier enquiries</h1>
        <p className="page-desc">
          Access requests submitted through the public supplier form. An enquiry is not an
          account. “Invite &amp; create account” provisions one and emails the supplier an
          invitation; they choose their own password. Marking an enquiry Invited is not a
          separate step — it records that an account now exists.
        </p>
      </div>

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

          {actionNotice && (
            <div role="status" className="notice" style={{ marginBottom: 16 }}>
              {actionNotice}
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
                  {/* 'invited' is NOT offered as a plain status here. It is set only
                      by the provisioning action below, so the label always means an
                      account exists. */}
                  {TRIAGE_ACTIONS.filter(s => s !== row.status && s !== 'invited').map(status => (
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

                  {row.status !== 'invited' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busyId === row.id}
                      // NOT the `void` idiom used above, deliberately. provision()
                      // handles every failure internally and cannot reject, so an
                      // explicit no-op catch says that plainly and keeps the
                      // promise handled — without adding a THIRD void finding to
                      // the two the owner has already reviewed and accepted here.
                      onClick={() => { provision(row).catch(() => undefined) }}
                    >
                      {busyId === row.id ? 'Creating account…' : 'Invite & create account'}
                    </button>
                  )}

                  {/* Offered only once an account exists. A supplier who never
                      opened their invitation before it expired cannot rescue
                      themselves: "forgot password" sends nothing for an
                      unconfirmed identity, so this is the only route back in. */}
                  {row.status === 'invited' && (
                    <button
                      type="button"
                      // btn-ghost, NOT btn-secondary: the latter is defined only
                      // under `.eo-farmer`, which this admin page is not inside,
                      // so it would render unstyled. That is the exact defect
                      // PR #90 fixed on this very page — a class referenced from
                      // a stylesheet that does not apply here.
                      className="btn btn-ghost"
                      disabled={busyId === row.id}
                      onClick={() => { resend(row).catch(() => undefined) }}
                    >
                      {busyId === row.id ? 'Re-issuing…' : 'Resend invitation'}
                    </button>
                  )}
                </div>

                {/* A one-time link the provider would not email. It is a
                    CREDENTIAL — whoever holds it can set this supplier's
                    password — so it is shown only to the admin who asked for it,
                    for this row, and is never persisted or logged. */}
                {resendLink?.rowId === row.id && (
                  <div className="notice" style={{ marginTop: 10 }}>
                    <p style={{ marginTop: 0 }}>
                      Email delivery was refused, so here is a one-time invitation link.
                      Send it to the supplier yourself (LINE, WhatsApp, or your own email).
                      <strong> Treat it like a password — anyone who opens it can set their password.</strong>
                    </p>
                    <input
                      type="text"
                      readOnly
                      value={resendLink.url}
                      onFocus={e => e.currentTarget.select()}
                      style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.8em' }}
                      aria-label="One-time invitation link"
                    />
                  </div>
                )}

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
