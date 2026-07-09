import { useState, useRef } from 'react'
import type { Lang, InventoryItem } from '../../types'

interface Props {
  lang: Lang
  inventory: InventoryItem[]
  onAddNew: () => void
  onEdit: (itemId: string) => void
  openRequestCount: number
  onGoRequests: () => void
  onCoaUpload?: (batchId: string, file: File) => Promise<void>
}

type Filter = 'all' | 'draft' | 'submitted' | 'needs_changes' | 'approved' | 'archived'

const STOCK_STATUS_LABEL: Record<string, { en: string; th: string; cls: string }> = {
  draft:             { en: 'Draft',           th: 'แบบร่าง',       cls: 'badge-gray' },
  submitted:         { en: 'Pending Review',  th: 'รอตรวจสอบ',     cls: 'badge-pending' },
  needs_changes:     { en: 'Needs Changes',   th: 'ต้องแก้ไข',     cls: 'badge-orange' },
  approved_internal: { en: 'Approved',        th: 'อนุมัติแล้ว',   cls: 'badge-approved' },
  client_visible:    { en: 'Visible to Buyers', th: 'มองเห็นโดยผู้ซื้อ', cls: 'badge-blue' },
  reserved:          { en: 'Reserved',        th: 'จองแล้ว',       cls: 'badge-purple' },
  sold:              { en: 'Sold',            th: 'ขายแล้ว',       cls: 'badge-approved' },
  archived:          { en: 'Archived',        th: 'เก็บถาวร',      cls: 'badge-gray' },
}

const PENDING_REVIEW_LABEL = { en: 'Pending Review', th: 'รอตรวจสอบ', cls: 'badge-pending' }

function getStatusInfo(item: InventoryItem) {
  if (item.stockStatus) return STOCK_STATUS_LABEL[item.stockStatus] ?? PENDING_REVIEW_LABEL
  if (item.status === 'Approved') return STOCK_STATUS_LABEL.approved_internal
  if (item.status === 'Missing Document') return STOCK_STATUS_LABEL.needs_changes
  if (item.status === 'Rejected') return { en: 'Rejected', th: 'ถูกปฏิเสธ', cls: 'badge-rejected' }
  return PENDING_REVIEW_LABEL
}

function matchesFilter(item: InventoryItem, f: Filter): boolean {
  if (f === 'all') return true
  const ss = item.stockStatus
  if (f === 'draft') return ss === 'draft'
  if (f === 'submitted') return ss === 'submitted' || (!ss && item.status === 'Pending Review')
  if (f === 'needs_changes') return ss === 'needs_changes' || item.status === 'Missing Document'
  if (f === 'approved') return ss === 'approved_internal' || ss === 'client_visible' || item.status === 'Approved'
  if (f === 'archived') return ss === 'archived' || ss === 'sold'
  return true
}

export default function FarmerMyStock({
  lang, inventory, onAddNew, onEdit, openRequestCount, onGoRequests, onCoaUpload,
}: Props) {
  const isTh = lang === 'th'
  const [filter, setFilter] = useState<Filter>('all')
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const coaInputRef = useRef<HTMLInputElement>(null)

  function handleCoaClick(batchId: string) {
    setUploadingId(batchId)
    setUploadError(null)
    coaInputRef.current?.click()
  }

  async function handleCoaFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !uploadingId || !onCoaUpload) return
    if (file.type !== 'application/pdf') {
      setUploadError(isTh ? 'อนุญาตเฉพาะไฟล์ PDF เท่านั้น' : 'PDF files only. Please choose a .pdf file.')
      if (coaInputRef.current) coaInputRef.current.value = ''
      setUploadingId(null)
      return
    }
    try {
      await onCoaUpload(uploadingId, file)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : (isTh ? 'อัปโหลดล้มเหลว' : 'Upload failed'))
    } finally {
      if (coaInputRef.current) coaInputRef.current.value = ''
      setUploadingId(null)
    }
  }

  const filtered = inventory.filter(i => matchesFilter(i, filter))

  const FILTERS: { key: Filter; en: string; th: string }[] = [
    { key: 'all',           en: 'All',           th: 'ทั้งหมด' },
    { key: 'draft',         en: 'Draft',          th: 'แบบร่าง' },
    { key: 'submitted',     en: 'Pending',        th: 'รอตรวจสอบ' },
    { key: 'needs_changes', en: 'Needs Changes',  th: 'ต้องแก้ไข' },
    { key: 'approved',      en: 'Approved',       th: 'อนุมัติแล้ว' },
    { key: 'archived',      en: 'Archived',       th: 'เก็บถาวร' },
  ]

  const needsChangesCount = inventory.filter(i =>
    i.stockStatus === 'needs_changes' || i.status === 'Missing Document'
  ).length

  return (
    <div className="page-wrap" style={{ maxWidth: 680 }}>
      {/* Hidden file input — shared across all batch cards */}
      <input
        ref={coaInputRef}
        type="file"
        accept=".pdf,application/pdf"
        style={{ display: 'none' }}
        onChange={handleCoaFileChange}
      />

      {uploadError && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }}>
          {uploadError}
          <button
            style={{ marginLeft: 10, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
            onClick={() => setUploadError(null)}
            aria-label={isTh ? 'ปิดข้อความแจ้งเตือน' : 'Dismiss'}
          >✕</button>
        </div>
      )}

      <div className="page-header farmer-header" style={{ marginBottom: 20 }}>
        <div className="page-eyebrow">{isTh ? 'พอร์ทัลเกษตรกร' : 'SUPPLIER & FARMER PORTAL'}</div>
        <h1 className="page-title">{isTh ? 'สต็อกของฉัน' : 'My Stock'}</h1>
        <p className="page-desc">
          {isTh ? 'รายการสต็อกสินค้าของคุณทั้งหมด' : 'All your stock listings'}
        </p>
      </div>

      {openRequestCount > 0 && (
        <button
          onClick={onGoRequests}
          className="card"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 18px', marginBottom: 16, width: '100%', textAlign: 'left',
            border: '1.5px solid rgba(184,120,46,0.4)', background: 'rgba(184,120,46,0.06)', cursor: 'pointer',
            borderRadius: 8,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: 'var(--warning)', fontSize: 13.5 }}>
              {openRequestCount} {isTh ? 'คำขอจาก DDP ที่รอดำเนินการ' : 'open requests from DDP'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--warning)', marginTop: 2, opacity: 0.75 }}>
              {isTh ? 'แตะที่นี่เพื่อดูและดำเนินการ' : 'Tap to view and take action'}
            </div>
          </div>
          <span style={{ color: 'var(--warning)', fontSize: 16 }}>→</span>
        </button>
      )}

      {needsChangesCount > 0 && openRequestCount === 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          {isTh
            ? `${needsChangesCount} รายการต้องการการแก้ไข`
            : `${needsChangesCount} item${needsChangesCount > 1 ? 's' : ''} need changes`}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div className="filter-tabs" style={{ margin: 0 }}>
          {FILTERS.map(f => (
            <button
              key={f.key}
              className={`filter-tab${filter === f.key ? ' filter-active' : ''}`}
              onClick={() => setFilter(f.key)}
            >{isTh ? f.th : f.en}</button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={onAddNew} style={{ fontSize: 13, padding: '7px 16px', flexShrink: 0 }}>
          + {isTh ? 'เพิ่มสต็อกใหม่' : 'Add New Stock'}
        </button>
      </div>

      {filtered.length === 0 && (
        <div className="empty-state-hero">
          <div className="empty-state-icon">
            <svg width="44" height="44" viewBox="0 0 20 20" fill="none" stroke="var(--border)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 11.5V18M4 8v6.5l6 3.5 6-3.5V8L10 4.5 4 8z"/>
              <path d="M16 8l-6 3.5L4 8"/>
            </svg>
          </div>
          <p className="empty-state-message">
            {inventory.length === 0
              ? (isTh ? 'ยังไม่มีสต็อก กดปุ่มด้านบนเพื่อเพิ่มสต็อกแรก' : 'No stock yet. Add your first listing above.')
              : (isTh ? 'ไม่มีรายการในหมวดนี้' : 'No items in this category.')}
          </p>
          {inventory.length === 0 && (
            <button className="btn btn-primary" onClick={onAddNew} style={{ marginTop: 16 }}>
              + {isTh ? 'เพิ่มสต็อกแรก' : 'Add First Stock'}
            </button>
          )}
        </div>
      )}

      <div className="status-list">
        {filtered.map(item => {
          const si = getStatusInfo(item)
          const isDraft = item.stockStatus === 'draft'
          const needsChange = item.stockStatus === 'needs_changes' || item.status === 'Missing Document'
          return (
            <div key={item.id} className={`card stock-item-card${needsChange ? ' stock-card-needs-changes' : ''}`}>
              <div className="status-card-top">
                <div>
                  <div className="status-product">{item.productName}</div>
                  <div className="status-meta">
                    {item.farmName}
                    {item.productType && ` · ${item.productType}`}
                    {item.batchNumber && ` · ${isTh ? 'แบทช์' : 'Batch'} ${item.batchNumber}`}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                  <span className={`badge ${si.cls}`}>{isTh ? si.th : si.en}</span>
                  {item.clientVisible && (
                    <span className="badge badge-blue" style={{ fontSize: 10 }}>
                      {isTh ? 'มองเห็นโดยผู้ซื้อ' : 'Buyer visible'}
                    </span>
                  )}
                </div>
              </div>

              <div className="status-pills">
                {item.quantityKg > 0 && (
                  <span className="pill">{item.quantityKg.toLocaleString()} {item.unit ?? 'kg'}</span>
                )}
                {item.pricePerKg > 0 && (
                  <span className="pill">฿{item.pricePerKg.toLocaleString()}/{item.unit ?? 'kg'}</span>
                )}
                {item.thcPct > 0 && <span className="pill">THC {item.thcPct}%</span>}
                {item.cbdPct > 0 && <span className="pill">CBD {item.cbdPct}%</span>}
                {item.certFileName || item.coaAvailable || item.coaStoragePath
                  ? (
                    <span className="pill pill-doc">
                      {item.certFileName || 'COA'}
                      {onCoaUpload && (
                        <button
                          type="button"
                          onClick={() => handleCoaClick(item.id)}
                          disabled={uploadingId === item.id}
                          style={{ marginLeft: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)', padding: 0 }}
                          title={isTh ? 'แทนที่ไฟล์ COA' : 'Replace COA'}
                          aria-label={isTh ? 'แทนที่ไฟล์ COA' : 'Replace COA'}
                        >
                          {uploadingId === item.id ? '…' : '↑'}
                        </button>
                      )}
                    </span>
                  )
                  : onCoaUpload
                    ? (
                      <button
                        type="button"
                        className="pill"
                        style={{ cursor: 'pointer', border: '1px dashed var(--text-muted)', background: 'none', color: 'var(--text-muted)' }}
                        onClick={() => handleCoaClick(item.id)}
                        disabled={uploadingId === item.id}
                      >
                        {uploadingId === item.id
                          ? (isTh ? 'กำลังอัปโหลด…' : 'Uploading…')
                          : (isTh ? 'อัปโหลด COA' : 'Upload COA')}
                      </button>
                    )
                    : <span className="pill" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>{isTh ? 'ไม่มี COA' : 'No COA'}</span>
                }
                {item.harvestDate && (
                  <span className="pill">{isTh ? 'เก็บเกี่ยว' : 'Harvest'} {item.harvestDate}</span>
                )}
                {(item.photoUrls?.length ?? 0) > 0 && (
                  <span className="pill">{item.photoUrls!.length} photo{item.photoUrls!.length === 1 ? '' : 's'}</span>
                )}
              </div>

              {needsChange && (
                <div className="alert alert-warning" style={{ marginTop: 10, padding: '8px 12px', fontSize: 13 }}>
                  {isTh
                    ? 'DDP ต้องการข้อมูลเพิ่มเติม — กดแก้ไขเพื่อดูรายละเอียด'
                    : 'DDP requested changes — edit to see details'}
                </div>
              )}

              <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-review"
                  onClick={() => onEdit(item.id)}
                  style={{ fontSize: 13 }}
                >
                  {isDraft ? (isTh ? 'ต่อเนื่อง' : 'Continue') : (isTh ? 'แก้ไข' : 'Edit')}
                </button>
                {item.submittedAt && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
                    {isTh ? 'อัปเดต' : 'Updated'} {new Date(item.submittedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
