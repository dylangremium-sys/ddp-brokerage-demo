import type { Page } from '../../types'
import { DDPMonogramLogo } from '../../components/logos'
import { pathForPage } from '../../lib/urlRouting'
import { shouldInterceptAnchorClick } from '../../lib/anchorNavigation'

/* ────────────────────────────────────────────────────────────────────────────
   /de — the German-language buyer page.

   WHY IT EXISTS
     The site publishes English and Thai. Thai serves the SUPPLY side: Thai
     farms reached by QR code and WhatsApp. Germany is the demand side, and had
     no language on the site at all — a German buyer searching in German would
     not have reached an English page for any query they were likely to type.

   THE RULE THIS FILE OBEYS
     EVERY substantive sentence here is a translation of copy already published
     in English in translations.ts. Nothing asserts anything new.

     That is not a stylistic preference. No wording on this site has been
     through a compliance review in any of the six jurisdictions this company
     operates across, and cannabis advertising rules differ sharply between
     them — Germany's are strict about anything touching prescription medicines.
     Translating language that already stands publicly is the only construction
     available that adds no unreviewed claim. If cleared German copy is ever
     produced, it should replace this wholesale rather than be layered onto it.

     The source key for each string is named in a comment beside it, so a
     reviewer can check the German against the English it came from without
     leaving the file. germanBuyerPage.test.ts asserts that both legal notices
     survive, because those are the sentences that bound everything else.

   WHY IT IS NOT A THIRD APP LANGUAGE
     Adding 'de' to Lang would mean translating every authenticated screen in
     the application. This is one public document that stands alone. It carries
     no language toggle for the same reason: there is no German anywhere else to
     switch to, and offering one would promise a translated app that does not
     exist.

   WHY IT USES THE corp-* CLASSES
     They are the chrome the four public corporate pages already use, so this
     page inherits their appearance without a line of new CSS.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  /** In-app navigation. The anchors still carry a real href for crawlers. */
  onNavigate: (page: Page) => void
}

/** The four process steps, translated from homeProcessStep1-4Title/Desc. */
const SCHRITTE: Array<{ titel: string; text: string }> = [
  {
    // homeProcessStep1Title / homeProcessStep1Desc
    titel: 'Beschaffung',
    text: 'Wir beziehen von lizenzierten Produzenten und erfassen die wesentlichen Liefer- und Dokumentationsdaten.',
  },
  {
    // homeProcessStep2Title / homeProcessStep2Desc
    titel: 'Prüfung',
    text: 'Nachweise und Laborberichte werden von unserem Team strukturiert und geprüft.',
  },
  {
    // homeProcessStep3Title / homeProcessStep3Desc
    titel: 'Zuordnung',
    text: 'Das Angebot wird auf die Anforderungen und Beschaffungsziele des Einkäufers abgestimmt.',
  },
  {
    // homeProcessStep4Title / homeProcessStep4Desc
    titel: 'Begleitung',
    text: 'Wir begleiten strukturierte Beschaffungsgespräche und die laufende Koordination.',
  },
]

/**
 * An in-app link a crawler can also follow.
 *
 * Module scope, not inside the component: a component created during render is
 * a fresh type each time, so React remounts rather than updates its subtree.
 */
function InterneLink({
  ziel, onNavigate, className, children,
}: {
  ziel: Page
  onNavigate: (page: Page) => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <a
      href={pathForPage(ziel)}
      className={className}
      onClick={(e) => { if (!shouldInterceptAnchorClick(e)) return; e.preventDefault(); onNavigate(ziel) }}
    >
      {children}
    </a>
  )
}

export default function GermanBuyerPage({ onNavigate }: Props) {
  return (
    <div className="corp-shell">
      <header className="corp-nav">
        <div className="corp-nav-inner">
          <InterneLink ziel="landing" onNavigate={onNavigate} className="corp-brand">
            <DDPMonogramLogo height={44} color="#C6A24C" />
            {/* navBrandDescriptor — left in English: it is the brand mark, not a claim. */}
            <span className="corp-brand-descriptor">Regulated Supply Intelligence</span>
          </InterneLink>

          <nav className="corp-nav-menu" aria-label="Weitere Seiten">
            {/* The English site is the rest of the content. Saying so plainly is
                better than a language toggle that implies a translated app. */}
            <InterneLink ziel="landing" onNavigate={onNavigate} className="corp-nav-link">
              English site
            </InterneLink>
            <InterneLink ziel="contact" onNavigate={onNavigate} className="corp-nav-link">
              Kontakt
            </InterneLink>
          </nav>
        </div>
      </header>

      <main className="corp-main" id="main">
        <article className="corp-doc">
          {/* landingHeadline: "Organizing evidence. Supporting decisions." */}
          <h1 className="corp-heading">Nachweise strukturieren. Entscheidungen unterstützen.</h1>

          <p className="corp-provenance">
            <span>Inhaltlich verantwortlich: <strong>DDP Brokerage — Compliance &amp; Operations</strong></span>
            <span className="corp-provenance-sep" aria-hidden="true">·</span>
            <span>Zuletzt geprüft: <time dateTime="2026-08-09">9. August 2026</time></span>
          </p>

          {/* landingHero1 */}
          <p>
            DDP macht aus Farmbeständen, Chargenunterlagen, COAs und Preisen klare Prüfpakete für
            ernsthafte Einkäufer.
          </p>

          {/* landingHeroBody */}
          <p>
            DDP Brokerage unterstützt qualifizierte Einkäufer dabei, Angebot, Dokumentation und
            Beschaffungsreife über Netzwerke lizenzierter Produzenten zu beurteilen.
          </p>

          <h2>Wie geprüft wird</h2>
          <ol>
            {SCHRITTE.map(({ titel, text }) => (
              <li key={titel}>
                <strong>{titel}</strong> — {text}
              </li>
            ))}
          </ol>

          <h2>Was DDP ausdrücklich nicht tut</h2>
          {/* landingAuthorityNote — the sentence that bounds every other sentence
              on this page. It must not be softened in translation. */}
          <p>
            DDP organisiert, konsolidiert und prüft Lieferantenunterlagen. DDP zertifiziert weder
            die Exportfähigkeit noch die pharmazeutische Eignung noch die Einhaltung gesetzlicher
            Vorgaben in irgendeiner Rechtsordnung. Einkaufsentscheidungen sollten sich
            ausschließlich auf geprüfte Dokumente und die Bestätigung einer qualifizierten Stelle
            stützen.
          </p>

          <h2>Wer diese Plattform nutzen darf</h2>
          {/* landingDisclaimer */}
          <p>
            Diese Plattform richtet sich ausschließlich an lizenzierte Cannabis-Unternehmen in
            Rechtsordnungen, in denen Anbau, Verarbeitung und Lieferung von Cannabis rechtlich
            zulässig sind. Der Zugang ist während der laufenden Onboarding-Phase auf aufgenommene
            Partner beschränkt.
          </p>

          <h2>Kontakt</h2>
          <p>
            Anfragen von lizenzierten Einkäufern nimmt das Unternehmen über die{' '}
            <InterneLink ziel="contact" onNavigate={onNavigate}>Kontaktseite</InterneLink> entgegen.
            Die übrigen Seiten dieser Website sind auf{' '}
            <InterneLink ziel="landing" onNavigate={onNavigate}>Englisch</InterneLink> verfügbar.
          </p>
        </article>
      </main>

      <footer className="corp-footer">
        <div className="corp-footer-inner">
          <nav className="corp-footer-links" aria-label="Weitere Seiten">
            <InterneLink ziel="landing" onNavigate={onNavigate} className="corp-footer-link">English site</InterneLink>
            <InterneLink ziel="contact" onNavigate={onNavigate} className="corp-footer-link">Kontakt</InterneLink>
            <InterneLink ziel="privacy" onNavigate={onNavigate} className="corp-footer-link">Privacy Policy</InterneLink>
            <InterneLink ziel="terms" onNavigate={onNavigate} className="corp-footer-link">Terms of Use</InterneLink>
          </nav>

          <p className="corp-copyright">© 2026 DDP Brokerage Co., Ltd. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}
