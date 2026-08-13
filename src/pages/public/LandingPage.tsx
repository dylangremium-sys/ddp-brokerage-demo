import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import { pathForPage } from '../../lib/urlRouting'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'
import { BatchDossierCard } from '../../components/public/BatchDossierCard'
import '../../styles/publicHome.css'

/* ────────────────────────────────────────────────────────────────────────────
   Homepage — handoff screen 9, on the Organic design system.

   WHAT THIS REPLACES. A homepage whose headline was "Organizing evidence.
   Supporting decisions." — a sentence that never says Thailand, never says
   Europe, and never says what DDP brokers. Confirmed still live on
   www.ddpbrokerage.com immediately before this was written. The supplier page
   already carried the plain promise; this brings it to the front door.

   STANDING RULES APPLIED HERE
     1. One primary action, AND IT BELONGS TO THE PAGE. The filled terracotta
        button is the hero's "Register your farm". An earlier pass put the only
        primary in the nav and stepped both hero buttons down to secondary,
        reasoning that one-per-page was satisfied either way. It is not: rule 1
        says the primary "belongs to the *page*, never to the chrome — the nav's
        own CTA steps down to `.btn-secondary` so it cannot outrank the hero's".
        A visitor met a front door whose loudest control was a nav item.
     3. The status vocabulary is four states, and the hero's batch dossier card
        renders them from src/lib/statusVocabulary.ts — the same constant the
        console reads. No status string is typed on this page.
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
      <p className="hp-form-step">
        {t.hpFormStep}
      </p>
      <div className="hp-progress" aria-hidden="true"><div className="hp-progress-fill" /></div>

      <ul className="hp-points hp-field-grid">
        {[t.hpFormFarmName, t.hpFormProvince, t.hpFormLicence].map(label => (
          <li key={label}>
            <span className="hp-tick" aria-hidden="true">·</span>
            <span>{label}</span>
          </li>
        ))}
      </ul>

      <p className="hp-form-cropslabel">{t.hpFormCrops}</p>
      {/* Labels, not controls. These were buttons with local `crop` state that
          `onStart` never received and navigation threw away — an apparent
          answer to an apparent "Step 1 of 4", silently discarded. That is the
          same trap the fields above are written to avoid, so the pills stop
          pretending too. The real choice is made in the registration flow. */}
      <div className="hp-croprow">
        {crops.map(cropLabel => (
          <span key={cropLabel} className="tag tag-outline">{cropLabel}</span>
        ))}
      </div>

      <div className="hp-note">{t.hpFormUploadNote}</div>

      <button type="button" className="btn btn-secondary btn-block hp-form-cta" onClick={onStart}>
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
            {/* A page, not an anchor. Rendered as an anchor with the real path
                so it is discoverable — the same reasoning as the footer links. */}
            <a
              href={pathForPage('governance')}
              className="hp-navlink"
              onClick={e => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate('governance') }}
            >
              {t.hpNavCompliance}
            </a>

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

            {/* One action group, not two controls adrift in the corner. The
                pair sits in its own wrapper so the gap between them is tighter
                than the nav's own 26px rhythm, which is what makes them read as
                belonging together. */}
            <div className="hp-nav-actions">
              <button type="button" className="btn btn-ghost" onClick={onSecureLogin}>
                {t.hpNavSignIn}
              </button>
              {/* Secondary, not primary. Rule 1: the filled terracotta button
                  belongs to the page, never to the chrome — the nav's CTA steps
                  down so it cannot outrank the hero's. Weight is not hierarchy:
                  this carries a tint so it reads as a deliberate control, and
                  the tint is a ramp step nowhere near the hero's solid 500. */}
              <button type="button" className="btn btn-secondary" onClick={onSupplierSignup}>
                {t.hpNavApply}
              </button>
            </div>
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
                {/* The page's one primary action. */}
                <button type="button" className="btn btn-primary" onClick={onSupplierSignup}>
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
              STILL NO PHOTOGRAPH. §9 puts a 210px `.washed` frame above this
              card and there is no such asset — the only image in the repo is an
              unrelated 343×361 graphic. The earlier note here holds and is worth
              keeping: the box that once stood in this column rendered the shoot
              brief itself to every visitor, and an empty frame reads as a broken
              image. So the column carries the card alone until the facility
              frame exists; the brief lives in the handoff README under "Assets".
            */}
            <BatchDossierCard lang={lang} />
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
              <h2 className="hp-split-title">{t.hpFarmsTitle}</h2>
              <p className="hp-split-lede">
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
            {/* §9 specifies this link; it had no destination until §11 existed. */}
            <a
              href={pathForPage('governance')}
              className="hp-compliance-link"
              onClick={e => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate('governance') }}
            >
              {t.hpComplianceLink}
            </a>
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
