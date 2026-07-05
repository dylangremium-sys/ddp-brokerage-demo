import { useState } from 'react'
import { T } from '../../translations'
import { calcCompletion } from '../../data'
import type { Lang, FarmProfile } from '../../types'

interface Props {
  lang: Lang
  farms: FarmProfile[]
  onSave: (farm: FarmProfile) => void
  onBack: () => void
}

type Draft = Partial<FarmProfile>

const YES_NO = ['Yes', 'No', 'Not yet']

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field" style={{ marginBottom: 12 }}>
      <span>{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

function Row2({ children }: { children: React.ReactNode }) {
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="adv-section">
      <button type="button" className="adv-section-toggle" onClick={() => setOpen(o => !o)}>
        <span>{title}</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="adv-section-body">{children}</div>}
    </div>
  )
}

export default function FarmerAdvancedProfile({ lang, farms, onSave, onBack }: Props) {
  const t = T[lang]

  // Pick the most recent submitted farm to edit, or start from blank
  const base = farms.length > 0 ? { ...farms[farms.length - 1] } : undefined
  const [form, setForm] = useState<Draft>(base ?? {})

  function set(field: keyof Draft, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function handleSave() {
    if (!base) return  // No farm to update — guide farmer to complete wizard first
    const updated: FarmProfile = {
      ...base,
      ...form,
      completionPct: calcCompletion({ ...base, ...form }),
    } as FarmProfile
    onSave(updated)
  }

  const noFarm = !base

  return (
    <div className="page-wrap">
      <div className="page-header farmer-header">
        <div className="page-eyebrow">{t.eyebrow}</div>
        <h1 className="page-title">{t.advProfileTitle}</h1>
        <p className="page-desc">{t.advProfileDesc}</p>
      </div>

      {noFarm ? (
        <div className="card form-card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>◈</div>
          <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
            {lang === 'th'
              ? 'กรุณาสร้างโปรไฟล์ฟาร์มขั้นพื้นฐานก่อน แล้วกลับมาเพิ่มรายละเอียดขั้นสูง'
              : 'Complete your basic farm profile first, then return here to add advanced details.'}
          </p>
          <button className="btn btn-primary" onClick={onBack}>{lang === 'th' ? 'กลับแดชบอร์ด' : 'Go to Dashboard'}</button>
        </div>
      ) : (
        <div className="card form-card">

          {/* A — Legal Business Details */}
          <Section title={t.advProfileSectionBusiness}>
            <Row2>
              <Field label={t.legalBusinessName}>
                <input value={(form.legalBusinessName as string) ?? ''} onChange={e => set('legalBusinessName', e.target.value)} />
              </Field>
              <Field label={t.tradingName}>
                <input value={(form.tradingName as string) ?? ''} onChange={e => set('tradingName', e.target.value)} />
              </Field>
            </Row2>
            <Row2>
              <Field label={t.registrationNumber}>
                <input value={(form.registrationNumber as string) ?? ''} onChange={e => set('registrationNumber', e.target.value)} placeholder="TH-2022-XXX-0000" />
              </Field>
              <Field label={t.taxNumber}>
                <input value={(form.taxNumber as string) ?? ''} onChange={e => set('taxNumber', e.target.value)} placeholder="010556…" />
              </Field>
            </Row2>
            <Row2>
              <Field label={t.dateEstablished}>
                <input type="date" value={(form.dateEstablished as string) ?? ''} onChange={e => set('dateEstablished', e.target.value)} />
              </Field>
              <Field label={t.gpsCoordinates} hint="e.g. 18.91°N, 98.93°E">
                <input value={(form.gpsCoordinates as string) ?? ''} onChange={e => set('gpsCoordinates', e.target.value)} />
              </Field>
            </Row2>
            <Field label={t.registeredAddress}>
              <input value={(form.registeredAddress as string) ?? ''} onChange={e => set('registeredAddress', e.target.value)} />
            </Field>
            <Field label={t.operationalAddress}>
              <input value={(form.operationalAddress as string) ?? ''} onChange={e => set('operationalAddress', e.target.value)} />
            </Field>
            <Row2>
              <Field label={t.website}><input value={(form.website as string) ?? ''} onChange={e => set('website', e.target.value)} placeholder="www…" /></Field>
              <Field label={t.facebook}><input value={(form.facebook as string) ?? ''} onChange={e => set('facebook', e.target.value)} /></Field>
            </Row2>
            <Row2>
              <Field label={t.whatsapp}><input value={(form.whatsapp as string) ?? ''} onChange={e => set('whatsapp', e.target.value)} placeholder="+66…" /></Field>
              <Field label={t.secondaryContact}><input value={(form.secondaryContact as string) ?? ''} onChange={e => set('secondaryContact', e.target.value)} /></Field>
            </Row2>
            <Field label={t.emergencyContact}><input value={(form.emergencyContact as string) ?? ''} onChange={e => set('emergencyContact', e.target.value)} /></Field>
          </Section>

          {/* B — Ownership Structure */}
          <Section title={t.advProfileSectionOwnership}>
            <Row2>
              <Field label={t.ownerName}><input value={(form.ownerName as string) ?? ''} onChange={e => set('ownerName', e.target.value)} /></Field>
              <Field label={t.nationality}><input value={(form.nationality as string) ?? ''} onChange={e => set('nationality', e.target.value)} placeholder="Thai" /></Field>
            </Row2>
            <Row2>
              <Field label={t.ownershipPct}><input value={(form.ownershipPct as string) ?? ''} onChange={e => set('ownershipPct', e.target.value)} placeholder="100" /></Field>
              <Field label={t.additionalShareholders}><input value={(form.additionalShareholders as string) ?? ''} onChange={e => set('additionalShareholders', e.target.value)} /></Field>
            </Row2>
            <Field label={t.ownershipBreakdown}><input value={(form.ownershipBreakdown as string) ?? ''} onChange={e => set('ownershipBreakdown', e.target.value)} /></Field>
            <Field label={t.ultimateBeneficialOwners} hint={lang === 'th' ? 'ผู้ที่ได้รับประโยชน์จริง' : 'The person(s) who ultimately benefit from the business'}>
              <input value={(form.ultimateBeneficialOwners as string) ?? ''} onChange={e => set('ultimateBeneficialOwners', e.target.value)} />
            </Field>
            <Row2>
              <Field label={t.parentCompany}><input value={(form.parentCompany as string) ?? ''} onChange={e => set('parentCompany', e.target.value)} placeholder="None" /></Field>
              <Field label={t.subsidiaries}><input value={(form.subsidiaries as string) ?? ''} onChange={e => set('subsidiaries', e.target.value)} placeholder="None" /></Field>
            </Row2>
            <Row2>
              <Field label={t.foreignInvestors}><input value={(form.foreignInvestors as string) ?? ''} onChange={e => set('foreignInvestors', e.target.value)} placeholder="None" /></Field>
              <Field label={t.strategicPartners}><input value={(form.strategicPartners as string) ?? ''} onChange={e => set('strategicPartners', e.target.value)} /></Field>
            </Row2>
          </Section>

          {/* C — Additional Licences */}
          <Section title={t.advProfileSectionLicences}>
            <Row2>
              <Field label={t.processingLicence}><input value={(form.processingLicence as string) ?? ''} onChange={e => set('processingLicence', e.target.value)} placeholder="PL-…pdf" /></Field>
              <Field label={t.manufacturingLicence}><input value={(form.manufacturingLicence as string) ?? ''} onChange={e => set('manufacturingLicence', e.target.value)} placeholder="ML-…pdf" /></Field>
            </Row2>
            <Row2>
              <Field label={t.researchLicence}><input value={(form.researchLicence as string) ?? ''} onChange={e => set('researchLicence', e.target.value)} placeholder="RL-…pdf" /></Field>
              <Field label={t.medicalCannabisLicence}><input value={(form.medicalCannabisLicence as string) ?? ''} onChange={e => set('medicalCannabisLicence', e.target.value)} placeholder="MCL-…pdf" /></Field>
            </Row2>
            <Row2>
              <Field label={t.exportLicence}><input value={(form.exportLicence as string) ?? ''} onChange={e => set('exportLicence', e.target.value)} placeholder="EL-…pdf" /></Field>
              <Field label={t.importLicence}><input value={(form.importLicence as string) ?? ''} onChange={e => set('importLicence', e.target.value)} placeholder="IL-…pdf" /></Field>
            </Row2>
            <Row2>
              <Field label={t.organicCert}><input value={(form.organicCert as string) ?? ''} onChange={e => set('organicCert', e.target.value)} placeholder="ORG-…pdf" /></Field>
              <Field label={t.isoCerts}><input value={(form.isoCerts as string) ?? ''} onChange={e => set('isoCerts', e.target.value)} placeholder="ISO9001-…pdf" /></Field>
            </Row2>
            <Field label={t.otherCerts}><input value={(form.otherCerts as string) ?? ''} onChange={e => set('otherCerts', e.target.value)} /></Field>
            <Field label={t.documentExpiry}><input type="date" value={(form.documentExpiry as string) ?? ''} onChange={e => set('documentExpiry', e.target.value)} /></Field>
          </Section>

          {/* D — Facility Details */}
          <Section title={t.advProfileSectionFacility}>
            <Row2>
              <Field label={t.totalLandArea}><input value={(form.totalLandArea as string) ?? ''} onChange={e => set('totalLandArea', e.target.value)} placeholder="e.g. 12 rai" /></Field>
              <Field label={t.cultivationArea}><input value={(form.cultivationArea as string) ?? ''} onChange={e => set('cultivationArea', e.target.value)} placeholder="e.g. 8 rai" /></Field>
            </Row2>
            <Row2>
              <Field label={t.floweringArea}><input value={(form.floweringArea as string) ?? ''} onChange={e => set('floweringArea', e.target.value)} /></Field>
              <Field label={t.nurseryArea}><input value={(form.nurseryArea as string) ?? ''} onChange={e => set('nurseryArea', e.target.value)} /></Field>
            </Row2>
            <Row2>
              <Field label={t.processingArea}><input value={(form.processingArea as string) ?? ''} onChange={e => set('processingArea', e.target.value)} /></Field>
              <Field label={t.dryingArea}><input value={(form.dryingArea as string) ?? ''} onChange={e => set('dryingArea', e.target.value)} /></Field>
            </Row2>
            <Row2>
              <Field label={t.storageArea}><input value={(form.storageArea as string) ?? ''} onChange={e => set('storageArea', e.target.value)} /></Field>
              <Field label={t.expansionCapacity}><input value={(form.expansionCapacity as string) ?? ''} onChange={e => set('expansionCapacity', e.target.value)} /></Field>
            </Row2>
            <Field label={t.securityArea}><input value={(form.securityArea as string) ?? ''} onChange={e => set('securityArea', e.target.value)} placeholder="e.g. Perimeter fenced with CCTV" /></Field>
          </Section>

          {/* E — Production Details */}
          <Section title={t.advProfileSectionProduction}>
            <Row2>
              <Field label={t.activeRooms}><input value={(form.activeRooms as string) ?? ''} onChange={e => set('activeRooms', e.target.value)} placeholder="e.g. 6" /></Field>
              <Field label={t.productionUtilisation}><input value={(form.productionUtilisation as string) ?? ''} onChange={e => set('productionUtilisation', e.target.value)} placeholder="e.g. 85" /></Field>
            </Row2>
            <Row2>
              <Field label={t.maxProductionCapacity}><input value={(form.maxProductionCapacity as string) ?? ''} onChange={e => set('maxProductionCapacity', e.target.value)} /></Field>
              <Field label={t.projectedInventory}><input value={(form.projectedInventory as string) ?? ''} onChange={e => set('projectedInventory', e.target.value)} /></Field>
            </Row2>
            <Field label={t.cultivationMethod}><input value={(form.cultivationMethod as string) ?? ''} onChange={e => set('cultivationMethod', e.target.value)} placeholder="e.g. Greenhouse hydroponic" /></Field>
            <Row2>
              <Field label={t.fertiliserProgram}><input value={(form.fertiliserProgram as string) ?? ''} onChange={e => set('fertiliserProgram', e.target.value)} /></Field>
              <Field label={t.nutrientBrands}><input value={(form.nutrientBrands as string) ?? ''} onChange={e => set('nutrientBrands', e.target.value)} /></Field>
            </Row2>
            <Row2>
              <Field label={t.pestManagement}><input value={(form.pestManagement as string) ?? ''} onChange={e => set('pestManagement', e.target.value)} /></Field>
              <Field label={t.waterSource}><input value={(form.waterSource as string) ?? ''} onChange={e => set('waterSource', e.target.value)} /></Field>
            </Row2>
            <Row2>
              <Field label={t.waterTestingFrequency}><input value={(form.waterTestingFrequency as string) ?? ''} onChange={e => set('waterTestingFrequency', e.target.value)} placeholder="e.g. Monthly" /></Field>
              <Field label={t.waterAnalysisFile}><input value={(form.waterAnalysisFile as string) ?? ''} onChange={e => set('waterAnalysisFile', e.target.value)} placeholder="water_analysis.pdf" /></Field>
            </Row2>
          </Section>

          {/* F — Genetics */}
          <Section title={t.advProfileSectionGenetics}>
            <Row2>
              <Field label={t.breeder}><input value={(form.breeder as string) ?? ''} onChange={e => set('breeder', e.target.value)} /></Field>
              <Field label={t.geneticLineage}><input value={(form.geneticLineage as string) ?? ''} onChange={e => set('geneticLineage', e.target.value)} /></Field>
            </Row2>
            <Row2>
              <Field label={t.dominantTerpenes}><input value={(form.dominantTerpenes as string) ?? ''} onChange={e => set('dominantTerpenes', e.target.value)} placeholder="e.g. Myrcene, Limonene" /></Field>
              <Field label={t.yieldPerSqm}><input value={(form.yieldPerSqm as string) ?? ''} onChange={e => set('yieldPerSqm', e.target.value)} placeholder="e.g. 450g" /></Field>
            </Row2>
          </Section>

          {/* G — Compliance Checklist */}
          <Section title={t.advProfileSectionCompliance}>
            <div className="wizard-yn-grid">
              {([
                ['batchTrackingSystem', t.batchTrackingSystem],
                ['seedToSaleSystem', t.seedToSaleSystem],
                ['sopsAvailable', t.sopsAvailable],
                ['recallProcedure', t.recallProcedure],
                ['wasteDisposal', t.wasteDisposal],
                ['employeeTraining', t.employeeTraining],
                ['securityProtocols', t.securityProtocols],
                ['visitorProcedures', t.visitorProcedures],
                ['incidentReporting', t.incidentReporting],
                ['capaProgram', t.capaProgram],
                ['internalAudits', t.internalAudits],
                ['externalAudits', t.externalAudits],
              ] as [keyof Draft, string][]).map(([field, label]) => (
                <div key={field} className="wizard-yn-row">
                  <span>{label}</span>
                  <YesNoSelect value={(form[field] as string) ?? ''} onChange={v => set(field, v)} />
                </div>
              ))}
            </div>
          </Section>

          {/* H — Export & GMP Readiness */}
          <Section title={t.advProfileSectionExport}>
            <div className="wizard-yn-grid" style={{ marginBottom: 16 }}>
              {([
                ['suppliedEU', t.suppliedEU],
                ['suppliedPharma', t.suppliedPharma],
                ['suppliedGMPProcessors', t.suppliedGMPProcessors],
                ['existingSopLibrary', t.existingSopLibrary],
                ['existingQA', t.existingQA],
                ['existingQC', t.existingQC],
                ['qualifiedPerson', t.qualifiedPerson],
                ['stabilityProgram', t.stabilityProgram],
                ['changeControl', t.changeControl],
                ['deviationProcedures', t.deviationProcedures],
                ['riskManagement', t.riskManagement],
                ['documentationControl', t.documentationControl],
              ] as [keyof Draft, string][]).map(([field, label]) => (
                <div key={field} className="wizard-yn-row">
                  <span>{label}</span>
                  <YesNoSelect value={(form[field] as string) ?? ''} onChange={v => set(field, v)} />
                </div>
              ))}
            </div>
            <Row2>
              <Field label={t.countriesExported}><input value={(form.countriesExported as string) ?? ''} onChange={e => set('countriesExported', e.target.value)} placeholder="e.g. Germany, Czech Republic" /></Field>
              <Field label={t.freightProviders}><input value={(form.freightProviders as string) ?? ''} onChange={e => set('freightProviders', e.target.value)} /></Field>
            </Row2>
            <Row2>
              <Field label={t.customsBrokers}><input value={(form.customsBrokers as string) ?? ''} onChange={e => set('customsBrokers', e.target.value)} /></Field>
              <Field label={t.incotermsFamiliarity}><input value={(form.incotermsFamiliarity as string) ?? ''} onChange={e => set('incotermsFamiliarity', e.target.value)} placeholder="e.g. CIF, FOB" /></Field>
            </Row2>
            <Row2>
              <Field label={t.packagingStandards}><input value={(form.packagingStandards as string) ?? ''} onChange={e => set('packagingStandards', e.target.value)} /></Field>
              <Field label={t.labellingStandards}><input value={(form.labellingStandards as string) ?? ''} onChange={e => set('labellingStandards', e.target.value)} /></Field>
            </Row2>
            <Field label={t.shippingCapacity}><input value={(form.shippingCapacity as string) ?? ''} onChange={e => set('shippingCapacity', e.target.value)} placeholder="e.g. Up to 500 kg per shipment" /></Field>
          </Section>

          {/* I — Partnership Preferences */}
          <Section title={t.advProfileSectionPartnership}>
            <div className="wizard-yn-grid">
              {([
                ['interestedExclusive', t.interestedExclusive],
                ['interestedNonExclusive', t.interestedNonExclusive],
                ['interestedEUGMP', t.interestedEUGMP],
                ['interestedLongTerm', t.interestedLongTerm],
                ['interestedJV', t.interestedJV],
                ['monthlyReportingAgreement', t.monthlyReportingAgreement],
              ] as [keyof Draft, string][]).map(([field, label]) => (
                <div key={field} className="wizard-yn-row">
                  <span>{label}</span>
                  <YesNoSelect value={(form[field] as string) ?? ''} onChange={v => set(field, v)} />
                </div>
              ))}
            </div>
          </Section>

          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <button className="btn btn-ghost" onClick={onBack}>{t.btnBack}</button>
            <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={handleSave}>
              {t.advProfileSave}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
