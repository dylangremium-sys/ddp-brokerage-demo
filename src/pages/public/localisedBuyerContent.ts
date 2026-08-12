// ─── Buyer-page content, per language ───────────────────────────────────────
//
// THE RULE EVERY ENTRY HERE OBEYS
//   Each string is a TRANSLATION of copy already published in English in
//   translations.ts. Nothing here asserts anything the English site does not.
//   The source key is named against every field, so a reviewer can check a
//   translation against the English it came from without leaving this file.
//
//   That is not a style preference. No wording on this site has been through a
//   compliance review in any of the six jurisdictions this company operates
//   across, and cannabis advertising rules differ sharply between them —
//   Germany's are strict about anything touching prescription medicines.
//   Translating language that already stands publicly is the only construction
//   available that adds no unreviewed claim.
//
//   localisedBuyerPage.test.ts asserts, for EVERY language added here, that
//   both legal notices survive and that no certification, approval or
//   partnership is claimed. A new language cannot be added without meeting
//   that bar, which is the point of holding the content as data.
//
// WHY THESE ARE NOT APP LANGUAGES
//   Adding 'de' or 'cs' to Lang would mean translating every authenticated
//   screen in the application. These are standalone public documents for buyers
//   who arrive from a search result. They carry no language toggle, because
//   there is no translated app to switch into.

import type { Page } from '../../types'

export interface LocalisedBuyerContent {
  /** The Page enum member this content renders. */
  page: Page
  /** BCP-47 language of the document. Must match the register's `lang`. */
  lang: string
  /** landingHeadline — "Organizing evidence. Supporting decisions." */
  heading: string
  /** Label for the "content owner" provenance line. */
  ownerLabel: string
  /** Label for the "last reviewed" provenance line. */
  reviewedLabel: string
  /** Human-readable review date, in this language. */
  reviewedValue: string
  /**
   * The hero's opening sentence, in this language.
   *
   * Authored here, per locale. It used to cite `landingHero1` as its source, but
   * that translation key was never rendered by anything and has been removed —
   * these prerendered pages are where the sentence actually lives.
   */
  lead: string
  /** The landing hero body. */
  body: string
  /** Heading above the four process steps. */
  processHeading: string
  /** homeProcessStep1-4Title / Desc */
  steps: Array<{ title: string; text: string }>
  /** Heading above landingAuthorityNote. */
  limitsHeading: string
  /** landingAuthorityNote — what DDP does NOT certify. Must not be softened. */
  limits: string
  /** Heading above landingDisclaimer. */
  eligibilityHeading: string
  /** landingDisclaimer sentence ① — licensed operators, lawful jurisdictions. */
  eligibility: string
  /** landingDisclaimerAccess — sentence ②. Always renders with eligibility. */
  eligibilityAccess: string
  /** Heading above the contact paragraph. */
  contactHeading: string
  /** Contact paragraph, split so the two links can be placed inside it. */
  contactBefore: string
  contactLinkLabel: string
  contactMiddle: string
  englishLinkLabel: string
  contactAfter: string
  /** Nav/footer label pointing at the English site. */
  englishSiteLabel: string
  /** Nav/footer label for the contact page. */
  contactNavLabel: string
  /** aria-label for the navigation landmarks. */
  navLabel: string
}

export const LOCALISED_BUYER_CONTENT: LocalisedBuyerContent[] = [
  {
    page: 'de-buyer',
    lang: 'de',
    heading: 'Nachweise strukturieren. Entscheidungen unterstützen.',
    ownerLabel: 'Inhaltlich verantwortlich',
    reviewedLabel: 'Zuletzt geprüft',
    reviewedValue: '9. August 2026',
    lead: 'DDP macht aus Farmbeständen, Chargenunterlagen, COAs und Preisen klare Prüfpakete für ernsthafte Einkäufer.',
    body: 'DDP Brokerage unterstützt qualifizierte Einkäufer dabei, Angebot, Dokumentation und Beschaffungsreife über Netzwerke lizenzierter Produzenten zu beurteilen.',
    processHeading: 'Wie geprüft wird',
    steps: [
      { title: 'Beschaffung', text: 'Wir beziehen von lizenzierten Produzenten und erfassen die wesentlichen Liefer- und Dokumentationsdaten.' },
      { title: 'Prüfung', text: 'Nachweise und Laborberichte werden von unserem Team strukturiert und geprüft.' },
      { title: 'Zuordnung', text: 'Das Angebot wird auf die Anforderungen und Beschaffungsziele des Einkäufers abgestimmt.' },
      { title: 'Begleitung', text: 'Wir begleiten strukturierte Beschaffungsgespräche und die laufende Koordination.' },
    ],
    limitsHeading: 'Was DDP ausdrücklich nicht tut',
    limits:
      'DDP organisiert, konsolidiert und prüft Lieferantenunterlagen. DDP zertifiziert weder die Exportfähigkeit noch die pharmazeutische Eignung noch die Einhaltung gesetzlicher Vorgaben in irgendeiner Rechtsordnung. Einkaufsentscheidungen sollten sich ausschließlich auf geprüfte Dokumente und die Bestätigung einer qualifizierten Stelle stützen.',
    eligibilityHeading: 'Wer diese Plattform nutzen darf',
    eligibility:
      'Diese Plattform richtet sich ausschließlich an lizenzierte Cannabis-Unternehmen in Rechtsordnungen, in denen Anbau, Verarbeitung und Lieferung von Cannabis rechtlich zulässig sind.',
    eligibilityAccess: 'Plattformkonten werden nur auf Einladung vergeben. Lizenzierte Produzenten können jederzeit Zugang anfragen.',
    contactHeading: 'Kontakt',
    contactBefore: 'Anfragen von lizenzierten Einkäufern nimmt das Unternehmen über die ',
    contactLinkLabel: 'Kontaktseite',
    contactMiddle: ' entgegen. Die übrigen Seiten dieser Website sind auf ',
    englishLinkLabel: 'Englisch',
    contactAfter: ' verfügbar.',
    englishSiteLabel: 'English site',
    contactNavLabel: 'Kontakt',
    navLabel: 'Weitere Seiten',
  },

  {
    page: 'cs-buyer',
    lang: 'cs',
    heading: 'Strukturujeme důkazy. Podporujeme rozhodnutí.',
    ownerLabel: 'Obsah spravuje',
    reviewedLabel: 'Naposledy zkontrolováno',
    reviewedValue: '9. srpna 2026',
    lead: 'DDP převádí zásoby farem, šaržní záznamy, COA a ceny do přehledných podkladů pro seriózní kupující.',
    body: 'DDP Brokerage pomáhá kvalifikovaným kupujícím posoudit nabídku, dokumentaci a připravenost k nákupu v sítích licencovaných producentů.',
    processHeading: 'Jak probíhá kontrola',
    steps: [
      { title: 'Zajištění', text: 'Odebíráme od licencovaných producentů a shromažďujeme zásadní údaje o dodávce a dokumentaci.' },
      { title: 'Kontrola', text: 'Důkazy a laboratorní zprávy náš tým strukturuje a kontroluje.' },
      { title: 'Přiřazení', text: 'Nabídka je přiřazena k požadavkům a nákupním cílům kupujícího.' },
      { title: 'Podpora', text: 'Podporujeme strukturovaná nákupní jednání a průběžnou koordinaci.' },
    ],
    limitsHeading: 'Co DDP výslovně nedělá',
    limits:
      'DDP organizuje, konsoliduje a kontroluje dodavatelskou dokumentaci. DDP necertifikuje připravenost k exportu, farmaceutickou způsobilost ani soulad s právními předpisy v žádné jurisdikci. Nákupní rozhodnutí by se měla opírat výhradně o zkontrolované dokumenty a potvrzení kvalifikované strany.',
    eligibilityHeading: 'Kdo může platformu používat',
    eligibility:
      'Tato platforma je určena výhradně licencovaným subjektům v oblasti konopí, a to v jurisdikcích, kde je pěstování, zpracování a dodávka konopí právně povolena.',
    eligibilityAccess: 'Účty na platformě se vydávají pouze na pozvání. Licencovaní producenti mohou o přístup požádat kdykoli.',
    contactHeading: 'Kontakt',
    contactBefore: 'Poptávky licencovaných kupujících přijímá společnost prostřednictvím ',
    contactLinkLabel: 'kontaktní stránky',
    contactMiddle: '. Ostatní stránky tohoto webu jsou k dispozici v ',
    englishLinkLabel: 'angličtině',
    contactAfter: '.',
    englishSiteLabel: 'English site',
    contactNavLabel: 'Kontakt',
    navLabel: 'Další stránky',
  },
]

/** The content for `page`, or undefined if it is not a localised buyer page. */
export function localisedBuyerContentFor(page: Page): LocalisedBuyerContent | undefined {
  return LOCALISED_BUYER_CONTENT.find((content) => content.page === page)
}
