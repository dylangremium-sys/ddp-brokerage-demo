import { useMemo } from 'react'
import { T } from '../../translations'
import { calcCompletion } from '../../data'
import { daysOpen, displayName, shortIdentifier } from '../../lib/entityName'
import type { FarmProfile, InventoryItem, Lang, ReviewRequest } from '../../types'
import type { UserProfile } from '../../services/auth'
import '../../styles/farmerPortal.css'

/**
 * The farm portal — handoff screens 1 (phone) and 2 (desktop).
 *
 * TWO LAYOUTS, NOT ONE STRETCHED ONE. The markup is shared; the arrangement is
 * decided by a media query in farmerPortal.css. Below 900px this is a single
 * column held to 430px — the phone screen. Above it, a main column and a 430px
 * rail. The build this replaces had no breakpoint at all, so the phone layout
 * rendered unconstrained at desk width and the primary button grew to the width
 * of the window.
 *
 * WHAT THE PAGE IS FOR. A Thai farmer, on a phone, on mobile data, learns the
 * one thing DDP needs and sends it. So one blocking task leads, and everything
 * else is reference.
 *
 * NAMES. Where a farm or batch has no name saved, `displayName` renders a plain
 * statement with the identifier demoted beneath it — never a raw UUID as a
 * title, never a dangling "·". Standing rule 4, shared with the Operations Desk
 * so the same absent name reads the same way on both sides of the product.
 */

export type BlockingTaskKind = 'evidence' | 'requests' | 'licence' | 'coa' | 'profile'

export interface FarmerPortalProps {
  lang: Lang
  onLang: (lang: Lang) => void
  farms: FarmProfile[]
  inventory: InventoryItem[]
  reviewRequests: ReviewRequest[]
  currentProfile: UserProfile | null
  evidenceWaitingCount: number | null
  /**
   * Whether the document register holds a COA for this farm. `null` = not
   * known yet; see resolveBlockingTask, which refuses to read that as "no".
   */
  coaDocumentOnFile: boolean | null
  openRequestsCount: number
  onPrimary: (task: BlockingTaskKind) => void
  onContact: () => void
  onAddBatch: () => void
  onSignOut: () => void
  /** Opens the section a checklist row is asking for. */
  onGoTo: (task: BlockingTaskKind) => void
}

/** The one thing DDP needs next, in the order that matters to the farm. */
function resolveBlockingTask(input: {
  evidenceWaiting: number
  openRequests: number
  hasLicence: boolean
  /**
   * Whether DDP holds a certificate of analysis for this farm at all.
   *
   * `null` means NOT KNOWN YET — the document register has not answered. It is
   * deliberately not folded into `false`: "we could not check" and "you have
   * not sent one" are different statements, and only one of them justifies
   * telling a farm to go and take a photograph. Asking for a document the farm
   * has already sent is the exact defect this screen shipped with on
   * 2026-08-12, so an unknown answer stays silent and the profile checklist —
   * which lists the gap without instructing anyone — carries it instead.
   */
  coaOnFile: boolean | null
}): BlockingTaskKind {
  // DDP has asked a question — nothing else the farm does will unblock it.
  if (input.evidenceWaiting > 0) return 'evidence'
  if (input.openRequests > 0) return 'requests'
  // Then the two documents that gate a listing at all, named separately.
  // They were one card until 2026-08-12, and it only ever said "licence".
  if (!input.hasLicence) return 'licence'
  if (input.coaOnFile === false) return 'coa'
  return 'profile'
}

function hasAnyLicence(farm?: FarmProfile): boolean {
  return [
    farm?.cultivationLicence, farm?.gapCert, farm?.gacpCert,
    farm?.gmpCert, farm?.organicCert, farm?.otherCerts,
  ].some(value => value?.trim())
}

/** Sage when a batch is visible to buyers, terracotta when paperwork holds it. */
function stockState(item: InventoryItem): 'listed' | 'held' {
  const listed = item.stockStatus === 'client_visible'
    || item.stockStatus === 'approved_internal'
    || item.status === 'Approved'
  return listed ? 'listed' : 'held'
}

export default function FarmerPortal({
  lang, onLang, farms, inventory, reviewRequests, currentProfile,
  evidenceWaitingCount, coaDocumentOnFile, openRequestsCount,
  onPrimary, onContact, onAddBatch, onSignOut, onGoTo,
}: FarmerPortalProps) {
  const text = T[lang]
  const farm = farms[0]
  const farmNamed = displayName(farm?.tradingName ?? '', text.portalNoName, farm?.id)

  const completion = farm ? Math.max(farm.completionPct, calcCompletion(farm)) : 0

  /**
   * A COA counts as on file if EITHER the farm profile carries one or the
   * document register holds one.
   *
   * The profile field alone was the whole test until 2026-08-12, and it knows
   * nothing about `farmer_documents` — so a farm that had uploaded a
   * certificate into the register, had it received and read by DDP, still
   * measured as having sent nothing. Unknown (`null`) propagates rather than
   * collapsing to "missing".
   */
  const coaOnFile: boolean | null = farm?.coaFiles?.trim() ? true : coaDocumentOnFile

  const task = resolveBlockingTask({
    evidenceWaiting: evidenceWaitingCount ?? 0,
    openRequests: openRequestsCount,
    hasLicence: hasAnyLicence(farm),
    coaOnFile,
  })

  /** Oldest open request, so the age shown is the age of the actual wait. */
  const ageDays = useMemo(() => {
    const [oldest] = reviewRequests
      .filter(r => r.status === 'open')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return oldest ? daysOpen(oldest.createdAt) : null
  }, [reviewRequests])

  const checklist = useMemo(() => [
    { key: 'licence' as const, label: text.portalCheckLicence, done: hasAnyLicence(farm) },
    // Ticked when the register holds one, not only when the profile field is
    // filled — the same correction as the blocking card above.
    { key: 'coa' as const, label: text.portalCheckCoa, done: coaOnFile === true },
    { key: 'profile' as const, label: text.portalCheckProfile, done: completion >= 60 },
    { key: 'profile' as const, label: text.portalCheckStock, done: inventory.length > 0 },
  ], [farm, coaOnFile, completion, inventory.length, text])

  const activity = useMemo(
    () => [...reviewRequests]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 4),
    [reviewRequests],
  )

  /**
   * What to call the farm on its own portal.
   *
   * THE NAME THEY GIVE THEMSELVES COMES FIRST. `trading_name` is the formal
   * name that goes on a dossier a buyer reads; the account's own display name
   * is what the farm calls itself, and this is the farm's own screen. Owner's
   * rule, 2026-08-11: use the self-given name, not the trading name.
   *
   * The trading name is still the fallback, because a farm that filled that in
   * and left its account name blank has still told us what it is called. Only
   * when there is nothing at all does the no-name statement appear — and that
   * is reported in the profile checklist, which is the place a farm can act on
   * it, rather than shouted in the header.
   *
   * NOTE this is a display rule only. Nothing here writes a self-given name
   * into `trading_name`: that field feeds buyer paperwork, and a name a farm
   * uses for itself is not necessarily the business's registered one.
   */
  const portalName = currentProfile?.displayName?.trim()
    || (farmNamed.unnamed ? '' : farmNamed.name)
    || currentProfile?.email
    || farmNamed.name

  return (
    <div className="organic-scope">
      <div className="portal">
        {/* ── Header ─────────────────────────────────────────────────────────
            Two shapes, because the spec asks for two: a plain account row on a
            phone, and the dark lockup pill at desk width. Both carry the same
            two things — who you are, and which language you are reading. */}
        <PortalHeader
          lang={lang}
          onLang={onLang}
          farmName={portalName}
          accountLabel={portalName}
          onSignOut={onSignOut}
        />

        <div className="portal-main">
          {/* Page title — desk only. On a phone the blocking task is the title. */}
          <div className="portal-titleblock">
            <p style={{ fontSize: 15, color: 'var(--color-neutral-700)', margin: '0 0 8px' }}>
              {text.portalToday}
            </p>
            <h1 className="portal-title" style={{ fontSize: 46, lineHeight: 1.08, maxWidth: '22ch', margin: 0 }}>
              {text.portalHeading}
            </h1>
          </div>

          <BlockingTask
            lang={lang}
            kind={task}
            ageDays={ageDays}
            onPrimary={() => onPrimary(task)}
            onContact={onContact}
          />

          <StockList lang={lang} inventory={inventory} onAddBatch={onAddBatch} />
        </div>

        <div className="portal-rail">
          {/* Contact sits first in the source so the phone order matches screen
              1 — account, task, stock, a named human. The rail reorders it at
              desk width, where the spec puts the checklist first. */}
          <ContactCard lang={lang} onContact={onContact} />
          <ProfileChecklist lang={lang} completion={completion} rows={checklist} onGoTo={onGoTo} />
          <RecentActivity lang={lang} entries={activity} />
        </div>
      </div>
    </div>
  )
}

/**
 * Two header shapes, because the spec asks for two: a plain account row on a
 * phone, and the dark lockup pill at desk width. Both carry the same two
 * things — who you are, and which language you are reading. Which one shows is
 * decided by the media query, not by this component.
 */
function PortalHeader({ lang, onLang, farmName, accountLabel, onSignOut }: {
  lang: Lang
  onLang: (lang: Lang) => void
  farmName: string
  accountLabel: string
  onSignOut: () => void
}) {
  const text = T[lang]
  return (
    <div className="portal-header">
      <div className="portal-header-phone">
        <span style={{ fontWeight: 700, fontSize: 15 }}>{farmName}</span>
        <LanguageSegment lang={lang} onLang={onLang} tone="light" />
      </div>

      <div className="portal-header-desk">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span aria-hidden="true" className="portal-mark">DDP</span>
          <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-neutral-100)' }}>
            {text.portalTitle}
          </span>
          <span className="portal-account">{accountLabel}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <LanguageSegment lang={lang} onLang={onLang} tone="dark" />
          <button type="button" className="portal-signout" onClick={onSignOut}>
            {text.portalSignOut}
          </button>
        </div>
      </div>
    </div>
  )
}

function LanguageSegment({ lang, onLang, tone }: {
  lang: Lang; onLang: (l: Lang) => void; tone: 'light' | 'dark'
}) {
  // Thai first, because this portal is read by Thai farms.
  return (
    <div className={`portal-seg portal-seg--${tone}`}>
      {(['th', 'en'] as const).map(code => (
        <button
          key={code}
          type="button"
          aria-pressed={lang === code}
          onClick={() => onLang(code)}
          className={`portal-seg-opt${lang === code ? ' is-active' : ''}`}
        >
          {code === 'th' ? 'ไทย' : 'EN'}
        </button>
      ))}
    </div>
  )
}

function BlockingTask({ lang, kind, ageDays, onPrimary, onContact }: {
  lang: Lang; kind: BlockingTaskKind; ageDays: number | null
  onPrimary: () => void; onContact: () => void
}) {
  const text = T[lang]
  const copy = text.portalTask[kind]
  return (
    <section className="portal-task">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12 }}>
        <span className="tag tag-accent" style={{ fontSize: 10.5 }}>{copy.tag}</span>
        {/* Identifiers and metadata in mono; absent is an em dash. */}
        <span className="portal-age">{ageDays === null ? '—' : text.portalDaysOpen(ageDays)}</span>
      </div>
      <h2 className="portal-task-title">{copy.title}</h2>
      <p className="portal-task-body">{copy.body}</p>
      {/* One primary on the screen; the ghost sits directly beneath it at the
          same width so the pair reads as a choice, not a button and a link. */}
      <div className="portal-actions">
        <button type="button" className="btn btn-primary" onClick={onPrimary}>{copy.cta}</button>
        <button type="button" className="btn btn-secondary" onClick={onContact}>{text.portalMessageDdp}</button>
      </div>
    </section>
  )
}

function StockList({ lang, inventory, onAddBatch }: {
  lang: Lang; inventory: InventoryItem[]; onAddBatch: () => void
}) {
  const text = T[lang]
  return (
    <section className="portal-card portal-stock">
      <h3 className="portal-card-head">{text.portalYourStock}</h3>
      {inventory.length === 0 ? (
        <p className="portal-empty">{text.portalNoStock}</p>
      ) : (
        inventory.map(item => {
          // A batch is not a farm — the same rule, the right noun.
          const named = displayName(item.productName ?? '', text.portalNoBatchName, item.id)
          const state = stockState(item)
          return (
            <div className="stock-row" key={item.id}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>{named.name}</div>
                {/* Join only the parts that exist. Every batch on this farm
                    has an empty batch number, so a fixed template rendered
                    "— · 50 kg" — a separator with nothing on one side of it,
                    which is the shape of missing data rather than a fact. */}
                <div className="portal-code">
                  {[
                    named.identifier ? shortIdentifier(named.identifier) : item.batchNumber,
                    `${item.quantityKg} kg`,
                  ].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="stock-col-desk portal-num">{item.quantityKg} kg</div>
              <div className="stock-col-desk">{item.qualityGrade || '\u2014'}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end' }}>
                <span aria-hidden="true" className={`portal-dot portal-dot--${state}`} />
                <span style={{ fontSize: 14, color: 'var(--color-neutral-700)' }}>
                  {state === 'listed' ? text.portalListed : text.portalHeld}
                </span>
              </div>
            </div>
          )
        })
      )}
      <div className="portal-stock-foot">
        <button type="button" className="btn btn-secondary" onClick={onAddBatch}>{text.portalAddBatch}</button>
      </div>
    </section>
  )
}

function ProfileChecklist({ lang, completion, rows, onGoTo }: {
  lang: Lang; completion: number
  rows: Array<{ key: BlockingTaskKind; label: string; done: boolean }>
  onGoTo: (task: BlockingTaskKind) => void
}) {
  const text = T[lang]
  return (
    <section className="portal-card portal-checklist">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 className="portal-card-head" style={{ margin: 0 }}>{text.portalProfile}</h3>
        <span className="portal-pct">{completion}%</span>
      </div>
      <div className="portal-bar"><div className="portal-bar-fill" style={{ width: `${completion}%` }} /></div>
      {rows.map(row => (
        <div className="portal-check-row" key={row.label}>
          <span aria-hidden="true" className={`portal-mark-sm${row.done ? ' is-done' : ' is-todo'}`}>
            {row.done ? '✓' : '!'}
          </span>
          <span style={{ fontSize: 14.5 }}>{row.label}</span>
          {!row.done && (
            <button type="button" className="portal-link" onClick={() => onGoTo(row.key)}>
              {text.portalAdd}
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

function ContactCard({ lang, onContact }: { lang: Lang; onContact: () => void }) {
  const text = T[lang]
  const name = text.portalContactName
  return (
    <section className="portal-contact">
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <span aria-hidden="true" className="portal-avatar">
          {name.split(' ').map(part => part[0]).slice(0, 2).join('')}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-accent-2-900)' }}>{name}</div>
          <div style={{ fontSize: 13.5, color: 'var(--color-accent-2-900)' }}>{text.portalContactRole}</div>
        </div>
      </div>
      <button type="button" className="btn btn-secondary" style={{ width: '100%', marginTop: 14 }} onClick={onContact}>
        {text.portalMessageDdp}
      </button>
    </section>
  )
}

function RecentActivity({ lang, entries }: { lang: Lang; entries: ReviewRequest[] }) {
  const text = T[lang]
  return (
    <section className="portal-card">
      <h3 className="portal-card-head">{text.portalActivity}</h3>
      {entries.length === 0 ? (
        <p className="portal-empty">{text.portalNoActivity}</p>
      ) : (
        entries.map(entry => (
          <div className="portal-activity-row" key={entry.id}>
            <div style={{ fontSize: 14.5, lineHeight: 1.5, color: 'var(--color-neutral-800)' }}>
              {entry.message}
            </div>
            <div className="portal-stamp">{text.portalWhen(entry.createdAt)}</div>
          </div>
        ))
      )}
    </section>
  )
}
