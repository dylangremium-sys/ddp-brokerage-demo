import { useState } from 'react'
import { validateFarmProfile, blockingIssues, type FarmValidationIssue } from '../../lib/farmProfileValidation'
import { T } from '../../translations'
import { calcCompletion, loadFarmDraft, saveFarmDraft, clearFarmDraft } from '../../data'
import type { Lang, FarmProfile } from '../../types'
import type { UserProfile } from '../../services/auth'
import '../../styles/farmerOnboarding.css'

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

/** [English, Thai] names for the fields validation can complain about. */
const FIELD_LABELS: Record<string, [string, string]> = {
  tradingName: ['Farm / trading name', 'ชื่อฟาร์ม'],
  province: ['Province', 'จังหวัด'],
  district: ['District', 'อำเภอ'],
  farmType: ['Farm type', 'ประเภทฟาร์ม'],
  primaryContact: ['Contact name', 'ชื่อผู้ติดต่อ'],
  position: ['Position', 'ตำแหน่ง'],
  email: ['Email', 'อีเมล'],
  mobileNumber: ['Mobile number', 'เบอร์มือถือ'],
  lineId: ['LINE ID', 'ไลน์ไอดี'],
  qtyAvailableNow: ['Quantity available now', 'ปริมาณที่มีตอนนี้'],
  typicalThc: ['Typical THC %', 'THC โดยทั่วไป (%)'],
  typicalCbd: ['Typical CBD %', 'CBD โดยทั่วไป (%)'],
  harvestsPerYear: ['Harvests per year', 'จำนวนรอบเก็บเกี่ยวต่อปี'],
  avgYieldPerHarvest: ['Average yield per harvest', 'ผลผลิตเฉลี่ยต่อรอบ'],
  annualCapacity: ['Annual capacity', 'กำลังผลิตต่อปี'],
  qtyAvailable30: ['Available in 30 days', 'พร้อมส่งใน 30 วัน'],
  qtyAvailable60: ['Available in 60 days', 'พร้อมส่งใน 60 วัน'],
  qtyAvailable90: ['Available in 90 days', 'พร้อมส่งใน 90 วัน'],
  qtyAvailable180: ['Available in 180 days', 'พร้อมส่งใน 180 วัน'],
}

/**
 * Bilingual on the spot, matching how the rest of the farmer screens handle
 * copy. The validator returns codes precisely so it stays free of UI.
 */
function describeIssue(issue: FarmValidationIssue, lang: Lang): string {
  const th = lang === 'th'
  const label = (FIELD_LABELS[issue.field] ?? [issue.field, issue.field])[th ? 1 : 0]
  switch (issue.code) {
    case 'required':          return th ? `กรุณากรอก${label}` : `${label} is required`
    case 'contact-required':  return th
      ? 'กรุณาระบุช่องทางติดต่ออย่างน้อยหนึ่งช่องทาง (อีเมล เบอร์มือถือ หรือ LINE)'
      : 'Give DDP at least one way to contact you — email, mobile or LINE'
    case 'email-invalid':     return th ? 'รูปแบบอีเมลไม่ถูกต้อง' : 'That email address does not look right'
    case 'phone-invalid':     return th ? 'เบอร์โทรศัพท์ไม่ถูกต้อง' : 'That phone number does not look right'
    case 'not-a-number':      return th ? `${label} ต้องเป็นตัวเลข` : `${label} must be a number`
    case 'negative':          return th ? `${label} ต้องไม่ติดลบ` : `${label} cannot be negative`
    case 'percent-out-of-range': return th ? `${label} ต้องอยู่ระหว่าง 0 ถึง 100` : `${label} must be between 0 and 100`
    case 'cannabinoids-implausible': return th
      ? 'THC และ CBD รวมกันเกิน 100% — โปรดตรวจสอบอีกครั้ง'
      : 'THC and CBD add up to more than 100% — please double-check'
    // Unreachable while the union is exhaustive, but a new code must degrade
    // to something a farmer can read rather than to `undefined`.
    default: return issue.code
  }
}


const TOTAL_STEPS = 9
const FARM_TYPES = ['Indoor', 'Greenhouse', 'Outdoor', 'Mixed']
const YES_NO = ['Yes', 'No', 'Not yet']

// Maps the simple farmer-facing licence/cert dropdown to the existing FarmProfile fields.
const LICENCE_TYPE_FIELDS = {
  thai: 'cultivationLicence',
  gap: 'gapCert',
  gacp: 'gacpCert',
  gmp: 'gmpCert',
  organic: 'organicCert',
  other: 'otherCerts',
} as const

type LicenceTypeKey = 'none' | keyof typeof LICENCE_TYPE_FIELDS

function detectLicenceType(f: Draft): LicenceTypeKey {
  const entry = (Object.entries(LICENCE_TYPE_FIELDS) as [Exclude<LicenceTypeKey, 'none'>, keyof Draft][])
    .find(([, field]) => !!(f[field] as string | undefined)?.trim())
  return entry ? entry[0] : 'none'
}

function splitLicenceValue(value: string): { number: string; doc: string } {
  const match = value.match(/^(.*?)(?: \((.*)\))?$/)
  return { number: match?.[1] ?? '', doc: match?.[2] ?? '' }
}

function combineLicenceValue(number: string, doc: string): string {
  if (number && doc) return `${number} (${doc})`
  return number || doc
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
  const [issues, setIssues] = useState<FarmValidationIssue[]>([])
  const [warningsSeen, setWarningsSeen] = useState(false)
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
    // An edit invalidates a previous acknowledgement: the farmer may have just
    // fixed what they were warned about, or introduced something new. Without
    // this, a second warning could reach the database unseen.
    setWarningsSeen(false)
    setForm(prev => ({ ...prev, [field]: value }))
  }

  // Simple certification / licence picker (Step 8) — writes into the existing
  // per-type FarmProfile fields so admin views and completion scoring see no change.
  const [licenceType, setLicenceType] = useState<LicenceTypeKey>(() => detectLicenceType(form))
  const [licenceNumber, setLicenceNumber] = useState(() => {
    const t0 = detectLicenceType(form)
    return t0 === 'none' ? '' : splitLicenceValue((form[LICENCE_TYPE_FIELDS[t0]] as string) ?? '').number
  })
  const [licenceDoc, setLicenceDoc] = useState(() => {
    const t0 = detectLicenceType(form)
    return t0 === 'none' ? '' : splitLicenceValue((form[LICENCE_TYPE_FIELDS[t0]] as string) ?? '').doc
  })

  function commitLicence(nextType: LicenceTypeKey, nextNumber: string, nextDoc: string) {
    if (nextType === 'none') return
    set(LICENCE_TYPE_FIELDS[nextType], combineLicenceValue(nextNumber, nextDoc))
  }

  function handleLicenceTypeChange(v: LicenceTypeKey) {
    setLicenceType(v)
    commitLicence(v, licenceNumber, licenceDoc)
  }
  function handleLicenceNumberChange(v: string) {
    setLicenceNumber(v)
    commitLicence(licenceType, v, licenceDoc)
  }
  function handleLicenceDocChange(v: string) {
    setLicenceDoc(v)
    commitLicence(licenceType, licenceNumber, v)
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
    // Checked only here. Saving a draft and stepping between pages stays
    // unblocked: a farmer part-way through nine steps on a phone must always
    // be able to stop without losing the work.
    const found = validateFarmProfile(form as Record<string, unknown>)
    setIssues(found)

    // A warning the farmer never sees is not a warning. On a clean-but-warned
    // submission the save succeeds and the app navigates straight to
    // farmer-status, so without this the "please double-check" message would
    // render and be gone in the same click. First press shows it; a second
    // press submits anyway. It never blocks — it just refuses to be silent.
    const warnings = found.filter(i => i.severity === 'warning')
    if (blockingIssues(found).length === 0 && warnings.length > 0 && !warningsSeen) {
      setWarningsSeen(true)
      return
    }

    if (blockingIssues(found).length > 0) {
      // Deliberately stays on the review step. Jumping straight to the first
      // bad field moves the farmer away from the summary that explains why —
      // they get teleported with no reason given. The panel lists everything
      // and each entry carries its own "go to step" link, so the farmer
      // chooses, and can see the whole list before deciding.
      return
    }
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
    <div className="organic-scope">
    <div className="ob">
    <div className="ob-inner">
      <div>
        <div className="ob-eyebrow">{t.eyebrow}</div>
        <h1 className="ob-title">{t.wizardTitle}</h1>
        <p className="ob-desc">{t.wizardDesc}</p>
      </div>

      <div className="ob-cols">
        {/* ── Stage rail ──────────────────────────────────────────────────
            Replaces a 4px bar whose only signal was a creeping percentage.
            Nine entries, because there are nine steps — see the note at the
            head of styles/farmerOnboarding.css on why they were not regrouped
            into the handoff's four stages.

            Each entry is a button: the wizard already allowed movement between
            steps, and a rail you can read but not use is a worse rail. */}
        <nav className="ob-rail" aria-label={t.wizardTitle}>
          {stepTitles.map((title, i) => {
            const n = i + 1
            const state = n === step ? 'is-current' : n < step ? 'is-done' : ''
            return (
              <button
                key={title}
                type="button"
                className={`ob-stage ${state}`}
                aria-current={n === step ? 'step' : undefined}
                /*
                 * The accessible name is navigational, not the step title.
                 *
                 * Step 9 is called "Ready to Submit?", so a rail entry carrying
                 * that title announces as a submit control sitting beside the
                 * real one — two buttons a screen reader reads as the same
                 * action, one of which only scrolls. The validation tests found
                 * it first ("Found multiple elements with the role button and
                 * name /submit|send to ddp|finish/"), but the ambiguity is real
                 * before it is a test failure.
                 *
                 * The title stays visible; only the announced name changes.
                 */
                aria-label={lang === 'th' ? `ไปที่ขั้นตอนที่ ${n}` : `Go to step ${n}`}
                onClick={() => setStep(n)}
              >
                <span className="ob-stage-num" aria-hidden="true">{n}</span>
                <span>
                  <span className="ob-stage-name">{title}</span>
                  <span className="ob-stage-state">
                    {n === step
                      ? t.stepOf(step, TOTAL_STEPS)
                      : `${completionPct}% ${lang === 'th' ? 'สมบูรณ์' : 'complete'}`}
                  </span>
                </span>
              </button>
            )
          })}
        </nav>

        <div className="ob-panel">
          {/* The step's own hint, kept — it is the one line telling a farmer
              what this step is for. */}
          <p className="ob-panel-hint">{hints[step]}</p>

      {/* ── Step 1: Farm Basics ── */}
      {step === 1 && (
        <div className="card form-card">
          <Row>
            <Field label={t.tradingName} hint={lang === 'th' ? 'ชื่อที่คุณต้องการให้แสดง' : 'The name you want displayed'}>
              <input value={form.tradingName ?? ''} onChange={e => set('tradingName', e.target.value)} placeholder={lang === 'th' ? 'เช่น สวนพฤกษา' : 'e.g. Green Valley Farm'} />
            </Field>
            {/* A segmented control, not a dropdown. The handoff is explicit
                that farm type is never free text and never a select whose
                empty value renders as "—" — which is exactly what the live
                build shows here, so "—" reads as a farm type rather than as
                "not answered".

                Same field, same four stored values, same `set` call. Only the
                affordance changed: four visible options a thumb can hit,
                instead of a menu that hides them and defaults to a dash. */}
            <Field label={t.farmType}>
              <div className="ob-seg" role="group" aria-label={t.farmType}>
                {FARM_TYPES.map(ft => (
                  <button
                    key={ft}
                    type="button"
                    className={`ob-seg-opt${form.farmType === ft ? ' is-active' : ''}`}
                    aria-pressed={form.farmType === ft}
                    onClick={() => set('farmType', ft)}
                  >
                    {ft}
                  </button>
                ))}
              </div>
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

      {/* ── Step 8: Certification / Licence ── */}
      {step === 8 && (
        <div className="card form-card">
          <Field label={t.licenceTypeLabel}>
            <select
              value={licenceType}
              onChange={e => handleLicenceTypeChange(e.target.value as LicenceTypeKey)}
            >
              <option value="none">{t.licenceTypeNone}</option>
              <option value="thai">{t.licenceTypeThai}</option>
              <option value="gap">{t.licenceTypeGap}</option>
              <option value="gacp">{t.licenceTypeGacp}</option>
              <option value="gmp">{t.licenceTypeGmp}</option>
              <option value="organic">{t.licenceTypeOrganic}</option>
              <option value="other">{t.licenceTypeOther}</option>
            </select>
          </Field>

          {licenceType !== 'none' && (
            <Row>
              <Field label={t.licenceNumberLabel} hint={t.licenceNumberHint}>
                <input
                  value={licenceNumber}
                  onChange={e => handleLicenceNumberChange(e.target.value)}
                  placeholder="e.g. TH-2024-00123"
                />
              </Field>
              <Field label={t.licenceDocLabel} hint={t.licenceDocHint}>
                <input
                  value={licenceDoc}
                  onChange={e => handleLicenceDocChange(e.target.value)}
                  placeholder="CL-CNX-2022.pdf"
                />
              </Field>
            </Row>
          )}

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
            {licenceType !== 'none' && form[LICENCE_TYPE_FIELDS[licenceType]] && (
              <div className="review-pill">✓ {t.licenceTypeLabel}: {form[LICENCE_TYPE_FIELDS[licenceType]]}</div>
            )}
          </div>

          {issues.length > 0 && (
            <div
              className="form-error-panel"
              role="alert"
              style={{
                border: '1px solid var(--danger, #c0392b)', borderRadius: 8,
                padding: '12px 14px', marginBottom: 16,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {lang === 'th' ? 'กรุณาตรวจสอบข้อมูลต่อไปนี้' : 'Please check the following'}
              </div>
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {issues.map(i => (
                  <li key={`${i.field}-${i.code}`} style={{ marginBottom: 2 }}>
                    {describeIssue(i, lang)}
                    {' '}
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => setStep(i.step)}
                      style={{ background: 'none', border: 0, padding: 0, textDecoration: 'underline', cursor: 'pointer' }}
                    >
                      {lang === 'th' ? `(ไปขั้นตอนที่ ${i.step})` : `(go to step ${i.step})`}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

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

          {/* ── Controls ──────────────────────────────────────────────────
              EVERY control the wizard had is still here. The handoff's
              complaint is that four exits of equal weight give a farmer no
              idea which one is the way forward — and the fix for that is
              hierarchy, not amputation. One filled button, the rest secondary
              or text. Someone who relies on "Skip for now" still finds it. */}
          <div className="ob-foot">
            <span className="ob-foot-status">
              {draftSavedMsg ? t.draftSaved : `${completionPct}% ${lang === 'th' ? 'สมบูรณ์' : 'complete'}`}
            </span>

            {step > 1 && (
              <button type="button" className="btn btn-ghost" onClick={handleBack}>{t.btnBack}</button>
            )}
            <button type="button" className="btn btn-ghost" onClick={handleContinueLater}>
              {t.continueLater}
            </button>
            {step < TOTAL_STEPS && (
              <>
                <button type="button" className="btn btn-ghost" onClick={handleSkip}>
                  {t.skipForNow}
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleSaveDraft}>
                  {t.saveProgress}
                </button>
                <button type="button" className="btn btn-primary" onClick={handleNext}>
                  {t.btnNext}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
    </div>
    </div>
  )
}
