import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import CorporatePageShell from '../../components/public/CorporatePageShell'

/* ────────────────────────────────────────────────────────────────────────────
   /privacy — privacy policy.

   SOURCING: this page is DESCRIPTIVE, not aspirational.

   Every statement about what the platform collects or does was taken from the
   code that does it, not from what a privacy policy usually says:

     - the access-request fields (name, email, telephone) are the fields of
       AccessRequestInput in lib/accessRequestClient.ts;
     - the supplier-profile fields are those of FarmProfile in types.ts;
     - private storage and short-lived links are uploadCoaFile / uploadBatchPhoto
       and getCoaSignedUrl / getPhotoSignedUrl in lib/db.ts;
     - row-level security enforced by the database is the RLS work verified
       against production, not a claim about intent;
     - "no third-party analytics or tracking" is checkable in vercel.json: the
       content security policy allows `script-src 'self'` and a `connect-src` of
       this origin plus our own Supabase project, so no third-party script can
       execute or exfiltrate anything even if one were added by accident;
     - the browser-storage uses are the auth session and lib/languagePreference.

   DELIBERATELY ABSENT: a data-protection officer, a company registration
   number, and specific retention periods in days or years. The repository does
   not evidence any of them and a privacy policy is the worst possible place to
   guess. The retention section says what is structurally true — records tied to
   a decision already taken are kept as part of its audit trail — and routes the
   specific question to a real address rather than inventing a number.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  onNavigate: (page: Page) => void
}

export default function PrivacyPage({ lang, setLang, onNavigate }: Props) {
  const t = T[lang]

  return (
    <CorporatePageShell
      lang={lang}
      setLang={setLang}
      page="privacy"
      onNavigate={onNavigate}
      heading={t.corpPrivacyHeading}
    >
      <section className="corp-section">
        <p className="corp-lead">{t.corpPrivacyIntro}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpPrivacyCollectHeading}</h2>
        <ul className="corp-list">
          <li>{t.corpPrivacyCollectRequest}</li>
          <li>{t.corpPrivacyCollectProfile}</li>
          <li>{t.corpPrivacyCollectDocuments}</li>
          <li>{t.corpPrivacyCollectAccount}</li>
        </ul>
      </section>

      <section className="corp-section">
        <h2>{t.corpPrivacyWhyHeading}</h2>
        <p>{t.corpPrivacyWhyText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpPrivacyProcessorsHeading}</h2>
        <p>{t.corpPrivacyProcessorsText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpPrivacyControlsHeading}</h2>
        <p>{t.corpPrivacyControlsText}</p>
      </section>

      {/* Three paragraphs, not one, because the honest version has three
          distinct facts in it: no tracking scripts; fonts DO come from Google,
          which sees the visitor's IP; and browser storage holds different
          things before and after sign-in. The first draft of this section
          collapsed all three into a single sentence and got two of them wrong
          — it claimed the browser talks only to our backend (vercel.json's CSP
          whitelists fonts.googleapis.com and fonts.gstatic.com, and index.html
          preconnects to both), and it claimed storage holds only a session and
          a language choice, which is true only while signed out. */}
      <section className="corp-section">
        <h2>{t.corpPrivacyCookiesHeading}</h2>
        <p>{t.corpPrivacyCookiesText}</p>
        <p>{t.corpPrivacyFontsText}</p>
        <p>{t.corpPrivacyStorageText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpPrivacyRetentionHeading}</h2>
        <p>{t.corpPrivacyRetentionText}</p>
      </section>

      <section className="corp-section corp-section-emphasis">
        <h2>{t.corpPrivacyContactHeading}</h2>
        <p>{t.corpPrivacyContactText}</p>
      </section>

      <section className="corp-section">
        <h2>{t.corpPrivacyChangesHeading}</h2>
        <p>{t.corpPrivacyChangesText}</p>
      </section>
    </CorporatePageShell>
  )
}
