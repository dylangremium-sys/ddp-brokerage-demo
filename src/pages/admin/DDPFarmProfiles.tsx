import { useState } from 'react'
import type { FarmProfile, FarmStatus, CarbonProgrammeStatus } from '../../types'

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

  const filtered = farms.filter(f => {
    if (filter === 'All') return true
    if (filter === 'Pending') return f.status === 'Submitted to DDP' || f.status === 'Under Review'
    if (filter === 'Approved') return f.status === 'Approved' || f.status === 'Strategic Partner'
    if (filter === 'Watchlist') return f.status === 'Watchlist'
    if (filter === 'Rejected') return f.status === 'Rejected' || f.status === 'More Information Required'
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

      <div className="card table-card">
        <div className="table-card-title">Farm Profile Registry — {filtered.length} {filtered.length === 1 ? 'farm' : 'farms'}</div>
        <div className="table-scroll">
          <table className="inv-table">
            <thead>
              <tr>
                <th>Farm Name</th>
                <th>Province</th>
                <th>Profile Completeness</th>
                <th>Status</th>
                <th>Export Readiness</th>
                <th>Risk Level</th>
                <th>Partner Tier</th>
                <th>Carbon</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="empty-table-cell">No farm profiles match this filter.</td></tr>
              ) : filtered.map(farm => {
                const risk = riskLevel(farm)
                const exp = exportReadiness(farm)
                return (
                  <tr key={farm.id}>
                    <td className="td-bold">{farm.tradingName || farm.legalBusinessName || 'Unnamed farm profile'}</td>
                    <td className="td-muted">{farm.province || '—'}</td>
                    <td>
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
                    <td><span className={`badge ${STATUS_CLASS[farm.status]}`}>{farm.status}</span></td>
                    <td>
                      <span className={`readiness-chip readiness-${exp.toLowerCase()}`}>{exp}</span>
                    </td>
                    <td>
                      <span className={`risk-chip ${risk.cls}`}>{risk.label}</span>
                    </td>
                    <td>
                      <span className={`farm-tier-badge tier-${farm.partnerTier.toLowerCase().replace(/ /g, '-')}`}>
                        {farm.partnerTier}
                      </span>
                    </td>
                    <td>
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
  )
}
