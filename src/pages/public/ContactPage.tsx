import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import CorporatePageShell from '../../components/public/CorporatePageShell'
import { pathForPage } from '../../lib/urlRouting'

/* ────────────────────────────────────────────────────────────────────────────
   /contact — public contact information.

   Every address, telephone number and email on this page is the value already
   published in the landing page footer, reused by key. Nothing is newly
   asserted about how the company is reached.

   The supplier route is a real <a href="/farmer"> for the same reason the
   landing page's is: it survives a copy-paste, a QR scan and a WhatsApp share.
   Note that /farmer is disallowed in robots.txt and marked noindex in the
   metadata register — linking to it from an indexable page is fine and is not
   a contradiction. The link is for people; the crawl controls are about whether
   the onboarding form itself belongs in a search result, and it does not.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  onNavigate: (page: Page) => void
}

export default function ContactPage({ lang, setLang, onNavigate }: Props) {
  const t = T[lang]

  return (
    <CorporatePageShell
      lang={lang}
      setLang={setLang}
      page="contact"
      onNavigate={onNavigate}
      heading={t.corpContactHeading}
    >
      <section className="corp-section">
        <p className="corp-lead">{t.corpContactLead}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpContactEmailHeading}</h2>
        <dl className="corp-contact-list">
          <div>
            <dt>{t.corpContactGeneralLabel}</dt>
            <dd><a href={`mailto:${t.homeFooterEmail1}`}>{t.homeFooterEmail1}</a></dd>
          </div>
          <div>
            <dt>{t.corpContactPartnershipsLabel}</dt>
            <dd><a href={`mailto:${t.homeFooterEmail2}`}>{t.homeFooterEmail2}</a></dd>
          </div>
        </dl>
      </section>

      <section className="corp-section">
        <h2>{t.corpContactOfficeHeading}</h2>
        <address className="corp-address">
          <strong>DDP Brokerage Co., Ltd.</strong><br />
          {t.homeFooterOfficeLine1}<br />
          {t.homeFooterOfficeLine2}<br />
          {t.homeFooterOfficeLine3}<br />
          {t.homeFooterOfficeTel}
        </address>
      </section>

      <section className="corp-section">
        <h2>{t.corpContactSupplierHeading}</h2>
        <p>{t.corpContactSupplierText}</p>
        <p>
          <a
            className="corp-cta"
            href={pathForPage('farmer-register')}
            onClick={(e) => { e.preventDefault(); onNavigate('farmer-register') }}
          >
            {t.corpContactSupplierCta}
          </a>
        </p>
      </section>

      {/* Practical, and also the honest security position: email is not where
          supplier documents belong, and the platform's own storage controls are
          described on the privacy page. */}
      <section className="corp-section corp-section-emphasis">
        <p>{t.corpContactDocumentsNote}</p>
      </section>
    </CorporatePageShell>
  )
}
