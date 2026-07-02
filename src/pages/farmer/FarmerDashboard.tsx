import { T } from '../../translations'
import { calcCompletion, loadFarmDraft } from '../../data'
import type { Lang, FarmProfile } from '../../types'
import type { UserProfile } from '../../services/auth'

function IconFarm() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 18V8.5l7-5.5 7 5.5V18"/>
      <rect x="7.5" y="12" width="5" height="6" rx="0.5"/>
    </svg>
  )
}

function IconBox() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 11.5V18M4 8v6.5l6 3.5 6-3.5V8L10 4.5 4 8z"/>
      <path d="M16 8l-6 3.5L4 8"/>
    </svg>
  )
}

function IconList() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="12" height="14" rx="1.5"/>
      <path d="M7 8h6M7 11h6M7 14h4"/>
    </svg>
  )
}

function IconInbox() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="14" height="12" rx="1.5"/>
      <path d="M3 12h4l2.5 3L12 12h5"/>
    </svg>
  )
}

function IconDoc() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 2h7l4 4v12a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z"/>
      <path d="M12 2v5h5"/>
      <path d="M7 10h6M7 13h4"/>
    </svg>
  )
}

interface Props {
  lang: Lang
  farms: FarmProfile[]
  currentProfile: UserProfile | null
  onBuildProfile: () => void
  onMyStock: () => void
  onMyActivity: () => void
  onAdvancedProfile: () => void
  onRequests: () => void
  openRequestsCount?: number
}

export default function FarmerDashboard({
  lang,
  farms,
  currentProfile,
  onBuildProfile,
  onMyStock,
  onMyActivity,
  onAdvancedProfile,
  onRequests,
  openRequestsCount = 0,
}: Props) {
  const t = T[lang]

  // Use the most recent farm for profile completion, or 0 if none
  const latestFarm = farms.length > 0 ? farms[farms.length - 1] : null
  const draft = loadFarmDraft()
  const completionPct = latestFarm
    ? Math.max(latestFarm.completionPct, calcCompletion(latestFarm))
    : draft
      ? calcCompletion(draft)
      : 0
  const displayName = currentProfile?.displayName
    || currentProfile?.phoneNumber
    || draft?.primaryContact
    || draft?.tradingName
    || 'there'

  return (
    <div className="page-wrap farmer-dashboard">

      {/* Welcome card */}
      <div className="dashboard-welcome-card">
        <div className="dashboard-welcome-text">
          <div className="page-eyebrow">{t.eyebrow}</div>
          <h1 className="dashboard-welcome-name">
            {t.dashboardWelcome(displayName)}
          </h1>
          <p className="dashboard-welcome-desc">{t.dashboardDesc}</p>
        </div>
        <div className="dashboard-completion-wrap">
          <div className="dashboard-completion-label">
            {t.dashboardCompletion} — {completionPct}%
          </div>
          <div className="completion-bar-track dashboard-bar-track">
            <div
              className="completion-bar-fill"
              style={{ width: `${completionPct}%` }}
            />
          </div>
          {completionPct < 60 && (
            <div className="dashboard-completion-hint">{t.dashboardCompletionHint}</div>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div className="quick-action-grid">
        <button className="quick-action-card quick-action-primary" onClick={onBuildProfile}>
          <div className="quick-action-icon"><IconFarm /></div>
          <div className="quick-action-label">{t.buildProfile}</div>
          <div className="quick-action-desc">{t.buildProfileDesc}</div>
        </button>

        <button className="quick-action-card" onClick={onMyStock}>
          <div className="quick-action-icon"><IconBox /></div>
          <div className="quick-action-label">{t.myStock}</div>
          <div className="quick-action-desc">{t.myStockDesc}</div>
        </button>

        <button className="quick-action-card" onClick={onMyActivity}>
          <div className="quick-action-icon"><IconList /></div>
          <div className="quick-action-label">{t.myActivity}</div>
          <div className="quick-action-desc">{t.myActivityDesc}</div>
        </button>

        <button
          className={`quick-action-card${openRequestsCount > 0 ? ' quick-action-requests' : ' quick-action-advanced'}`}
          onClick={onRequests}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="quick-action-icon"><IconInbox /></div>
            {openRequestsCount > 0 && (
              <span className="requests-badge">{openRequestsCount}</span>
            )}
          </div>
          <div className="quick-action-label">{t.requestsLabel}</div>
          <div className="quick-action-desc">
            {openRequestsCount > 0
              ? (lang === 'th' ? `${openRequestsCount} รายการรอดำเนินการ` : `${openRequestsCount} open`)
              : t.requestsDesc}
          </div>
        </button>

        <button className="quick-action-card quick-action-advanced" onClick={onAdvancedProfile}>
          <div className="quick-action-icon"><IconDoc /></div>
          <div className="quick-action-label">{t.advancedProfile}</div>
          <div className="quick-action-desc">{t.advancedProfileDesc}</div>
        </button>
      </div>

      {/* Help button */}
      <div className="dashboard-help-strip">
        <span>{t.needHelp}</span>
        <a
          className="btn btn-outline-sm"
          href="https://line.me/R/ti/p/@ddpbrokerage"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t.helpContact} →
        </a>
      </div>

    </div>
  )
}
