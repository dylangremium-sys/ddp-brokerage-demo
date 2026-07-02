import { useState } from 'react'
import { farmTotalScore } from '../../data'
import type { FarmProfile, CarbonProgrammeStatus } from '../../types'

const CARBON_ADMIN_LABELS: Record<CarbonProgrammeStatus, string> = {
  not_reviewed: 'Not reviewed',
  admin_reviewing: 'Under DDP review',
  eligible_internal: 'Internally eligible',
  excluded_by_farmer: 'Excluded by farmer',
  withdrawn_by_farmer: 'Withdrawn by farmer',
  ineligible: 'Ineligible',
}

interface Props {
  farm: FarmProfile
  onBack: () => void
  onAction: (farmId: string, action: string) => void
  onCarbonAction?: (farmId: string, status: CarbonProgrammeStatus) => void
  /** False when running against a configured Supabase backend without an approved
   *  persistence migration for carbon status — the control must not imply a save. */
  carbonPersistenceAvailable?: boolean
}

function DetailRow({ label, value }: { label: string; value: string | React.ReactNode }) {
  return (
    <div className="detail-row">
      <span className="dl">{label}</span>
      <span className="dv">{value || <span className="text-muted">—</span>}</span>
    </div>
  )
}

function LicenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span className="dl">{label}</span>
      <span className="dv">
        {value ? <span className="text-green">✓ {value}</span> : <span className="text-missing">✗ Not provided</span>}
      </span>
    </div>
  )
}

function YesNoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span className="dl">{label}</span>
      <span className="dv">
        {value === 'Yes' ? <span className="check-yes">✓ Yes</span> : value === 'No' ? <span className="check-no">✗ No</span> : <span className="text-muted">—</span>}
      </span>
    </div>
  )
}

function ScoreBar({ label, score }: { label: string; score: number }) {
  const cls = score >= 80 ? 'score-fill-high' : score >= 60 ? 'score-fill-mid' : 'score-fill-low'
  return (
    <div className="score-bar-row">
      <div className="score-bar-label">{label}</div>
      <div className="score-bar-track">
        <div className={`score-bar-fill ${cls}`} style={{ width: `${score}%` }} />
      </div>
      <div className="score-bar-val">{score}</div>
    </div>
  )
}

function Section({ title, children, open = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <div className="detail-section">
      <div className="detail-section-title">{title}</div>
      <div className="detail-section-body" style={{ display: open ? 'block' : 'none' }}>
        {children}
      </div>
    </div>
  )
}

function tierFromScore(total: number): string {
  if (total >= 850) return 'Platinum Partner'
  if (total >= 750) return 'Gold Partner'
  if (total >= 650) return 'Silver Partner'
  return 'Watchlist'
}

export default function DDPFarmReview({ farm, onBack, onAction, onCarbonAction, carbonPersistenceAvailable = true }: Props) {
  const totalScore = farmTotalScore(farm)
  const [carbonStatus, setCarbonStatus] = useState<CarbonProgrammeStatus>(
    farm.carbonProgrammeStatus ?? 'not_reviewed'
  )
  const tier = tierFromScore(totalScore)

  const negativeFlags: string[] = []
  const positiveFlags: string[] = []

  if (!farm.exportLicence) negativeFlags.push('Missing export licence')
  if (!farm.coaFiles) negativeFlags.push('Missing COAs')
  if (!farm.gmpCert) negativeFlags.push('No GMP certification')
  if (farm.completionPct < 60) negativeFlags.push('Low documentation completeness')
  if (farm.monthlyReportingAgreement !== 'Yes') negativeFlags.push('No monthly reporting agreement')
  if (farm.foreignInvestors && farm.foreignInvestors !== '' && farm.foreignInvestors !== 'None') {
    negativeFlags.push('Foreign investors present — verify structure')
  }

  if (farm.exportLicence) positiveFlags.push('Export licence held')
  if (farm.interestedEUGMP === 'Yes' || farm.suppliedEU === 'Yes') positiveFlags.push('High export potential')
  if (parseInt(farm.annualCapacity) > 1000) positiveFlags.push('Strong production capacity')
  if (farm.gmpCert) positiveFlags.push('GMP certified')
  if (farm.interestedExclusive === 'Yes' && farm.monthlyReportingAgreement === 'Yes') {
    positiveFlags.push('Strategic partner candidate')
  }
  if (farm.suppliedEU === 'Yes') positiveFlags.push('Existing EU supply track record')

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header review-page-header">
        <div>
          <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — FARM REVIEW</div>
          <h1 className="page-title">{farm.tradingName || farm.legalBusinessName}</h1>
          <p className="page-desc">{farm.province}{farm.district ? `, ${farm.district}` : ''} · {farm.farmType}</p>
        </div>
        <button className="btn btn-ghost" onClick={onBack}>← Back to Farm Profiles</button>
      </div>

      <div className="review-layout">
        <div className="review-main">
          <Section title="1. Business Information">
            <div className="detail-rows">
              <DetailRow label="Legal Business Name" value={farm.legalBusinessName} />
              <DetailRow label="Trading Name" value={farm.tradingName} />
              <DetailRow label="Registration No." value={farm.registrationNumber} />
              <DetailRow label="Tax Number" value={farm.taxNumber} />
              <DetailRow label="Date Established" value={farm.dateEstablished} />
              <DetailRow label="Province" value={farm.province} />
              <DetailRow label="District" value={farm.district} />
              <DetailRow label="GPS" value={farm.gpsCoordinates} />
              <DetailRow label="Email" value={farm.email} />
              <DetailRow label="Primary Contact" value={`${farm.primaryContact} — ${farm.position}`} />
              <DetailRow label="Mobile" value={farm.mobileNumber} />
              <DetailRow label="Website" value={farm.website} />
              <DetailRow label="Line ID" value={farm.lineId} />
              <DetailRow label="WhatsApp" value={farm.whatsapp} />
            </div>
          </Section>

          <Section title="2. Ownership Structure">
            <div className="detail-rows">
              <DetailRow label="Owner" value={farm.ownerName} />
              <DetailRow label="Nationality" value={farm.nationality} />
              <DetailRow label="Ownership %" value={farm.ownershipPct} />
              <DetailRow label="Additional Shareholders" value={farm.additionalShareholders} />
              <DetailRow label="Foreign Investors" value={farm.foreignInvestors || 'None'} />
              <DetailRow label="Strategic Partners" value={farm.strategicPartners} />
              <DetailRow label="Export Partners" value={farm.exportPartners} />
            </div>
          </Section>

          <Section title="3. Licences & Certifications">
            <div className="detail-rows">
              <LicenceRow label="Cultivation Licence" value={farm.cultivationLicence} />
              <LicenceRow label="Processing Licence" value={farm.processingLicence} />
              <LicenceRow label="Manufacturing Licence" value={farm.manufacturingLicence} />
              <LicenceRow label="Research Licence" value={farm.researchLicence} />
              <LicenceRow label="Medical Cannabis Licence" value={farm.medicalCannabisLicence} />
              <LicenceRow label="Export Licence" value={farm.exportLicence} />
              <LicenceRow label="Import Licence" value={farm.importLicence} />
              <LicenceRow label="GMP Certification" value={farm.gmpCert} />
              <LicenceRow label="GAP Certification" value={farm.gapCert} />
              <LicenceRow label="GACP Certification" value={farm.gacpCert} />
              <LicenceRow label="Organic Certification" value={farm.organicCert} />
              <LicenceRow label="ISO Certifications" value={farm.isoCerts} />
              <LicenceRow label="Other Certifications" value={farm.otherCerts} />
              <DetailRow label="Document Expiry" value={farm.documentExpiry} />
            </div>
          </Section>

          <Section title="4. Farm & Facility">
            <div className="detail-rows">
              <DetailRow label="Farm Type" value={farm.farmType} />
              <DetailRow label="Total Land Area" value={farm.totalLandArea} />
              <DetailRow label="Cultivation Area" value={farm.cultivationArea} />
              <DetailRow label="Flowering Area" value={farm.floweringArea} />
              <DetailRow label="Nursery Area" value={farm.nurseryArea} />
              <DetailRow label="Processing Area" value={farm.processingArea} />
              <DetailRow label="Drying Area" value={farm.dryingArea} />
              <DetailRow label="Storage Area" value={farm.storageArea} />
              <DetailRow label="Security" value={farm.securityArea} />
              <DetailRow label="Expansion Capacity" value={farm.expansionCapacity} />
            </div>
          </Section>

          <Section title="5. Cultivation & Production">
            <div className="detail-rows">
              <DetailRow label="Active Rooms" value={farm.activeRooms} />
              <DetailRow label="Harvests / Year" value={farm.harvestsPerYear} />
              <DetailRow label="Avg Yield / Harvest" value={farm.avgYieldPerHarvest} />
              <DetailRow label="Annual Capacity" value={farm.annualCapacity} />
              <DetailRow label="Current Inventory" value={farm.currentInventory} />
              <DetailRow label="Utilisation %" value={farm.productionUtilisation ? `${farm.productionUtilisation}%` : ''} />
              <DetailRow label="Max Capacity" value={farm.maxProductionCapacity} />
              <DetailRow label="Cultivation Method" value={farm.cultivationMethod} />
              <DetailRow label="Fertiliser Program" value={farm.fertiliserProgram} />
              <DetailRow label="Pest Management" value={farm.pestManagement} />
              <DetailRow label="Water Source" value={farm.waterSource} />
              <DetailRow label="Water Testing" value={farm.waterTestingFrequency} />
            </div>
          </Section>

          <Section title="6. Strain Intelligence">
            <div className="detail-rows">
              <DetailRow label="Main Strains" value={farm.mainStrains} />
              <DetailRow label="Breeder" value={farm.breeder} />
              <DetailRow label="Genetic Lineage" value={farm.geneticLineage} />
              <DetailRow label="Typical THC %" value={farm.typicalThc} />
              <DetailRow label="Typical CBD %" value={farm.typicalCbd} />
              <DetailRow label="Dominant Terpenes" value={farm.dominantTerpenes} />
              <DetailRow label="Harvest Cycle" value={farm.harvestCycle} />
              <DetailRow label="Yield per m²" value={farm.yieldPerSqm} />
              <DetailRow label="Available Now" value={farm.qtyAvailableNow} />
              <DetailRow label="Available 30d" value={farm.qtyAvailable30} />
              <DetailRow label="Available 60d" value={farm.qtyAvailable60} />
              <DetailRow label="Available 90d" value={farm.qtyAvailable90} />
              <DetailRow label="Available 180d" value={farm.qtyAvailable180} />
            </div>
          </Section>

          <Section title="7. Lab Testing & Compliance">
            <div className="detail-rows">
              <DetailRow label="COA Files" value={farm.coaFiles || <span className="text-missing">None listed</span>} />
              <YesNoRow label="Heavy Metals Tested" value={farm.heavyMetalsTested} />
              <YesNoRow label="Pesticides Tested" value={farm.pesticidesTested} />
              <YesNoRow label="Mycotoxins Tested" value={farm.mycotoxinsTested} />
              <YesNoRow label="Microbiology Tested" value={farm.microbiologyTested} />
              <YesNoRow label="Water Activity Tested" value={farm.waterActivityTested} />
              <YesNoRow label="Batch Tracking System" value={farm.batchTrackingSystem} />
              <YesNoRow label="Seed-to-Sale System" value={farm.seedToSaleSystem} />
              <YesNoRow label="SOPs Available" value={farm.sopsAvailable} />
              <YesNoRow label="Recall Procedure" value={farm.recallProcedure} />
              <YesNoRow label="CAPA Program" value={farm.capaProgram} />
              <YesNoRow label="Internal Audits" value={farm.internalAudits} />
              <YesNoRow label="External Audits" value={farm.externalAudits} />
            </div>
          </Section>

          <Section title="8. GMP & Export Readiness">
            <div className="detail-rows">
              <YesNoRow label="Supplied EU Before" value={farm.suppliedEU} />
              <YesNoRow label="Supplied Pharma Before" value={farm.suppliedPharma} />
              <YesNoRow label="Supplied GMP Processors" value={farm.suppliedGMPProcessors} />
              <YesNoRow label="Existing QA Dept" value={farm.existingQA} />
              <YesNoRow label="Existing QC Dept" value={farm.existingQC} />
              <YesNoRow label="Qualified Person" value={farm.qualifiedPerson} />
              <YesNoRow label="Stability Program" value={farm.stabilityProgram} />
              <YesNoRow label="Change Control" value={farm.changeControl} />
              <YesNoRow label="Risk Management" value={farm.riskManagement} />
              <DetailRow label="Countries Exported" value={farm.countriesExported} />
              <DetailRow label="Freight Providers" value={farm.freightProviders} />
              <DetailRow label="Incoterms" value={farm.incotermsFamiliarity} />
              <DetailRow label="Shipping Capacity" value={farm.shippingCapacity} />
            </div>
          </Section>

          <Section title="9. Partnership Interest">
            <div className="detail-rows">
              <YesNoRow label="Exclusive Partnership" value={farm.interestedExclusive} />
              <YesNoRow label="Non-Exclusive Partnership" value={farm.interestedNonExclusive} />
              <YesNoRow label="EU GMP Conversion" value={farm.interestedEUGMP} />
              <YesNoRow label="Long-Term Supply Agreement" value={farm.interestedLongTerm} />
              <YesNoRow label="Joint Venture" value={farm.interestedJV} />
              <YesNoRow label="Monthly Reporting Agreement" value={farm.monthlyReportingAgreement} />
            </div>
          </Section>
        </div>

        <div className="review-sidebar">
          <div className="card decision-card sidebar-sticky">
            <div className="decision-title">Compliance Score</div>
            <div className="score-total-row">
              <span className="score-total-num">{totalScore}</span>
              <span className="score-total-denom">/ 900</span>
              <span className={`farm-tier-badge tier-${tier.toLowerCase().replace(/ /g, '-')}`} style={{ marginLeft: 8 }}>{tier}</span>
            </div>

            <div className="score-bars-list">
              <ScoreBar label="Compliance" score={farm.scoreCompliance} />
              <ScoreBar label="Documentation" score={farm.scoreDocumentation} />
              <ScoreBar label="Facility Quality" score={farm.scoreFacilityQuality} />
              <ScoreBar label="Product Quality" score={farm.scoreProductQuality} />
              <ScoreBar label="Export Readiness" score={farm.scoreExportReadiness} />
              <ScoreBar label="Reliability" score={farm.scoreReliability} />
              <ScoreBar label="Communication" score={farm.scoreCommunication} />
              <ScoreBar label="Scalability" score={farm.scoreScalability} />
              <ScoreBar label="GMP Readiness" score={farm.scoreGMPReadiness} />
            </div>

            {(negativeFlags.length > 0 || positiveFlags.length > 0) && (
              <div className="risk-flags-section">
                {negativeFlags.length > 0 && (
                  <div>
                    <div className="risk-flags-label risk-negative-label">Risk Flags</div>
                    <ul className="risk-flags-list">
                      {negativeFlags.map((f, i) => <li key={i} className="risk-flag-negative">⚠ {f}</li>)}
                    </ul>
                  </div>
                )}
                {positiveFlags.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div className="risk-flags-label risk-positive-label">Positive Signals</div>
                    <ul className="risk-flags-list">
                      {positiveFlags.map((f, i) => <li key={i} className="risk-flag-positive">✓ {f}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="decision-actions">
              <button className="btn btn-approve" onClick={() => onAction(farm.id, 'approve')}>Approve Farm Profile</button>
              <button className="btn btn-missing" onClick={() => onAction(farm.id, 'request-info')}>Request Additional Information</button>
              <button className="btn btn-watchlist" onClick={() => onAction(farm.id, 'watchlist')}>Flag for Watchlist</button>
              <button className="btn btn-strategic" onClick={() => onAction(farm.id, 'strategic')}>Designate as Strategic Partner</button>
              <button className="btn btn-reject" onClick={() => onAction(farm.id, 'reject')}>Reject Farm Profile</button>
            </div>

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div className="decision-title" style={{ marginBottom: 6 }}>Carbon Programme</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                This status is managed by DDP. Farmers can only exclude themselves.
              </div>
              {!carbonPersistenceAvailable && (
                <div className="alert alert-warning" style={{ fontSize: 12, marginBottom: 10 }}>
                  ⚠ Not connected to production storage yet. Changes below will not be saved.
                </div>
              )}
              {(carbonStatus === 'excluded_by_farmer' || carbonStatus === 'withdrawn_by_farmer') && (
                <div className="alert alert-warning" style={{ fontSize: 12, marginBottom: 10 }}>
                  ⚠ Farmer has set this status. Do not override without farmer consent.
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                Current: <strong>{CARBON_ADMIN_LABELS[carbonStatus]}</strong>
              </div>
              <select
                className="select-control"
                value={carbonStatus}
                disabled={!carbonPersistenceAvailable}
                title={carbonPersistenceAvailable ? undefined : 'Not connected to production storage yet.'}
                onChange={e => {
                  if (!carbonPersistenceAvailable) return
                  const s = e.target.value as CarbonProgrammeStatus
                  setCarbonStatus(s)
                  onCarbonAction?.(farm.id, s)
                }}
                style={{
                  width: '100%',
                  marginTop: 6,
                  cursor: carbonPersistenceAvailable ? 'pointer' : 'not-allowed',
                }}
              >
                {(Object.keys(CARBON_ADMIN_LABELS) as CarbonProgrammeStatus[]).map(v => (
                  <option key={v} value={v}>{CARBON_ADMIN_LABELS[v]}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
