import type { Lang, ReviewRequest, InventoryItem } from '../types'

interface Props {
  lang: Lang
  requests: ReviewRequest[]
  inventory: InventoryItem[]
  onResolve: (requestId: string) => void
  onEditStock: (itemId: string) => void
  onGoMyStock: () => void
}

const REQUEST_TYPE_LABEL: Record<string, { en: string; th: string }> = {
  coa:          { en: 'Upload COA',         th: 'อัปโหลดใบ COA' },
  photo:        { en: 'Add Photos',         th: 'เพิ่มรูปภาพ' },
  quantity:     { en: 'Confirm Quantity',   th: 'ยืนยันปริมาณ' },
  price:        { en: 'Revise Price',       th: 'ปรับราคา' },
  batch_number: { en: 'Add Batch Number',   th: 'เพิ่มเลขแบทช์' },
  licence:      { en: 'Upload Licence',     th: 'อัปโหลดใบอนุญาต' },
  general:      { en: 'Action Required',    th: 'ต้องดำเนินการ' },
}

export default function FarmerRequests({
  lang, requests, inventory, onResolve, onEditStock, onGoMyStock,
}: Props) {
  const isTh = lang === 'th'

  const open = requests.filter(r => r.status === 'open')
  const resolved = requests.filter(r => r.status === 'resolved')

  function getItemForRequest(r: ReviewRequest): InventoryItem | undefined {
    return r.stockItemId ? inventory.find(i => i.id === r.stockItemId) : undefined
  }

  return (
    <div className="page-wrap" style={{ maxWidth: 680 }}>
      <div className="page-header farmer-header" style={{ marginBottom: 20 }}>
        <div className="page-eyebrow">{isTh ? 'พอร์ทัลเกษตรกร' : 'SUPPLIER & FARMER PORTAL'}</div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h1 className="page-title">{isTh ? 'คำขอจาก DDP' : 'Requests from DDP'}</h1>
            <p className="page-desc">
              {isTh ? 'รายการที่ DDP ต้องการให้คุณดำเนินการ' : 'Items DDP needs you to act on'}
            </p>
          </div>
          <button
            className="btn btn-ghost"
            style={{ color: 'rgba(255,255,255,0.8)', padding: '6px 12px', fontSize: 13, flexShrink: 0 }}
            onClick={onGoMyStock}
          >← {isTh ? 'สต็อกของฉัน' : 'My Stock'}</button>
        </div>
      </div>

      {open.length === 0 && (
        <div className="empty-state-hero">
          <div className="empty-state-icon">✅</div>
          <p className="empty-state-message">
            {isTh
              ? 'ไม่มีคำขอที่รอดำเนินการ ทุกอย่างเรียบร้อยดี'
              : 'No open requests. Everything looks good.'}
          </p>
        </div>
      )}

      {open.length > 0 && (
        <>
          <div className="section-label-row" style={{ marginBottom: 12 }}>
            <div className="section-label">
              {isTh ? 'รอดำเนินการ' : 'Open'}
              {' '}
              <span style={{
                background: 'var(--error)', color: 'var(--text)',
                borderRadius: '50%', fontSize: 10, fontWeight: 700,
                padding: '1px 6px', marginLeft: 4,
              }}>{open.length}</span>
            </div>
          </div>

          <div className="status-list" style={{ marginBottom: 28 }}>
            {open.map(req => {
              const item = getItemForRequest(req)
              const typeInfo = REQUEST_TYPE_LABEL[req.requestType] ?? REQUEST_TYPE_LABEL.general
              return (
                <div key={req.id} className="card request-card">
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                    <div className="request-icon">
                      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="var(--warning)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="14" height="12" rx="1.5"/>
                        <path d="M3 12h4l2.5 3L12 12h5"/>
                      </svg>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)', marginBottom: 2 }}>
                        {isTh ? typeInfo.th : typeInfo.en}
                      </div>
                      {(req.productName || item?.productName) && (
                        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 4 }}>
                          {item?.productName ?? req.productName}
                          {(req.farmName || item?.farmName) && ` · ${req.farmName ?? item?.farmName}`}
                        </div>
                      )}
                    </div>
                    <span className="badge badge-orange" style={{ fontSize: 11, flexShrink: 0 }}>
                      {isTh ? 'รอดำเนินการ' : 'Open'}
                    </span>
                  </div>

                  <div className="request-message">
                    {req.message}
                  </div>

                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8, marginBottom: 14 }}>
                    {new Date(req.createdAt).toLocaleDateString(
                      isTh ? 'th-TH' : 'en-GB',
                      { day: 'numeric', month: 'short', year: 'numeric' }
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {item && (
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: 13, padding: '7px 14px' }}
                        onClick={() => onEditStock(item.id)}
                      >
                        {isTh ? 'แก้ไขสต็อก' : 'Edit Stock'}
                      </button>
                    )}
                    <button
                      className="btn btn-ghost-dark"
                      style={{ fontSize: 13, padding: '7px 14px' }}
                      onClick={() => onResolve(req.id)}
                    >
                      {isTh ? '✓ แก้ไขแล้ว' : '✓ Mark Resolved'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {resolved.length > 0 && (
        <>
          <div className="section-label-row" style={{ marginBottom: 12 }}>
            <div className="section-label">{isTh ? 'แก้ไขแล้ว' : 'Resolved'}</div>
          </div>
          <div className="status-list">
            {resolved.map(req => {
              const item = getItemForRequest(req)
              const typeInfo = REQUEST_TYPE_LABEL[req.requestType] ?? REQUEST_TYPE_LABEL.general
              return (
                <div key={req.id} className="card" style={{ padding: '14px 18px', opacity: 0.65 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: 'var(--success)', fontSize: 14, fontWeight: 700 }}>✓</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                        {isTh ? typeInfo.th : typeInfo.en}
                        {(req.productName || item?.productName) && (
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                            {' · '}{item?.productName ?? req.productName}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="badge badge-approved" style={{ fontSize: 10 }}>
                      {isTh ? 'แก้ไขแล้ว' : 'Resolved'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {requests.length === 0 && (
        <div style={{ textAlign: 'center', marginTop: 32 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {isTh
              ? 'คำขอจาก DDP จะปรากฏที่นี่เมื่อ DDP ตรวจสอบสต็อกของคุณ'
              : 'DDP requests will appear here once they review your stock.'}
          </p>
        </div>
      )}
    </div>
  )
}
