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
  const copy = T[lang]

  return (
    <CorporatePageShell
      lang={lang}
      setLang={setLang}
      page="privacy"
      onNavigate={onNavigate}
      heading={copy.corpPrivacyHeading}
    >
      <section className="corp-section">
        <p className="corp-lead">{copy.corpPrivacyIntro}</p>
      </section>

      <section className="corp-section">
        <h2>{copy.corpPrivacyCollectHeading}</h2>
        <ul className="corp-list">
          <li>{copy.corpPrivacyCollectRequest}</li>
          <li>{copy.corpPrivacyCollectProfile}</li>
          <li>{copy.corpPrivacyCollectDocuments}</li>
          <li>{copy.corpPrivacyCollectAccount}</li>
        </ul>
      </section>

      <section className="corp-section">
        <h2>{copy.corpPrivacyWhyHeading}</h2>
        <p>{copy.corpPrivacyWhyText}</p>
      </section>

      <section className="corp-section">
        <h2>{copy.corpPrivacyProcessorsHeading}</h2>
        <p>{copy.corpPrivacyProcessorsText}</p>
      </section>

      <section className="corp-section">
        <h2>{copy.corpPrivacyControlsHeading}</h2>
        <p>{copy.corpPrivacyControlsText}</p>
      </section>

      {/* Several paragraphs, not one, because the honest version has several
          distinct facts in it. The first draft collapsed them into a single
          sentence and got three wrong:

            - it said the browser "talks only to our own backend". vercel.json's
              CSP allows connect-src to 'self' AND the Supabase project over
              both https and wss, and style-src/font-src to fonts.googleapis.com
              and fonts.gstatic.com, which index.html preconnects to and pulls a
              stylesheet from. Three destinations, one of them Google.
            - it said storage holds a session and a language choice. That is
              true only while signed OUT.
            - it ignored the demo build entirely, where localStorage IS the
              database (see lib/browserPersistence.ts) and holds farm and
              inventory records a visitor typed in.

          Each is now its own paragraph, because each is a separate thing a
          reader might need to act on. */}
      <section className="corp-section">
        <h2>{copy.corpPrivacyCookiesHeading}</h2>
        <p>{copy.corpPrivacyCookiesText}</p>
        <p>{copy.corpPrivacyNetworkText}</p>
        <p>{copy.corpPrivacyFontsText}</p>
        <p>{copy.corpPrivacyStorageText}</p>
        <p>{copy.corpPrivacyDemoText}</p>
      </section>

      <section className="corp-section">
        <h2>{copy.corpPrivacyRetentionHeading}</h2>
        <p>{copy.corpPrivacyRetentionText}</p>
      </section>

      <section className="corp-section corp-section-emphasis">
        <h2>{copy.corpPrivacyContactHeading}</h2>
        <p>{copy.corpPrivacyContactText}</p>
      </section>

      <section className="corp-section">
        <h2>{copy.corpPrivacyChangesHeading}</h2>
        <p>{copy.corpPrivacyChangesText}</p>
      </section>
    </CorporatePageShell>
  )
}
