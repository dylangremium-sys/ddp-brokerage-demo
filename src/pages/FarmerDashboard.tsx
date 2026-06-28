import { T } from '../translations'
import { calcCompletion, loadFarmDraft } from '../data'
import type { Lang, FarmProfile } from '../types'
import type { UserProfile } from '../services/auth'

interface Props {
  lang: Lang
  farms: FarmProfile[]
  currentProfile: UserProfile | null
  onBuildProfile: () => void
  onSubmitBatch: () => void
  onMyActivity: () => void
  onAdvancedProfile: () => void
}

export default function FarmerDashboard({
  lang,
  farms,
  currentProfile,
  onBuildProfile,
  onSubmitBatch,
  onMyActivity,
  onAdvancedProfile,
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
          <div className="quick-action-icon">🌿</div>
          <div className="quick-action-label">{t.buildProfile}</div>
          <div className="quick-action-desc">{t.buildProfileDesc}</div>
        </button>

        <button className="quick-action-card" onClick={onSubmitBatch}>
          <div className="quick-action-icon">📦</div>
          <div className="quick-action-label">{t.submitBatch}</div>
          <div className="quick-action-desc">{t.submitBatchDesc}</div>
        </button>

        <button className="quick-action-card" onClick={onMyActivity}>
          <div className="quick-action-icon">📋</div>
          <div className="quick-action-label">{t.myActivity}</div>
          <div className="quick-action-desc">{t.myActivityDesc}</div>
        </button>

        <button className="quick-action-card quick-action-advanced" onClick={onAdvancedProfile}>
          <div className="quick-action-icon">📑</div>
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
