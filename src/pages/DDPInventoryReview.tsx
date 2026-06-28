import type { FarmProfile, InventoryItem, InventoryStatus } from '../types'

interface Props {
  item: InventoryItem
  farm: FarmProfile | undefined
  onBack: () => void
  onAction: (itemId: string, action: string) => void
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

export default function DDPInventoryReview({ item, farm, onBack, onAction }: Props) {
  const checks = [
    { label: 'Farm profile submitted', pass: !!farm },
    { label: 'Farmer details complete', pass: !!(item.farmerName && item.farmName && item.location) },
    { label: 'Batch number supplied', pass: !!item.batchNumber },
    { label: 'COA supplied', pass: !!item.certFileName },
    { label: 'THC recorded', pass: item.thcPct > 0 },
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
          <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS</div>
          <h1 className="page-title">{item.productName}</h1>
          <p className="page-desc" style={{ color: '#93c5fd' }}>{item.farmName} · {item.location}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onBack}>← Back to Inventory</button>
          <span className={`badge ${STATUS_CLASS[item.status]}`}>{item.status}</span>
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
                  <div className="detail-row"><span className="dl">Partner Tier</span><span className="dv">{farm.partnerTier}</span></div>
                  <div className="detail-row"><span className="dl">Profile Completion</span><span className="dv">{farm.completionPct}%</span></div>
                </div>
              </div>
            )}

            <div className="detail-block">
              <div className="detail-block-title">Product Details</div>
              <div className="detail-rows">
                <div className="detail-row"><span className="dl">Product</span><span className="dv">{item.productName}</span></div>
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
              <div className="detail-rows">
                <div className="detail-row"><span className="dl">Batch Number</span><span className="dv mono">{item.batchNumber || '—'}</span></div>
                <div className="detail-row"><span className="dl">THC %</span><span className="dv">{item.thcPct > 0 ? `${item.thcPct}%` : <span className="text-missing">Not recorded</span>}</span></div>
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
                    {item.certFileName
                      ? <span className="doc-name">📄 {item.certFileName}</span>
                      : <span className="text-missing">✗ Not provided</span>}
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
                <img src={item.photoUrl} alt="Product" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #e2e8f0' }} />
              </div>
            )}

            <div className="detail-block">
              <div className="detail-block-title">Storage & Notes</div>
              <div className="detail-rows">
                <div className="detail-row"><span className="dl">Storage Conditions</span><span className="dv">{item.storageConditions || <span className="text-muted">—</span>}</span></div>
              </div>
              {item.notes && <p className="notes-body" style={{ marginTop: 12 }}>{item.notes}</p>}
            </div>

            <div className="detail-block" style={{ borderBottom: 'none' }}>
              <div className="detail-block-title">Compliance Checklist — {passCount}/{checks.length}</div>
              <div className="compliance-checklist">
                {checks.map((c, i) => <CheckRow key={i} label={c.label} pass={c.pass} />)}
              </div>
            </div>
          </div>
        </div>

        <div className="review-sidebar">
          <div className="card decision-card sidebar-sticky">
            <div className="decision-title">DDP Decision</div>
            <p className="decision-desc">Select an action to update the status. The farmer sees this change immediately.</p>
            <button className="btn btn-approve" onClick={() => onAction(item.id, 'approve')}>✅ Approve Inventory</button>
            <button className="btn btn-missing" onClick={() => onAction(item.id, 'missing')}>📋 Request Missing Document</button>
            <button className="btn btn-reject" onClick={() => onAction(item.id, 'reject')}>✗ Reject Inventory</button>
          </div>
        </div>
      </div>
    </div>
  )
}
