import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import CorporatePageShell from '../../components/public/CorporatePageShell'
import { pathForPage } from '../../lib/urlRouting'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'

/* ────────────────────────────────────────────────────────────────────────────
   /contact — public contact information.

   Every address, telephone number and email on this page is the value already
   published in the landing page footer, reused by key. Nothing is newly
   asserted about how the company is reached.

   The supplier route is a real <a href="/farmer"> for the same reason the
   landing page's is: it survives a copy-paste, a QR scan and a WhatsApp share.

   Linking to /farmer from an indexable page is not a contradiction. /farmer is
   deliberately CRAWLABLE — robots.txt does not disallow it — and excluded from
   results by an `X-Robots-Tag: noindex, nofollow` response header set for that
   path in vercel.json, backed by the page-level noindex in the metadata
   register. Allowing the crawl is what lets a search engine receive the
   exclusion at all; disallowing it previously meant the noindex was never
   fetched. The link is for people; the exclusion decides whether the onboarding
   form belongs in a search result, and it does not.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  onNavigate: (page: Page) => void
}

/**
 * One labelled email channel.
 *
 * Extracted rather than written inline: the definition list nested the anchor
 * six levels deep, which DeepSource flags and which reads badly. Each channel
 * is one idea, so it gets one component.
 */
function EmailChannel({ label, address }: { label: string; address: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><a href={`mailto:${address}`}>{address}</a></dd>
    </div>
  )
}

export default function ContactPage({ lang, setLang, onNavigate }: Props) {
  const copy = T[lang]

  return (
    <CorporatePageShell
      lang={lang}
      setLang={setLang}
      page="contact"
      onNavigate={onNavigate}
      heading={copy.corpContactHeading}
    >
      <section className="corp-section">
        <p className="corp-lead">{copy.corpContactLead}</p>
      </section>

      <section className="corp-section">
        <h2>{copy.corpContactEmailHeading}</h2>
        <dl className="corp-contact-list">
          <EmailChannel label={copy.corpContactGeneralLabel} address={copy.homeFooterEmail1} />
          <EmailChannel label={copy.corpContactPartnershipsLabel} address={copy.homeFooterEmail2} />
        </dl>
      </section>

      <section className="corp-section">
        <h2>{copy.corpContactOfficeHeading}</h2>
        <OfficeAddress lang={lang} />
      </section>

      <section className="corp-section">
        <h2>{copy.corpContactSupplierHeading}</h2>
        <p>{copy.corpContactSupplierText}</p>
        <SupplierCta lang={lang} onNavigate={onNavigate} />
      </section>

      {/* Practical, and also the honest security position: email is not where
          supplier documents belong, and the platform's own storage controls are
          described on the privacy page. */}
      <section className="corp-section corp-section-emphasis">
        <p>{copy.corpContactDocumentsNote}</p>
      </section>
    </CorporatePageShell>
  )
}

/** Registered office, as published in the landing page footer. */
function OfficeAddress({ lang }: { lang: Lang }) {
  const copy = T[lang]

  return (
    <address className="corp-address">
      <strong>DDP Brokerage Co., Ltd.</strong><br />
      {copy.homeFooterOfficeLine1}<br />
      {copy.homeFooterOfficeLine2}<br />
      {copy.homeFooterOfficeLine3}<br />
      {copy.homeFooterOfficeTel}
    </address>
  )
}

/**
 * The route into supplier onboarding.
 *
 * A real <a href="/farmer"> so it survives a copy-paste, a QR scan and a
 * WhatsApp share — the ways farmers actually receive it — and guarded so a
 * Cmd-click still opens a new tab. Note /farmer is deliberately crawlable and
 * carries noindex via an X-Robots-Tag header plus a meta tag; linking to it
 * from an indexable page is not a contradiction. The link is for people, and
 * the exclusion controls decide whether the form itself belongs in a result.
 */
function SupplierCta({ lang, onNavigate }: { lang: Lang; onNavigate: (page: Page) => void }) {
  const copy = T[lang]

  return (
    <p>
      <a
        className="corp-cta"
        href={pathForPage('farmer-register')}
        onClick={(e) => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate('farmer-register') }}
      >
        {copy.corpContactSupplierCta}
      </a>
    </p>
  )
}
