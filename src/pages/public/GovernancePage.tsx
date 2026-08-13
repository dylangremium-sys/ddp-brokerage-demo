import { T } from '../../translations'
import type { Lang, Page } from '../../types'
import CorporatePageShell from '../../components/public/CorporatePageShell'
import { STATUS_STATES } from '../../lib/statusVocabulary'
import '../../styles/publicGovernance.css'

/* ────────────────────────────────────────────────────────────────────────────
   Governance — handoff §11.

   WHY THIS PAGE EXISTS. The homepage used to open on "Organising evidence.
   Supporting decisions." — abstract language written for a compliance officer,
   standing in front of a farmer and a first-time buyer. §11 gives the sentence
   its audience. The homepage kept the concrete promise; this page took the
   governance argument.

   THE STATUS TABLE IS RENDERED FROM statusVocabulary.ts, the same constant the
   homepage dossier card and the console tiles read. Standing rule 3 says the
   marketing site and the console share one vocabulary; a table that retyped the
   four states would be the drift it exists to prevent. No status string appears
   in this file.

   ─────────────────────────────────────────────────────────────────────────────
   TWO OF §11's ACCOUNTABILITY BULLETS ARE NOT PUBLISHED AS WRITTEN, because
   they are false against production. Checked read-only on 2026-08-13 against
   the live schema, not against the migration files:

   1. §11: "Uploader and reviewer can never be the same person — enforced in the
      database, not the interface."
      `farmer_documents` has `uploaded_at` but NO `uploaded_by` COLUMN. The
      database does not record who uploaded a document, so the comparison cannot
      be made at all — this is unrepresentable, not merely unenforced. No
      function references both an uploader and a reviewer; no CHECK constraint
      encodes the separation.

   2. §11: "Every decision is timestamped and reversible only by a second
      reviewer, who is also recorded."
      Timestamped is true. "Only by a second reviewer" is not enforced anywhere:
      no rule restricts who may reverse a decision, and the gate permits the
      same reviewer to return a document to the queue and decide it again.

   Standing rule 10 — never display a claim the record cannot support — applies
   hardest on the page whose whole purpose is to be relied upon by someone who
   would ask us to evidence it. So both are replaced by claims the schema does
   support, and which happen to be stronger. What IS enforced, verified:

     • `review_decision_requires_reviewer` CHECK + fn_farmer_documents_set_reviewer
       — a non-pending status must carry `reviewed_by`, taken from the session,
       never chosen by the caller.
     • enforce_evidence_decision_gate on INSERT — a document must ARRIVE
       undecided; creating one already accepted is refused.
     • The same gate on UPDATE — the deciding reviewer must appear in
       farmer_document_opens for that document, and every status change needs a
       reason of substance, including a return to the queue.

   Bullet 4 is narrowed for the same reason: farms do see their own trail in
   Thai (FarmerStatus renders a recent-activity section and the portal is
   bilingual), but nothing in the farmer portal names the DDP person holding
   the file, so that clause is not published.

   These are flagged for the owner in the PR. If the separation of duties is
   wanted as stated, it needs a schema change first and the copy second.
──────────────────────────────────────────────────────────────────────────── */

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  onNavigate: (page: Page) => void
}

export default function GovernancePage({ lang, setLang, onNavigate }: Props) {
  const t = T[lang]

  const accountability = [
    t.govAcct1,
    t.govAcct2,
    t.govAcct3,
    t.govAcct4,
  ]
  const notDoing = [t.govNot1, t.govNot2, t.govNot3, t.govNot4]

  return (
    <CorporatePageShell
      lang={lang}
      setLang={setLang}
      page="governance"
      onNavigate={onNavigate}
      heading={t.govTitle}
      fullBleed
      hero={
        <div className="gov-hero-band">
          <div className="gov-wrap">
            <div className="gov-eyebrow">{t.govEyebrow}</div>
            <h1 className="gov-h1">{t.govTitle}</h1>
            <p className="gov-lede">{t.govLede}</p>
          </div>
        </div>
      }
    >
      {/* ── Status vocabulary ──────────────────────────────────────────────
          Band colour on the outer element, content capped inside it. */}
      <div className="gov-band-sand">
        <div className="gov-wrap gov-section">
          <h2 className="gov-h2">{t.govVocabTitle}</h2>
          <p className="gov-note">{t.govVocabNote}</p>

          <div className="gov-vocab">
            {STATUS_STATES.map(state => (
              <div className="gov-vocab-row" key={state.key}>
                <div>
                  <span className={state.tagClass}>{state.label[lang]}</span>
                </div>
                <p className="gov-vocab-meaning">{state.meaning[lang]}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Accountability split ───────────────────────────────────────────── */}
      <div className="gov-wrap gov-section">
        <div className="gov-split">
          <div>
            <h2 className="gov-h2">{t.govAcctTitle}</h2>
            <p className="gov-body">{t.govAcctBody}</p>
            <ul className="gov-points">
              {accountability.map(point => (
                <li key={point}>
                  <span className="gov-dot" aria-hidden="true" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="gov-notdo">
            <h2 className="gov-notdo-title">{t.govNotTitle}</h2>
            <p className="gov-notdo-intro">{t.govNotIntro}</p>
            <div className="gov-notdo-items">
              {notDoing.map(item => (
                <div className="gov-notdo-item" key={item}>{item}</div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Dossier request ────────────────────────────────────────────────
          NO INPUT, AND THAT IS DELIBERATE. §11 draws an `.input` beside this
          button. There is no public dossier-request intake to receive what
          someone types, and the homepage's buyer strip already set the
          precedent for this exact situation: a field that accepts a value and
          discards it on navigation is the defect this product keeps finding —
          a control that looks live and is not. The button is the page's one
          filled primary and it routes to the contact page, which is a real
          destination staffed by real addresses. */}
      <div className="gov-band-dark">
        <div className="gov-wrap gov-section">
          <div className="gov-request">
            <div>
              <h2 className="gov-request-title">{t.govRequestTitle}</h2>
              <p className="gov-request-body">{t.govRequestBody}</p>
            </div>
            <button
              type="button"
              className="btn btn-primary gov-request-cta"
              onClick={() => onNavigate('contact')}
            >
              {t.govRequestCta}
            </button>
          </div>
        </div>
      </div>
    </CorporatePageShell>
  )
}
