import { T } from '../../translations'
import type { Lang } from '../../types'
import { DDPMonogramLogo } from '../../components/logos'
import { StatusBadge } from '../../components/shared/StatusBadge'

function FarmerPortalIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21v-9" />
      <path d="M12 12C11 9.5 8.5 7.5 6 7C6 10 8 12.5 12 13" />
      <path d="M12 12C13 9.5 15.5 7.5 18 7C18 10 16 12.5 12 13" />
    </svg>
  )
}

function OperationsDashboardIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3L5 7v6C5 18 8.5 21 12 22C15.5 21 19 18 19 13V7Z" />
      <polyline points="9,12.5 11,15 15,9.5" />
    </svg>
  )
}

export interface LandingReadiness {
  farmsUnderReview: number
  batchesDocumented: number
  coasReceived: number
  missingFiles: number
  buyerReadyInventory: number
}

interface Props {
  lang: Lang
  onEnterFarmer: () => void
  onEnterDDP: () => void
  readiness: LandingReadiness
}

export default function LandingPage({ lang, onEnterFarmer, onEnterDDP, readiness }: Props) {
  const t = T[lang]
  const proofItems = [t.landingProof1, t.landingProof2, t.landingProof3, t.landingProof4, t.landingProof5]

  const readinessItems = [
    { label: t.landingReadinessFarms, value: readiness.farmsUnderReview },
    { label: t.landingReadinessDocumented, value: readiness.batchesDocumented },
    { label: t.landingReadinessCoa, value: readiness.coasReceived },
    { label: t.landingReadinessMissing, value: readiness.missingFiles },
    { label: t.landingReadinessBuyerReady, value: readiness.buyerReadyInventory },
  ]

  return (
    <div className="landing-page">
      <div className="landing-hero">
        <div className="landing-hero-inner">
          <div className="landing-hero-content">
            <div className="landing-hero-brand-row">
              <DDPMonogramLogo height={40} />
              <span className="landing-tagline">{t.landingTagline}</span>
            </div>
            <h1 className="landing-headline">{t.landingHeadline}</h1>
            <p className="landing-hero-text">{t.landingHero1}</p>
            <p className="landing-hero-text">{t.landingHero2}</p>
          </div>

          <div className="landing-access-grid">
            <button type="button" className="access-module access-module-primary" onClick={onEnterFarmer}>
              <span className="access-module-icon" aria-hidden="true"><FarmerPortalIcon /></span>
              <span className="access-module-body">
                <span className="access-module-title">{t.landingEnterFarmer}</span>
                <span className="access-module-desc">{t.landingAccessFarmerDesc}</span>
                <span className="access-module-cta">{t.landingAccessFarmerCta} <span className="access-module-arrow">→</span></span>
              </span>
            </button>
            <button type="button" className="access-module access-module-secondary" onClick={onEnterDDP}>
              <span className="access-module-icon" aria-hidden="true"><OperationsDashboardIcon /></span>
              <span className="access-module-body">
                <span className="access-module-title">{t.landingEnterDDP}</span>
                <span className="access-module-desc">{t.landingAccessDDPDesc}</span>
                <span className="access-module-cta">{t.landingAccessDDPCta} <span className="access-module-arrow">→</span></span>
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Verification framework strip ── */}
      <div className="framework-strip">
        <div className="framework-strip-inner">
          <div className="framework-strip-title">{t.landingFrameworkTitle}</div>
          <div className="framework-steps">
            <div className="framework-step">
              <StatusBadge status="claimed" lang={lang} />
              <p className="framework-step-desc">{t.landingFrameworkClaimedDesc}</p>
            </div>
            <div className="framework-connector" aria-hidden="true" />
            <div className="framework-step">
              <StatusBadge status="documented" lang={lang} />
              <p className="framework-step-desc">{t.landingFrameworkDocumentedDesc}</p>
            </div>
            <div className="framework-connector" aria-hidden="true" />
            <div className="framework-step">
              <StatusBadge status="verified" lang={lang} />
              <p className="framework-step-desc">{t.landingFrameworkVerifiedDesc}</p>
            </div>
            <div className="framework-connector" aria-hidden="true" />
            <div className="framework-step">
              <StatusBadge status="buyer-ready" lang={lang} />
              <p className="framework-step-desc">{t.landingFrameworkBuyerReadyDesc}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="landing-body">
        <div className="proof-strip">
          <div className="proof-strip-title">{t.landingProofTitle}</div>
          <div className="proof-strip-items">
            {proofItems.map((item, i) => (
              <div key={i} className="proof-strip-item">
                <span className="proof-strip-dot" />
                {item}
              </div>
            ))}
          </div>
        </div>

        {/* ── Buyer pack preview ── */}
        <div className="buyer-pack-preview">
          <div className="buyer-pack-preview-head">
            <div>
              <div className="buyer-pack-preview-title">{t.landingBuyerPackTitle}</div>
              <p className="buyer-pack-preview-desc">{t.landingBuyerPackDesc}</p>
            </div>
            <span className="buyer-pack-preview-badge">{t.landingBuyerPackBadge}</span>
          </div>
          <div className="buyer-pack-preview-grid">
            <div className="buyer-pack-preview-field">
              <span className="buyer-pack-preview-label">{t.landingBuyerPackFarmLabel}</span>
              <StatusBadge status="documented" lang={lang} />
            </div>
            <div className="buyer-pack-preview-field">
              <span className="buyer-pack-preview-label">{t.landingBuyerPackBatchLabel}</span>
              <StatusBadge status="verified" lang={lang} />
            </div>
            <div className="buyer-pack-preview-field">
              <span className="buyer-pack-preview-label">{t.landingBuyerPackCoaLabel}</span>
              <StatusBadge status="coa-received" lang={lang} />
            </div>
            <div className="buyer-pack-preview-field">
              <span className="buyer-pack-preview-label">{t.landingBuyerPackMissingLabel}</span>
              <span className="buyer-pack-preview-value">{t.landingBuyerPackMissingValue}</span>
            </div>
            <div className="buyer-pack-preview-field">
              <span className="buyer-pack-preview-label">{t.landingBuyerPackRiskLabel}</span>
              <span className="risk-chip risk-low">{t.landingBuyerPackRiskValue}</span>
            </div>
            <div className="buyer-pack-preview-field">
              <span className="buyer-pack-preview-label">{t.landingBuyerPackActionLabel}</span>
              <StatusBadge status="progress" lang={lang} />
            </div>
          </div>
          <p className="buyer-pack-preview-note">{t.landingBuyerPackActionNote}</p>
        </div>

        {/* ── Procurement readiness (real counts) ── */}
        <div className="readiness-panel">
          <div className="readiness-panel-head">
            <div className="readiness-panel-title">{t.landingReadinessTitle}</div>
            <p className="readiness-panel-desc">{t.landingReadinessDesc}</p>
          </div>
          <div className="readiness-stats">
            {readinessItems.map((item, i) => (
              <div key={i} className="readiness-stat">
                <div className="readiness-stat-val">{item.value}</div>
                <div className="readiness-stat-lbl">{item.label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="concept-cards">
          <div className="concept-card">
            <div className="concept-icon-num">01</div>
            <div className="concept-card-title">{t.landingCard1Title}</div>
            <p className="concept-card-desc">{t.landingCard1Desc}</p>
          </div>
          <div className="concept-card">
            <div className="concept-icon-num">02</div>
            <div className="concept-card-title">{t.landingCard2Title}</div>
            <p className="concept-card-desc">{t.landingCard2Desc}</p>
          </div>
          <div className="concept-card">
            <div className="concept-icon-num">03</div>
            <div className="concept-card-title">{t.landingCard3Title}</div>
            <p className="concept-card-desc">{t.landingCard3Desc}</p>
          </div>
        </div>

        <div className="workflow-section">
          <div className="workflow-title">{t.landingWorkflowTitle}</div>
          <div className="workflow-steps">
            {[t.landingStep1, t.landingStep2, t.landingStep3, t.landingStep4, t.landingStep5, t.landingStep6].map((step, i, arr) => (
              <div key={i} className="workflow-step-wrap">
                <div className="workflow-step">
                  <div className="workflow-step-num">{i + 1}</div>
                  <div className="workflow-step-label">{step}</div>
                </div>
                {i < arr.length - 1 && <div className="workflow-arrow">→</div>}
              </div>
            ))}
          </div>
        </div>

        <div className="legal-strip">{t.landingDisclaimer}</div>
      </div>
    </div>
  )
}
