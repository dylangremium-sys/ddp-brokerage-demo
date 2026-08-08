import type { ReactNode } from 'react'
import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import { DDPMonogramLogo } from '../logos'
import { pathForPage } from '../../lib/urlRouting'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'

/* ────────────────────────────────────────────────────────────────────────────
   Shell for the public corporate pages (/about, /contact, /privacy, /terms).

   WHY EVERY LINK HERE IS A REAL <a href>
     These are the first pages on this site that exist to be found from outside
     it, and a crawler discovers pages by following `href` attributes. The
     landing page's own Privacy and Terms controls were `<button>` elements with
     no handler — invisible to a crawler and inert to a visitor. Rendering an
     anchor with the real path and calling preventDefault keeps the SPA from
     hard-reloading on an in-app click while leaving something for a crawler,
     a bookmark, a middle-click and "open in new tab" to act on.

     The paths are read from lib/urlRouting rather than written out here, so a
     link cannot point at a path the router does not accept.

   WHY IT IS NOT THE AUTH SHELL
     PUBLIC_AUTH_PAGES drives the cream `public-auth-shell` card. A privacy
     policy is a document, not a card, so these pages carry their own full-width
     chrome — see navigationGuard.ts, where PUBLIC_CORPORATE_PAGES is kept
     deliberately separate for this reason.
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

/** The corporate pages, in the order they appear in the footer. */
const CORPORATE_LINKS: Array<{ page: Page; labelKey: 'homeFooterAbout' | 'homeFooterContact' | 'homeFooterPrivacy' | 'homeFooterTerms' }> = [
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

export default function CorporatePageShell({ lang, setLang, page, onNavigate, heading, children }: Props) {
  const t = T[lang]

  return (
    <div className="corp-shell">
      <header className="corp-nav">
        <div className="corp-nav-inner">
          <InternalLink target="landing" currentPage={page} onNavigate={onNavigate} className="corp-brand">
            <DDPMonogramLogo height={44} color="#C6A24C" />
            <span className="corp-brand-descriptor">{t.navBrandDescriptor}</span>
          </InternalLink>

          <nav className="corp-nav-menu" aria-label={t.corpRelatedHeading}>
            <InternalLink target="landing" currentPage={page} onNavigate={onNavigate} className="corp-nav-link">{t.corpNavHome}</InternalLink>
            {CORPORATE_LINKS.map(({ page: target, labelKey }) => (
              <InternalLink key={target} target={target} currentPage={page} onNavigate={onNavigate} className="corp-nav-link">{t[labelKey]}</InternalLink>
            ))}
          </nav>

          <div className="corp-nav-right">
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
            <button type="button" className="corp-login" onClick={() => onNavigate('login')}>
              <LockIcon />
              {t.navSecureLogin}
            </button>
          </div>
        </div>
      </header>

      <main className="corp-main" id="main">
        <article className="corp-doc">
          <h1 className="corp-heading">{heading}</h1>

          {/* The master plan requires a named content owner and a last-reviewed
              date on every public corporate page. Rendered as real text rather
              than a comment so the requirement is visible to a reader, which is
              the point of it. */}
          <p className="corp-provenance">
            <span>{t.corpOwnerLabel}: <strong>{t.corpOwnerValue}</strong></span>
            <span className="corp-provenance-sep" aria-hidden="true">·</span>
            <span>{t.corpReviewedLabel}: <time dateTime="2026-08-08">{t.corpReviewedValue}</time></span>
          </p>

          {children}
        </article>
      </main>

      <footer className="corp-footer">
        <div className="corp-footer-inner">
          <nav className="corp-footer-links" aria-label={t.corpRelatedHeading}>
            <InternalLink target="landing" currentPage={page} onNavigate={onNavigate} className="corp-footer-link">{t.corpBackHome}</InternalLink>
            {CORPORATE_LINKS.filter(({ page: target }) => target !== page).map(({ page: target, labelKey }) => (
              <InternalLink key={target} target={target} currentPage={page} onNavigate={onNavigate} className="corp-footer-link">{t[labelKey]}</InternalLink>
            ))}
          </nav>

          {/* The same two notices the landing page carries, reused by key. They
              are the company's approved statement of what it does and does not
              assess, and they belong on any page that describes the service. */}
          <div className="corp-footer-legalnote">
            <p>{t.landingAuthorityNote}</p>
            <p>{t.landingDisclaimer}</p>
          </div>

          <p className="corp-copyright">{t.homeFooterCopyright}</p>
        </div>
      </footer>
    </div>
  )
}
