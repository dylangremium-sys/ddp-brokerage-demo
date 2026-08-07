import { useCallback, useEffect, useState } from 'react'
import { runGuardedLoad } from '../../lib/asyncLoadGuard'
import { supabase } from '../../lib/supabase'
import { inviteBuyer, type InviteBuyerResult } from '../../services/adminBuyerProvisioning'

/**
 * Buyer onboarding — the administrator's route to creating a buyer account.
 *
 * WHY THIS IS A SEPARATE PAGE FROM SUPPLIER ENQUIRIES.
 * A farmer arrives through the public intake queue and is provisioned FROM a
 * row in it. A buyer does not: there is no buyer self-registration anywhere in
 * the product, by design, so there is no queue to provision from. Onboarding a
 * buyer starts with an administrator deciding to, which is a form and not a
 * triage action.
 *
 * WHAT WAS MISSING. `profiles.role` has admitted 'buyer' since migration 39;
 * `organisations`, `organisation_memberships` and migration 46's verified-buyer
 * read predicate have all been live — with zero rows and zero code references.
 * #174 taught the router what to do with a buyer once one existed. Nothing
 * could bring one into existence. This page is that step.
 *
 * Authorization is the server's, not this component's. Every field here is
 * advisory: /api/admin/provision-buyer re-reads the caller's role from the
 * database and fails closed. This page adds no privilege and assumes none.
 *
 * VERIFICATION IS NOT DONE HERE. A new organisation is created 'unverified'.
 * Marking one verified requires a named administrator and a timestamp
 * (`organisations_verified_requires_evidence`) and is a separate decision from
 * onboarding — deliberately not a checkbox on this form.
 */

interface BuyerOrgRow {
  id: string
  legalName: string
  displayName: string | null
  countryCode: string
  verificationState: string
  memberCount: number
}

const ORG_ROLES = ['owner', 'admin', 'operator', 'viewer'] as const

async function loadBuyerOrganisations(): Promise<BuyerOrgRow[]> {
  if (!supabase) throw new Error('Supabase is not configured.')
  // `organisations_select` admits an admin or a member, so this read runs under
  // the signed-in administrator's own policy — the page adds no privilege.
  const { data, error } = await supabase
    .from('organisations')
    .select('id, legal_name, display_name, country_code, verification_state, organisation_memberships(user_id)')
    .eq('org_type', 'buyer')
    .order('legal_name')
  if (error) throw new Error(error.message)
  return (data ?? []).map((row): BuyerOrgRow => ({
    id: String(row.id),
    legalName: String(row.legal_name ?? ''),
    displayName: typeof row.display_name === 'string' ? row.display_name : null,
    countryCode: String(row.country_code ?? ''),
    verificationState: String(row.verification_state ?? 'unverified'),
    memberCount: Array.isArray(row.organisation_memberships) ? row.organisation_memberships.length : 0,
  }))
}

export default function DDPBuyerProvisioning() {
  // null means "no successful load yet" — distinct from [], so "no buyer
  // organisations exist" is never shown before a load has actually succeeded.
  const [orgs, setOrgs] = useState<BuyerOrgRow[] | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [orgMode, setOrgMode] = useState<'existing' | 'new'>('new')
  const [organisationId, setOrganisationId] = useState('')
  const [legalName, setLegalName] = useState('')
  const [orgDisplayName, setOrgDisplayName] = useState('')
  const [countryCode, setCountryCode] = useState('')
  const [orgRole, setOrgRole] = useState<(typeof ORG_ROLES)[number]>('owner')

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<InviteBuyerResult | null>(null)

  useEffect(() => {
    let active = true
    // Same guarded-load idiom as the other admin pages: a slow first fetch must
    // not land on top of a newer one after the operator hits Refresh.
    void runGuardedLoad(
      loadBuyerOrganisations(),
      () => active,
      {
        onSuccess: rows => {
          setOrgs(rows)
          setLoadState('ready')
          setLoadError(null)
        },
        onError: err => {
          // A failed load is reported as failed. It is NOT rendered as an empty
          // list — "you have no buyer organisations" and "we could not find
          // out" are different statements and only one of them is true.
          setLoadState('failed')
          setLoadError(err instanceof Error ? err.message : 'The buyer organisations could not be loaded.')
        },
      },
    )
    return () => { active = false }
  }, [reloadToken])

  const refresh = useCallback(() => setReloadToken(t => t + 1), [])

  const submit = useCallback(async () => {
    setBusy(true)
    setResult(null)
    try {
      const outcome = await inviteBuyer({
        email: email.trim(),
        displayName: displayName.trim() || undefined,
        phoneNumber: phoneNumber.trim() || undefined,
        orgRole,
        ...(orgMode === 'existing'
          ? { organisationId: organisationId.trim() || undefined }
          : {
              legalName: legalName.trim() || undefined,
              organisationDisplayName: orgDisplayName.trim() || undefined,
              countryCode: countryCode.trim() || undefined,
            }),
      })
      setResult(outcome)
      if (outcome.ok) {
        // Clear only the person, not the organisation: onboarding a second
        // contact at the same buyer is the common next action.
        setEmail('')
        setDisplayName('')
        setPhoneNumber('')
        if (orgMode === 'new') {
          // The organisation now exists — switch to it rather than offering to
          // create a duplicate on the next submission.
          setOrgMode('existing')
          setOrganisationId(outcome.organisationId)
          setLegalName('')
          setOrgDisplayName('')
          setCountryCode('')
        }
        refresh()
      } else if (outcome.organisationId) {
        // A partial failure that already created the organisation. Point the
        // form at it so a retry cannot create a second one.
        setOrgMode('existing')
        setOrganisationId(outcome.organisationId)
      }
    } finally {
      setBusy(false)
    }
  }, [email, displayName, phoneNumber, orgRole, orgMode, organisationId, legalName, orgDisplayName, countryCode, refresh])

  return (
    <div className="page">
      <h2>Onboard a buyer</h2>
      <p className="muted">
        Buyers are provisioned by DDP only — there is no buyer self-registration. The invitation
        email sends the buyer to set a password, after which they sign in to their own dashboard.
      </p>

      <form
        className="card"
        style={{ padding: 16, display: 'grid', gap: 12, maxWidth: 640 }}
        onSubmit={e => { e.preventDefault(); void submit() }}
      >
        <div>
          <label htmlFor="buyer-email">Buyer email</label>
          <input
            id="buyer-email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={e => setEmail(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        <div>
          <label htmlFor="buyer-name">Contact name (optional)</label>
          <input
            id="buyer-name"
            type="text"
            maxLength={120}
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        <div>
          <label htmlFor="buyer-phone">Phone (optional)</label>
          <input
            id="buyer-phone"
            type="tel"
            maxLength={32}
            value={phoneNumber}
            onChange={e => setPhoneNumber(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        <fieldset style={{ border: '1px solid var(--border, #ccc)', padding: 12 }}>
          <legend>Organisation</legend>

          <label style={{ display: 'block', marginBottom: 8 }}>
            <input
              type="radio"
              name="org-mode"
              checked={orgMode === 'new'}
              onChange={() => setOrgMode('new')}
            />{' '}
            Create a new buyer organisation
          </label>

          {orgMode === 'new' && (
            <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
              <div>
                <label htmlFor="org-legal">Legal name</label>
                <input
                  id="org-legal"
                  type="text"
                  maxLength={200}
                  value={legalName}
                  onChange={e => setLegalName(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label htmlFor="org-display">Trading name (optional)</label>
                <input
                  id="org-display"
                  type="text"
                  maxLength={120}
                  value={orgDisplayName}
                  onChange={e => setOrgDisplayName(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label htmlFor="org-country">Country code</label>
                <input
                  id="org-country"
                  type="text"
                  maxLength={2}
                  placeholder="e.g. DE"
                  value={countryCode}
                  onChange={e => setCountryCode(e.target.value)}
                  style={{ width: 120 }}
                />
                {/* Said here because the database CHECK is case-sensitive and
                    the server uppercases for you — a form that silently
                    accepted 'de' and then failed would be stating a rule it
                    never made. */}
                <span className="muted" style={{ marginLeft: 8 }}>
                  Two letters. Lower case is accepted and stored upper case.
                </span>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
                New organisations are created <strong>unverified</strong>. Verification is a separate,
                recorded decision.
              </p>
            </div>
          )}

          <label style={{ display: 'block', marginBottom: 8 }}>
            <input
              type="radio"
              name="org-mode"
              checked={orgMode === 'existing'}
              onChange={() => setOrgMode('existing')}
              disabled={loadState !== 'ready' || (orgs?.length ?? 0) === 0}
            />{' '}
            Add to an existing buyer organisation
          </label>

          {orgMode === 'existing' && (
            <div>
              <label htmlFor="org-existing">Organisation</label>
              <select
                id="org-existing"
                value={organisationId}
                onChange={e => setOrganisationId(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">— select —</option>
                {(orgs ?? []).map(o => (
                  <option key={o.id} value={o.id}>
                    {o.legalName}{o.displayName ? ` (${o.displayName})` : ''} · {o.countryCode} · {o.verificationState}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label htmlFor="org-role">Role within the organisation</label>
            <select
              id="org-role"
              value={orgRole}
              onChange={e => setOrgRole(e.target.value as (typeof ORG_ROLES)[number])}
              style={{ width: 200 }}
            >
              {ORG_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </fieldset>

        <div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating account…' : 'Invite & create buyer account'}
          </button>
        </div>
      </form>

      {result && !result.ok && (
        <div role="alert" className="notice notice-error" style={{ marginTop: 16, maxWidth: 640 }}>
          <p style={{ marginTop: 0 }}>{result.error}</p>
          {/* The ids are shown, not hidden, because every partial failure here
              is recoverable BY ID and the admin is the one who has to do it. */}
          {(result.userId || result.organisationId) && (
            <p className="muted" style={{ marginBottom: 0, fontFamily: 'monospace', fontSize: '0.8em' }}>
              {result.organisationId && <>organisationId: {result.organisationId}<br /></>}
              {result.userId && <>userId: {result.userId}</>}
            </p>
          )}
        </div>
      )}

      {result?.ok && (
        <div role="status" className="notice" style={{ marginTop: 16, maxWidth: 640 }}>
          Buyer invited. They will receive an email to set a password, then sign in to their
          own dashboard.
          <span className="muted" style={{ display: 'block', fontFamily: 'monospace', fontSize: '0.8em' }}>
            userId: {result.userId}<br />
            organisationId: {result.organisationId}{result.organisationCreated ? ' (created)' : ''}
          </span>
        </div>
      )}

      <h3 style={{ marginTop: 32 }}>Buyer organisations</h3>
      <div style={{ marginBottom: 12 }}>
        <button type="button" onClick={refresh}>Refresh</button>
      </div>

      {loadState === 'loading' && <p className="muted">Loading…</p>}

      {loadState === 'failed' && (
        <div role="alert" className="notice notice-error">
          {loadError}
        </div>
      )}

      {loadState === 'ready' && (orgs?.length ?? 0) === 0 && (
        <p className="muted">No buyer organisations yet. The form above creates the first one.</p>
      )}

      {loadState === 'ready' && (orgs?.length ?? 0) > 0 && (
        <table>
          <thead>
            <tr>
              <th>Legal name</th><th>Trading name</th><th>Country</th><th>Verification</th><th>Members</th>
            </tr>
          </thead>
          <tbody>
            {(orgs ?? []).map(o => (
              <tr key={o.id}>
                <td>{o.legalName}</td>
                <td>{o.displayName ?? '—'}</td>
                <td>{o.countryCode}</td>
                <td>{o.verificationState}</td>
                <td>{o.memberCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
