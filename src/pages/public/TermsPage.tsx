import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import CorporatePageShell from '../../components/public/CorporatePageShell'

/* ────────────────────────────────────────────────────────────────────────────
   /terms — terms of use.

   SOURCING: the same rule as the other corporate pages. The eligibility section
   and the statement of what DDP does not assess are the landing page's own
   approved notices, reused by key. The access model — accounts created by an
   administrator after a reviewed request, rather than open self-service — is
   how lib/accessRequestClient.ts and the buyer/farmer provisioning flows
   actually work.

   DELIBERATELY ABSENT: governing law, jurisdiction, limitation of liability and
   warranty disclaimers.

   That absence is a decision, not an oversight. Those clauses have real legal
   effect and their correct content depends on facts this repository does not
   hold — where the entity is incorporated for the purpose of a choice-of-law
   clause, and what the owner's counsel advises. A plausible-looking liability
   cap written by guesswork is worse than none: it reads as though it were
   advised when it was not. They are flagged for the owner in the pull request
   instead.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  onNavigate: (page: Page) => void
}

export default function TermsPage({ lang, setLang, onNavigate }: Props) {
  const t = T[lang]

  return (
    <CorporatePageShell
      lang={lang}
      setLang={setLang}
      page="terms"
      onNavigate={onNavigate}
      heading={t.corpTermsHeading}
    >
      <section className="corp-section">
        <p className="corp-lead">{t.corpTermsIntro}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsEligibilityHeading}</h2>
        <p>{t.landingDisclaimer}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsAccessHeading}</h2>
        <p>{t.corpTermsAccessText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsServiceHeading}</h2>
        <p>{t.corpTermsServiceText}</p>
      </section>

      {/* The reliance section carries the landing page's authority note in
          full. On a terms page this is the operative sentence, not a footnote:
          it is what a buyer is told before relying on a status shown here. */}
      <section className="corp-section corp-section-emphasis">
        <h2>{t.corpTermsRelianceHeading}</h2>
        <p>{t.corpTermsRelianceText}</p>
        <p>{t.landingAuthorityNote}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsSupplierHeading}</h2>
        <p>{t.corpTermsSupplierText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsConfidentialityHeading}</h2>
        <p>{t.corpTermsConfidentialityText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsAcceptableHeading}</h2>
        <p>{t.corpTermsAcceptableText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsIpHeading}</h2>
        <p>{t.corpTermsIpText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsChangesHeading}</h2>
        <p>{t.corpTermsChangesText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpTermsContactHeading}</h2>
        <p>{t.corpTermsContactText}</p>
      </section>
    </CorporatePageShell>
  )
}
