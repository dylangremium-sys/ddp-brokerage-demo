import type { ReactNode } from 'react'
import type { Page } from '../../types'
import { DDPMonogramLogo } from '../../components/logos'
import { pathForPage } from '../../lib/urlRouting'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'
import { localisedBuyerContentFor } from './localisedBuyerContent'
import { metadataForPage } from '../../lib/publicPageMetadata'

/* ────────────────────────────────────────────────────────────────────────────
   One buyer page, rendered in whichever language the content record names.

   WHY THESE PAGES EXIST
     The site published English and Thai. Thai serves the SUPPLY side — Thai
     farms reached by QR code and WhatsApp. Both demand-side markets the company
     names, Germany and Czechia, had no language on the site at all, and buyers
     in those markets search in their own language.

   WHY ONE COMPONENT AND NOT ONE PER LANGUAGE
     The German page came first and carried its own chrome. Adding Czech by
     copying it would have duplicated the markup, the anchors and the legal
     notices — and duplicated notices are notices that drift apart, which is the
     one thing that must not happen to these two paragraphs. The words live in
     localisedBuyerContent.ts as data; this file is the shape they are poured
     into, and it is identical for every language.

     The practical consequence: a further language is a content record and a
     register entry. No new markup, and the same tests apply to it
     automatically, because localisedBuyerPage.test.ts iterates the content.

   WHAT THESE PAGES MAY SAY
     Only what the English site already says. See the header of
     localisedBuyerContent.ts for why that rule exists and what enforces it.

   WHY THERE IS NO LANGUAGE TOGGLE
     There is no translated application to switch into — 'de' and 'cs' are not
     app languages. A toggle would promise one. The nav links to the English
     site instead, which is honest about what is on the other side.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  /** Which localised page to render. Must have a content record. */
  page: Page
  /** In-app navigation. The anchors still carry a real href for crawlers. */
  onNavigate: (page: Page) => void
}

/**
 * An in-app link a crawler can also follow.
 *
 * Module scope, not inside the component: a component created during render is
 * a fresh type each time, so React remounts rather than updates its subtree.
 */
function InternalLink({
  target, onNavigate, className, children,
}: {
  target: Page
  onNavigate: (page: Page) => void
  className?: string
  children: ReactNode
}) {
  return (
    <a
      href={pathForPage(target)}
      className={className}
      // Guarded: a Cmd/Ctrl-click is the browser's own "open in new tab".
      onClick={(e) => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate(target) }}
    >
      {children}
    </a>
  )
}

export default function LocalisedBuyerPage({ page, onNavigate }: Props) {
  const copy = localisedBuyerContentFor(page)

  // Fail visibly rather than rendering an empty shell: a localised page with no
  // content record would otherwise be published to the sitemap as a blank
  // document. localisedBuyerPage.test.ts asserts every registered page has one.
  if (!copy) return null

  return (
    <div className="corp-shell">
      <header className="corp-nav">
        <div className="corp-nav-inner">
          <InternalLink target="landing" onNavigate={onNavigate} className="corp-brand">
            <DDPMonogramLogo height={44} color="#C6A24C" />
            {/* navBrandDescriptor — left in English: it is the brand mark, not a claim. */}
            <span className="corp-brand-descriptor">Regulated Supply Intelligence</span>
          </InternalLink>

          <nav className="corp-nav-menu" aria-label={copy.navLabel}>
            <InternalLink target="landing" onNavigate={onNavigate} className="corp-nav-link">
              {copy.englishSiteLabel}
            </InternalLink>
            <InternalLink target="contact" onNavigate={onNavigate} className="corp-nav-link">
              {copy.contactNavLabel}
            </InternalLink>
          </nav>
        </div>
      </header>

      <main className="corp-main" id="main">
        <article className="corp-doc">
          <h1 className="corp-heading">{copy.heading}</h1>

          <p className="corp-provenance">
            <span>{copy.ownerLabel}: <strong>DDP Brokerage — Compliance &amp; Operations</strong></span>
            <span className="corp-provenance-sep" aria-hidden="true">·</span>
            <span>{copy.reviewedLabel}: <time dateTime={metadataForPage(page).lastReviewed}>{copy.reviewedValue}</time></span>
          </p>

          <p>{copy.lead}</p>
          <p>{copy.body}</p>

          <h2>{copy.processHeading}</h2>
          <ol>
            {copy.steps.map(({ title, text }) => (
              <li key={title}>
                <strong>{title}</strong> — {text}
              </li>
            ))}
          </ol>

          {/* landingAuthorityNote. The sentence that bounds every other sentence
              on the page; it must not be softened in translation. */}
          <h2>{copy.limitsHeading}</h2>
          <p>{copy.limits}</p>

          {/* landingDisclaimer. */}
          <h2>{copy.eligibilityHeading}</h2>
          <p>{copy.eligibility} {copy.eligibilityAccess}</p>

          <h2>{copy.contactHeading}</h2>
          <p>
            {copy.contactBefore}
            <InternalLink target="contact" onNavigate={onNavigate}>{copy.contactLinkLabel}</InternalLink>
            {copy.contactMiddle}
            <InternalLink target="landing" onNavigate={onNavigate}>{copy.englishLinkLabel}</InternalLink>
            {copy.contactAfter}
          </p>
        </article>
      </main>

      <footer className="corp-footer">
        <div className="corp-footer-inner">
          <nav className="corp-footer-links" aria-label={copy.navLabel}>
            <InternalLink target="landing" onNavigate={onNavigate} className="corp-footer-link">{copy.englishSiteLabel}</InternalLink>
            <InternalLink target="contact" onNavigate={onNavigate} className="corp-footer-link">{copy.contactNavLabel}</InternalLink>
            <InternalLink target="privacy" onNavigate={onNavigate} className="corp-footer-link">Privacy Policy</InternalLink>
            <InternalLink target="terms" onNavigate={onNavigate} className="corp-footer-link">Terms of Use</InternalLink>
          </nav>

          <p className="corp-copyright">© 2026 DDP Brokerage Co., Ltd. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}
