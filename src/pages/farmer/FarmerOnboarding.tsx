import { useState } from 'react'
import { T } from '../../translations'
import { calcCompletion, loadFarmDraft, saveFarmDraft, clearFarmDraft } from '../../data'
import type { Lang, FarmProfile } from '../../types'
import type { UserProfile } from '../../services/auth'

interface Props {
  lang: Lang
  currentProfile?: UserProfile | null
  onSubmit: (farm: FarmProfile) => void
  onBack: () => void   // "Continue later" → goes to dashboard
}

type Draft = Partial<FarmProfile>

const BLANK: Draft = {
  legalBusinessName: '', tradingName: '', registrationNumber: '', taxNumber: '',
  dateEstablished: '', province: '', district: '', gpsCoordinates: '',
  registeredAddress: '', operationalAddress: '', website: '', facebook: '',
  lineId: '', whatsapp: '', email: '', primaryContact: '', position: '',
  mobileNumber: '', secondaryContact: '', emergencyContact: '',
  ownerName: '', nationality: '', ownershipPct: '', additionalShareholders: '',
  ownershipBreakdown: '', ultimateBeneficialOwners: '', parentCompany: '',
  subsidiaries: '', foreignInvestors: '', strategicPartners: '', exportPartners: '',
  cultivationLicence: '', processingLicence: '', manufacturingLicence: '',
  researchLicence: '', medicalCannabisLicence: '', exportLicence: '', importLicence: '',
  gmpCert: '', gapCert: '', gacpCert: '', picsCert: '', organicCert: '', isoCerts: '', otherCerts: '', documentExpiry: '',
  farmType: '', totalLandArea: '', cultivationArea: '', floweringArea: '', nurseryArea: '',
  motherPlantArea: '', processingArea: '', dryingArea: '', storageArea: '', securityArea: '',
  expansionCapacity: '', facilityPhotoUrl: '',
  activeRooms: '', harvestsPerYear: '', avgYieldPerHarvest: '', annualCapacity: '',
  currentInventory: '', projectedInventory: '', productionUtilisation: '', maxProductionCapacity: '',
  cultivationMethod: '', fertiliserProgram: '', nutrientBrands: '', pestManagement: '',
  ipmProcedures: '', waterSource: '', waterTestingFrequency: '', waterAnalysisFile: '',
  mainStrains: '', breeder: '', geneticLineage: '', typicalThc: '', typicalCbd: '',
  dominantTerpenes: '', harvestCycle: '', yieldPerSqm: '',
  qtyAvailableNow: '', qtyAvailable30: '', qtyAvailable60: '', qtyAvailable90: '', qtyAvailable180: '', productPhotoUrl: '',
  coaFiles: '', heavyMetalsTested: '', pesticidesTested: '', mycotoxinsTested: '',
  microbiologyTested: '', waterActivityTested: '', batchTrackingSystem: '', seedToSaleSystem: '',
  sopsAvailable: '', recallProcedure: '', wasteDisposal: '', employeeTraining: '',
  securityProtocols: '', visitorProcedures: '', incidentReporting: '', capaProgram: '',
  internalAudits: '', externalAudits: '',
  suppliedEU: '', suppliedPharma: '', suppliedGMPProcessors: '', existingSopLibrary: '',
  existingQA: '', existingQC: '', qualifiedPerson: '', stabilityProgram: '', changeControl: '',
  deviationProcedures: '', riskManagement: '', documentationControl: '',
  countriesExported: '', freightProviders: '', customsBrokers: '', incotermsFamiliarity: '',
  packagingStandards: '', labellingStandards: '', shippingCapacity: '',
  interestedExclusive: '', interestedNonExclusive: '', interestedEUGMP: '',
  interestedLongTerm: '', interestedJV: '', monthlyReportingAgreement: '',
  scoreCompliance: 0, scoreDocumentation: 0, scoreFacilityQuality: 0,
  scoreProductQuality: 0, scoreExportReadiness: 0, scoreReliability: 0,
  scoreCommunication: 0, scoreScalability: 0, scoreGMPReadiness: 0,
}

const TOTAL_STEPS = 9
const FARM_TYPES = ['Indoor', 'Greenhouse', 'Outdoor', 'Mixed']
const YES_NO = ['Yes', 'No', 'Not yet']

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="form-row-2">{children}</div>
}

function YesNoSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}>
      <option value="">—</option>
      {YES_NO.map(v => <option key={v} value={v}>{v}</option>)}
    </select>
  )
}

export default function FarmerOnboarding({ lang, currentProfile, onSubmit, onBack }: Props) {
  const t = T[lang]
  const [step, setStep] = useState(1)
  const [draftSavedMsg, setDraftSavedMsg] = useState(false)

  // Load draft from localStorage on mount, pre-fill contact info from profile
  const [form, setForm] = useState<Draft>(() => {
    const saved = loadFarmDraft()
    const base = saved ?? { ...BLANK }
    if (currentProfile) {
      base.mobileNumber = base.mobileNumber || currentProfile.phoneNumber || ''
      base.lineId = base.lineId || currentProfile.lineId || ''
      base.email = base.email || currentProfile.email || ''
      base.primaryContact = base.primaryContact || currentProfile.displayName || ''
      base.province = base.province || currentProfile.province || ''
    }
    return base
  })

  function set(field: keyof Draft, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function handleSaveDraft() {
    saveFarmDraft(form)
    setDraftSavedMsg(true)
    setTimeout(() => setDraftSavedMsg(false), 2000)
  }

  function handleContinueLater() {
    saveFarmDraft(form)
    onBack()
  }

  function handleSkip() {
    if (step < TOTAL_STEPS) setStep(s => s + 1)
  }

  function handleNext() {
    saveFarmDraft(form)
    if (step < TOTAL_STEPS) setStep(s => s + 1)
  }

  function handleBack() {
    if (step > 1) setStep(s => s - 1)
  }

  function handleFinalSubmit() {
    clearFarmDraft()
    const now = new Date().toISOString()
    const complete = calcCompletion(form)
    const full: FarmProfile = {
      id: crypto.randomUUID(),
      status: 'Submitted to DDP',
      submittedAt: now,
      completionPct: complete,
      ...Object.fromEntries(
        Object.entries(BLANK).map(([k]) => [k, (form as Record<string, unknown>)[k] ?? (BLANK as Record<string, unknown>)[k]])
      ),
    } as FarmProfile
    onSubmit(full)
  }

  const completionPct = calcCompletion(form)
  const stepTitles = t.wizardStepTitles

  const hints: Record<number, string> = {
    1: t.wizardStep1Hint, 2: t.wizardStep2Hint, 3: t.wizardStep3Hint,
    4: t.wizardStep4Hint, 5: t.wizardStep5Hint, 6: t.wizardStep6Hint,
    7: t.wizardStep7Hint, 8: t.wizardStep8Hint, 9: t.wizardStep9Hint,
  }

  return (
    <div className="page-wrap">
      <div className="page-header farmer-header">
        <div className="page-eyebrow">{t.eyebrow}</div>
        <h1 className="page-title">{t.wizardTitle}</h1>
        <p className="page-desc">{t.wizardDesc}</p>
      </div>

      {/* Progress bar */}
      <div className="wizard-progress-wrap">
        <div className="wizard-progress-meta">
          <span className="wizard-step-label">{t.stepOf(step, TOTAL_STEPS)} — {stepTitles[step - 1]}</span>
          <span className="wizard-completion-pct">{completionPct}% {lang === 'th' ? 'สมบูรณ์' : 'complete'}</span>
        </div>
        <div className="wizard-progress-track">
          <div className="wizard-progress-fill" style={{ width: `${(step / TOTAL_STEPS) * 100}%` }} />
        </div>
        <div className="wizard-step-hint">{hints[step]}</div>
      </div>

      {/* ── Step 1: Farm Basics ── */}
      {step === 1 && (
        <div className="card form-card">
          <Row>
            <Field label={t.tradingName} hint={lang === 'th' ? 'ชื่อที่คุณต้องการให้แสดง' : 'The name you want displayed'}>
              <input value={form.tradingName ?? ''} onChange={e => set('tradingName', e.target.value)} placeholder={lang === 'th' ? 'เช่น สวนพฤกษา' : 'e.g. Green Valley Farm'} />
            </Field>
            <Field label={t.farmType}>
              <select value={form.farmType ?? ''} onChange={e => set('farmType', e.target.value)}>
                <option value="">—</option>
                {FARM_TYPES.map(ft => <option key={ft} value={ft}>{ft}</option>)}
              </select>
            </Field>
          </Row>
          <Row>
            <Field label={t.province}>
              <input value={form.province ?? ''} onChange={e => set('province', e.target.value)} placeholder={lang === 'th' ? 'เช่น เชียงใหม่' : 'e.g. Chiang Mai'} />
            </Field>
            <Field label={t.district}>
              <input value={form.district ?? ''} onChange={e => set('district', e.target.value)} placeholder={lang === 'th' ? 'เช่น แม่ริม' : 'e.g. Mae Rim'} />
            </Field>
          </Row>
        </div>
      )}

      {/* ── Step 2: Contact Details ── */}
      {step === 2 && (
        <div className="card form-card">
          <Row>
            <Field label={t.primaryContact}>
              <input value={form.primaryContact ?? ''} onChange={e => set('primaryContact', e.target.value)} placeholder={lang === 'th' ? 'ชื่อผู้ติดต่อ' : 'Contact name'} />
            </Field>
            <Field label={t.position}>
              <input value={form.position ?? ''} onChange={e => set('position', e.target.value)} placeholder={lang === 'th' ? 'ตำแหน่ง' : 'e.g. Owner, Director'} />
            </Field>
          </Row>
          <Row>
            <Field label={t.mobileNumber}>
              <input type="tel" value={form.mobileNumber ?? ''} onChange={e => set('mobileNumber', e.target.value)} placeholder="+66…" />
            </Field>
            <Field label={t.lineId}>
              <input value={form.lineId ?? ''} onChange={e => set('lineId', e.target.value)} placeholder="@farmname" />
            </Field>
          </Row>
          <Field label={t.email} hint={lang === 'th' ? 'สำหรับการสื่อสารจาก DDP' : 'For DDP communications'}>
            <input type="email" value={form.email ?? ''} onChange={e => set('email', e.target.value)} placeholder="you@example.com" />
          </Field>
        </div>
      )}

      {/* ── Step 3: Farm Photos ── */}
      {step === 3 && (
        <div className="card form-card">
          <Field
            label={t.facilityPhotoUrl}
            hint={lang === 'th' ? 'วางลิงก์จาก Google Photos หรือ LINE' : 'Paste a link from Google Photos, LINE, or any photo host'}
          >
            <input
              type="url"
              value={form.facilityPhotoUrl ?? ''}
              onChange={e => set('facilityPhotoUrl', e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <Field
            label={t.productPhotoUrl}
            hint={lang === 'th' ? 'ลิงก์รูปสินค้าของคุณ (ไม่บังคับ)' : 'Link to a product photo (optional)'}
          >
            <input
              type="url"
              value={form.productPhotoUrl ?? ''}
              onChange={e => set('productPhotoUrl', e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <div className="wizard-photo-note">
            {lang === 'th'
              ? 'ถ้ายังไม่มีลิงก์รูป คุณสามารถถ่ายรูปและส่งทีหลังผ่าน LINE ได้เลย'
              : 'No photo link yet? You can send photos directly to DDP via LINE after registering.'}
          </div>
        </div>
      )}

      {/* ── Step 4: Available Stock ── */}
      {step === 4 && (
        <div className="card form-card">
          <Field
            label={t.mainStrains}
            hint={lang === 'th' ? 'เช่น Red Dragon, OG Kush, Mango' : 'e.g. Red Dragon, OG Kush, Mango'}
          >
            <input value={form.mainStrains ?? ''} onChange={e => set('mainStrains', e.target.value)} placeholder={lang === 'th' ? 'สายพันธุ์ที่คุณปลูก' : 'Strains you grow'} />
          </Field>
          <Row>
            <Field label={t.qtyAvailableNow} hint={lang === 'th' ? 'ปริมาณโดยประมาณ' : 'Approximate quantity'}>
              <input value={form.qtyAvailableNow ?? ''} onChange={e => set('qtyAvailableNow', e.target.value)} placeholder="e.g. 500 kg" />
            </Field>
            <Field label={t.currentInventory} hint={lang === 'th' ? 'สต็อกทั้งหมดในมือ' : 'Total stock on hand'}>
              <input value={form.currentInventory ?? ''} onChange={e => set('currentInventory', e.target.value)} placeholder="e.g. 800 kg" />
            </Field>
          </Row>
        </div>
      )}

      {/* ── Step 5: Strain & Batch Details ── */}
      {step === 5 && (
        <div className="card form-card">
          <Row>
            <Field label={t.typicalThc} hint="e.g. 20–25%">
              <input value={form.typicalThc ?? ''} onChange={e => set('typicalThc', e.target.value)} placeholder="e.g. 22%" />
            </Field>
            <Field label={t.typicalCbd} hint="e.g. 0.1–0.2%">
              <input value={form.typicalCbd ?? ''} onChange={e => set('typicalCbd', e.target.value)} placeholder="e.g. 0.1%" />
            </Field>
          </Row>
          <Row>
            <Field label={t.harvestCycle} hint={lang === 'th' ? 'เช่น ทุก 10–12 สัปดาห์' : 'e.g. 10–12 weeks'}>
              <input value={form.harvestCycle ?? ''} onChange={e => set('harvestCycle', e.target.value)} placeholder="e.g. 10–12 weeks" />
            </Field>
            <Field label={t.harvestsPerYear}>
              <input value={form.harvestsPerYear ?? ''} onChange={e => set('harvestsPerYear', e.target.value)} placeholder="e.g. 4" />
            </Field>
          </Row>
          <Row>
            <Field label={t.avgYieldPerHarvest}>
              <input value={form.avgYieldPerHarvest ?? ''} onChange={e => set('avgYieldPerHarvest', e.target.value)} placeholder="e.g. 500 kg" />
            </Field>
            <Field label={t.annualCapacity}>
              <input value={form.annualCapacity ?? ''} onChange={e => set('annualCapacity', e.target.value)} placeholder="e.g. 2000 kg/year" />
            </Field>
          </Row>
        </div>
      )}

      {/* ── Step 6: Pricing & Availability ── */}
      {step === 6 && (
        <div className="card form-card">
          <Row>
            <Field label={t.qtyAvailable30} hint={lang === 'th' ? 'ปริมาณที่จะมีใน 30 วัน' : 'Qty available in 30 days'}>
              <input value={form.qtyAvailable30 ?? ''} onChange={e => set('qtyAvailable30', e.target.value)} placeholder="e.g. 200 kg" />
            </Field>
            <Field label={t.qtyAvailable60}>
              <input value={form.qtyAvailable60 ?? ''} onChange={e => set('qtyAvailable60', e.target.value)} placeholder="e.g. 200 kg" />
            </Field>
          </Row>
          <Row>
            <Field label={t.qtyAvailable90}>
              <input value={form.qtyAvailable90 ?? ''} onChange={e => set('qtyAvailable90', e.target.value)} placeholder="e.g. 200 kg" />
            </Field>
            <Field label={t.qtyAvailable180}>
              <input value={form.qtyAvailable180 ?? ''} onChange={e => set('qtyAvailable180', e.target.value)} placeholder="e.g. 600 kg" />
            </Field>
          </Row>
          <Field
            label={lang === 'th' ? 'ราคาโดยประมาณต่อกก. (฿)' : 'Approximate price per kg (฿)'}
            hint={lang === 'th' ? 'ราคาคร่าวๆ ปรับได้ทีหลัง' : 'Rough price — can be adjusted later'}
          >
            <input
              value={form.projectedInventory ?? ''}
              onChange={e => set('projectedInventory', e.target.value)}
              placeholder={lang === 'th' ? 'เช่น ฿50,000 – ฿80,000 ต่อกก.' : 'e.g. ฿50,000 – ฿80,000/kg'}
            />
          </Field>
        </div>
      )}

      {/* ── Step 7: COA / Lab Results ── */}
      {step === 7 && (
        <div className="card form-card">
          <Field
            label={t.coaFiles}
            hint={lang === 'th' ? 'ชื่อไฟล์ COA เช่น Mango_COA_2025.pdf' : 'COA filenames, e.g. Mango_COA_2025.pdf'}
          >
            <input value={form.coaFiles ?? ''} onChange={e => set('coaFiles', e.target.value)} placeholder="filename1.pdf, filename2.pdf" />
          </Field>
          <div className="wizard-yn-grid">
            {([
              ['heavyMetalsTested', t.heavyMetalsTested],
              ['pesticidesTested', t.pesticidesTested],
              ['mycotoxinsTested', t.mycotoxinsTested],
              ['microbiologyTested', t.microbiologyTested],
              ['waterActivityTested', t.waterActivityTested],
            ] as [keyof Draft, string][]).map(([field, label]) => (
              <div key={field} className="wizard-yn-row">
                <span>{label}</span>
                <YesNoSelect value={(form[field] as string) ?? ''} onChange={v => set(field, v)} />
              </div>
            ))}
          </div>
          <div className="wizard-photo-note" style={{ marginTop: 12 }}>
            {lang === 'th'
              ? 'ไม่มีเอกสาร COA ตอนนี้? ไม่เป็นไร คุณสามารถเพิ่มได้ทีหลัง'
              : 'No COA files yet? That\'s fine — you can add them later or send via LINE.'}
          </div>
        </div>
      )}

      {/* ── Step 8: Licences ── */}
      {step === 8 && (
        <div className="card form-card">
          <Field
            label={t.cultivationLicence}
            hint={lang === 'th' ? 'ชื่อไฟล์ เช่น CL-CNX-2022.pdf' : 'Filename, e.g. CL-CNX-2022.pdf'}
          >
            <input value={form.cultivationLicence ?? ''} onChange={e => set('cultivationLicence', e.target.value)} placeholder="CL-…pdf" />
          </Field>
          <Row>
            <Field label={t.processingLicence}>
              <input value={form.processingLicence ?? ''} onChange={e => set('processingLicence', e.target.value)} placeholder="PL-…pdf (optional)" />
            </Field>
            <Field label={t.gmpCert}>
              <input value={form.gmpCert ?? ''} onChange={e => set('gmpCert', e.target.value)} placeholder="GMP-…pdf (optional)" />
            </Field>
          </Row>
          <Row>
            <Field label={t.gapCert}>
              <input value={form.gapCert ?? ''} onChange={e => set('gapCert', e.target.value)} placeholder="GAP-…pdf (optional)" />
            </Field>
            <Field label={t.gacpCert}>
              <input value={form.gacpCert ?? ''} onChange={e => set('gacpCert', e.target.value)} placeholder="GACP-…pdf (optional)" />
            </Field>
          </Row>
          <div className="wizard-photo-note" style={{ marginTop: 12 }}>
            {lang === 'th'
              ? 'ถ้ายังไม่มีใบอนุญาตครบ DDP จะช่วยแนะนำขั้นตอนต่อไป'
              : 'Missing some licences? DDP will guide your next steps after reviewing what you have.'}
          </div>
        </div>
      )}

      {/* ── Step 9: Review & Submit ── */}
      {step === 9 && (
        <div className="card form-card">
          <div className="review-completion-row">
            <span className="review-completion-label">{t.reviewCompletion}</span>
            <span className="review-completion-pct">{completionPct}%</span>
          </div>
          <div className="completion-bar-track" style={{ marginBottom: 20 }}>
            <div className="completion-bar-fill" style={{ width: `${completionPct}%` }} />
          </div>

          {/* What you filled in */}
          <div className="review-summary">
            {form.tradingName && <div className="review-pill">✓ {t.tradingName}: {form.tradingName}</div>}
            {form.farmType && <div className="review-pill">✓ {t.farmType}: {form.farmType}</div>}
            {form.province && <div className="review-pill">✓ {t.province}: {form.province}</div>}
            {form.mobileNumber && <div className="review-pill">✓ {t.mobileNumber}: {form.mobileNumber}</div>}
            {form.mainStrains && <div className="review-pill">✓ {t.mainStrains}: {form.mainStrains}</div>}
            {form.typicalThc && <div className="review-pill">✓ THC: {form.typicalThc}</div>}
            {form.coaFiles && <div className="review-pill">✓ COA: {form.coaFiles}</div>}
            {form.cultivationLicence && <div className="review-pill">✓ {t.cultivationLicence}: {form.cultivationLicence}</div>}
          </div>

          {/* What can be added later */}
          <div className="review-can-add-later">
            <div className="review-can-add-title">{t.canAddLater}</div>
            <ul className="review-can-add-list">
              {!form.legalBusinessName && <li>{t.legalBusinessName}</li>}
              {!form.ownerName && <li>{lang === 'th' ? 'โครงสร้างการถือหุ้น' : 'Ownership structure'}</li>}
              {!form.exportLicence && <li>{t.exportLicence}</li>}
              {!form.suppliedEU && <li>{lang === 'th' ? 'ความพร้อมส่งออก' : 'Export readiness'}</li>}
              {!form.batchTrackingSystem && <li>{lang === 'th' ? 'ระบบติดตามแบทช์และ SOP' : 'Batch tracking, SOPs, compliance checklist'}</li>}
            </ul>
          </div>

          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 16 }}>
            {t.wizardStep9Hint}
          </p>

          <button
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 20 }}
            onClick={handleFinalSubmit}
          >
            {t.submitToDDPReview}
          </button>
        </div>
      )}

      {/* ── Wizard controls ── */}
      <div className="wizard-controls">
        <div className="wizard-controls-left">
          {step > 1 && (
            <button className="btn btn-ghost" onClick={handleBack}>{t.btnBack}</button>
          )}
        </div>
        <div className="wizard-controls-center">
          <button className="btn btn-ghost-sm" onClick={handleContinueLater}>
            {t.continueLater}
          </button>
          {draftSavedMsg && (
            <span className="wizard-draft-saved">{t.draftSaved}</span>
          )}
        </div>
        <div className="wizard-controls-right">
          {step < TOTAL_STEPS && (
            <>
              <button className="btn btn-outline-sm" onClick={handleSaveDraft} style={{ marginRight: 8 }}>
                {t.saveProgress}
              </button>
              <button className="btn btn-ghost-sm" onClick={handleSkip} style={{ marginRight: 8 }}>
                {t.skipForNow}
              </button>
              <button className="btn btn-primary" onClick={handleNext}>
                {t.btnNext}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
