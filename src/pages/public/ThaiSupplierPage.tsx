import type { Page } from '../../types'
import { T } from '../../translations'
import { DDPMonogramLogo } from '../../components/logos'
import { pathForPage } from '../../lib/urlRouting'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'
import { metadataForPage } from '../../lib/publicPageMetadata'
import { DRAFTED } from './thaiSupplierCopy'

/* ────────────────────────────────────────────────────────────────────────────
   /th/suppliers — the Thai-language page for producers.

   WHY THIS AND NOT AN INDEXED /farmer
     /farmer is the application FORM. A form has nothing for a search engine to
     rank: field labels do not answer a question anybody types. Indexing it
     would win the query "DDP supplier signup", which only people who already
     know the company search — and would invite submission bots at a form that
     collects a name, an email and a phone number.

     This page is the content. It says what documents a producer needs before
     applying, which is the thing a Thai grower actually searches for, and links
     to /farmer as the step after reading. The form stays noindex.

   WHERE THE WORDS COME FROM
     Most of this page is human-written Thai that already existed in
     translations.ts and is referenced by key here, never retyped: both legal
     notices, the hero, the four process steps, the brand descriptor, and the
     note about what happens after applying.

     The rest — five headings and the document list — was drafted for this page
     and is listed in thaiSupplierCopy.ts with the English it came from, so a
     Thai reviewer can check it without reading this file.

     Sections the brief asked for that have no cleared wording are absent, not
     stubbed. See PENDING_SECTIONS.

   WHY IT IS noindex FOR NOW
     Its new Thai has not been read by a Thai speaker and several sections are
     missing. This audience gives one first impression. The register entry
     carries `noindex,nofollow`, so the sitemap generator leaves it out on its
     own; clearing it to index is a change to the register and to the
     hand-written URL list, both of which a person has to make deliberately.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  onNavigate: (page: Page) => void
}

/** An in-app link a crawler can also follow. Module scope — see /de and /cs. */
function InternalLink({
  target, onNavigate, className, children,
}: {
  target: Page
  onNavigate: (page: Page) => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <a
      href={pathForPage(target)}
      className={className}
      onClick={(e) => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate(target) }}
    >
      {children}
    </a>
  )
}

export default function ThaiSupplierPage({ onNavigate }: Props) {
  // Thai only. This page is not part of the EN/TH toggle: it exists because the
  // toggle is not how a Thai producer arrives — a search result is.
  const copy = T.th

  const documents = ['docLicence', 'docCoa', 'docThc', 'docPanel', 'docBatchRecords'] as const

  return (
    <div className="corp-shell">
      <header className="corp-nav">
        <div className="corp-nav-inner">
          <InternalLink target="landing" onNavigate={onNavigate} className="corp-brand">
            <DDPMonogramLogo height={44} color="#C6A24C" />
            {/* EXISTING: navBrandDescriptor */}
            <span className="corp-brand-descriptor">{copy.navBrandDescriptor}</span>
          </InternalLink>

          <nav className="corp-nav-menu" aria-label="เมนู">
            <InternalLink target="landing" onNavigate={onNavigate} className="corp-nav-link">
              English site
            </InternalLink>
            {/* EXISTING: farmerRegHeading — "สมัครเป็นผู้จัดหาสินค้า" */}
            <InternalLink target="farmer-register" onNavigate={onNavigate} className="corp-nav-link">
              {copy.farmerRegHeading}
            </InternalLink>
          </nav>
        </div>
      </header>

      <main className="corp-main" id="main">
        <article className="corp-doc">
          {/* EXISTING: landingAboutText1 is the fullest published description of
              what DDP does with Thai farm supply, so it carries the heading. */}
          <h1 className="corp-heading">{copy.farmerRegHeading}</h1>

          <p className="corp-provenance">
            <span>ผู้ดูแลเนื้อหา: <strong>DDP Brokerage — Compliance &amp; Operations</strong></span>
            <span className="corp-provenance-sep" aria-hidden="true">·</span>
            <span>
              ตรวจทานล่าสุด:{' '}
              <time dateTime={metadataForPage('th-supplier').lastReviewed}>9 สิงหาคม 2569</time>
            </span>
          </p>

          {/* EXISTING: landingAboutText1 */}
          <p>{copy.landingAboutText1}</p>

          {/* DRAFTED heading + document list. The requirements come from the
              brief; the Thai is drafted and listed for review. */}
          <h2>{DRAFTED.headingDocuments}</h2>
          <ul>
            {documents.map((key) => (
              <li key={key}>{DRAFTED[key]}</li>
            ))}
          </ul>
          <p>{DRAFTED.docNote}</p>

          {/* EXISTING: the four process steps, verbatim from translations.ts */}
          <h2>{DRAFTED.headingProcess}</h2>
          <ol>
            <li><strong>{copy.homeProcessStep1Title}</strong> — {copy.homeProcessStep1Desc}</li>
            <li><strong>{copy.homeProcessStep2Title}</strong> — {copy.homeProcessStep2Desc}</li>
            <li><strong>{copy.homeProcessStep3Title}</strong> — {copy.homeProcessStep3Desc}</li>
            <li><strong>{copy.homeProcessStep4Title}</strong> — {copy.homeProcessStep4Desc}</li>
          </ol>

          {/* EXISTING: farmerRegReviewNote and farmerRegAdminOnlyNote both
              describe what happens after applying, and both were already
              written in Thai for the form itself. No timeline is stated —
              none has been cleared. See PENDING_SECTIONS. */}
          <h2>{DRAFTED.headingAfter}</h2>
          <p>{copy.farmerRegReviewNote}</p>
          <p>{copy.farmerRegAdminOnlyNote}</p>
          <p>
            <InternalLink target="farmer-register" onNavigate={onNavigate}>
              {copy.farmerRegHeading}
            </InternalLink>
          </p>

          {/* EXISTING: landingAuthorityNote. The sentence that bounds every
              other sentence here. Never retyped, never softened. */}
          <h2>{DRAFTED.headingLimits}</h2>
          <p>{copy.landingAuthorityNote}</p>

          {/* EXISTING: landingDisclaimer. */}
          <h2>{DRAFTED.headingEligibility}</h2>
          <p>{copy.landingDisclaimer}</p>
        </article>
      </main>

      <footer className="corp-footer">
        <div className="corp-footer-inner">
          <nav className="corp-footer-links" aria-label="เมนู">
            <InternalLink target="landing" onNavigate={onNavigate} className="corp-footer-link">English site</InternalLink>
            <InternalLink target="farmer-register" onNavigate={onNavigate} className="corp-footer-link">{copy.farmerRegHeading}</InternalLink>
            <InternalLink target="privacy" onNavigate={onNavigate} className="corp-footer-link">Privacy Policy</InternalLink>
            <InternalLink target="terms" onNavigate={onNavigate} className="corp-footer-link">Terms of Use</InternalLink>
          </nav>
          <p className="corp-copyright">© 2026 DDP Brokerage Co., Ltd. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}
