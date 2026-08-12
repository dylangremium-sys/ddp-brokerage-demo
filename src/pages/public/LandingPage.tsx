import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import { pathForPage } from '../../lib/urlRouting'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'
import '../../styles/publicHome.css'

/* ────────────────────────────────────────────────────────────────────────────
   Homepage — handoff screen 9, on the Organic design system.

   WHAT THIS REPLACES. A homepage whose headline was "Organizing evidence.
   Supporting decisions." — a sentence that never says Thailand, never says
   Europe, and never says what DDP brokers. Confirmed still live on
   www.ddpbrokerage.com immediately before this was written. The supplier page
   already carried the plain promise; this brings it to the front door.

   STANDING RULES APPLIED HERE
     1. One primary action. The filled terracotta button is "Apply to supply",
        once, in the nav. The prototype drew the two hero buttons as primary +
        secondary; both are secondary here so the rule holds on the page as a
        whole.
    10. Never display a claim the record cannot support. The prototype's three
        "trust" figures — 2 licensed farms, 233 regulatory updates, 100% of
        batches released with a COA on file — are NOT rendered. They are
        illustrative, the read-only reporting role is refused on every table
        that could derive them
        (RLS calls has_operational_farmer_access, which it may not execute), and
        the third is a compliance claim about a regulated product. The band says
        what is true without them. Real figures are open question 3.

   NO PHOTOGRAPH, AND NO SLOT. The handoff supplies none and forbids shipping
   its striped placeholders. A first pass held the space with a dashed box
   containing the shoot brief — which meant the front door showed every visitor
   an internal note. The hero runs one column until a real asset exists; the
   brief lives in the handoff README under "Assets".

   NOTHING CLAIMS CHAIN OF CUSTODY. AGENTS.md § "Ground rules": fulfilment and
   chain-of-custody tracking are PLANNED, NOT IMPLEMENTED. The handoff's copy
   asserts both in the hero and the compliance band; publishing that to
   regulated buyers would be claiming a capability the record cannot support —
   standing rule 10 again, this time in prose rather than in figures.

   THE APPLICATION FORM IS A PREVIEW, NOT AN INTAKE. See FarmApplicationPanel.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  /** Wired to the existing auth flow — goTo('login') in App.tsx. */
  onSecureLogin: () => void
  /** Routes to the supplier/farmer registration flow. */
  onSupplierSignup: () => void
  /**
   * In-app navigation for the public corporate pages linked from the footer.
   *
   * These links are how a crawler discovers /about, /contact, /privacy and
   * /terms at all. The sitemap lists them, but a sitemap is a hint; an internal
   * link from the site's only established page is the real discovery path. The
   * nav is down to four destinations under this design — these four links stay
   * in the footer, and removing them would orphan four indexed pages.
   */
  onNavigate: (page: Page) => void
}

function scrollToId(id: string) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function FooterLink({ target, label, onNavigate }: {
  target: Page; label: string; onNavigate: (page: Page) => void
}) {
  return (
    <a
      href={pathForPage(target)}
      onClick={e => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate(target) }}
    >
      {label}
    </a>
  )
}

/**
 * What a farm is asked for, shown as a preview — not as live fields.
 *
 * The prototype draws editable inputs here. Rendering them would mean one of
 * two things, and both are worse than this: a second intake path alongside
 * /farmer (out of scope, and it would touch the database), or inputs that
 * accept what a farmer types and silently discard it on navigation. The second
 * is the exact defect this product keeps finding — a control that looks live
 * and is not.
 *
 * So the panel states what will be asked and how long it takes, and its one
 * button hands off to the real registration flow. Flagged for the owner: if a
 * live first step on the homepage is wanted, it needs the intake path designed,
 * not improvised here.
 */
function FarmApplicationPanel({ lang, onStart }: { lang: Lang; onStart: () => void }) {
  const t = T[lang]
  const crops = [t.hpCrop1, t.hpCrop2, t.hpCrop3, t.hpCrop4]

  return (
    <div className="hp-form">
      <div className="hp-eyebrow">{t.hpFormTitle}</div>
      <p style={{ margin: '10px 0 0', fontSize: 14, color: 'var(--color-neutral-700)' }}>
        {t.hpFormStep}
      </p>
      <div className="hp-progress" aria-hidden="true"><div className="hp-progress-fill" /></div>

      <ul className="hp-points hp-field-grid" style={{ marginTop: 24 }}>
        {[t.hpFormFarmName, t.hpFormProvince, t.hpFormLicence].map(label => (
          <li key={label}>
            <span className="hp-tick" aria-hidden="true">·</span>
            <span>{label}</span>
          </li>
        ))}
      </ul>

      <p style={{ margin: '22px 0 10px', fontSize: 14, fontWeight: 600 }}>{t.hpFormCrops}</p>
      {/* Labels, not controls. These were buttons with local `crop` state that
          `onStart` never received and navigation threw away — an apparent
          answer to an apparent "Step 1 of 4", silently discarded. That is the
          same trap the fields above are written to avoid, so the pills stop
          pretending too. The real choice is made in the registration flow. */}
      <div className="hp-croprow">
        {crops.map(c => (
          <span key={c} className="tag tag-outline">{c}</span>
        ))}
      </div>

      <div className="hp-note">{t.hpFormUploadNote}</div>

      <button type="button" className="btn btn-secondary btn-block" onClick={onStart} style={{ marginTop: 20 }}>
        {t.hpFarmsCta}
      </button>

      <p className="hp-reassure">{t.hpFormReassure}</p>
    </div>
  )
}

export default function LandingPage({ lang, setLang, onSecureLogin, onSupplierSignup, onNavigate }: Props) {
  const t = T[lang]

  const steps = [
    { num: '1', title: t.hpStep1Title, body: t.hpStep1Body, who: t.hpStep1Who },
    { num: '2', title: t.hpStep2Title, body: t.hpStep2Body, who: t.hpStep2Who },
    { num: '3', title: t.hpStep3Title, body: t.hpStep3Body, who: t.hpStep3Who },
    { num: '4', title: t.hpStep4Title, body: t.hpStep4Body, who: t.hpStep4Who },
  ]

  const points = [t.hpFarmPoint1, t.hpFarmPoint2, t.hpFarmPoint3, t.hpFarmPoint4]

  return (
    <div className="organic-scope">
      <div className="hp">

        {/* ── Nav ─────────────────────────────────────────────────────────── */}
        <div className="hp-wrap">
          <nav className="hp-nav">
            <span className="hp-brand">
              <span className="hp-mark" aria-hidden="true">DDP</span>
              <span className="hp-wordmark">Brokerage</span>
            </span>

            <button type="button" className="hp-navlink" onClick={() => scrollToId('how-it-works')}>
              {t.hpNavHowItWorks}
            </button>
            <button type="button" className="hp-navlink" onClick={() => scrollToId('for-farms')}>
              {t.hpNavForFarms}
            </button>
            <button type="button" className="hp-navlink" onClick={() => scrollToId('for-buyers')}>
              {t.hpNavForBuyers}
            </button>
            <button type="button" className="hp-navlink" onClick={() => scrollToId('compliance')}>
              {t.hpNavCompliance}
            </button>

            {/* Language. The label is each language in its own script, so a
                reader who cannot read the current one can still find theirs.

                Its own classes, not Organic's `.seg`/`.seg-opt`: those style
                the active option with `:has(input:checked)`, i.e. they expect a
                radio inside each option. These are buttons, so the Organic
                rule would never match and the active language would show no
                state at all. */}
            <div className="hp-seg" role="group" aria-label="Language">
              {(['en', 'th'] as const).map(code => (
                <button
                  key={code}
                  type="button"
                  className={`hp-seg-opt${lang === code ? ' is-active' : ''}`}
                  aria-pressed={lang === code}
                  onClick={() => setLang(code)}
                >
                  {code === 'th' ? 'ไทย' : 'EN'}
                </button>
              ))}
            </div>

            <button type="button" className="btn btn-ghost" onClick={onSecureLogin}>
              {t.hpNavSignIn}
            </button>
            {/* The one primary action on this page. */}
            <button type="button" className="btn btn-primary" onClick={onSupplierSignup}>
              {t.hpNavApply}
            </button>
          </nav>
        </div>

        {/* ── Hero ────────────────────────────────────────────────────────── */}
        <div className="hp-wrap">
          <section className="hp-hero">
            <div>
              <span className="hp-badge">{t.hpHeroBadge}</span>
              <h1>{t.hpHeroTitle}</h1>
              <p className="hp-hero-body">{t.hpHeroBody}</p>

              <div className="hp-cta-row">
                <button type="button" className="btn btn-secondary" onClick={onSupplierSignup}>
                  {t.hpHeroCtaFarm}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => scrollToId('for-buyers')}>
                  {t.hpHeroCtaBuyer}
                </button>
              </div>

              <div className="hp-creds">
                <span className="tag tag-outline">{t.hpCred1}</span>
                <span className="tag tag-outline">{t.hpCred2}</span>
                <span className="tag tag-outline">{t.hpCred3}</span>
              </div>
            </div>

            {/*
              NO PHOTOGRAPH, AND NO SLOT EITHER.

              This held a dashed box containing the words "photo — a licensed
              Chiang Mai greenhouse, daylight, workers with visible ID badges".
              That is a note to ourselves, and it was rendered at full size to
              every visitor on the front door — `role="presentation"` changes
              how assistive technology treats an element, it does not hide it.
              So the comment above it said "do not ship the placeholder" while
              the markup shipped one.

              An empty framed box is not better: it reads as a broken image. The
              hero simply runs one column until there is a photograph to put
              here. The brief lives in the handoff README under "Assets", which
              is where a brief belongs.
            */}
          </section>
        </div>

        {/* ── How it works ────────────────────────────────────────────────── */}
        <div className="hp-band-sand" id="how-it-works">
          <div className="hp-wrap hp-section">
            <h2>{t.hpStepsTitle}</h2>
            <div className="hp-steps">
              {steps.map(s => (
                <div className="hp-step" key={s.num}>
                  <span className="hp-step-num" aria-hidden="true">{s.num}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                  <p className="hp-step-who">{s.who}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── For farms + application preview ─────────────────────────────── */}
        <div className="hp-wrap hp-section" id="for-farms">
          <div className="hp-split">
            <div>
              <div className="hp-eyebrow">{t.hpFarmsEyebrow}</div>
              <h2 style={{ marginTop: 14 }}>{t.hpFarmsTitle}</h2>
              <p style={{ fontSize: 17, lineHeight: 1.65, maxWidth: '48ch', marginTop: 18 }}>
                {t.hpFarmsBody}
              </p>
              <ul className="hp-points">
                {points.map(p => (
                  <li key={p}>
                    <span className="hp-tick" aria-hidden="true">✓</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>

            <FarmApplicationPanel lang={lang} onStart={onSupplierSignup} />
          </div>
        </div>

        {/* ── Compliance band ─────────────────────────────────────────────── */}
        <div className="hp-compliance" id="compliance">
          <div className="hp-wrap hp-section">
            <h2>{t.hpComplianceTitle}</h2>
            <p>{t.hpComplianceBody}</p>
          </div>
        </div>

        {/* ── Buyer strip ─────────────────────────────────────────────────── */}
        <div className="hp-wrap hp-section" id="for-buyers">
          <div className="hp-buyers">
            <div>
              <h2>{t.hpBuyersTitle}</h2>
              <p>{t.hpBuyersBody}</p>
            </div>
            {/* Routed to the existing contact page rather than a new endpoint:
                there is no public access-request intake, and inventing one
                would be a second path into DDPAccessRequests. */}
            <button type="button" className="btn btn-secondary" onClick={() => onNavigate('contact')}>
              {t.hpBuyersCta}
            </button>
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <footer className="hp-footer">
          <div className="hp-wrap">
            <div className="hp-footer-links">
              <FooterLink target="about" label={t.homeFooterAbout} onNavigate={onNavigate} />
              <FooterLink target="contact" label={t.homeFooterContact} onNavigate={onNavigate} />
              <FooterLink target="privacy" label={t.homeFooterPrivacy} onNavigate={onNavigate} />
              <FooterLink target="terms" label={t.homeFooterTerms} onNavigate={onNavigate} />
            </div>
            <p className="hp-footer-note">© 2026 DDP Brokerage · Bangkok &amp; Prague</p>
            <p className="hp-footer-note">{t.hpFooterNote}</p>
          </div>
        </footer>

      </div>
    </div>
  )
}
