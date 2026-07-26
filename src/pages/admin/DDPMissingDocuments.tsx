import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ComplianceAlert, ComplianceRule, DocumentRequirementType, EvidenceStatus, FarmProfile, InventoryItem } from '../../types'
import {
  DOCUMENT_REQUIREMENT_TYPES,
  DOCUMENT_REQUIREMENT_LABELS,
  deriveFarmDocumentRequirements,
} from '../../lib/procurementControl'
import {
  resolveRequirementOverrides,
  recordRequirementOverride,
  requirementKey,
  isEffectiveOverride,
  type BatchOverrideResolution,
  type ResolvedRequirementOverride,
} from '../../lib/procurementOverrideStore'
import BrowserOnlyProvenanceNotice from '../../components/shared/BrowserOnlyProvenanceNotice'
import { getComplianceRuleImpact } from '../../lib/complianceRuleImpact'
import { ComplianceRuleCheckBadge } from '../../components/shared/StatusBadge'

interface Props {
  farms: FarmProfile[]
  inventory: InventoryItem[]
  complianceRules?: ComplianceRule[]
  complianceAlerts?: ComplianceAlert[]
}

// The matrix uses its own six-word vocabulary (per the procurement plan) —
// distinct from, but derived from, the underlying EvidenceStatus.
type MatrixLabel = 'Received' | 'Partial' | 'Missing' | 'Reviewed' | 'Verified' | 'Blocker'

const MATRIX_LABEL: Record<EvidenceStatus, MatrixLabel> = {
  claimed: 'Partial',
  documented: 'Received',
  reviewed: 'Reviewed',
  verified: 'Verified',
  missing: 'Missing',
  rejected: 'Blocker',
  expired: 'Blocker',
}

const MATRIX_CLASS: Record<MatrixLabel, string> = {
  Received: 'status-documented',
  Partial: 'status-claimed',
  Missing: 'status-missing',
  Reviewed: 'status-reviewed',
  Verified: 'status-verified',
  Blocker: 'status-reject',
}

const OVERRIDE_OPTIONS: EvidenceStatus[] = ['claimed', 'documented', 'reviewed', 'verified', 'missing', 'rejected', 'expired']

const OVERRIDE_LABEL: Record<EvidenceStatus, string> = {
  claimed: 'Claimed',
  documented: 'Documented',
  reviewed: 'Reviewed',
  verified: 'Verified',
  missing: 'Missing',
  rejected: 'Rejected',
  expired: 'Expired',
}

/**
 * One override in the act of being recorded. A select change only PROPOSES a
 * status — nothing is written, and the displayed pill does not move, until the
 * operator supplies the reason the audit record requires and confirms. The
 * store (and the DB CHECK behind it) refuses a reasonless override, and a
 * fabricated placeholder reason would be worse than no override at all, so the
 * reason must come from the operator, at the moment of the decision.
 *
 * Held as a SINGLE pending cell rather than a reason input per cell: this page
 * renders 13 requirement types per farm, and a permanent textarea in every cell
 * would bury the matrix. The reason UI appears inline, only under the one cell
 * being changed — mirroring the buyer-pack decision panel's select + required
 * textarea + confirm shape, which is the established pattern for this exact
 * kind of audited write.
 */
interface PendingOverride {
  farmId: string
  type: DocumentRequirementType
  status: EvidenceStatus
  reason: string
}

export default function DDPMissingDocuments({ farms, inventory, complianceRules = [], complianceAlerts = [] }: Props) {
  const [openFarmId, setOpenFarmId] = useState<string | null>(null)

  // Stable primitive dep: the resolve must re-run when the SET of farm ids
  // changes, not on every re-render that rebuilds an equal array.
  const farmKey = farms.map(f => f.id).join(' ')

  // null = the authoritative read has not settled. The resolution is stored
  // WITH the farm set it was read for, and staleness is DERIVED rather than
  // reset inside the effect (same shape as the Qualified Buyer Preview list).
  // A changed farm set therefore reads as 'loading' in the very same render
  // that changed it — there is no window in which the previous set's overrides
  // are applied to this one.
  const [resolvedOverrides, setResolvedOverrides] = useState<{ key: string; value: BatchOverrideResolution<ResolvedRequirementOverride> } | null>(null)
  const resolution = resolvedOverrides !== null && resolvedOverrides.key === farmKey ? resolvedOverrides.value : null

  // SERVER WINS. Overrides used to be written straight to localStorage in
  // Supabase mode too — invisible to other admins, unattributed, wiped by
  // sign-out (audit F2b). They are now batch-resolved from the authoritative
  // store in ONE round trip for the whole farm set, not an N+1 per cell.
  useEffect(() => {
    let cancelled = false
    void resolveRequirementOverrides(farmKey === '' ? [] : farmKey.split(' ')).then(
      next => { if (!cancelled) setResolvedOverrides({ key: farmKey, value: next }) },
      (err: unknown) => {
        if (cancelled) return
        // resolveRequirementOverrides reports read failures in-band; this is
        // the belt-and-braces path for an unexpected throw. Fail closed
        // identically.
        const message = err instanceof Error ? err.message : 'The requirement overrides could not be read.'
        setResolvedOverrides({ key: farmKey, value: { byKey: new Map(), unavailable: true, error: message } })
      },
    )
    return () => { cancelled = true }
  }, [farmKey])

  // Three distinct states, branched on `unavailable` — NEVER on map membership:
  // a failed batch read returns an EMPTY byKey with unavailable: true, so "not
  // in the map" is indistinguishable from "no override" and must not be used to
  // detect failure. Only 'resolved' may present overrides as in effect.
  const overrideState: 'loading' | 'unavailable' | 'resolved' =
    resolution === null ? 'loading' : resolution.unavailable ? 'unavailable' : 'resolved'

  const [pending, setPending] = useState<PendingOverride | null>(null)
  const [saving, setSaving] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)

  const rows = useMemo(() => {
    return farms.map(farm => {
      const derived = deriveFarmDocumentRequirements(farm, inventory)
      // FAIL CLOSED. Overrides are applied only from a settled, successful
      // authoritative read. While loading — and above all when the read FAILED
      // — the matrix shows the DERIVED statuses untouched, because an override
      // is a clearance and a clearance whose server state could not be read
      // must not move a requirement off Missing/Blocker (or onto Verified).
      const requirements = resolution === null || resolution.unavailable
        ? derived
        : derived.map(req => {
            const override = resolution.byKey.get(requirementKey(req.farmId, req.type))
            if (!override || override.status === null || !isEffectiveOverride(override.source)) return req
            return { ...req, status: override.status, notes: override.notes ?? req.notes }
          })
      const blockerCount = requirements.filter(r => MATRIX_LABEL[r.status] === 'Blocker').length
      const missingCount = requirements.filter(r => r.status === 'missing').length
      const receivedCount = requirements.filter(r => r.status === 'documented' || r.status === 'reviewed' || r.status === 'verified').length
      return { farm, requirements, blockerCount, missingCount, receivedCount }
    })
  }, [farms, inventory, resolution])

  // How many requirements ON THIS PAGE are showing an override that exists only
  // in this browser — i.e. source === 'local-cache'. Server-recorded overrides
  // are durable and attributed, so warning about them would be false; and on a
  // failed read the count is 0 because nothing browser-local is being APPLIED
  // (the fail-closed branch above shows derived statuses only). Counted against
  // the live (farmId, type) pairs, so an override for a farm no longer listed
  // is not counted.
  const overriddenCount = useMemo(() => {
    if (resolution === null || resolution.unavailable) return 0
    return rows.reduce(
      (total, row) =>
        total + row.requirements.filter(r => resolution.byKey.get(requirementKey(r.farmId, r.type))?.source === 'local-cache').length,
      0,
    )
  }, [rows, resolution])

  function handleSelectStatus(farmId: string, type: DocumentRequirementType, status: EvidenceStatus) {
    setWriteError(null)
    // Re-selecting on the already-pending cell keeps the typed reason — losing
    // it on a status correction would punish careful operators. Any other cell
    // starts a fresh pending override with a deliberately BLANK reason.
    setPending(prev =>
      prev && prev.farmId === farmId && prev.type === type
        ? { ...prev, status }
        : { farmId, type, status, reason: '' },
    )
  }

  // The override is now recorded through the server-authoritative store
  // (append-only, actor captured from auth.uid()); localStorage is only the
  // store's own cache. A refused write caches NOTHING, so the matrix can never
  // present a status the server rejected as applied.
  async function handleRecordOverride() {
    if (!pending || saving) return
    const reason = pending.reason.trim()
    if (!reason) return // belt-and-braces; the button is disabled until a reason is supplied
    setSaving(true)
    setWriteError(null)

    // The whole sequence is guarded and `saving` is released in `finally`.
    // recordRequirementOverride reports refusals in-band (ok: false), but it can
    // still REJECT — localStorage throwing while refreshing the cache, or any
    // unexpected client/network exception. Releasing `saving` only on the in-band
    // paths left every override control permanently disabled on a rejection, and
    // produced an unhandled rejection alongside it.
    try {
      const result = await recordRequirementOverride({
        farmId: pending.farmId,
        type: pending.type,
        status: pending.status,
        reason,
      })

      if (!result.ok) {
        // The server REFUSED the write. The pending cell stays open (reason
        // intact) so the operator can retry; the displayed pill still shows the
        // authoritative status, never the attempted one.
        setWriteError(result.error ?? 'The override could not be recorded.')
        return
      }

      // Accepted (server) or deliberately local (table absent / demo mode).
      // Re-resolve so the displayed statuses and the provenance count come from
      // the authoritative source, never from a value this function assumed.
      const next = await resolveRequirementOverrides(farmKey === '' ? [] : farmKey.split(' '))
      setResolvedOverrides({ key: farmKey, value: next })
      setPending(null)
    } catch (err: unknown) {
      // The pending cell is kept so the operator can retry. The displayed pill
      // is untouched — it is only ever rendered from the resolution — so a write
      // whose outcome is unknown cannot appear applied.
      setWriteError(err instanceof Error ? err.message : 'The override could not be recorded.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — PROCUREMENT AUTHORITY</div>
        <h1 className="page-title">Missing Document Matrix</h1>
        <p className="page-desc">
          Every required document or evidence item, per farm, labelled by evidence level — not by whether a field was typed in.
        </p>
      </div>

      <div className="disclaimer-box">
        <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>NOTE</span>
        <div>
          Most farm-level fields are free-text claims, not uploaded files. They can only read as <strong>Partial</strong> (claimed) or <strong>Missing</strong> here
          until a real document is received. <strong>Reviewed</strong> and <strong>Verified</strong> only appear once a DDP reviewer or qualified party has explicitly recorded that step below.
        </div>
      </div>

      {/* Provenance. A requirement moved to Rejected/Expired here is half of the
          release gate (blockerRequirements), and moving one OFF those statuses
          clears a blocker. The count covers only overrides whose source is the
          browser cache — server-recorded ones are durable and attributed. */}
      <BrowserOnlyProvenanceNotice count={overriddenCount} subject="document status overrides" />

      {/* The authoritative read has not settled. Says nothing about overrides
          yet, so nothing below may be read as their absence. */}
      {overrideState === 'loading' && farms.length > 0 && (
        <div className="card" style={{ marginTop: 12, padding: '10px 14px', fontSize: 12.5, color: 'var(--text-muted)' }}>
          Checking the recorded document status overrides for these farms… Statuses below are the derived ones until the check settles.
        </div>
      )}

      {/* The authoritative read FAILED. This is not "no overrides" — it is
          unknown, and the matrix must say so rather than quietly rendering the
          derived picture as if it were the whole truth. */}
      {overrideState === 'unavailable' && (
        <div className="card" style={{ marginTop: 12, padding: '10px 14px', fontSize: 12.5, color: 'var(--warning)' }}>
          ⚠ The document status overrides could not be verified against the server, so any recorded
          overrides are <strong>unknown</strong>. This is <strong>not</strong> a statement that none exist.
          The statuses and the Received / Missing / Blockers counts below are the <strong>derived</strong> ones
          only and are not authoritative. Recording an override is still permitted, but it will be
          applied without a verified baseline.
          {resolution?.error ? ` (${resolution.error})` : ''}
        </div>
      )}

      {farms.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>No farm profiles on file.</div>
      ) : (
        <div className="card table-card" style={{ marginTop: 20 }}>
          <div className="table-scroll">
            <table className="inv-table inv-table--compact">
              <thead>
                <tr>
                  <th>Farm</th>
                  <th>Received</th>
                  <th>Missing</th>
                  <th>Blockers</th>
                  <th>Compliance Rule Check</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ farm, blockerCount, missingCount, receivedCount, requirements }) => {
                  const ruleImpact = getComplianceRuleImpact('farm', farm.id, complianceRules, complianceAlerts)
                  return (
                  <Fragment key={farm.id}>
                    <tr>
                      <td className="td-bold">{farm.tradingName}</td>
                      <td className="td-num">{receivedCount}/{DOCUMENT_REQUIREMENT_TYPES.length}</td>
                      <td className="td-num">{missingCount > 0 ? <span className="status-pill status-missing">{missingCount}</span> : '—'}</td>
                      <td className="td-num">{blockerCount > 0 ? <span className="status-pill status-reject">{blockerCount}</span> : '—'}</td>
                      <td data-label="Compliance Rule Check"><ComplianceRuleCheckBadge impact={ruleImpact} /></td>
                      <td>
                        <button className="btn btn-review" onClick={() => setOpenFarmId(openFarmId === farm.id ? null : farm.id)}>
                          {openFarmId === farm.id ? 'Close' : 'Open Matrix'}
                        </button>
                      </td>
                    </tr>
                    {openFarmId === farm.id && (
                      <tr>
                        <td colSpan={6} style={{ padding: 0, background: 'var(--bg-elevated)' }}>
                          <div style={{ padding: '16px 20px' }}>
                            <div className="detail-rows">
                              {requirements.map(req => {
                                const isPendingCell = pending !== null && pending.farmId === farm.id && pending.type === req.type
                                return (
                                <div className="detail-row" key={req.type} style={{ alignItems: 'flex-start' }}>
                                  <span className="dl">{DOCUMENT_REQUIREMENT_LABELS[req.type]}</span>
                                  <span className="dv" style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                                    <span className={`status-pill ${MATRIX_CLASS[MATRIX_LABEL[req.status]]}`}>{MATRIX_LABEL[req.status]}</span>
                                    {req.reference && <span className="td-muted" style={{ fontSize: 11.5 }}>{req.reference}</span>}
                                    {req.notes && <span className="td-muted" style={{ fontSize: 11.5, maxWidth: 320, textAlign: 'right' }}>{req.notes}</span>}
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
                                      Override:
                                      {/* Fail-closed governs DISPLAY, not input. When the
                                          authoritative state is unread or unreadable the banner
                                          above and this control's title say the shown status is
                                          unverified — but the operator is not locked out. The
                                          write is an absolute set against the server, not a delta
                                          off this baseline, and it re-resolves afterwards. */}
                                      <select
                                        value={isPendingCell ? pending.status : req.status}
                                        disabled={saving}
                                        title={overrideState === 'resolved' ? undefined : 'The recorded override state has not been read, so the status shown may not be the recorded one.'}
                                        onChange={e => handleSelectStatus(farm.id, req.type, e.target.value as EvidenceStatus)}
                                        style={{ fontSize: 12 }}
                                      >
                                        {OVERRIDE_OPTIONS.map(o => <option key={o} value={o}>{OVERRIDE_LABEL[o]}</option>)}
                                      </select>
                                    </label>
                                    {isPendingCell && (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', width: '100%', maxWidth: 360 }}>
                                        {/* An override without a stated reason is not an audit
                                            record. The server CHECK enforces this too; the button
                                            is disabled until it is supplied so the operator is
                                            never surprised by a rejection. */}
                                        <textarea
                                          value={pending.reason}
                                          onChange={e => setPending(prev => (prev ? { ...prev, reason: e.target.value } : prev))}
                                          placeholder="Reason for this override (required — recorded in the audit trail)"
                                          rows={2}
                                          style={{ width: '100%', fontSize: 12.5 }}
                                        />
                                        <div style={{ display: 'flex', gap: 8 }}>
                                          <button
                                            type="button"
                                            className="btn btn-ghost"
                                            onClick={() => { setPending(null); setWriteError(null) }}
                                            disabled={saving}
                                          >
                                            Cancel
                                          </button>
                                          <button
                                            type="button"
                                            className="btn btn-review"
                                            onClick={() => { void handleRecordOverride() }}
                                            disabled={!pending.reason.trim() || saving}
                                          >
                                            {saving ? 'Recording…' : 'Record Override'}
                                          </button>
                                        </div>
                                        {writeError && (
                                          <div style={{ fontSize: 12, color: 'var(--danger, #b00020)', textAlign: 'right' }}>{writeError}</div>
                                        )}
                                      </div>
                                    )}
                                  </span>
                                </div>
                                )
                              })}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
