import { useState } from 'react'
import type { FarmProfile, FarmStatus, CarbonProgrammeStatus } from '../../types'
import { deriveComplianceTier, COMPLIANCE_TIER_LABEL, complianceTierClass } from '../../data'
import { FilterSidebar, CertCheckboxGroup } from '../../components/shared/FilterSidebar'

const CERT_OPTIONS: { key: keyof FarmProfile; label: string }[] = [
  { key: 'gmpCert', label: 'EU-GMP' },
  { key: 'gacpCert', label: 'GACP' },
  { key: 'picsCert', label: 'PIC/S' },
]

const CARBON_STATUS_LABEL: Record<CarbonProgrammeStatus, string> = {
  not_reviewed: 'Not reviewed',
  admin_reviewing: 'Under DDP review',
  eligible_internal: 'Internally eligible',
  excluded_by_farmer: 'Excluded by farmer',
  withdrawn_by_farmer: 'Withdrawn by farmer',
  ineligible: 'Ineligible',
}

interface Props {
  farms: FarmProfile[]
  onReview: (farmId: string) => void
}

const STATUS_CLASS: Record<FarmStatus, string> = {
  'Draft': 'badge-gray',
  'Submitted to DDP': 'badge-pending',
  'Under Review': 'badge-under-review',
  'More Information Required': 'badge-orange',
  'Approved': 'badge-approved',
  'Watchlist': 'badge-watchlist',
  'Strategic Partner': 'badge-purple',
  'Rejected': 'badge-rejected',
}

function riskLevel(farm: FarmProfile): { label: string; cls: string } {
  if (farm.completionPct >= 80 && farm.exportLicence && farm.gmpCert) return { label: 'Low', cls: 'risk-low' }
  if (farm.completionPct >= 60) return { label: 'Medium', cls: 'risk-medium' }
  return { label: 'High', cls: 'risk-high' }
}

function exportReadiness(farm: FarmProfile): string {
  if (farm.exportLicence && farm.suppliedEU === 'Yes') return 'High'
  if (farm.exportLicence || farm.interestedEUGMP === 'Yes') return 'Medium'
  return 'Low'
}

type FilterStatus = 'All' | 'Pending' | 'Approved' | 'Watchlist' | 'Rejected'

export default function DDPFarmProfiles({ farms, onReview }: Props) {
  const [filter, setFilter] = useState<FilterStatus>('All')
  const [certFilters, setCertFilters] = useState<string[]>([])

  function toggleCert(key: string) {
    setCertFilters(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])
  }

  const filtered = farms.filter(f => {
    if (filter === 'All') { /* no status filter */ }
    else if (filter === 'Pending') { if (!(f.status === 'Submitted to DDP' || f.status === 'Under Review')) return false }
    else if (filter === 'Approved') { if (!(f.status === 'Approved' || f.status === 'Strategic Partner')) return false }
    else if (filter === 'Watchlist') { if (f.status !== 'Watchlist') return false }
    else if (filter === 'Rejected') { if (!(f.status === 'Rejected' || f.status === 'More Information Required')) return false }
    if (certFilters.length > 0 && !certFilters.every(key => !!f[key as keyof FarmProfile])) return false
    return true
  })

  const counts = {
    all: farms.length,
    pending: farms.filter(f => f.status === 'Submitted to DDP' || f.status === 'Under Review').length,
    approved: farms.filter(f => f.status === 'Approved' || f.status === 'Strategic Partner').length,
    watchlist: farms.filter(f => f.status === 'Watchlist').length,
    rejected: farms.filter(f => f.status === 'Rejected' || f.status === 'More Information Required').length,
  }

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — FARM PROFILES</div>
        <h1 className="page-title">Farm Profiles</h1>
        <p className="page-desc">All submitted farm profiles — qualification, compliance, and partner assessment.</p>
      </div>

      <div className="filter-tabs">
        {(['All', 'Pending', 'Approved', 'Watchlist', 'Rejected'] as FilterStatus[]).map(s => (
          <button
            key={s}
            className={`filter-tab${filter === s ? ' filter-active' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s === 'All' ? `All (${counts.all})` :
             s === 'Pending' ? `Pending Review (${counts.pending})` :
             s === 'Approved' ? `Approved (${counts.approved})` :
             s === 'Watchlist' ? `Watchlist (${counts.watchlist})` :
             `Needs Action (${counts.rejected})`}
          </button>
        ))}
      </div>

      <div className="filter-layout">
        <FilterSidebar onReset={() => setCertFilters([])}>
          <CertCheckboxGroup label="Compliance Gates" options={CERT_OPTIONS} selected={certFilters} onToggle={toggleCert} />
        </FilterSidebar>
      <div className="card table-card">
        <div className="table-card-title">Farm Profile Registry — {filtered.length} {filtered.length === 1 ? 'farm' : 'farms'}</div>
        <div className="table-scroll">
          <table className="inv-table inv-table--cards">
            <thead>
              <tr>
                <th>Farm Name</th>
                <th>Province</th>
                <th>Profile Completeness</th>
                <th>Status</th>
                <th>Export Readiness</th>
                <th>Risk Level</th>
                <th>Verification Tier</th>
                <th>Carbon</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="empty-table-cell">NO ASSETS MATCH SPECIFIED PROCUREMENT CRITERIA</td></tr>
              ) : filtered.map(farm => {
                const risk = riskLevel(farm)
                const exp = exportReadiness(farm)
                return (
                  <tr key={farm.id}>
                    <td className="td-bold" data-label="Farm Name">{farm.tradingName || farm.legalBusinessName || 'Unnamed farm profile'}</td>
                    <td className="td-muted" data-label="Province">{farm.province || '—'}</td>
                    <td data-label="Completeness">
                      <div className="completion-cell">
                        <span className="completion-pct-text">{farm.completionPct}%</span>
                        <div className="completion-bar-track-sm">
                          <div
                            className={`completion-bar-fill-sm ${farm.completionPct >= 80 ? 'fill-good' : farm.completionPct >= 60 ? 'fill-medium' : 'fill-low'}`}
                            style={{ width: `${farm.completionPct}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td data-label="Status"><span className={`badge ${STATUS_CLASS[farm.status]}`}>{farm.status}</span></td>
                    <td data-label="Export Readiness">
                      <span className={`readiness-chip readiness-${exp.toLowerCase()}`}>{exp}</span>
                    </td>
                    <td data-label="Risk Level">
                      <span className={`risk-chip ${risk.cls}`}>{risk.label}</span>
                    </td>
                    <td data-label="Verification Tier">
                      <span className={`farm-tier-badge ${complianceTierClass(deriveComplianceTier(farm))}`}>
                        {COMPLIANCE_TIER_LABEL[deriveComplianceTier(farm)]}
                      </span>
                    </td>
                    <td data-label="Carbon">
                      <span className="text-muted" style={{ fontSize: 12 }}>
                        {CARBON_STATUS_LABEL[farm.carbonProgrammeStatus ?? 'not_reviewed']}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-review" onClick={() => onReview(farm.id)}>Open Review</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </div>
  )
}
