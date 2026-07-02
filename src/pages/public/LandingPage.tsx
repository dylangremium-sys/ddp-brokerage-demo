import { T } from '../../translations'
import type { Lang } from '../../types'
import { DDPMonogramLogo } from '../../components/logos'

interface Props {
  lang: Lang
  onEnterFarmer: () => void
  onEnterDDP: () => void
}

export default function LandingPage({ lang, onEnterFarmer, onEnterDDP }: Props) {
  const t = T[lang]
  const proofItems = [t.landingProof1, t.landingProof2, t.landingProof3, t.landingProof4, t.landingProof5]

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
              <span className="access-module-icon">🌿</span>
              <span className="access-module-body">
                <span className="access-module-title">{t.landingEnterFarmer}</span>
                <span className="access-module-desc">{t.landingAccessFarmerDesc}</span>
              </span>
              <span className="access-module-arrow">→</span>
            </button>
            <button type="button" className="access-module access-module-secondary" onClick={onEnterDDP}>
              <span className="access-module-icon">🔒</span>
              <span className="access-module-body">
                <span className="access-module-title">{t.landingEnterDDP}</span>
                <span className="access-module-desc">{t.landingAccessDDPDesc}</span>
              </span>
              <span className="access-module-arrow">→</span>
            </button>
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
