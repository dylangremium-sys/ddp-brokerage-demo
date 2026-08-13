import type { Lang } from '../../types'
import {
  STATUS_VOCABULARY,
  statesPresentIn,
  type StatusStateKey,
} from '../../lib/statusVocabulary'
import { T } from '../../translations'

/* ────────────────────────────────────────────────────────────────────────────
   The batch dossier card — handoff §9, and the fix for audit finding 12.

   WHAT THIS REPLACES. A card that scored four rows with green / amber / amber /
   red traffic lights. Red is not in the Organic palette at all, and it was
   applied to "Buyer visibility: Restricted" — which is the system behaving
   correctly, not a failure. The colour told a buyer that a working control was
   a fault.

   The card's job is to teach, in the shop window, the same colour rule the
   console obeys: terracotta means a named human must act, sage means cleared,
   an outline means the question does not apply here. Every tag and every legend
   line is rendered from `statusVocabulary.ts`. There are no status strings in
   this file, and there must never be.

   WHY THE LEGEND IS DERIVED. §9 specifies a fixed three-line legend written
   against a fixed five-row card. Deriving it from the rows means the two cannot
   drift apart — and it avoids explaining a colour the reader cannot see.

   WHY THERE IS NO CHAIN-OF-CUSTODY ROW. §9 lists one. AGENTS.md, "Ground
   rules": *"Fulfilment and chain-of-custody tracking are planned, not
   implemented. Do not assume they exist."* Publishing "Chain of custody ·
   Cleared" on the front door would assert a capability the record cannot
   support — standing rule 10 — to exactly the audience that would ask us to
   evidence it. The row returns when the tracking does.
──────────────────────────────────────────────────────────────────────────── */

/**
 * The sample dossier.
 *
 * FLAGGED FOR THE OWNER: this is illustrative, not a real batch. Deviation 4 of
 * the handoff asks for "a real cleared batch with names and dates redacted —
 * the card should demonstrate, not disclaim", and there is no read credential
 * for production from which to source one. The farm is written in the
 * anonymised form §8 already uses for buyer-facing origin ("Farm 02 · Chiang
 * Mai") rather than invented as a named farm, so nothing here names a real
 * party. Swapping in a redacted real batch is an edit to this constant alone.
 */
/** Translation keys for the document names, narrowed so `t[key]` is a string. */
type DocLabelKey =
  | 'hpDossierDocLicence'
  | 'hpDossierDocCoa'
  | 'hpDossierDocPhyto'
  | 'hpDossierDocGmp'

const SAMPLE_DOSSIER: {
  batchCode: string
  documents: { key: DocLabelKey; state: StatusStateKey }[]
} = {
  batchCode: 'GEL-0418',
  documents: [
    { key: 'hpDossierDocLicence', state: 'cleared' },
    { key: 'hpDossierDocCoa', state: 'cleared' },
    { key: 'hpDossierDocPhyto', state: 'needsPerson' },
    { key: 'hpDossierDocGmp', state: 'notApplicable' },
  ],
}

export function BatchDossierCard({ lang }: { lang: Lang }) {
  const t = T[lang]
  const legend = statesPresentIn(SAMPLE_DOSSIER.documents.map(d => d.state))
  const headerState = STATUS_VOCABULARY.cleared

  return (
    <aside className="hp-dossier" aria-labelledby="hp-dossier-title">
      <div className="hp-dossier-head">
        <h2 className="hp-dossier-title" id="hp-dossier-title">
          {t.hpDossierTitle} <span className="hp-dossier-code">{SAMPLE_DOSSIER.batchCode}</span>
        </h2>
        <span className={headerState.tagClass}>{headerState.label[lang]}</span>
      </div>

      <p className="hp-dossier-sub">{t.hpDossierSub}</p>

      <div className="hp-dossier-rows">
        {SAMPLE_DOSSIER.documents.map(doc => {
          const state = STATUS_VOCABULARY[doc.state]
          return (
            <div className="hp-dossier-row" key={doc.key}>
              <span className="hp-dossier-doc">{t[doc.key]}</span>
              <span className={state.tagClass}>{state.label[lang]}</span>
            </div>
          )
        })}
      </div>

      <div className="hp-dossier-legend">
        <div className="hp-dossier-legend-label">{t.hpDossierLegend}</div>
        <ul className="hp-dossier-legend-items">
          {legend.map(state => (
            <li key={state.key}>
              {/* Class, never a `style` prop — the CSP refuses inline styles and
                  this page is prerendered. See statusVocabulary.ts. */}
              <span className={`hp-dossier-dot ${state.modifier}`} aria-hidden="true" />
              <span>{state.meaning[lang]}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
