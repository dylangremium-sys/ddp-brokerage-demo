import { useState } from 'react'
import type { FarmProfile, InventoryItem, InventoryStatus, ReviewRequest } from '../../types'
import { deriveComplianceTier, COMPLIANCE_TIER_LABEL } from '../../data'
import { DocumentCard } from '../../components/shared/DocumentCard'

type RequestType = ReviewRequest['requestType']

const REQUEST_TYPES: { key: RequestType; label: string }[] = [
  { key: 'coa',          label: 'Upload COA' },
  { key: 'photo',        label: 'Add Photos' },
  { key: 'quantity',     label: 'Confirm Quantity' },
  { key: 'price',        label: 'Revise Price' },
  { key: 'batch_number', label: 'Add Batch Number' },
  { key: 'licence',      label: 'Upload Licence' },
  { key: 'general',      label: 'General Request' },
]

interface Props {
  item: InventoryItem
  farm: FarmProfile | undefined
  onBack: () => void
  onAction: (itemId: string, action: string) => void
  onSendRequest?: (req: Omit<ReviewRequest, 'id' | 'createdAt'>) => void
  onGetCoaUrl?: (storagePath: string) => Promise<string | null>
  onSaveNote?: (itemId: string, note: string) => void
}

const STATUS_CLASS: Record<InventoryStatus, string> = {
  'Pending Review': 'badge-pending',
  'Approved': 'badge-approved',
  'Missing Document': 'badge-missing',
  'Rejected': 'badge-rejected',
}

function CheckRow({ label, pass }: { label: string; pass: boolean }) {
  return (
    <div className={`checklist-row ${pass ? 'check-pass' : 'check-fail'}`}>
      <span className="check-icon">{pass ? '✓' : '✗'}</span>
      <span>{label}</span>
    </div>
  )
}

export default function DDPInventoryReview({ item, farm, onBack, onAction, onSendRequest, onGetCoaUrl, onSaveNote }: Props) {
  const [reqType, setReqType] = useState<RequestType>('general')
  const [reqMsg, setReqMsg] = useState('')
  const [reqSent, setReqSent] = useState(false)
  const [coaLoading, setCoaLoading] = useState(false)
  const [note, setNote] = useState(item.ownerNotes ?? '')
  const [noteSaved, setNoteSaved] = useState(false)
  const hasCoaOnFile = !!(item.certFileName || item.coaStoragePath)

  function handleSaveNote() {
    if (!onSaveNote) return
    onSaveNote(item.id, note.trim())
    setNoteSaved(true)
    setTimeout(() => setNoteSaved(false), 2500)
  }

  async function handleViewCoa() {
    if (!onGetCoaUrl || !item.coaStoragePath) return
    setCoaLoading(true)
    const url = await onGetCoaUrl(item.coaStoragePath)
    setCoaLoading(false)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  function handleSendRequest() {
    if (!reqMsg.trim() || !onSendRequest) return
    onSendRequest({
      stockItemId: item.id,
      requestType: reqType,
      message: reqMsg.trim(),
      status: 'open',
      createdBy: 'DDP Admin',
      productName: item.productName,
      farmName: item.farmName,
    })
    setReqMsg('')
    setReqSent(true)
    setTimeout(() => setReqSent(false), 3000)
  }
  const checks = [
    { label: 'Farm profile submitted', pass: !!farm },
    { label: 'Farmer details complete', pass: !!(item.farmerName && item.farmName && item.location) },
    { label: 'Batch number supplied', pass: !!item.batchNumber },
    { label: 'COA supplied', pass: !!item.certFileName },
    { label: 'THC recorded', pass: item.thcPct != null },
    { label: 'CBD recorded', pass: item.cbdPct > 0 },
    { label: 'Moisture recorded', pass: item.moisturePct > 0 },
    { label: 'Water activity recorded', pass: !!item.waterActivity },
    { label: 'Product photo supplied', pass: !!item.photoUrl },
    { label: 'Storage conditions supplied', pass: !!item.storageConditions },
  ]
  const passCount = checks.filter(c => c.pass).length

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header review-page-header">
        <div>
          <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — BATCH REVIEW</div>
          <h1 className="page-title">{item.productName || 'Unnamed batch'}</h1>
          <p className="page-desc">{item.farmName} · {item.location}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onBack}>← Back to Inventory Dashboard</button>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className={`badge ${STATUS_CLASS[item.status]}`}>{item.status}</span>
            {item.clientVisible && (
              <span className="badge badge-blue">Buyer Visible</span>
            )}
          </div>
        </div>
      </div>

      <div className="review-layout">
        <div className="review-main">
          <div className="card review-card">
            {farm && (
              <div className="detail-block">
                <div className="detail-block-title">Farm Profile</div>
                <div className="detail-rows">
                  <div className="detail-row"><span className="dl">Farm</span><span className="dv">{farm.tradingName}</span></div>
                  <div className="detail-row"><span className="dl">Province</span><span className="dv">{farm.province}</span></div>
                  <div className="detail-row"><span className="dl">Farm Status</span><span className="dv"><span className={`badge badge-sm`}>{farm.status}</span></span></div>
                  <div className="detail-row"><span className="dl">Compliance Tier</span><span className="dv">{COMPLIANCE_TIER_LABEL[deriveComplianceTier(farm, [item])]}</span></div>
                  <div className="detail-row"><span className="dl">Profile Completion</span><span className="dv">{farm.completionPct}%</span></div>
                </div>
              </div>
            )}

            <div className="detail-block">
              <div className="detail-block-title">Product Details</div>
              <div className="detail-rows">
                <div className="detail-row"><span className="dl">Product</span><span className="dv">{item.productName || 'Unnamed batch'}</span></div>
                <div className="detail-row"><span className="dl">Farmer</span><span className="dv">{item.farmerName}</span></div>
                <div className="detail-row"><span className="dl">Farm Name</span><span className="dv">{item.farmName}</span></div>
                <div className="detail-row"><span className="dl">Location</span><span className="dv">{item.location}</span></div>
                <div className="detail-row"><span className="dl">Quantity</span><span className="dv">{item.quantityKg.toLocaleString()} kg</span></div>
                <div className="detail-row"><span className="dl">Quality Grade</span><span className="dv"><span className="grade-chip">Grade {item.qualityGrade}</span></span></div>
                <div className="detail-row"><span className="dl">Price per kg</span><span className="dv">฿{item.pricePerKg}</span></div>
                <div className="detail-row"><span className="dl">Harvest Date</span><span className="dv">{item.harvestDate || '—'}</span></div>
                <div className="detail-row"><span className="dl">Cure Date</span><span className="dv">{item.cureDate || '—'}</span></div>
              </div>
            </div>

            <div className="detail-block">
              <div className="detail-block-title">Batch & Lab Values</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-4px 0 10px' }}>
                Farmer-entered — typed by the supplier from their COA, not yet independently checked by DDP.
                Compare these figures against the uploaded COA before approving.
              </p>
              <div className="detail-rows">
                <div className="detail-row"><span className="dl">Batch Number</span><span className="dv mono">{item.batchNumber || '—'}</span></div>
                <div className="detail-row"><span className="dl">THC %</span><span className="dv">{item.thcPct != null ? `${item.thcPct}%` : <span className="text-missing">Not recorded</span>}</span></div>
                <div className="detail-row"><span className="dl">CBD %</span><span className="dv">{item.cbdPct > 0 ? `${item.cbdPct}%` : <span className="text-missing">Not recorded</span>}</span></div>
                <div className="detail-row"><span className="dl">Moisture %</span><span className="dv">{item.moisturePct > 0 ? `${item.moisturePct}%` : <span className="text-missing">Not recorded</span>}</span></div>
                <div className="detail-row"><span className="dl">Water Activity</span><span className="dv">{item.waterActivity || <span className="text-missing">Not recorded</span>}</span></div>
              </div>
            </div>

            <div className="detail-block">
              <div className="detail-block-title">Documents</div>
              <div className="detail-rows">
                <div className="detail-row">
                  <span className="dl">COA / Certificate</span>
                  <span className="dv">
                    <DocumentCard
                      hasFile={!!(item.certFileName || item.coaStoragePath)}
                      fileName={item.certFileName}
                      openable={!!(item.coaStoragePath && onGetCoaUrl)}
                      loading={coaLoading}
                      onOpen={handleViewCoa}
                      missingText="COA missing"
                    />
                  </span>
                </div>
                <div className="detail-row">
                  <span className="dl">Product Photo</span>
                  <span className="dv">
                    {item.photoUrl
                      ? <a href={item.photoUrl} target="_blank" rel="noreferrer">View Photo</a>
                      : <span className="text-muted">Not provided</span>}
                  </span>
                </div>
              </div>
            </div>

            {item.photoUrl && (
              <div className="detail-block">
                <div className="detail-block-title">Photo Preview</div>
                <img src={item.photoUrl} alt="Product" loading="lazy" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)' }} />
              </div>
            )}

            {(item.photoUrls?.length ?? 0) > 0 && (
              <div className="detail-block">
                <div className="detail-block-title">Photos ({item.photoUrls!.length})</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {item.photoUrls!.map((url, i) => (
                    <img key={i} src={url} alt={`Batch photo ${i + 1} of ${item.photoUrls!.length}`} loading="lazy" style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                  ))}
                </div>
              </div>
            )}

            <div className="detail-block">
              <div className="detail-block-title">Storage & Notes</div>
              <div className="detail-rows">
                <div className="detail-row"><span className="dl">Storage Conditions</span><span className="dv">{item.storageConditions || <span className="text-muted">—</span>}</span></div>
              </div>
              {item.farmerNotes && <p className="notes-body" style={{ marginTop: 12 }}><strong>Farmer:</strong> {item.farmerNotes}</p>}
              {item.notes && !item.farmerNotes && <p className="notes-body" style={{ marginTop: 12 }}>{item.notes}</p>}
              {item.ownerNotes && <p className="notes-body" style={{ marginTop: 12, borderLeft: '2px solid var(--accent)' }}><strong>Internal:</strong> {item.ownerNotes}</p>}
            </div>

          </div>
        </div>

        <div className="review-sidebar">
          <div className="card ledger-card">
            <div className="ledger-scroll">
              {(item.heavyMetalsStatus || item.pesticidesStatus || item.microbialStatus || item.mycotoxinsStatus) && (
                <div className="detail-block">
                  <div className="detail-block-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    COA Test Results
                    <span className={`badge badge-sm ${hasCoaOnFile ? 'badge-pending' : 'badge-missing'}`}>
                      {hasCoaOnFile ? 'COA uploaded — pending DDP check' : 'No COA on file'}
                    </span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-2px 0 10px' }}>
                    Farmer-entered from their COA. Open the COA above and confirm these figures match before relying on them.
                  </p>
                  <div className="detail-rows">
                    {item.labName && <div className="detail-row"><span className="dl">Lab</span><span className="dv">{item.labName}</span></div>}
                    {item.reportNumber && <div className="detail-row"><span className="dl">Report #</span><span className="dv mono">{item.reportNumber}</span></div>}
                    {item.testDate && <div className="detail-row"><span className="dl">Test Date</span><span className="dv">{item.testDate}</span></div>}
                    {item.heavyMetalsStatus && <div className="detail-row"><span className="dl">Heavy Metals</span><span className={`dv ${item.heavyMetalsStatus === 'pass' ? 'check-yes' : item.heavyMetalsStatus === 'fail' ? 'check-no' : ''}`}>{item.heavyMetalsStatus}</span></div>}
                    {item.pesticidesStatus && <div className="detail-row"><span className="dl">Pesticides</span><span className={`dv ${item.pesticidesStatus === 'pass' ? 'check-yes' : item.pesticidesStatus === 'fail' ? 'check-no' : ''}`}>{item.pesticidesStatus}</span></div>}
                    {item.microbialStatus && <div className="detail-row"><span className="dl">Microbial</span><span className={`dv ${item.microbialStatus === 'pass' ? 'check-yes' : item.microbialStatus === 'fail' ? 'check-no' : ''}`}>{item.microbialStatus}</span></div>}
                    {item.mycotoxinsStatus && <div className="detail-row"><span className="dl">Mycotoxins</span><span className={`dv ${item.mycotoxinsStatus === 'pass' ? 'check-yes' : item.mycotoxinsStatus === 'fail' ? 'check-no' : ''}`}>{item.mycotoxinsStatus}</span></div>}
                  </div>
                </div>
              )}

              {onSaveNote && (
                <div className="detail-block">
                  <div className="detail-block-title">Internal Note</div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-2px 0 10px' }}>
                    Once you've compared the typed values against the uploaded COA, record it here — e.g. "COA checked against typed values."
                  </p>
                  <textarea
                    rows={3}
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="COA checked against typed values."
                    style={{ width: '100%', fontSize: 13 }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ marginTop: 8, fontSize: 13 }}
                    onClick={handleSaveNote}
                  >
                    {noteSaved ? '✓ Note saved' : 'Save Note'}
                  </button>
                </div>
              )}

              <div className="detail-block" style={{ borderBottom: 'none' }}>
                <div className="detail-block-title">Batch Compliance Checklist — {passCount}/{checks.length} checks passed</div>
                <div className="compliance-checklist">
                  {checks.map((c, i) => <CheckRow key={i} label={c.label} pass={c.pass} />)}
                </div>
              </div>
            </div>
          </div>

          <div className="card decision-card sidebar-sticky">
            <div className="decision-title">Review Decision</div>
            <p className="decision-desc">Select an action to update this batch status. The supplier will see this change immediately.</p>
            <button className="btn btn-approve" onClick={() => onAction(item.id, 'approve')}>Approve Batch</button>
            <button className="btn btn-missing" onClick={() => onAction(item.id, 'missing')}>Request Missing Document</button>
            <button className="btn btn-reject" onClick={() => onAction(item.id, 'reject')}>Reject Batch</button>

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 }}>
              <div className="decision-title" style={{ fontSize: 13 }}>Client Visibility</div>
              <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
                Only approved batches should be made buyer-visible.
              </p>
              {item.clientVisible ? (
                <button
                  className="btn"
                  style={{ background: 'rgba(46,139,103,0.12)', color: 'var(--success)', border: '1px solid rgba(46,139,103,0.35)', width: '100%', fontSize: 13, marginBottom: 0 }}
                  onClick={() => onAction(item.id, 'client-hide')}
                >
                  Hide from Buyers
                </button>
              ) : (
                <button
                  className="btn"
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--border)', width: '100%', fontSize: 13 }}
                  onClick={() => onAction(item.id, 'client-visible')}
                  disabled={item.status !== 'Approved'}
                  title={item.status !== 'Approved' ? 'Approve the batch first' : ''}
                >
                  Mark Buyer-Visible
                </button>
              )}
            </div>

            {onSendRequest && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 }}>
                <div className="decision-title" style={{ fontSize: 13 }}>Send Request to Farmer</div>
                {reqSent && (
                  <div className="alert-success-sm" style={{ marginBottom: 10 }}>✓ Request sent</div>
                )}
                <div className="field" style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)' }}>Request type</span>
                  <select
                    value={reqType}
                    onChange={e => setReqType(e.target.value as RequestType)}
                    style={{ fontSize: 13 }}
                  >
                    {REQUEST_TYPES.map(r => (
                      <option key={r.key} value={r.key}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)' }}>Message to farmer</span>
                  <textarea
                    rows={3}
                    value={reqMsg}
                    onChange={e => setReqMsg(e.target.value)}
                    placeholder="e.g. Please upload a clearer COA image..."
                    style={{ fontSize: 13 }}
                  />
                </div>
                <button
                  className="btn"
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--border)', width: '100%', fontSize: 13 }}
                  onClick={handleSendRequest}
                  disabled={!reqMsg.trim()}
                >
                  Send Request →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
