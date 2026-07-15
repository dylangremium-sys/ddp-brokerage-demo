import { T } from '../../translations'
import type { Lang } from '../../types'
import { DDPMonogramLogo } from '../../components/logos'

/* ────────────────────────────────────────────────────────────────────────────
   Homepage — implements the approved LandPage.png visual specification.
   Palette: deep forest green nav/strip/footer, warm gold accent, cream hero.
   All styles are scoped under `.landing-shell` in App.css so the page keeps its
   own light theme while the rest of the app stays on the navy palette.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  /** Wired to the existing auth flow — goTo('login') in App.tsx. */
  onSecureLogin: () => void
}

function scrollToId(id: string) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/* ── Icons (inline, no external assets) ─────────────────────────────────────── */
function CaretIcon() {
  return (
    <svg className="ln-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6,9 12,15 18,9" />
    </svg>
  )
}

function LockIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg className="ln-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="12" x2="19" y2="12" />
      <polyline points="13,6 19,12 13,18" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9,6 15,12 9,18" />
    </svg>
  )
}

function CheckCircleIcon() {
  return (
    <svg className="ln-doc-check" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#3E8E5A" />
      <path d="M7.5 12.4l3 3 6-6.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* Small row icons for the sample-batch checklist */
function DocGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3.5h7l4 4V20a1 1 0 01-1 1H7a1 1 0 01-1-1V4.5a1 1 0 011-1z" />
      <path d="M13.5 3.5v4.5H18" />
    </svg>
  )
}
function LabGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.5v6L5.5 18a1.5 1.5 0 001.4 2.1h10.2A1.5 1.5 0 0018.5 18L14 9.5v-6" />
      <path d="M8.5 3.5h7" />
      <path d="M8 14h8" />
    </svg>
  )
}
function UserGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5.5 20c0-3.4 2.9-5.6 6.5-5.6s6.5 2.2 6.5 5.6" />
    </svg>
  )
}
function DecisionGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.3l2.6 2.6L16 9.4" />
    </svg>
  )
}
function ShieldGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.5l7.5 3v6c0 5-3.2 8.3-7.5 10-4.3-1.7-7.5-5-7.5-10v-6l7.5-3z" />
      <path d="M8.75 12.25l2.25 2.25 4.25-4.5" />
    </svg>
  )
}

/* Process-step icons */
function LeafGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21v-8.5" />
      <path d="M12 12.5C10.6 9.6 7.8 7.5 4.8 7c0 3.3 2.2 6.1 7.2 6.9" />
      <path d="M12 12.5C13.4 9.6 16.2 7.5 19.2 7c0 3.3-2.2 6.1-7.2 6.9" />
    </svg>
  )
}
function UsersGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" />
      <path d="M16 6.2a3 3 0 010 5.6" />
      <path d="M17.5 14.5c2.4.5 4 2.2 4 4.5" />
    </svg>
  )
}

/* Assurance-strip icons */
function ClipboardGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4.5" width="14" height="16" rx="2" />
      <path d="M9 4.5a3 3 0 016 0" />
      <path d="M8.5 12l2 2 4-4.2" />
    </svg>
  )
}
function BarChartGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="12" width="3" height="6" />
      <rect x="11" y="8" width="3" height="10" />
      <rect x="16" y="4.5" width="3" height="13.5" />
    </svg>
  )
}

/* Footer channel icons */
function MailGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M4 7l8 5.5L20 7" />
    </svg>
  )
}
function PinGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21c4-4.2 7-7.6 7-11a7 7 0 10-14 0c0 3.4 3 6.8 7 11z" />
      <circle cx="12" cy="10" r="2.6" />
    </svg>
  )
}

export default function LandingPage({ lang, setLang, onSecureLogin }: Props) {
  const t = T[lang]

  const navItems: Array<{ key: string; label: string; target?: string; caret?: boolean }> = [
    { key: 'cap', label: t.navCapabilities, caret: true },
    { key: 'proc', label: t.navProcess, target: 'process' },
    { key: 'evi', label: t.navEvidence, target: 'evidence' },
    { key: 'gov', label: t.navGovernance, target: 'governance' },
    { key: 'com', label: t.navCompany, target: 'contact' },
    { key: 'res', label: t.navResources, caret: true },
  ]

  const checklist = [
    { icon: <UserGlyph />, label: t.homeBatchSupplierProfile, status: t.homeBatchStatusDocumented, tone: 'ok' },
    { icon: <DocGlyph />, label: t.homeBatchBatchEvidence, status: t.homeBatchStatusUnderReview, tone: 'pending' },
    { icon: <LabGlyph />, label: t.homeBatchLabReport, status: t.homeBatchStatusPresent, tone: 'ok' },
    { icon: <DecisionGlyph />, label: t.homeBatchBuyerRequirements, status: t.homeBatchStatusMatched, tone: 'ok' },
    { icon: <UserGlyph />, label: t.homeBatchHumanDecision, status: t.homeBatchStatusRequired, tone: 'pending' },
  ]

  const docStatus = [
    t.homeDocAllPresent,
    t.homeDocCoa,
    t.homeDocPesticides,
    t.homeDocHeavyMetals,
    t.homeDocMicro,
  ]

  const steps = [
    { icon: <LeafGlyph />, title: t.homeProcessStep1Title, desc: t.homeProcessStep1Desc },
    { icon: <DocGlyph />, title: t.homeProcessStep2Title, desc: t.homeProcessStep2Desc },
    { icon: <UsersGlyph />, title: t.homeProcessStep3Title, desc: t.homeProcessStep3Desc },
    { icon: <ShieldGlyph size={24} />, title: t.homeProcessStep4Title, desc: t.homeProcessStep4Desc },
  ]

  const assurance = [
    { icon: <ClipboardGlyph />, title: t.homeAssurance1Title, desc: t.homeAssurance1Desc },
    { icon: <UserGlyph />, title: t.homeAssurance2Title, desc: t.homeAssurance2Desc },
    { icon: <ShieldGlyph size={24} />, title: t.homeAssurance3Title, desc: t.homeAssurance3Desc },
    { icon: <LockIcon size={24} />, title: t.homeAssurance4Title, desc: t.homeAssurance4Desc },
    { icon: <BarChartGlyph />, title: t.homeAssurance5Title, desc: t.homeAssurance5Desc },
  ]

  return (
    <div className="landing-shell">
      {/* ── Top navigation ── */}
      <header className="ln-nav">
        <div className="ln-nav-inner">
          <div className="ln-nav-left">
            <a
              className="ln-brand"
              href="#top"
              onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              aria-label="DDP Brokerage — home"
            >
              <span className="ln-brand-logo"><DDPMonogramLogo height={54} color="#C6A24C" /></span>
            </a>
            <span className="ln-brand-descriptor">{t.navBrandDescriptor}</span>
          </div>

          <nav className="ln-nav-menu" aria-label="Primary">
            {navItems.map((item) =>
              item.target ? (
                <a
                  key={item.key}
                  className="ln-nav-link"
                  href={`#${item.target}`}
                  onClick={(e) => { e.preventDefault(); scrollToId(item.target!) }}
                >
                  {item.label}
                </a>
              ) : (
                // Visual-only dropdown labels (no target page yet) — decision: render as-is.
                <span key={item.key} className="ln-nav-link ln-nav-link-static">
                  {item.label}
                  {item.caret && <CaretIcon />}
                </span>
              ),
            )}
          </nav>

          <div className="ln-nav-right">
            <div className="ln-lang" role="group" aria-label="Language">
              <button
                type="button"
                className={`ln-lang-btn${lang === 'en' ? ' is-active' : ''}`}
                aria-pressed={lang === 'en'}
                onClick={() => setLang('en')}
              >
                EN
              </button>
              <span className="ln-lang-sep" aria-hidden="true">|</span>
              <button
                type="button"
                className={`ln-lang-btn${lang === 'th' ? ' is-active' : ''}`}
                aria-pressed={lang === 'th'}
                onClick={() => setLang('th')}
              >
                ไทย
              </button>
            </div>
            <button type="button" className="ln-secure-login" onClick={onSecureLogin}>
              <LockIcon size={14} />
              {t.navSecureLogin}
            </button>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="ln-hero" id="top">
        {/* Decorative cannabis leaf bleeding from the left edge */}
        <svg className="ln-hero-leaf" viewBox="0 0 200 260" fill="none" aria-hidden="true">
          <g stroke="#2E5B3A" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="#2E5B3A" fillOpacity="0.14">
            <path d="M100 250 L100 120" />
            <path d="M100 120 C70 118 34 96 12 54 C58 44 92 70 100 120 Z" />
            <path d="M100 120 C130 118 166 96 188 54 C142 44 108 70 100 120 Z" />
            <path d="M100 132 C68 138 30 128 4 96 C46 78 86 92 100 132 Z" />
            <path d="M100 132 C132 138 170 128 196 96 C154 78 114 92 100 132 Z" />
            <path d="M100 150 C74 160 44 158 22 138 C58 120 90 128 100 150 Z" />
            <path d="M100 150 C126 160 156 158 178 138 C142 120 110 128 100 150 Z" />
            <path d="M100 96 C84 66 82 34 92 6 C112 30 112 66 100 96 Z" />
            <path d="M100 96 C116 66 118 34 108 6 C88 30 88 66 100 96 Z" />
          </g>
        </svg>

        <div className="ln-hero-inner">
          <div className="ln-hero-copy">
            <p className="ln-eyebrow">{t.homeHeroEyebrow}</p>
            <h1 className="ln-headline">
              <span className="ln-headline-line">{t.homeHeroHeadlineLine1}</span>
              <span className="ln-headline-line">{t.homeHeroHeadlineLine2}</span>
            </h1>
            <p className="ln-hero-body">{t.homeHeroBody}</p>
            <div className="ln-hero-ctas">
              <button type="button" className="ln-btn ln-btn-primary" onClick={() => scrollToId('contact')}>
                {t.homeHeroCtaPrimary}
                <ArrowIcon />
              </button>
              <button type="button" className="ln-btn ln-btn-outline" onClick={() => scrollToId('process')}>
                {t.homeHeroCtaSecondary}
              </button>
            </div>
            <p className="ln-hero-secure">
              <LockIcon size={15} />
              {t.homeHeroSecureNote}
            </p>
          </div>

          {/* ── Sample Batch Overview card ── */}
          <div className="ln-batch" id="evidence">
            <div className="ln-batch-head">
              <h2 className="ln-batch-title">{t.homeBatchTitle}</h2>
              <span className="ln-batch-badge">{t.homeBatchReviewBadge}</span>
            </div>
            <p className="ln-batch-disclaimer">{t.homeBatchDisclaimer}</p>

            <div className="ln-batch-cols">
              <ul className="ln-check">
                {checklist.map((row, i) => (
                  <li className="ln-check-row" key={i}>
                    <span className="ln-check-ico" aria-hidden="true">{row.icon}</span>
                    <span className="ln-check-label">{row.label}</span>
                    <span className={`ln-check-status ln-status-${row.tone}`}>
                      <span className="ln-status-dot" aria-hidden="true" />
                      {row.status}
                    </span>
                  </li>
                ))}
                <li className="ln-check-note">
                  <span className="ln-check-note-ico" aria-hidden="true"><ShieldGlyph size={20} /></span>
                  <span>{t.homeBatchAuditNote}</span>
                </li>
              </ul>

              <div className="ln-batch-right">
                <div className="ln-summary">
                  <div className="ln-summary-main">
                    <div className="ln-summary-title">{t.homeBatchSummaryTitle}</div>
                    <dl className="ln-summary-list">
                      <div><dt>{t.homeBatchStrainLabel}</dt><dd>{t.homeBatchStrainValue}</dd></div>
                      <div><dt>{t.homeBatchOriginLabel}</dt><dd>{t.homeBatchOriginValue}</dd></div>
                      <div><dt>{t.homeBatchIdLabel}</dt><dd>{t.homeBatchIdValue}</dd></div>
                      <div><dt>{t.homeBatchHarvestLabel}</dt><dd>{t.homeBatchHarvestValue}</dd></div>
                    </dl>
                  </div>
                </div>

                <div className="ln-docs">
                  <div className="ln-docs-title">{t.homeDocStatusTitle}</div>
                  <div className="ln-docs-bar" aria-hidden="true"><span /></div>
                  <ul className="ln-docs-list">
                    {docStatus.map((line, i) => (
                      <li key={i}><CheckCircleIcon />{line}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Our Procurement Process ── */}
      <section className="ln-process" id="process">
        <div className="ln-process-inner">
          <h2 className="ln-section-title">{t.homeProcessTitle}</h2>
          <ol className="ln-steps">
            {steps.map((s, i) => (
              <li className="ln-step" key={i}>
                <div className="ln-step-head">
                  <span className="ln-step-num">{i + 1}</span>
                  <span className="ln-step-ico" aria-hidden="true">{s.icon}</span>
                </div>
                <div className="ln-step-title">{s.title}</div>
                <p className="ln-step-desc">{s.desc}</p>
                {i < steps.length - 1 && (
                  <span className="ln-step-conn" aria-hidden="true">
                    <ChevronRightIcon />
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Assurance strip (dark) ── */}
      <section className="ln-assurance" id="governance">
        <div className="ln-assurance-inner">
          {assurance.map((a, i) => (
            <div className="ln-assurance-item" key={i}>
              <span className="ln-assurance-ico" aria-hidden="true">{a.icon}</span>
              <div className="ln-assurance-title">{a.title}</div>
              <p className="ln-assurance-desc">{a.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer / contact ── */}
      <footer className="ln-footer" id="contact">
        <div className="ln-footer-inner">
          <div className="ln-footer-lead">
            <h2 className="ln-footer-heading">{t.homeFooterHeading}</h2>
            <p className="ln-footer-sub">{t.homeFooterSub}</p>
            <span className="ln-footer-rule" aria-hidden="true" />
          </div>

          <div className="ln-footer-channels">
            <div className="ln-channel">
              <span className="ln-channel-ico ln-channel-mail" aria-hidden="true"><MailGlyph /></span>
              <div className="ln-channel-body">
                <div className="ln-channel-label">{t.homeFooterEmailLabel}</div>
                <a className="ln-channel-value" href={`mailto:${t.homeFooterEmail1}`}>{t.homeFooterEmail1}</a>
                <a className="ln-channel-value" href={`mailto:${t.homeFooterEmail2}`}>{t.homeFooterEmail2}</a>
              </div>
            </div>

            <div className="ln-channel">
              <span className="ln-channel-ico ln-channel-line" aria-hidden="true">LINE</span>
              <div className="ln-channel-body">
                <div className="ln-channel-label">{t.homeFooterLineLabel}</div>
                <span className="ln-channel-value">{t.homeFooterLineValue}</span>
              </div>
            </div>

            <div className="ln-channel">
              <span className="ln-channel-ico ln-channel-wa" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                  <path d="M12 2a10 10 0 00-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1012 2zm0 2a8 8 0 016.6 12.5l-.3.5.7 2.5-2.6-.7-.5.3A8 8 0 1112 4zm-3 4.2c-.2 0-.5 0-.7.4-.2.4-.9 1-.9 2.3s1 2.7 1.1 2.9c.2.2 1.9 3 4.7 4 .7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2 0-.1-.2-.2-.5-.3l-1.7-.8c-.2-.1-.4-.1-.6.1l-.7.9c-.1.2-.3.2-.5.1-.6-.2-1.4-.5-2.2-1.3-.6-.6-1-1.3-1.2-1.5-.1-.2 0-.4.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.8-1.9c-.2-.5-.4-.4-.6-.4z" />
                </svg>
              </span>
              <div className="ln-channel-body">
                <div className="ln-channel-label">{t.homeFooterWhatsappLabel}</div>
                <span className="ln-channel-value">{t.homeFooterWhatsappValue}</span>
              </div>
            </div>

            <div className="ln-channel">
              <span className="ln-channel-ico ln-channel-pin" aria-hidden="true"><PinGlyph /></span>
              <div className="ln-channel-body">
                <div className="ln-channel-label">{t.homeFooterOfficeLabel}</div>
                <span className="ln-channel-value ln-channel-address">
                  {t.homeFooterOfficeLine1}<br />
                  {t.homeFooterOfficeLine2}<br />
                  {t.homeFooterOfficeLine3}
                </span>
                <span className="ln-channel-tel">{t.homeFooterOfficeTel}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="ln-footer-bottom">
          <span className="ln-copyright">{t.homeFooterCopyright}</span>
          <span className="ln-footer-legal">
            <button type="button" className="ln-footer-legal-link">{t.homeFooterPrivacy}</button>
            <span className="ln-footer-legal-sep" aria-hidden="true">|</span>
            <button type="button" className="ln-footer-legal-link">{t.homeFooterTerms}</button>
          </span>
        </div>
      </footer>
    </div>
  )
}
