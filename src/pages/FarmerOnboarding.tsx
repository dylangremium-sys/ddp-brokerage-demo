import { useState } from 'react'
import { T, FARM_STATUS_LABEL } from '../translations'
import { calcCompletion } from '../data'
import type { Lang, FarmProfile, FarmStatus } from '../types'

interface Props {
  lang: Lang
  onSubmit: (farm: FarmProfile) => void
  onBack: () => void
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
  gmpCert: '', gapCert: '', gacpCert: '', organicCert: '', isoCerts: '', otherCerts: '', documentExpiry: '',
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
  existingQA: '', existingQC: '', qualifiedPerson: '', stabilityProgram: '',
  changeControl: '', deviationProcedures: '', riskManagement: '', documentationControl: '',
  countriesExported: '', freightProviders: '', customsBrokers: '', incotermsFamiliarity: '',
  packagingStandards: '', labellingStandards: '', shippingCapacity: '',
  interestedExclusive: '', interestedNonExclusive: '', interestedEUGMP: '',
  interestedLongTerm: '', interestedJV: '', monthlyReportingAgreement: '',
  scoreCompliance: 0, scoreDocumentation: 0, scoreFacilityQuality: 0,
  scoreProductQuality: 0, scoreExportReadiness: 0, scoreReliability: 0,
  scoreCommunication: 0, scoreScalability: 0, scoreGMPReadiness: 0,
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function TextInput({ name, value, onChange, placeholder }: {
  name: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder?: string
}) {
  return <input name={name} value={value} onChange={onChange} placeholder={placeholder || ''} />
}

function YesNo({ name, value, onChange }: {
  name: string; value: string; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
}) {
  return (
    <select name={name} value={value} onChange={onChange}>
      <option value="">— Select —</option>
      <option value="Yes">Yes</option>
      <option value="No">No</option>
    </select>
  )
}

export default function FarmerOnboarding({ lang, onSubmit, onBack }: Props) {
  const [step, setStep] = useState(1)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [submitted, setSubmitted] = useState(false)
  const t = T[lang]
  const TOTAL_STEPS = 9

  function handleText(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setDraft(d => ({ ...d, [e.target.name]: e.target.value }))
  }

  function handleSubmit() {
    const completion = calcCompletion(draft)
    const farm: FarmProfile = {
      ...BLANK as FarmProfile,
      ...draft as FarmProfile,
      id: crypto.randomUUID(),
      status: 'Submitted to DDP' as FarmStatus,
      submittedAt: new Date().toISOString(),
      completionPct: completion,
      partnerTier: 'Pending',
      scoreCompliance: 0, scoreDocumentation: 0, scoreFacilityQuality: 0,
      scoreProductQuality: 0, scoreExportReadiness: 0, scoreReliability: 0,
      scoreCommunication: 0, scoreScalability: 0, scoreGMPReadiness: 0,
    }
    onSubmit(farm)
    setSubmitted(true)
  }

  const completion = calcCompletion(draft)
  const missingDocs: string[] = []
  if (!draft.cultivationLicence) missingDocs.push(t.missingCultivationLicence)
  if (!draft.exportLicence) missingDocs.push(t.missingExportLicence)
  if (!draft.gmpCert) missingDocs.push(t.missingGMPCert)
  if (!draft.coaFiles) missingDocs.push(t.missingCOA)

  if (submitted) {
    return (
      <div className="page-wrap">
        <div className="page-header farmer-header">
          <div className="farmer-header-row">
            <div className="page-eyebrow">{t.eyebrow}</div>
          </div>
          <h1 className="page-title">{t.onboardingTitle}</h1>
        </div>
        <div className="alert alert-success">
          <strong>{t.reviewSuccessTitle}</strong> {t.reviewSuccessBody}
        </div>
        <button className="btn btn-primary" onClick={onBack}>{t.navStatus}</button>
      </div>
    )
  }

  return (
    <div className="page-wrap">
      <div className="page-header farmer-header">
        <div className="farmer-header-row">
          <div className="page-eyebrow">{t.eyebrow}</div>
        </div>
        <h1 className="page-title">{t.onboardingTitle}</h1>
        <p className="page-desc">{t.onboardingDesc}</p>
      </div>

      {/* Progress */}
      <div className="wizard-progress-wrap card" style={{ padding: '16px 24px', marginBottom: 20 }}>
        <div className="wizard-step-header">
          <span className="wizard-step-label-text">{t.stepOf(step, TOTAL_STEPS)} — {t.stepTitles[step - 1]}</span>
          <span className="wizard-completion-badge">{completion}% {t.reviewCompletion}</span>
        </div>
        <div className="wizard-progress-track">
          <div className="wizard-progress-fill" style={{ width: `${(step / TOTAL_STEPS) * 100}%` }} />
        </div>
        <div className="wizard-steps-row">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={`wizard-step-dot ${i + 1 < step ? 'dot-done' : i + 1 === step ? 'dot-active' : 'dot-future'}`}
              onClick={() => setStep(i + 1)}
              title={t.stepTitles[i]}
            >{i + 1}</div>
          ))}
        </div>
      </div>

      <div className="card form-card">
        <div className="form-section-title">{t.stepTitles[step - 1]}</div>

        {step === 1 && (
          <div>
            <div className="form-grid-3">
              <Field label={t.legalBusinessName}><TextInput name="legalBusinessName" value={draft.legalBusinessName || ''} onChange={handleText} /></Field>
              <Field label={t.tradingName}><TextInput name="tradingName" value={draft.tradingName || ''} onChange={handleText} /></Field>
              <Field label={t.registrationNumber}><TextInput name="registrationNumber" value={draft.registrationNumber || ''} onChange={handleText} /></Field>
              <Field label={t.taxNumber}><TextInput name="taxNumber" value={draft.taxNumber || ''} onChange={handleText} /></Field>
              <Field label={t.dateEstablished}><input type="date" name="dateEstablished" value={draft.dateEstablished || ''} onChange={handleText} /></Field>
              <Field label={t.province}><TextInput name="province" value={draft.province || ''} onChange={handleText} /></Field>
              <Field label={t.district}><TextInput name="district" value={draft.district || ''} onChange={handleText} /></Field>
              <Field label={t.gpsCoordinates}><TextInput name="gpsCoordinates" value={draft.gpsCoordinates || ''} onChange={handleText} placeholder="e.g. 14.63° N, 102.79° E" /></Field>
              <Field label={t.email}><TextInput name="email" value={draft.email || ''} onChange={handleText} placeholder="email@farm.com" /></Field>
              <Field label={t.primaryContact}><TextInput name="primaryContact" value={draft.primaryContact || ''} onChange={handleText} /></Field>
              <Field label={t.position}><TextInput name="position" value={draft.position || ''} onChange={handleText} /></Field>
              <Field label={t.mobileNumber}><TextInput name="mobileNumber" value={draft.mobileNumber || ''} onChange={handleText} /></Field>
            </div>
            <div className="form-grid-2" style={{ marginTop: 16 }}>
              <Field label={t.registeredAddress}><TextInput name="registeredAddress" value={draft.registeredAddress || ''} onChange={handleText} /></Field>
              <Field label={t.operationalAddress}><TextInput name="operationalAddress" value={draft.operationalAddress || ''} onChange={handleText} /></Field>
              <Field label={t.website}><TextInput name="website" value={draft.website || ''} onChange={handleText} /></Field>
              <Field label={t.facebook}><TextInput name="facebook" value={draft.facebook || ''} onChange={handleText} /></Field>
              <Field label={t.lineId}><TextInput name="lineId" value={draft.lineId || ''} onChange={handleText} /></Field>
              <Field label={t.whatsapp}><TextInput name="whatsapp" value={draft.whatsapp || ''} onChange={handleText} /></Field>
              <Field label={t.secondaryContact}><TextInput name="secondaryContact" value={draft.secondaryContact || ''} onChange={handleText} /></Field>
              <Field label={t.emergencyContact}><TextInput name="emergencyContact" value={draft.emergencyContact || ''} onChange={handleText} /></Field>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="form-grid-3">
            <Field label={t.ownerName}><TextInput name="ownerName" value={draft.ownerName || ''} onChange={handleText} /></Field>
            <Field label={t.nationality}><TextInput name="nationality" value={draft.nationality || ''} onChange={handleText} /></Field>
            <Field label={t.ownershipPct}><TextInput name="ownershipPct" value={draft.ownershipPct || ''} onChange={handleText} placeholder="e.g. 100" /></Field>
            <Field label={t.additionalShareholders}><TextInput name="additionalShareholders" value={draft.additionalShareholders || ''} onChange={handleText} /></Field>
            <Field label={t.ownershipBreakdown}><TextInput name="ownershipBreakdown" value={draft.ownershipBreakdown || ''} onChange={handleText} /></Field>
            <Field label={t.ultimateBeneficialOwners}><TextInput name="ultimateBeneficialOwners" value={draft.ultimateBeneficialOwners || ''} onChange={handleText} /></Field>
            <Field label={t.parentCompany}><TextInput name="parentCompany" value={draft.parentCompany || ''} onChange={handleText} /></Field>
            <Field label={t.subsidiaries}><TextInput name="subsidiaries" value={draft.subsidiaries || ''} onChange={handleText} /></Field>
            <Field label={t.foreignInvestors}><TextInput name="foreignInvestors" value={draft.foreignInvestors || ''} onChange={handleText} /></Field>
            <Field label={t.strategicPartners}><TextInput name="strategicPartners" value={draft.strategicPartners || ''} onChange={handleText} /></Field>
            <Field label={t.exportPartners}><TextInput name="exportPartners" value={draft.exportPartners || ''} onChange={handleText} /></Field>
          </div>
        )}

        {step === 3 && (
          <div>
            <p style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
              Enter the file name of each document. Do not upload actual files.
            </p>
            <div className="form-grid-2">
              <Field label={t.cultivationLicence}><TextInput name="cultivationLicence" value={draft.cultivationLicence || ''} onChange={handleText} placeholder="e.g. cultivation_licence.pdf" /></Field>
              <Field label={t.processingLicence}><TextInput name="processingLicence" value={draft.processingLicence || ''} onChange={handleText} placeholder="e.g. processing_licence.pdf" /></Field>
              <Field label={t.manufacturingLicence}><TextInput name="manufacturingLicence" value={draft.manufacturingLicence || ''} onChange={handleText} /></Field>
              <Field label={t.researchLicence}><TextInput name="researchLicence" value={draft.researchLicence || ''} onChange={handleText} /></Field>
              <Field label={t.medicalCannabisLicence}><TextInput name="medicalCannabisLicence" value={draft.medicalCannabisLicence || ''} onChange={handleText} /></Field>
              <Field label={t.exportLicence}><TextInput name="exportLicence" value={draft.exportLicence || ''} onChange={handleText} /></Field>
              <Field label={t.importLicence}><TextInput name="importLicence" value={draft.importLicence || ''} onChange={handleText} /></Field>
              <Field label={t.gmpCert}><TextInput name="gmpCert" value={draft.gmpCert || ''} onChange={handleText} /></Field>
              <Field label={t.gapCert}><TextInput name="gapCert" value={draft.gapCert || ''} onChange={handleText} /></Field>
              <Field label={t.gacpCert}><TextInput name="gacpCert" value={draft.gacpCert || ''} onChange={handleText} /></Field>
              <Field label={t.organicCert}><TextInput name="organicCert" value={draft.organicCert || ''} onChange={handleText} /></Field>
              <Field label={t.isoCerts}><TextInput name="isoCerts" value={draft.isoCerts || ''} onChange={handleText} /></Field>
              <Field label={t.otherCerts}><TextInput name="otherCerts" value={draft.otherCerts || ''} onChange={handleText} /></Field>
              <Field label={t.documentExpiry}><input type="date" name="documentExpiry" value={draft.documentExpiry || ''} onChange={handleText} /></Field>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="form-grid-3">
            <Field label={t.farmType}>
              <select name="farmType" value={draft.farmType || ''} onChange={handleText}>
                <option value="">— Select —</option>
                <option value="Indoor">Indoor</option>
                <option value="Greenhouse">Greenhouse</option>
                <option value="Outdoor">Outdoor</option>
                <option value="Mixed">Mixed</option>
              </select>
            </Field>
            <Field label={t.totalLandArea}><TextInput name="totalLandArea" value={draft.totalLandArea || ''} onChange={handleText} placeholder="e.g. 10 rai" /></Field>
            <Field label={t.cultivationArea}><TextInput name="cultivationArea" value={draft.cultivationArea || ''} onChange={handleText} /></Field>
            <Field label={t.floweringArea}><TextInput name="floweringArea" value={draft.floweringArea || ''} onChange={handleText} /></Field>
            <Field label={t.nurseryArea}><TextInput name="nurseryArea" value={draft.nurseryArea || ''} onChange={handleText} /></Field>
            <Field label={t.motherPlantArea}><TextInput name="motherPlantArea" value={draft.motherPlantArea || ''} onChange={handleText} /></Field>
            <Field label={t.processingArea}><TextInput name="processingArea" value={draft.processingArea || ''} onChange={handleText} /></Field>
            <Field label={t.dryingArea}><TextInput name="dryingArea" value={draft.dryingArea || ''} onChange={handleText} /></Field>
            <Field label={t.storageArea}><TextInput name="storageArea" value={draft.storageArea || ''} onChange={handleText} /></Field>
            <Field label={t.securityArea}><TextInput name="securityArea" value={draft.securityArea || ''} onChange={handleText} /></Field>
            <Field label={t.expansionCapacity}><TextInput name="expansionCapacity" value={draft.expansionCapacity || ''} onChange={handleText} /></Field>
            <Field label={t.facilityPhotoUrl}><TextInput name="facilityPhotoUrl" value={draft.facilityPhotoUrl || ''} onChange={handleText} placeholder="https://..." /></Field>
          </div>
        )}

        {step === 5 && (
          <div className="form-grid-3">
            <Field label={t.activeRooms}><TextInput name="activeRooms" value={draft.activeRooms || ''} onChange={handleText} /></Field>
            <Field label={t.harvestsPerYear}><TextInput name="harvestsPerYear" value={draft.harvestsPerYear || ''} onChange={handleText} /></Field>
            <Field label={t.avgYieldPerHarvest}><TextInput name="avgYieldPerHarvest" value={draft.avgYieldPerHarvest || ''} onChange={handleText} /></Field>
            <Field label={t.annualCapacity}><TextInput name="annualCapacity" value={draft.annualCapacity || ''} onChange={handleText} /></Field>
            <Field label={t.currentInventory}><TextInput name="currentInventory" value={draft.currentInventory || ''} onChange={handleText} /></Field>
            <Field label={t.projectedInventory}><TextInput name="projectedInventory" value={draft.projectedInventory || ''} onChange={handleText} /></Field>
            <Field label={t.productionUtilisation}><TextInput name="productionUtilisation" value={draft.productionUtilisation || ''} onChange={handleText} placeholder="e.g. 85" /></Field>
            <Field label={t.maxProductionCapacity}><TextInput name="maxProductionCapacity" value={draft.maxProductionCapacity || ''} onChange={handleText} /></Field>
            <Field label={t.cultivationMethod}><TextInput name="cultivationMethod" value={draft.cultivationMethod || ''} onChange={handleText} /></Field>
            <Field label={t.fertiliserProgram}><TextInput name="fertiliserProgram" value={draft.fertiliserProgram || ''} onChange={handleText} /></Field>
            <Field label={t.nutrientBrands}><TextInput name="nutrientBrands" value={draft.nutrientBrands || ''} onChange={handleText} /></Field>
            <Field label={t.pestManagement}><TextInput name="pestManagement" value={draft.pestManagement || ''} onChange={handleText} /></Field>
            <Field label={t.ipmProcedures}><TextInput name="ipmProcedures" value={draft.ipmProcedures || ''} onChange={handleText} /></Field>
            <Field label={t.waterSource}><TextInput name="waterSource" value={draft.waterSource || ''} onChange={handleText} /></Field>
            <Field label={t.waterTestingFrequency}><TextInput name="waterTestingFrequency" value={draft.waterTestingFrequency || ''} onChange={handleText} /></Field>
            <Field label={t.waterAnalysisFile}><TextInput name="waterAnalysisFile" value={draft.waterAnalysisFile || ''} onChange={handleText} placeholder="water_analysis.pdf" /></Field>
          </div>
        )}

        {step === 6 && (
          <div className="form-grid-3">
            <Field label={t.mainStrains}><TextInput name="mainStrains" value={draft.mainStrains || ''} onChange={handleText} /></Field>
            <Field label={t.breeder}><TextInput name="breeder" value={draft.breeder || ''} onChange={handleText} /></Field>
            <Field label={t.geneticLineage}><TextInput name="geneticLineage" value={draft.geneticLineage || ''} onChange={handleText} /></Field>
            <Field label={t.typicalThc}><TextInput name="typicalThc" value={draft.typicalThc || ''} onChange={handleText} placeholder="e.g. 22–27%" /></Field>
            <Field label={t.typicalCbd}><TextInput name="typicalCbd" value={draft.typicalCbd || ''} onChange={handleText} placeholder="e.g. 0.08–0.12%" /></Field>
            <Field label={t.dominantTerpenes}><TextInput name="dominantTerpenes" value={draft.dominantTerpenes || ''} onChange={handleText} /></Field>
            <Field label={t.harvestCycle}><TextInput name="harvestCycle" value={draft.harvestCycle || ''} onChange={handleText} /></Field>
            <Field label={t.yieldPerSqm}><TextInput name="yieldPerSqm" value={draft.yieldPerSqm || ''} onChange={handleText} /></Field>
            <Field label={t.qtyAvailableNow}><TextInput name="qtyAvailableNow" value={draft.qtyAvailableNow || ''} onChange={handleText} /></Field>
            <Field label={t.qtyAvailable30}><TextInput name="qtyAvailable30" value={draft.qtyAvailable30 || ''} onChange={handleText} /></Field>
            <Field label={t.qtyAvailable60}><TextInput name="qtyAvailable60" value={draft.qtyAvailable60 || ''} onChange={handleText} /></Field>
            <Field label={t.qtyAvailable90}><TextInput name="qtyAvailable90" value={draft.qtyAvailable90 || ''} onChange={handleText} /></Field>
            <Field label={t.qtyAvailable180}><TextInput name="qtyAvailable180" value={draft.qtyAvailable180 || ''} onChange={handleText} /></Field>
            <Field label={t.productPhotoUrl}><TextInput name="productPhotoUrl" value={draft.productPhotoUrl || ''} onChange={handleText} placeholder="https://..." /></Field>
          </div>
        )}

        {step === 7 && (
          <div>
            <Field label={t.coaFiles}><TextInput name="coaFiles" value={draft.coaFiles || ''} onChange={handleText} placeholder="e.g. coa_batch1.pdf, coa_batch2.pdf" /></Field>
            <div className="form-grid-3" style={{ marginTop: 16 }}>
              <Field label={t.heavyMetalsTested}><YesNo name="heavyMetalsTested" value={draft.heavyMetalsTested || ''} onChange={handleText} /></Field>
              <Field label={t.pesticidesTested}><YesNo name="pesticidesTested" value={draft.pesticidesTested || ''} onChange={handleText} /></Field>
              <Field label={t.mycotoxinsTested}><YesNo name="mycotoxinsTested" value={draft.mycotoxinsTested || ''} onChange={handleText} /></Field>
              <Field label={t.microbiologyTested}><YesNo name="microbiologyTested" value={draft.microbiologyTested || ''} onChange={handleText} /></Field>
              <Field label={t.waterActivityTested}><YesNo name="waterActivityTested" value={draft.waterActivityTested || ''} onChange={handleText} /></Field>
              <Field label={t.batchTrackingSystem}><YesNo name="batchTrackingSystem" value={draft.batchTrackingSystem || ''} onChange={handleText} /></Field>
              <Field label={t.seedToSaleSystem}><YesNo name="seedToSaleSystem" value={draft.seedToSaleSystem || ''} onChange={handleText} /></Field>
              <Field label={t.sopsAvailable}><YesNo name="sopsAvailable" value={draft.sopsAvailable || ''} onChange={handleText} /></Field>
              <Field label={t.recallProcedure}><YesNo name="recallProcedure" value={draft.recallProcedure || ''} onChange={handleText} /></Field>
              <Field label={t.wasteDisposal}><YesNo name="wasteDisposal" value={draft.wasteDisposal || ''} onChange={handleText} /></Field>
              <Field label={t.employeeTraining}><YesNo name="employeeTraining" value={draft.employeeTraining || ''} onChange={handleText} /></Field>
              <Field label={t.securityProtocols}><YesNo name="securityProtocols" value={draft.securityProtocols || ''} onChange={handleText} /></Field>
              <Field label={t.visitorProcedures}><YesNo name="visitorProcedures" value={draft.visitorProcedures || ''} onChange={handleText} /></Field>
              <Field label={t.incidentReporting}><YesNo name="incidentReporting" value={draft.incidentReporting || ''} onChange={handleText} /></Field>
              <Field label={t.capaProgram}><YesNo name="capaProgram" value={draft.capaProgram || ''} onChange={handleText} /></Field>
              <Field label={t.internalAudits}><YesNo name="internalAudits" value={draft.internalAudits || ''} onChange={handleText} /></Field>
              <Field label={t.externalAudits}><YesNo name="externalAudits" value={draft.externalAudits || ''} onChange={handleText} /></Field>
            </div>
          </div>
        )}

        {step === 8 && (
          <div className="form-grid-3">
            <Field label={t.suppliedEU}><YesNo name="suppliedEU" value={draft.suppliedEU || ''} onChange={handleText} /></Field>
            <Field label={t.suppliedPharma}><YesNo name="suppliedPharma" value={draft.suppliedPharma || ''} onChange={handleText} /></Field>
            <Field label={t.suppliedGMPProcessors}><YesNo name="suppliedGMPProcessors" value={draft.suppliedGMPProcessors || ''} onChange={handleText} /></Field>
            <Field label={t.existingSopLibrary}><YesNo name="existingSopLibrary" value={draft.existingSopLibrary || ''} onChange={handleText} /></Field>
            <Field label={t.existingQA}><YesNo name="existingQA" value={draft.existingQA || ''} onChange={handleText} /></Field>
            <Field label={t.existingQC}><YesNo name="existingQC" value={draft.existingQC || ''} onChange={handleText} /></Field>
            <Field label={t.qualifiedPerson}><YesNo name="qualifiedPerson" value={draft.qualifiedPerson || ''} onChange={handleText} /></Field>
            <Field label={t.stabilityProgram}><YesNo name="stabilityProgram" value={draft.stabilityProgram || ''} onChange={handleText} /></Field>
            <Field label={t.changeControl}><YesNo name="changeControl" value={draft.changeControl || ''} onChange={handleText} /></Field>
            <Field label={t.deviationProcedures}><YesNo name="deviationProcedures" value={draft.deviationProcedures || ''} onChange={handleText} /></Field>
            <Field label={t.riskManagement}><YesNo name="riskManagement" value={draft.riskManagement || ''} onChange={handleText} /></Field>
            <Field label={t.documentationControl}><YesNo name="documentationControl" value={draft.documentationControl || ''} onChange={handleText} /></Field>
            <Field label={t.interestedExclusive}><YesNo name="interestedExclusive" value={draft.interestedExclusive || ''} onChange={handleText} /></Field>
            <Field label={t.interestedNonExclusive}><YesNo name="interestedNonExclusive" value={draft.interestedNonExclusive || ''} onChange={handleText} /></Field>
            <Field label={t.interestedEUGMP}><YesNo name="interestedEUGMP" value={draft.interestedEUGMP || ''} onChange={handleText} /></Field>
            <Field label={t.interestedLongTerm}><YesNo name="interestedLongTerm" value={draft.interestedLongTerm || ''} onChange={handleText} /></Field>
            <Field label={t.interestedJV}><YesNo name="interestedJV" value={draft.interestedJV || ''} onChange={handleText} /></Field>
            <Field label={t.monthlyReportingAgreement}><YesNo name="monthlyReportingAgreement" value={draft.monthlyReportingAgreement || ''} onChange={handleText} /></Field>
            <Field label={t.countriesExported}><TextInput name="countriesExported" value={draft.countriesExported || ''} onChange={handleText} /></Field>
            <Field label={t.freightProviders}><TextInput name="freightProviders" value={draft.freightProviders || ''} onChange={handleText} /></Field>
            <Field label={t.customsBrokers}><TextInput name="customsBrokers" value={draft.customsBrokers || ''} onChange={handleText} /></Field>
            <Field label={t.incotermsFamiliarity}><TextInput name="incotermsFamiliarity" value={draft.incotermsFamiliarity || ''} onChange={handleText} /></Field>
            <Field label={t.packagingStandards}><TextInput name="packagingStandards" value={draft.packagingStandards || ''} onChange={handleText} /></Field>
            <Field label={t.labellingStandards}><TextInput name="labellingStandards" value={draft.labellingStandards || ''} onChange={handleText} /></Field>
            <Field label={t.shippingCapacity}><TextInput name="shippingCapacity" value={draft.shippingCapacity || ''} onChange={handleText} /></Field>
          </div>
        )}

        {step === 9 && (
          <div>
            <div className="review-summary-block">
              <div className="review-summary-row">
                <span>{t.reviewCompletion}</span>
                <span className="review-completion-pct">{completion}%</span>
              </div>
              <div className="wizard-progress-track" style={{ marginTop: 8 }}>
                <div className={`wizard-progress-fill ${completion >= 70 ? 'fill-good' : completion >= 40 ? 'fill-medium' : 'fill-low'}`} style={{ width: `${completion}%` }} />
              </div>
            </div>

            {missingDocs.length > 0 && (
              <div className="alert alert-warning" style={{ marginTop: 16 }}>
                <strong>{t.reviewMissingDocs}:</strong>
                <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
                  {missingDocs.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            )}

            <div className="review-data-grid" style={{ marginTop: 20 }}>
              <div className="review-data-item"><span className="dl">{t.legalBusinessName}</span><span className="dv">{draft.legalBusinessName || '—'}</span></div>
              <div className="review-data-item"><span className="dl">{t.tradingName}</span><span className="dv">{draft.tradingName || '—'}</span></div>
              <div className="review-data-item"><span className="dl">{t.province}</span><span className="dv">{draft.province || '—'}</span></div>
              <div className="review-data-item"><span className="dl">{t.district}</span><span className="dv">{draft.district || '—'}</span></div>
              <div className="review-data-item"><span className="dl">{t.email}</span><span className="dv">{draft.email || '—'}</span></div>
              <div className="review-data-item"><span className="dl">{t.primaryContact}</span><span className="dv">{draft.primaryContact || '—'}</span></div>
              <div className="review-data-item"><span className="dl">{t.farmType}</span><span className="dv">{draft.farmType || '—'}</span></div>
              <div className="review-data-item"><span className="dl">{t.mainStrains}</span><span className="dv">{draft.mainStrains || '—'}</span></div>
              <div className="review-data-item"><span className="dl">{t.cultivationLicence}</span><span className="dv">{draft.cultivationLicence ? <span className="text-green">✓ {draft.cultivationLicence}</span> : <span className="text-missing">✗ Missing</span>}</span></div>
              <div className="review-data-item"><span className="dl">{t.exportLicence}</span><span className="dv">{draft.exportLicence ? <span className="text-green">✓ {draft.exportLicence}</span> : <span className="text-missing">✗ Missing</span>}</span></div>
              <div className="review-data-item"><span className="dl">{t.gmpCert}</span><span className="dv">{draft.gmpCert ? <span className="text-green">✓ {draft.gmpCert}</span> : <span className="text-missing">✗ Missing</span>}</span></div>
              <div className="review-data-item"><span className="dl">{t.monthlyReportingAgreement}</span><span className="dv">{draft.monthlyReportingAgreement || '—'}</span></div>
            </div>

            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                {lang === 'th'
                  ? 'เมื่อส่งข้อมูลแล้ว DDP จะทำการตรวจสอบโปรไฟล์ฟาร์มของคุณ'
                  : 'Once submitted, DDP will review your farm profile. You can track status under My Status.'}
              </div>
              <button className="btn btn-primary btn-lg" onClick={handleSubmit}>
                {t.reviewSubmitBtn}
              </button>
            </div>
          </div>
        )}

        <div className="wizard-nav-row">
          {step > 1 && (
            <button className="btn btn-ghost-dark" onClick={() => setStep(s => s - 1)}>
              {t.btnBack}
            </button>
          )}
          {step === 1 && (
            <button className="btn btn-ghost-dark" onClick={onBack}>
              {t.btnBack}
            </button>
          )}
          {step < TOTAL_STEPS && (
            <button className="btn btn-primary" onClick={() => setStep(s => s + 1)} style={{ marginLeft: 'auto' }}>
              {t.btnNext}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// suppress unused import warning
const _unused = FARM_STATUS_LABEL
void _unused
