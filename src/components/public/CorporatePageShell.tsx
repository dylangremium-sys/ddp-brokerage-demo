import type { ReactNode } from 'react'
import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import { DDPMonogramLogo } from '../logos'
import { pathForPage } from '../../lib/urlRouting'
import { metadataForPage } from '../../lib/publicPageMetadata'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'

/* ────────────────────────────────────────────────────────────────────────────
   Shell for the public corporate pages (/about, /contact, /privacy, /terms).

   WHY EVERY LINK HERE IS A REAL <a href>
     These are the first pages on this site that exist to be found from outside
     it, and a crawler discovers pages by following `href` attributes. The
     landing page's own Privacy and Terms controls were `<button>` elements with
     no handler — invisible to a crawler and inert to a visitor. Rendering an
     anchor with the real path and guarding the interception keeps the SPA from
     hard-reloading on an ordinary click while leaving a bookmark, a Cmd-click
     and "open in new tab" working exactly as the browser promises.

     The paths are read from lib/urlRouting rather than written out here, so a
     link cannot point at a path the router does not accept.

   WHY IT IS NOT THE AUTH SHELL
     PUBLIC_AUTH_PAGES drives the cream `public-auth-shell` card. A privacy
     policy is a document, not a card, so these pages carry their own full-width
     chrome — see navigationGuard.ts, where PUBLIC_CORPORATE_PAGES is kept
     deliberately separate for this reason.

   WHY THE CHROME IS SPLIT INTO SMALL COMPONENTS
     Header, language switch, provenance line and footer are separate components
     rather than one deep tree. Written inline it reached six levels of JSX
     nesting, which is both a DeepSource finding and genuinely hard to read —
     the language toggle sat four levels inside the header markup. Each piece
     now has a name that says what it is.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  /** The page being rendered — used to mark the current link in the footer. */
  page: Page
  /** In-app navigation. The anchors still carry a real href for crawlers. */
  onNavigate: (page: Page) => void
  /** Page heading, rendered as the single <h1>. */
  heading: string
  children: ReactNode
}

/** The corporate pages, in the order they appear in the navigation. */
const CORPORATE_LINKS: Array<{
  page: Page
  labelKey: 'homeFooterAbout' | 'homeFooterContact' | 'homeFooterPrivacy' | 'homeFooterTerms'
}> = [
  { page: 'about', labelKey: 'homeFooterAbout' },
  { page: 'contact', labelKey: 'homeFooterContact' },
  { page: 'privacy', labelKey: 'homeFooterPrivacy' },
  { page: 'terms', labelKey: 'homeFooterTerms' },
]

function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
    </svg>
  )
}

/**
 * An in-app link that a crawler can also follow.
 *
 * Module scope, not inside the component: a component created during render is
 * a fresh type each time, so React remounts rather than updates its subtree
 * (react-hooks/static-components). `currentPage` therefore has to be passed
 * rather than closed over.
 */
function InternalLink({
  target, currentPage, onNavigate, className, children,
}: {
  target: Page
  currentPage: Page
  onNavigate: (page: Page) => void
  className?: string
  children: ReactNode
}) {
  return (
    <a
      href={pathForPage(target)}
      className={className}
      // aria-current marks the page you are already on, for screen readers.
      aria-current={target === currentPage ? 'page' : undefined}
      // Guarded, not unconditional: a Cmd/Ctrl-click is the browser's own
      // "open in a new tab" and must reach the browser. See lib/anchorNavigation.
      onClick={(e) => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate(target) }}
    >
      {children}
    </a>
  )
}

/** EN / ไทย switch. */
function LangSwitch({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="corp-lang" role="group" aria-label="Language">
      <button
        type="button"
        className={`corp-lang-btn${lang === 'en' ? ' is-active' : ''}`}
        aria-pressed={lang === 'en'}
        onClick={() => setLang('en')}
      >
        EN
      </button>
      <span className="corp-lang-sep" aria-hidden="true">|</span>
      <button
        type="button"
        className={`corp-lang-btn${lang === 'th' ? ' is-active' : ''}`}
        aria-pressed={lang === 'th'}
        onClick={() => setLang('th')}
      >
        ไทย
      </button>
    </div>
  )
}

/** Brand, cross-links to the other corporate pages, language and sign-in. */
function CorporateHeader({
  lang, setLang, page, onNavigate,
}: {
  lang: Lang
  setLang: (l: Lang) => void
  page: Page
  onNavigate: (page: Page) => void
}) {
  const copy = T[lang]

  return (
    <header className="corp-nav">
      <div className="corp-nav-inner">
        <InternalLink target="landing" currentPage={page} onNavigate={onNavigate} className="corp-brand">
          <DDPMonogramLogo height={44} color="#C6A24C" />
          <span className="corp-brand-descriptor">{copy.navBrandDescriptor}</span>
        </InternalLink>

        <nav className="corp-nav-menu" aria-label={copy.corpRelatedHeading}>
          <InternalLink target="landing" currentPage={page} onNavigate={onNavigate} className="corp-nav-link">{copy.corpNavHome}</InternalLink>
          {CORPORATE_LINKS.map(({ page: target, labelKey }) => (
            <InternalLink key={target} target={target} currentPage={page} onNavigate={onNavigate} className="corp-nav-link">{copy[labelKey]}</InternalLink>
          ))}
        </nav>

        <div className="corp-nav-right">
          <LangSwitch lang={lang} setLang={setLang} />
          <button type="button" className="corp-login" onClick={() => onNavigate('login')}>
            <LockIcon />
            {copy.navSecureLogin}
          </button>
        </div>
      </div>
    </header>
  )
}

/**
 * Named content owner and last-reviewed date.
 *
 * The search-exposure master plan requires both on every public corporate page.
 * Rendered as visible text rather than a comment because its purpose is to tell
 * a reader who stands behind the page and how current it is.
 */
function PageProvenance({ lang, page }: { lang: Lang; page: Page }) {
  const copy = T[lang]

  return (
    <p className="corp-provenance">
      <span>{copy.corpOwnerLabel}: <strong>{copy.corpOwnerValue}</strong></span>
      <span className="corp-provenance-sep" aria-hidden="true">·</span>
      <span>{copy.corpReviewedLabel}: <time dateTime={metadataForPage(page).lastReviewed}>{copy.corpReviewedValue}</time></span>
    </p>
  )
}

/** Cross-links, the two approved legal notices, and the copyright line. */
function CorporateFooter({
  lang, page, onNavigate,
}: {
  lang: Lang
  page: Page
  onNavigate: (page: Page) => void
}) {
  const copy = T[lang]

  return (
    <footer className="corp-footer">
      <div className="corp-footer-inner">
        <nav className="corp-footer-links" aria-label={copy.corpRelatedHeading}>
          <InternalLink target="landing" currentPage={page} onNavigate={onNavigate} className="corp-footer-link">{copy.corpBackHome}</InternalLink>
          {CORPORATE_LINKS.filter(({ page: target }) => target !== page).map(({ page: target, labelKey }) => (
            <InternalLink key={target} target={target} currentPage={page} onNavigate={onNavigate} className="corp-footer-link">{copy[labelKey]}</InternalLink>
          ))}
        </nav>

        {/* The same two notices the landing page carries, reused by key. They
            are the company's approved statement of what it does and does not
            assess, and they belong on any page that describes the service. */}
        <div className="corp-footer-legalnote">
          <p>{copy.landingAuthorityNote}</p>
          <p>{copy.landingDisclaimer} {copy.landingDisclaimerAccess}</p>
        </div>

        <p className="corp-copyright">{copy.homeFooterCopyright}</p>
      </div>
    </footer>
  )
}

export default function CorporatePageShell({ lang, setLang, page, onNavigate, heading, children }: Props) {
  return (
    <div className="corp-shell">
      <CorporateHeader lang={lang} setLang={setLang} page={page} onNavigate={onNavigate} />

      <main className="corp-main" id="main">
        <article className="corp-doc">
          <h1 className="corp-heading">{heading}</h1>
          <PageProvenance lang={lang} page={page} />
          {children}
        </article>
      </main>

      <CorporateFooter lang={lang} page={page} onNavigate={onNavigate} />
    </div>
  )
}
