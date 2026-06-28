import type { InventoryItem } from '../types'

interface Props {
  inventory: InventoryItem[]
}

const BUYER_CARDS = [
  {
    flag: '🇨🇿',
    buyer: 'Czech Processor',
    interest: 'Interested in Grade A Mango — requesting batch documentation and COA review.',
    tags: ['Grade A', 'Mango', 'COA Required'],
  },
  {
    flag: '🇨🇭',
    buyer: 'Swiss Importer',
    interest: 'Requires verified batch documentation and certificate of analysis for all available strains.',
    tags: ['All Strains', 'COA Required', 'Verified Batch'],
  },
  {
    flag: '🇩🇪',
    buyer: 'German Distributor',
    interest: 'Requesting monthly supply estimate and pricing schedule.',
    tags: ['Supply Estimate', 'Pricing', 'Monthly Commitment'],
  },
  {
    flag: '🇬🇧',
    buyer: 'UK Medical Buyer',
    interest: 'Interested in export-ready batches only. Requires GMP documentation.',
    tags: ['Export Ready', 'GMP Required', 'Medical Grade'],
  },
]

export default function DDPBuyerPreview({ inventory }: Props) {
  const approved = inventory.filter(i => i.status === 'Approved')

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — FUTURE MODULE</div>
        <h1 className="page-title">Future Buyer Interest Preview</h1>
        <p className="page-desc">This module is in development. DDP controls what commercial buyers can see.</p>
      </div>

      <div className="disclaimer-box">
        <span className="disclaimer-icon">⚠️</span>
        <div>
          <strong>FUTURE MODULE</strong> — This section is a presentation preview only. Buyer access, messaging, pricing, and transactions are not functional. DDP controls all buyer visibility.
        </div>
      </div>

      {approved.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#64748b' }}>
          No approved inventory available for preview yet. Approve inventory from the Inventory Dashboard to enable this section.
        </div>
      ) : (
        <>
          <div className="buyer-cards-grid">
            {BUYER_CARDS.map((bc, i) => (
              <div key={i} className="buyer-card">
                <div className="buyer-card-flag">{bc.flag}</div>
                <div className="buyer-card-body">
                  <div className="buyer-card-name">{bc.buyer}</div>
                  <p className="buyer-card-interest">{bc.interest}</p>
                  <div className="buyer-card-tags">
                    {bc.tags.map((tag, j) => <span key={j} className="buyer-tag">{tag}</span>)}
                  </div>
                </div>
                <div className="buyer-card-status">
                  <span className="badge badge-pending">Interest Received</span>
                </div>
              </div>
            ))}
          </div>

          <div className="section-label-row" style={{ marginTop: 32 }}>
            <div className="section-label">Available Approved Inventory</div>
            <span style={{ fontSize: 12, color: '#64748b' }}>What qualified buyers would see — controlled by DDP</span>
          </div>

          <div className="card table-card">
            <div className="table-scroll">
              <table className="inv-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Farm</th>
                    <th>Quantity (kg)</th>
                    <th>THC %</th>
                    <th>CBD %</th>
                    <th>Grade</th>
                    <th>COA</th>
                    <th>Batch</th>
                  </tr>
                </thead>
                <tbody>
                  {approved.map(item => (
                    <tr key={item.id}>
                      <td className="td-bold">{item.productName}</td>
                      <td>{item.farmName}</td>
                      <td className="td-num">{item.quantityKg.toLocaleString()}</td>
                      <td className="td-num">{item.thcPct > 0 ? `${item.thcPct}%` : '—'}</td>
                      <td className="td-num">{item.cbdPct > 0 ? `${item.cbdPct}%` : '—'}</td>
                      <td><span className="grade-chip">Grade {item.qualityGrade}</span></td>
                      <td>{item.certFileName ? <span className="coa-present">✓</span> : <span className="coa-missing">✗</span>}</td>
                      <td className="td-mono">{item.batchNumber || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
