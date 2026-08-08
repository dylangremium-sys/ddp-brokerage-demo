import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import CorporatePageShell from '../../components/public/CorporatePageShell'

/* ────────────────────────────────────────────────────────────────────────────
   /about — public corporate information.

   SOURCING
     The substantive claims on this page are the landing page's own approved
     copy, reused BY KEY rather than re-typed: the description of what DDP does
     (landingAboutText1), the four process steps (homeProcessStep1-4Desc), the
     statement of what DDP does NOT assess (landingAuthorityNote), and who may
     use the platform (landingDisclaimer).

     That is deliberate. Re-typing this content would let the About page drift
     into a stronger claim than the landing page makes — which is the exact
     failure the master plan's Gate 5 exists to prevent — and it would let the
     two fall out of step when one is edited.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  onNavigate: (page: Page) => void
}

export default function AboutPage({ lang, setLang, onNavigate }: Props) {
  const t = T[lang]

  const steps = [
    { title: t.homeProcessStep1Title, desc: t.homeProcessStep1Desc },
    { title: t.homeProcessStep2Title, desc: t.homeProcessStep2Desc },
    { title: t.homeProcessStep3Title, desc: t.homeProcessStep3Desc },
    { title: t.homeProcessStep4Title, desc: t.homeProcessStep4Desc },
  ]

  return (
    <CorporatePageShell
      lang={lang}
      setLang={setLang}
      page="about"
      onNavigate={onNavigate}
      heading={t.corpAboutHeading}
    >
      <section className="corp-section">
        <h2>{t.corpAboutWhatHeading}</h2>
        <p className="corp-lead">{t.landingAboutText1}</p>
        <p>{t.homeHeroBody}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpAboutProcessHeading}</h2>
        <ol className="corp-steps">
          {/* Keyed by title, not by index: the step titles are distinct and
              stable, and an index key makes React reuse the wrong node if the
              list is ever reordered. */}
          {steps.map((step, i) => (
            <li key={step.title}>
              <span className="corp-step-num" aria-hidden="true">{i + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.desc}</p>
              </div>
            </li>
          ))}
        </ol>
        <p>{t.corpAboutReviewNote}</p>
      </section>

      {/* The limits are stated on their own, under their own heading, rather
          than tucked into a footnote. They are the part of this page a buyer is
          most entitled to see before relying on anything else on it. */}
      <section className="corp-section corp-section-emphasis">
        <h2>{t.corpAboutLimitsHeading}</h2>
        <p>{t.landingAuthorityNote}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpAboutAccessHeading}</h2>
        <p>{t.landingDisclaimer}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpAboutCompanyHeading}</h2>
        <p>{t.corpAboutCompanyIntro}</p>
        <address className="corp-address">
          {t.homeFooterOfficeLine1}<br />
          {t.homeFooterOfficeLine2}<br />
          {t.homeFooterOfficeLine3}<br />
          {t.homeFooterOfficeTel}
        </address>
      </section>
    </CorporatePageShell>
  )
}
