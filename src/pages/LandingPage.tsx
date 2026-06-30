import { T } from '../translations'
import type { Lang } from '../types'

interface Props {
  lang: Lang
  onEnterFarmer: () => void
  onEnterDDP: () => void
}

export default function LandingPage({ lang, onEnterFarmer, onEnterDDP }: Props) {
  const t = T[lang]
  return (
    <div className="landing-page">
      <div className="landing-hero">
        <div className="landing-hero-inner">
          <div className="landing-logo-row">
            <svg width="52" height="38" viewBox="0 0 40 30" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="0.75" y="0.75" width="38.5" height="28.5" rx="3.25" fill="#07130F" stroke="#C6A15B" strokeWidth="1.5"/>
              <text x="20" y="20.5" textAnchor="middle" fill="#C6A15B" fontSize="12" fontWeight="800"
                fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" letterSpacing="2.5">DDP</text>
            </svg>
            <span style={{ color: '#C6A15B', fontSize: 12, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase' }}>Verified Supply</span>
          </div>
          <h1 className="landing-headline">DDP Brokerage</h1>
          <div className="landing-tagline">{t.landingTagline}</div>
          <p className="landing-hero-text">{t.landingHero1}</p>
          <p className="landing-hero-text">{t.landingHero2}</p>
          <div className="landing-cta-row">
            <button className="btn btn-farmer-cta" onClick={onEnterFarmer}>{t.landingEnterFarmer}</button>
            <button className="btn btn-ddp-cta" onClick={onEnterDDP}>{t.landingEnterDDP}</button>
          </div>
        </div>
      </div>

      <div className="landing-body">
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
