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

function WhyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M8 12.5l2.6 2.6L16.5 9" />
    </svg>
  )
}

function DocumentIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2.5h8l4 4v14a1 1 0 01-1 1H6a1 1 0 01-1-1v-17a1 1 0 011-1z" />
      <path d="M14 2.5v4h4" />
      <path d="M8 13h8M8 16.5h8M8 9.5h3" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5l7.5 3v6c0 5-3.2 8.3-7.5 10-4.3-1.7-7.5-5-7.5-10v-6l7.5-3z" />
      <path d="M8.75 12.25l2.25 2.25 4.25-4.5" />
    </svg>
  )
}

function BriefcaseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7.5" width="18" height="12" rx="1.5" />
      <path d="M8.5 7.5V5.5a1.5 1.5 0 011.5-1.5h4a1.5 1.5 0 011.5 1.5v2" />
      <path d="M3 12.5h18" />
      <path d="M10.5 12.5v2h3v-2" />
    </svg>
  )
}

function BoxIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M4 7.5L12 12l8-4.5" />
      <path d="M12 12v9" />
    </svg>
  )
}

function FlagIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 21V3.5" />
      <path d="M5 4.5h13l-3 4.5 3 4.5H5" />
    </svg>
  )
}

interface Props {
  lang: Lang
  onEnterFarmer: () => void
  onEnterDDP: () => void
}

export default function LandingPage({ lang, onEnterFarmer, onEnterDDP }: Props) {
  const t = T[lang]

  const whyItems = [
    { title: t.landingWhy1Title, desc: t.landingWhy1Desc },
    { title: t.landingWhy2Title, desc: t.landingWhy2Desc },
    { title: t.landingWhy3Title, desc: t.landingWhy3Desc },
    { title: t.landingWhy4Title, desc: t.landingWhy4Desc },
  ]

  const orgItems = [
    { icon: <FarmerPortalIcon />, title: t.landingOrgItem1Title, desc: t.landingOrgItem1Desc },
    { icon: <BoxIcon />, title: t.landingOrgItem2Title, desc: t.landingOrgItem2Desc },
    { icon: <DocumentIcon />, title: t.landingOrgItem3Title, desc: t.landingOrgItem3Desc },
    { icon: <BriefcaseIcon />, title: t.landingOrgItem4Title, desc: t.landingOrgItem4Desc },
    { icon: <FlagIcon />, title: t.landingOrgItem5Title, desc: t.landingOrgItem5Desc },
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

            <div className="landing-hero-ctas">
              <button type="button" className="btn btn-primary btn-lg landing-hero-cta-primary" onClick={onEnterFarmer}>
                <span aria-hidden="true"><FarmerPortalIcon /></span>
                {t.landingAccessFarmerCta}
                <span className="access-module-arrow">→</span>
              </button>
              <button type="button" className="landing-hero-cta-secondary" onClick={onEnterDDP}>
                <span aria-hidden="true"><OperationsDashboardIcon /></span>
                {t.landingAccessDDPCta}
                <span className="access-module-arrow">→</span>
              </button>
            </div>
            <p className="landing-hero-cta-caption">{t.landingAccessFarmerDesc}</p>
          </div>

          <div className="hero-visual">
            <div className="hero-mock-card">
              <div className="hero-mock-chrome">
                <span className="hero-mock-chrome-dot" />
                <span className="hero-mock-chrome-dot" />
                <span className="hero-mock-chrome-dot" />
                <span className="hero-mock-badge">{t.landingHeroMockEyebrow}</span>
              </div>
              <div className="hero-mock-grid">
                <div className="hero-mock-field">
                  <span className="hero-mock-label">{t.landingHeroMockFarmLabel}</span>
                  <span className="hero-mock-value">{t.landingHeroMockFarmValue}</span>
                </div>
                <div className="hero-mock-field">
                  <span className="hero-mock-label">{t.landingHeroMockBatchLabel}</span>
                  <span className="hero-mock-value">{t.landingHeroMockBatchValue}</span>
                </div>
                <div className="hero-mock-field">
                  <span className="hero-mock-label">{t.landingHeroMockThcLabel}</span>
                  <span className="hero-mock-value">{t.landingHeroMockThcValue}</span>
                </div>
                <div className="hero-mock-field">
                  <span className="hero-mock-label">{t.landingHeroMockCoaLabel}</span>
                  <StatusBadge status="coa-received" lang={lang} />
                </div>
                <div className="hero-mock-field">
                  <span className="hero-mock-label">{t.landingHeroMockStatusLabel}</span>
                  <StatusBadge status="reviewed" lang={lang} />
                </div>
                <div className="hero-mock-field">
                  <span className="hero-mock-label">{t.landingHeroMockActionLabel}</span>
                  <StatusBadge status="progress" lang={lang} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Verification framework strip ── */}
      <div className="framework-strip">
        <div className="framework-strip-inner">
          <div className="framework-strip-title">{t.landingFrameworkTitle}</div>
          <div className="framework-steps">
            <div className="framework-step">
              <span className="framework-step-icon" aria-hidden="true"><FarmerPortalIcon /></span>
              <StatusBadge status="claimed" lang={lang} />
              <p className="framework-step-desc">{t.landingFrameworkClaimedDesc}</p>
            </div>
            <div className="framework-connector" aria-hidden="true" />
            <div className="framework-step">
              <span className="framework-step-icon" aria-hidden="true"><DocumentIcon /></span>
              <StatusBadge status="documented" lang={lang} />
              <p className="framework-step-desc">{t.landingFrameworkDocumentedDesc}</p>
            </div>
            <div className="framework-connector" aria-hidden="true" />
            <div className="framework-step">
              <span className="framework-step-icon" aria-hidden="true"><ShieldIcon /></span>
              <StatusBadge status="reviewed" lang={lang} />
              <p className="framework-step-desc">{t.landingFrameworkVerifiedDesc}</p>
            </div>
            <div className="framework-connector" aria-hidden="true" />
            <div className="framework-step">
              <span className="framework-step-icon" aria-hidden="true"><BriefcaseIcon /></span>
              <StatusBadge status="buyer-ready" lang={lang} />
              <p className="framework-step-desc">{t.landingFrameworkBuyerReadyDesc}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="landing-body">
        {/* ── Buyer pack preview ── */}
        <div className="buyer-pack-preview">
          <div className="buyer-pack-preview-eyebrow">{t.landingBuyerPackBadge}</div>
          <div className="buyer-pack-preview-head">
            <div>
              <div className="buyer-pack-preview-title">{t.landingBuyerPackTitle}</div>
              <p className="buyer-pack-preview-desc">{t.landingBuyerPackDesc}</p>
            </div>
          </div>
          <div className="buyer-pack-preview-grid">
            <div className="buyer-pack-preview-field">
              <span className="buyer-pack-preview-label">{t.landingBuyerPackFarmLabel}</span>
              <StatusBadge status="documented" lang={lang} />
            </div>
            <div className="buyer-pack-preview-field">
              <span className="buyer-pack-preview-label">{t.landingBuyerPackBatchLabel}</span>
              <StatusBadge status="reviewed" lang={lang} />
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

        {/* ── What DDP organizes (static — no live counts on the public page) ── */}
        <div className="org-panel">
          <div className="org-panel-head">
            <div className="org-panel-title">{t.landingOrgTitle}</div>
            <p className="org-panel-desc">{t.landingOrgDesc}</p>
          </div>
          <div className="org-grid">
            {orgItems.map((item, i) => (
              <div key={i} className="org-item">
                <span className="org-item-icon" aria-hidden="true">{item.icon}</span>
                <div className="org-item-title">{item.title}</div>
                <div className="org-item-desc">{item.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Why DDP ── */}
        <div className="why-ddp-section">
          <div className="why-ddp-title">{t.landingWhyTitle}</div>
          <div className="concept-cards">
            {whyItems.map((item, i) => (
              <div key={i} className="concept-card">
                <span className="concept-icon-why" aria-hidden="true"><WhyIcon /></span>
                <div className="concept-card-title">{item.title}</div>
                <p className="concept-card-desc">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── About Us ── */}
        <div className="about-section">
          <div className="about-section-title">{t.landingAboutTitle}</div>
          <p className="about-section-text">{t.landingAboutText1}</p>
        </div>

        <div className="legal-strip">{t.landingDisclaimer}</div>
      </div>
    </div>
  )
}
