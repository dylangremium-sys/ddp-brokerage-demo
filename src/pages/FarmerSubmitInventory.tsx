import { useState } from 'react'
import { T } from '../translations'
import type { Lang, InventoryItem, FarmProfile } from '../types'

interface Props {
  lang: Lang
  farms: FarmProfile[]
  onSubmit: (item: InventoryItem) => void
}

const BLANK = {
  farmerName: '', farmName: '', farmId: '', location: '',
  productName: '', quantityKg: '', harvestDate: '', cureDate: '',
  batchNumber: '', thcPct: '', cbdPct: '', moisturePct: '',
  waterActivity: '', qualityGrade: 'A', pricePerKg: '',
  certFileName: '', photoUrl: '', storageConditions: '', notes: '',
}

export default function FarmerSubmitInventory({ lang, farms, onSubmit }: Props) {
  const [form, setForm] = useState(BLANK)
  const [submitted, setSubmitted] = useState(false)
  const t = T[lang]

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
  }

  function handleFarmSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const farmId = e.target.value
    const farm = farms.find(f => f.id === farmId)
    if (farm) {
      setForm(f => ({
        ...f,
        farmId: farm.id,
        farmName: farm.tradingName,
        farmerName: farm.primaryContact,
        location: `${farm.province}, Thailand`,
      }))
    } else {
      setForm(f => ({ ...f, farmId: '', farmName: '', farmerName: '', location: '' }))
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const item: InventoryItem = {
      id: crypto.randomUUID(),
      farmerName: form.farmerName,
      farmName: form.farmName,
      farmId: form.farmId || undefined,
      location: form.location,
      productName: form.productName,
      quantityKg: parseFloat(form.quantityKg) || 0,
      harvestDate: form.harvestDate,
      cureDate: form.cureDate,
      batchNumber: form.batchNumber,
      thcPct: parseFloat(form.thcPct) || 0,
      cbdPct: parseFloat(form.cbdPct) || 0,
      moisturePct: parseFloat(form.moisturePct) || 0,
      waterActivity: form.waterActivity,
      qualityGrade: form.qualityGrade,
      pricePerKg: parseFloat(form.pricePerKg) || 0,
      certFileName: form.certFileName,
      photoUrl: form.photoUrl,
      storageConditions: form.storageConditions,
      notes: form.notes,
      status: 'Pending Review',
      submittedAt: new Date().toISOString(),
    }
    onSubmit(item)
    setSubmitted(true)
    setForm(BLANK)
    window.scrollTo(0, 0)
  }

  return (
    <div className="page-wrap">
      <div className="page-header farmer-header">
        <div className="farmer-header-row">
          <div className="page-eyebrow">{t.eyebrow}</div>
        </div>
        <h1 className="page-title">{t.submitTitle}</h1>
        <p className="page-desc">{t.submitDesc}</p>
      </div>

      {submitted && (
        <div className="alert alert-success">
          <strong>{t.alertSuccessTitle}</strong> {t.alertSuccessBody}
        </div>
      )}

      <form className="card form-card" onSubmit={handleSubmit}>
        <p className="form-intro">Submit a new inventory batch for DDP review. All batches must include harvest date and quantity. Lab data and COA documentation improve approval speed. Fields marked <span className="required-star">*</span> are required.</p>

        <div className="form-section-title">{t.sectionFarmerDetails}</div>

        {farms.length > 0 && (
          <div className="form-grid-2" style={{ marginBottom: 16 }}>
            <label className="field">
              <span>{t.farmLink}</span>
              <select onChange={handleFarmSelect} value={form.farmId}>
                <option value="">— {lang === 'th' ? 'เลือกฟาร์ม' : 'Select a known farm'} —</option>
                {farms.map(f => (
                  <option key={f.id} value={f.id}>{f.tradingName} ({f.province})</option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="form-grid-3">
          <label className="field">
            <span>{t.farmerName}<span className="required-star">*</span></span>
            <input name="farmerName" value={form.farmerName} onChange={handleChange} required placeholder={lang === 'th' ? 'ชื่อ-นามสกุล' : 'Full name of responsible operator'} />
          </label>
          <label className="field">
            <span>{t.farmName}<span className="required-star">*</span></span>
            <input name="farmName" value={form.farmName} onChange={handleChange} required placeholder={lang === 'th' ? 'ชื่อฟาร์ม' : 'Registered farm or business name'} />
          </label>
          <label className="field">
            <span>{t.location}<span className="required-star">*</span></span>
            <input name="location" value={form.location} onChange={handleChange} required placeholder={lang === 'th' ? 'จังหวัด, ประเทศ' : 'Province, Country'} />
          </label>
        </div>

        <div className="form-section-title">{t.sectionProductDetails}</div>
        <div className="form-grid-3">
          <label className="field">
            <span>{t.productName}<span className="required-star">*</span></span>
            <input name="productName" value={form.productName} onChange={handleChange} required placeholder={lang === 'th' ? 'เช่น มะม่วง, เรดดราก้อน' : 'Strain name or product type'} />
          </label>
          <label className="field">
            <span>{t.quantityKg}<span className="required-star">*</span></span>
            <input name="quantityKg" type="number" min="0" step="0.01" value={form.quantityKg} onChange={handleChange} required placeholder="0.00" />
          </label>
          <label className="field">
            <span>{t.harvestDate}<span className="required-star">*</span></span>
            <input name="harvestDate" type="date" value={form.harvestDate} onChange={handleChange} required />
          </label>
          <label className="field">
            <span>{t.cureDate}</span>
            <input name="cureDate" type="date" value={form.cureDate} onChange={handleChange} />
          </label>
          <label className="field">
            <span>{t.batchNumber}</span>
            <input name="batchNumber" value={form.batchNumber} onChange={handleChange} placeholder={lang === 'th' ? 'เช่น F4-122025' : 'e.g. F4-122025'} />
          </label>
          <label className="field">
            <span>{t.qualityGrade}</span>
            <select name="qualityGrade" value={form.qualityGrade} onChange={handleChange}>
              <option value="A">{t.gradeA}</option>
              <option value="B">{t.gradeB}</option>
              <option value="C">{t.gradeC}</option>
            </select>
          </label>
          <label className="field">
            <span>{t.pricePerKg}</span>
            <input name="pricePerKg" type="number" min="0" step="0.01" value={form.pricePerKg} onChange={handleChange} placeholder="0.00" />
          </label>
        </div>

        <div className="form-section-title">{t.sectionLabData}</div>
        <div className="form-grid-3">
          <label className="field">
            <span>{t.thcPct}</span>
            <input name="thcPct" type="number" min="0" max="40" step="0.01" value={form.thcPct} onChange={handleChange} placeholder="e.g. 23.5" />
          </label>
          <label className="field">
            <span>{t.cbdPct}</span>
            <input name="cbdPct" type="number" min="0" max="40" step="0.01" value={form.cbdPct} onChange={handleChange} placeholder="e.g. 0.10" />
          </label>
          <label className="field">
            <span>{t.moisturePct}</span>
            <input name="moisturePct" type="number" min="0" max="100" step="0.01" value={form.moisturePct} onChange={handleChange} placeholder="e.g. 10.27" />
          </label>
          <label className="field">
            <span>{t.waterActivity}</span>
            <input name="waterActivity" value={form.waterActivity} onChange={handleChange} placeholder="e.g. 0.58" />
          </label>
        </div>

        <div className="form-section-title">{t.sectionDocuments}</div>
        <div className="form-grid-2">
          <label className="field">
            <span>{t.certFileName}</span>
            <input name="certFileName" value={form.certFileName} onChange={handleChange} placeholder={lang === 'th' ? 'เช่น COA_batch1.pdf' : 'Filename or reference number, e.g. COA_batch1.pdf'} />
            <span className="field-hint">Certificate of Analysis reference. Required for full approval.</span>
          </label>
          <label className="field">
            <span>{t.photoUrl}</span>
            <input name="photoUrl" value={form.photoUrl} onChange={handleChange} placeholder="https://..." />
            <span className="field-hint">Paste a URL to an existing product photo if available.</span>
          </label>
        </div>
        <label className="field">
          <span>{t.storageConditions}</span>
          <input name="storageConditions" value={form.storageConditions} onChange={handleChange} placeholder={lang === 'th' ? 'เช่น ปิดสนิท, มืด, 18°C, 55% RH' : 'e.g. Sealed, dark, 18°C, 55% RH'} />
          <span className="field-hint">Current storage environment for this batch.</span>
        </label>
        <label className="field" style={{ marginTop: 12 }}>
          <span>{t.notes}</span>
          <textarea name="notes" value={form.notes} onChange={handleChange} rows={3} placeholder={lang === 'th' ? 'ข้อมูลเพิ่มเติมสำหรับ DDP...' : 'Any additional information DDP should be aware of for this batch...'} />
        </label>

        <div className="form-footer">
          <button type="submit" className="btn btn-primary btn-lg">{t.submitBtn}</button>
        </div>
      </form>
    </div>
  )
}
