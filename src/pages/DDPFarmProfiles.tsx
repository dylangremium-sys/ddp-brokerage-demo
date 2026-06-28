import type { FarmProfile, FarmStatus } from '../types'

interface Props {
  farms: FarmProfile[]
  onReview: (farmId: string) => void
}

const STATUS_CLASS: Record<FarmStatus, string> = {
  'Draft': 'badge-gray',
  'Submitted to DDP': 'badge-pending',
  'Under Review': 'badge-blue',
  'More Information Required': 'badge-orange',
  'Approved': 'badge-approved',
  'Watchlist': 'badge-rejected',
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

export default function DDPFarmProfiles({ farms, onReview }: Props) {
  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS</div>
        <h1 className="page-title">Farm Profiles</h1>
        <p className="page-desc">All submitted farm profiles — qualification, compliance, and partner assessment.</p>
      </div>

      <div className="card table-card">
        <div className="table-card-title">Farm Profile Registry — {farms.length} farms</div>
        <div className="table-scroll">
          <table className="inv-table">
            <thead>
              <tr>
                <th>Farm Name</th>
                <th>Province</th>
                <th>Completion</th>
                <th>Status</th>
                <th>Export Readiness</th>
                <th>Risk Level</th>
                <th>Partner Tier</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {farms.map(farm => {
                const risk = riskLevel(farm)
                const exp = exportReadiness(farm)
                return (
                  <tr key={farm.id}>
                    <td className="td-bold">{farm.tradingName || farm.legalBusinessName}</td>
                    <td>{farm.province}</td>
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
                      <button className="btn btn-review" onClick={() => onReview(farm.id)}>Review</button>
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
