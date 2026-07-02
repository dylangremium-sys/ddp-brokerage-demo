import { useState, useRef } from 'react'
import type {
  Lang, InventoryItem, FarmProfile, ProductType, TestStatus, MarketBenchmark, ReviewRequest
} from '../../types'

interface Props {
  lang: Lang
  farms: FarmProfile[]
  initialItem?: InventoryItem | null
  onSubmit: (item: InventoryItem) => void
  onBack: () => void
  marketBenchmarks?: MarketBenchmark[]
  openRequests?: ReviewRequest[]
}

const PRODUCT_TYPES: { key: ProductType; en: string; th: string }[] = [
  { key: 'flower',  en: 'Flower',   th: 'ดอก' },
  { key: 'trim',    en: 'Trim',     th: 'ทริม' },
  { key: 'biomass', en: 'Biomass',  th: 'ไบโอมาส' },
  { key: 'extract', en: 'Extract',  th: 'สารสกัด' },
  { key: 'other',   en: 'Other',    th: 'อื่นๆ' },
]

const TEST_OPTIONS: { key: TestStatus; en: string; th: string }[] = [
  { key: 'pass',       en: 'Pass',       th: 'ผ่าน' },
  { key: 'fail',       en: 'Fail',       th: 'ไม่ผ่าน' },
  { key: 'not_tested', en: 'Not tested', th: 'ยังไม่ทดสอบ' },
]

function initForm(item: InventoryItem | null | undefined) {
  if (!item) return {
    farmId: '', strainName: '', productType: 'flower' as ProductType,
    batchNumber: '', quantityAvailable: '', unit: 'kg' as 'kg' | 'g',
    askingPrice: '', minimumOrderKg: '', harvestDate: '', expiryDate: '',
    moisturePct: '', totalThc: '', totalCbd: '', totalTerpenes: '',
    coaAvailable: false, labName: '', reportNumber: '', sampleName: '', testDate: '',
    heavyMetalsStatus: '' as TestStatus, pesticidesStatus: '' as TestStatus,
    microbialStatus: '' as TestStatus, mycotoxinsStatus: '' as TestStatus,
    coaFileName: '', farmerNotes: '', waterActivity: '', storageConditions: '',
  }
  return {
    farmId: item.farmId ?? '',
    strainName: item.productName ?? '',
    productType: (item.productType ?? 'flower') as ProductType,
    batchNumber: item.batchNumber ?? '',
    quantityAvailable: item.quantityKg ? String(item.quantityKg) : '',
    unit: (item.unit ?? 'kg') as 'kg' | 'g',
    askingPrice: item.pricePerKg ? String(item.pricePerKg) : '',
    minimumOrderKg: item.minimumOrderKg ? String(item.minimumOrderKg) : '',
    harvestDate: item.harvestDate ?? '',
    expiryDate: item.expiryDate ?? '',
    moisturePct: item.moisturePct ? String(item.moisturePct) : '',
    totalThc: item.thcPct ? String(item.thcPct) : '',
    totalCbd: item.cbdPct ? String(item.cbdPct) : '',
    totalTerpenes: item.totalTerpenesPct ? String(item.totalTerpenesPct) : '',
    coaAvailable: item.coaAvailable ?? false,
    labName: item.labName ?? '',
    reportNumber: item.reportNumber ?? '',
    sampleName: item.sampleName ?? '',
    testDate: item.testDate ?? '',
    heavyMetalsStatus: (item.heavyMetalsStatus ?? '') as TestStatus,
    pesticidesStatus: (item.pesticidesStatus ?? '') as TestStatus,
    microbialStatus: (item.microbialStatus ?? '') as TestStatus,
    mycotoxinsStatus: (item.mycotoxinsStatus ?? '') as TestStatus,
    coaFileName: item.certFileName ?? '',
    farmerNotes: item.farmerNotes ?? item.notes ?? '',
    waterActivity: item.waterActivity ?? '',
    storageConditions: item.storageConditions ?? '',
  }
}

function SectionTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="form-section-title" style={style}>{children}</div>
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

function PillRow<T extends string>({
  options, value, onChange,
}: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="role-selector" style={{ flexWrap: 'wrap' }}>
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          className={`role-btn${value === o.key ? ' role-btn-active' : ''}`}
          onClick={() => onChange(o.key)}
        >{o.label}</button>
      ))}
    </div>
  )
}

export default function FarmerSubmitInventory({
  lang, farms, initialItem, onSubmit, onBack, marketBenchmarks = [], openRequests = [],
}: Props) {
  const isTh = lang === 'th'
  const isEdit = !!initialItem
  const [form, setForm] = useState(() => initForm(initialItem))
  const [photos, setPhotos] = useState<string[]>(initialItem?.photoUrls ?? [])
  const [saved, setSaved] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const coaInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)

  const selectedFarm = farms.find(f => f.id === form.farmId) ?? farms[0] ?? null

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const pricePerKg = form.unit === 'kg'
    ? parseFloat(form.askingPrice) || 0
    : (parseFloat(form.askingPrice) || 0) * 1000

  const benchmark = marketBenchmarks.find(b =>
    b.productType === form.productType && b.visibleToFarmers && b.unit === 'kg'
  )
  const priceAboveRange = benchmark && pricePerKg > benchmark.priceMax
  const priceBelowRange = benchmark && pricePerKg > 0 && pricePerKg < benchmark.priceMin

  function handleCoaFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) set('coaFileName', file.name)
  }

  function handlePhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string
      setPhotos(prev => [dataUrl, ...prev.slice(0, 3)])
    }
    reader.readAsDataURL(file)
  }

  function buildItem(isDraft: boolean): InventoryItem {
    const qtyKg = form.unit === 'g'
      ? (parseFloat(form.quantityAvailable) || 0) / 1000
      : parseFloat(form.quantityAvailable) || 0

    return {
      id: initialItem?.id ?? crypto.randomUUID(),
      farmerName: selectedFarm?.primaryContact ?? '',
      farmName: selectedFarm?.tradingName ?? '',
      farmId: form.farmId || selectedFarm?.id,
      location: selectedFarm ? `${selectedFarm.province}, Thailand` : '',
      productName: form.strainName.trim(),
      quantityKg: qtyKg,
      harvestDate: form.harvestDate,
      cureDate: '',
      batchNumber: form.batchNumber,
      thcPct: parseFloat(form.totalThc) || 0,
      cbdPct: parseFloat(form.totalCbd) || 0,
      moisturePct: parseFloat(form.moisturePct) || 0,
      waterActivity: form.waterActivity,
      qualityGrade: 'A',
      pricePerKg,
      certFileName: form.coaFileName,
      photoUrl: photos[0] ?? '',
      storageConditions: form.storageConditions,
      notes: form.farmerNotes,
      status: 'Pending Review',
      submittedAt: initialItem?.submittedAt ?? new Date().toISOString(),
      // Extended fields
      stockStatus: isDraft ? 'draft' : 'submitted',
      productType: form.productType,
      unit: form.unit,
      minimumOrderKg: parseFloat(form.minimumOrderKg) || undefined,
      totalTerpenesPct: parseFloat(form.totalTerpenes) || undefined,
      expiryDate: form.expiryDate || undefined,
      clientVisible: initialItem?.clientVisible ?? false,
      coaAvailable: form.coaAvailable,
      labName: form.labName || undefined,
      reportNumber: form.reportNumber || undefined,
      sampleName: form.sampleName || undefined,
      testDate: form.testDate || undefined,
      heavyMetalsStatus: form.heavyMetalsStatus || undefined,
      pesticidesStatus: form.pesticidesStatus || undefined,
      microbialStatus: form.microbialStatus || undefined,
      mycotoxinsStatus: form.mycotoxinsStatus || undefined,
      photoUrls: photos.length > 0 ? photos : undefined,
      farmerNotes: form.farmerNotes || undefined,
      ownerNotes: initialItem?.ownerNotes,
    }
  }

  function handleSaveDraft(e: React.FormEvent) {
    e.preventDefault()
    onSubmit(buildItem(true))
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.strainName.trim()) return
    onSubmit(buildItem(false))
    setSubmitted(true)
  }

  if (submitted) {
    return (
      <div className="page-wrap auth-page" style={{ textAlign: 'center', paddingTop: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ color: 'var(--text)', marginBottom: 8 }}>
          {isTh ? 'ส่งเรียบร้อยแล้ว' : 'Submitted for Review'}
        </h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 28, maxWidth: 360, margin: '0 auto 28px', lineHeight: 1.6 }}>
          {isTh
            ? 'DDP จะตรวจสอบสินค้าของคุณ ดูสถานะได้ที่สต็อกของฉัน'
            : 'DDP will review your stock. Track status in My Stock.'}
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={onBack}>
            {isTh ? '← กลับไปสต็อก' : '← Back to My Stock'}
          </button>
        </div>
      </div>
    )
  }

  const openRequestsForItem = openRequests.filter(r =>
    r.status === 'open' && r.stockItemId === initialItem?.id
  )

  return (
    <div className="page-wrap" style={{ maxWidth: 640 }}>
      <div className="page-header farmer-header" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ color: 'rgba(255,255,255,0.75)', padding: '4px 8px', fontSize: 13 }}
            onClick={onBack}
          >← {isTh ? 'กลับ' : 'Back'}</button>
        </div>
        <div className="page-eyebrow">{isTh ? 'พอร์ทัลเกษตรกร' : 'SUPPLIER & FARMER PORTAL'}</div>
        <h1 className="page-title">
          {isEdit
            ? (isTh ? 'แก้ไขสต็อก' : 'Edit Stock')
            : (isTh ? 'เพิ่มสต็อกใหม่' : 'Add Stock')}
        </h1>
        <p className="page-desc">
          {isTh
            ? 'กรอกข้อมูลที่มี บันทึกร่างได้ก่อน แล้วส่งตอนพร้อม'
            : 'Fill in what you know. Save a draft first, submit when ready.'}
        </p>
      </div>

      {openRequestsForItem.length > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          <strong>{isTh ? 'DDP ต้องการข้อมูลเพิ่มเติม:' : 'DDP requested changes:'}</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {openRequestsForItem.map(r => <li key={r.id} style={{ fontSize: 13 }}>{r.message}</li>)}
          </ul>
        </div>
      )}

      <form>
        <div className="card form-card" style={{ marginBottom: 16 }}>
          <SectionTitle>{isTh ? 'ข้อมูลฟาร์ม' : 'Farm'}</SectionTitle>

          {farms.length > 1 && (
            <Field label={isTh ? 'เลือกฟาร์ม' : 'Select farm'}>
              <select value={form.farmId} onChange={e => set('farmId', e.target.value)}>
                {farms.map(f => <option key={f.id} value={f.id}>{f.tradingName || f.primaryContact}</option>)}
              </select>
            </Field>
          )}
          {farms.length <= 1 && selectedFarm && (
            <div style={{ fontSize: 13.5, color: 'var(--text-muted)', padding: '8px 0' }}>
              {selectedFarm.tradingName || selectedFarm.primaryContact}
              {selectedFarm.province ? ` · ${selectedFarm.province}` : ''}
            </div>
          )}
          {farms.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--error)' }}>
              {isTh ? 'กรุณาสร้างโปรไฟล์ฟาร์มก่อน' : 'Create a farm profile first to link this stock.'}
            </div>
          )}

          <SectionTitle style={{ marginTop: 20 } as React.CSSProperties}>{isTh ? 'ข้อมูลสินค้า' : 'Product Info'}</SectionTitle>

          <Field label={isTh ? 'ชื่อสายพันธุ์ / สินค้า *' : 'Strain / product name *'}>
            <input
              value={form.strainName}
              onChange={e => set('strainName', e.target.value)}
              placeholder={isTh ? 'เช่น Purple Gelato, ดอกแห้ง A' : 'e.g. Purple Gelato, Dried Flower A'}
              required
            />
          </Field>

          <div style={{ marginTop: 14 }}>
            <div className="field-label">{isTh ? 'ประเภทสินค้า' : 'Product type'}</div>
            <PillRow
              options={PRODUCT_TYPES.map(p => ({ key: p.key, label: isTh ? p.th : p.en }))}
              value={form.productType}
              onChange={v => set('productType', v)}
            />
          </div>

          <Field label={isTh ? 'เลขแบทช์' : 'Batch number'} hint={isTh ? 'ตามที่ระบุในใบ COA' : 'As shown on COA'}>
            <input
              value={form.batchNumber}
              onChange={e => set('batchNumber', e.target.value)}
              placeholder={isTh ? 'เช่น PG-2025-001' : 'e.g. PG-2025-001'}
            />
          </Field>
        </div>

        <div className="card form-card" style={{ marginBottom: 16 }}>
          <SectionTitle>{isTh ? 'ปริมาณและราคา' : 'Quantity & Pricing'}</SectionTitle>

          <div className="form-grid-2">
            <Field label={isTh ? 'ปริมาณที่มีอยู่' : 'Available quantity'}>
              <input
                type="number"
                inputMode="decimal"
                value={form.quantityAvailable}
                onChange={e => set('quantityAvailable', e.target.value)}
                placeholder="0"
                min="0"
              />
            </Field>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <span className="field-label">{isTh ? 'หน่วย' : 'Unit'}</span>
              <div className="role-selector" style={{ marginTop: 4 }}>
                {(['kg', 'g'] as const).map(u => (
                  <button
                    key={u}
                    type="button"
                    className={`role-btn${form.unit === u ? ' role-btn-active' : ''}`}
                    onClick={() => set('unit', u)}
                  >{u}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="form-grid-2" style={{ marginTop: 14 }}>
            <Field
              label={isTh ? `ราคาที่ขอ (฿ /${form.unit})` : `Asking price (฿ per ${form.unit})`}
              hint={
                benchmark
                  ? `${isTh ? 'ช่วงตลาด' : 'Market range'}: ฿${(benchmark.priceMin / (form.unit === 'g' ? 1000 : 1)).toLocaleString()}–฿${(benchmark.priceMax / (form.unit === 'g' ? 1000 : 1)).toLocaleString()}/${form.unit}`
                  : undefined
              }
            >
              <input
                type="number"
                inputMode="decimal"
                value={form.askingPrice}
                onChange={e => set('askingPrice', e.target.value)}
                placeholder="0"
                min="0"
                style={priceAboveRange ? { borderColor: 'var(--warning)' } : priceBelowRange ? { borderColor: 'var(--border)' } : {}}
              />
            </Field>
            <Field label={isTh ? 'ปริมาณขั้นต่ำ (กก.)' : 'Min. order (kg)'}>
              <input
                type="number"
                inputMode="decimal"
                value={form.minimumOrderKg}
                onChange={e => set('minimumOrderKg', e.target.value)}
                placeholder="1"
                min="0"
              />
            </Field>
          </div>

          {priceAboveRange && (
            <div className="alert alert-warning" style={{ marginTop: 8 }}>
              {isTh
                ? `⚠ ราคาของคุณสูงกว่าช่วงตลาดของ DDP (฿${benchmark!.priceMin.toLocaleString()}–฿${benchmark!.priceMax.toLocaleString()}/กก.)`
                : `⚠ Your price is above DDP's current market range (฿${benchmark!.priceMin.toLocaleString()}–฿${benchmark!.priceMax.toLocaleString()}/kg)`}
            </div>
          )}

          <div className="form-grid-2" style={{ marginTop: 14 }}>
            <Field label={isTh ? 'วันที่เก็บเกี่ยว' : 'Harvest date'}>
              <input type="date" value={form.harvestDate} onChange={e => set('harvestDate', e.target.value)} />
            </Field>
            <Field label={isTh ? 'วันหมดอายุ' : 'Expiry date'}>
              <input type="date" value={form.expiryDate} onChange={e => set('expiryDate', e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="card form-card" style={{ marginBottom: 16 }}>
          <SectionTitle>{isTh ? 'ผลห้องแล็บ' : 'Lab Values'}</SectionTitle>

          <div className="form-grid-2">
            <Field label="THC %">
              <input
                type="number"
                inputMode="decimal"
                value={form.totalThc}
                onChange={e => set('totalThc', e.target.value)}
                placeholder="0.00"
                min="0" max="100" step="0.01"
              />
            </Field>
            <Field label="CBD %">
              <input
                type="number"
                inputMode="decimal"
                value={form.totalCbd}
                onChange={e => set('totalCbd', e.target.value)}
                placeholder="0.00"
                min="0" max="100" step="0.01"
              />
            </Field>
            <Field label={isTh ? 'ความชื้น %' : 'Moisture %'}>
              <input
                type="number"
                inputMode="decimal"
                value={form.moisturePct}
                onChange={e => set('moisturePct', e.target.value)}
                placeholder="0.00"
                min="0" max="100" step="0.01"
              />
            </Field>
            <Field label={isTh ? 'เทอร์พีน %' : 'Terpenes %'}>
              <input
                type="number"
                inputMode="decimal"
                value={form.totalTerpenes}
                onChange={e => set('totalTerpenes', e.target.value)}
                placeholder="0.00"
                min="0" max="30" step="0.01"
              />
            </Field>
            <Field label={isTh ? 'วอเตอร์แอคทิวิตี้ (aw)' : 'Water activity (aw)'} hint={isTh ? 'เช่น 0.55' : 'e.g. 0.55'}>
              <input
                type="number"
                inputMode="decimal"
                value={form.waterActivity}
                onChange={e => set('waterActivity', e.target.value)}
                placeholder="0.00"
                min="0" max="1" step="0.01"
              />
            </Field>
          </div>
        </div>

        <div className="card form-card" style={{ marginBottom: 16 }}>
          <SectionTitle>{isTh ? 'ใบรับรองการวิเคราะห์ (COA)' : 'Certificate of Analysis (COA)'}</SectionTitle>

          <div style={{ marginBottom: 14 }}>
            <div className="field-label">{isTh ? 'มีใบ COA ไหม?' : 'COA available?'}</div>
            <div className="role-selector">
              <button
                type="button"
                className={`role-btn${form.coaAvailable ? ' role-btn-active' : ''}`}
                onClick={() => set('coaAvailable', true)}
              >{isTh ? 'มี' : 'Yes'}</button>
              <button
                type="button"
                className={`role-btn${!form.coaAvailable ? ' role-btn-active' : ''}`}
                onClick={() => set('coaAvailable', false)}
              >{isTh ? 'ยังไม่มี' : 'Not yet'}</button>
            </div>
          </div>

          {form.coaAvailable && (
            <>
              <div style={{ marginBottom: 14 }}>
                <div className="field-label">{isTh ? 'อัปโหลดไฟล์ COA (PDF / รูป)' : 'Upload COA file (PDF / image)'}</div>
                <input
                  ref={coaInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  style={{ display: 'none' }}
                  onChange={handleCoaFile}
                />
                {form.coaFileName ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                    <span className="pill pill-doc">📄 {form.coaFileName}</span>
                    <button
                      type="button"
                      className="btn-ghost-sm"
                      onClick={() => { set('coaFileName', ''); if (coaInputRef.current) coaInputRef.current.value = '' }}
                    >✕</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost-dark"
                    style={{ marginTop: 4 }}
                    onClick={() => coaInputRef.current?.click()}
                  >
                    📎 {isTh ? 'เลือกไฟล์' : 'Choose file'}
                  </button>
                )}
                <span className="field-hint">{isTh ? 'PDF, JPG, หรือ PNG' : 'PDF, JPG, or PNG'}</span>
              </div>

              <div className="form-grid-2">
                <Field label={isTh ? 'ชื่อห้องแล็บ' : 'Lab name'}>
                  <input value={form.labName} onChange={e => set('labName', e.target.value)} placeholder={isTh ? 'เช่น Green Lab Thailand' : 'e.g. Green Lab Thailand'} />
                </Field>
                <Field label={isTh ? 'เลขที่รายงาน' : 'Report number'}>
                  <input value={form.reportNumber} onChange={e => set('reportNumber', e.target.value)} placeholder="RPT-2025-001" />
                </Field>
                <Field label={isTh ? 'ชื่อตัวอย่าง' : 'Sample name'}>
                  <input value={form.sampleName} onChange={e => set('sampleName', e.target.value)} placeholder={form.strainName || 'Purple Gelato'} />
                </Field>
                <Field label={isTh ? 'วันที่ทดสอบ' : 'Test date'}>
                  <input type="date" value={form.testDate} onChange={e => set('testDate', e.target.value)} />
                </Field>
              </div>

              <div style={{ marginTop: 16 }}>
                <div className="detail-block-title">{isTh ? 'ผลการทดสอบ' : 'Test Results'}</div>
                {([
                  { key: 'heavyMetalsStatus', label: isTh ? 'โลหะหนัก' : 'Heavy Metals' },
                  { key: 'pesticidesStatus',  label: isTh ? 'สารกำจัดแมลง' : 'Pesticides' },
                  { key: 'microbialStatus',   label: isTh ? 'จุลชีววิทยา' : 'Microbial' },
                  { key: 'mycotoxinsStatus',  label: isTh ? 'ไมโคทอกซิน' : 'Mycotoxins' },
                ] as { key: 'heavyMetalsStatus' | 'pesticidesStatus' | 'microbialStatus' | 'mycotoxinsStatus'; label: string }[]).map(({ key, label }) => (
                  <div key={key} style={{ marginBottom: 12 }}>
                    <div className="field-label" style={{ fontSize: 13, marginBottom: 4 }}>{label}</div>
                    <PillRow
                      options={TEST_OPTIONS.map(o => ({ key: o.key, label: isTh ? o.th : o.en }))}
                      value={form[key] as TestStatus}
                      onChange={v => set(key, v as TestStatus)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="card form-card" style={{ marginBottom: 16 }}>
          <SectionTitle>{isTh ? 'รูปภาพสินค้า' : 'Product Photos'}</SectionTitle>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={handlePhotoFile}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
            {photos.map((url, i) => (
              <div key={i} style={{ position: 'relative', width: 80, height: 80 }}>
                <img
                  src={url}
                  alt=""
                  style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }}
                />
                <button
                  type="button"
                  onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                  style={{
                    position: 'absolute', top: -6, right: -6,
                    background: 'var(--error)', color: 'var(--text)',
                    border: 'none', borderRadius: '50%',
                    width: 20, height: 20, cursor: 'pointer',
                    fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >✕</button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost-dark"
            onClick={() => photoInputRef.current?.click()}
          >
            📷 {isTh ? 'ถ่ายรูปหรือเลือกรูป' : 'Take photo or choose image'}
          </button>
          <span className="field-hint">{isTh ? 'รูปดอก บรรจุภัณฑ์ หรือป้ายแบทช์' : 'Bud close-up, packaging, or batch label'}</span>
        </div>

        <div className="card form-card" style={{ marginBottom: 24 }}>
          <SectionTitle>{isTh ? 'บันทึก' : 'Notes'}</SectionTitle>
          <Field label={isTh ? 'สภาพการเก็บรักษา' : 'Storage conditions'} hint={isTh ? 'เช่น ห้องเย็น 15°C ความชื้นต่ำกว่า 60%' : 'e.g. Cool room 15°C, humidity below 60%'}>
            <input
              value={form.storageConditions}
              onChange={e => set('storageConditions', e.target.value)}
              placeholder={isTh ? 'เช่น ห้องเย็น 15°C ความชื้นต่ำกว่า 60%' : 'e.g. Cool room 15°C, RH < 60%, dark storage'}
            />
          </Field>
          <label className="field" style={{ marginTop: 14 }}>
            <span>{isTh ? 'บันทึกของเกษตรกร (มองเห็นเฉพาะ DDP)' : 'Farmer notes (visible to DDP only)'}</span>
            <textarea
              rows={3}
              value={form.farmerNotes}
              onChange={e => set('farmerNotes', e.target.value)}
              placeholder={isTh ? 'หมายเหตุเพิ่มเติมสำหรับ DDP...' : 'Additional notes for DDP...'}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 40 }}>
          <button
            type="button"
            className="btn btn-ghost-dark"
            style={{ flex: 1 }}
            onClick={handleSaveDraft}
          >
            {saved
              ? (isTh ? '✓ บันทึกแล้ว' : '✓ Saved')
              : (isTh ? '💾 บันทึกร่าง' : '💾 Save Draft')}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ flex: 2 }}
            disabled={!form.strainName.trim()}
            onClick={handleSubmit}
          >
            {isTh ? 'ส่งให้ DDP ตรวจสอบ →' : 'Submit for Review →'}
          </button>
        </div>
      </form>
    </div>
  )
}
