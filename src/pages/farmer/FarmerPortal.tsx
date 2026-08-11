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

export type BlockingTaskKind = 'evidence' | 'requests' | 'documents' | 'profile'

export interface FarmerPortalProps {
  lang: Lang
  onLang: (lang: Lang) => void
  farms: FarmProfile[]
  inventory: InventoryItem[]
  reviewRequests: ReviewRequest[]
  currentProfile: UserProfile | null
  evidenceWaitingCount: number | null
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
  hasCoa: boolean
}): BlockingTaskKind {
  // DDP has asked a question — nothing else the farm does will unblock it.
  if (input.evidenceWaiting > 0) return 'evidence'
  if (input.openRequests > 0) return 'requests'
  // Then the two documents that gate a listing at all.
  if (!input.hasLicence || !input.hasCoa) return 'documents'
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
  evidenceWaitingCount, openRequestsCount,
  onPrimary, onContact, onAddBatch, onSignOut, onGoTo,
}: FarmerPortalProps) {
  const t = T[lang]
  const farm = farms[0]
  const farmNamed = displayName(farm?.tradingName ?? '', t.portalNoName, farm?.id)

  const completion = farm ? Math.max(farm.completionPct, calcCompletion(farm)) : 0

  const task = resolveBlockingTask({
    evidenceWaiting: evidenceWaitingCount ?? 0,
    openRequests: openRequestsCount,
    hasLicence: hasAnyLicence(farm),
    hasCoa: Boolean(farm?.coaFiles?.trim()),
  })

  /** Oldest open request, so the age shown is the age of the actual wait. */
  const ageDays = useMemo(() => {
    const oldest = reviewRequests
      .filter(r => r.status === 'open')
      .reduce<ReviewRequest | undefined>(
        (found, r) => (!found || r.createdAt < found.createdAt ? r : found), undefined)
    return oldest ? daysOpen(oldest.createdAt) : null
  }, [reviewRequests])

  const checklist = useMemo(() => [
    { key: 'documents' as const, label: t.portalCheckLicence, done: hasAnyLicence(farm) },
    { key: 'documents' as const, label: t.portalCheckCoa, done: Boolean(farm?.coaFiles?.trim()) },
    { key: 'profile' as const, label: t.portalCheckProfile, done: completion >= 60 },
    { key: 'profile' as const, label: t.portalCheckStock, done: inventory.length > 0 },
  ], [farm, completion, inventory.length, t])

  const activity = useMemo(
    () => [...reviewRequests]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 4),
    [reviewRequests],
  )

  const accountLabel = currentProfile?.displayName || currentProfile?.email || farmNamed.name

  return (
    <div className="organic-scope">
      <div className="portal">
        {/* ── Header ─────────────────────────────────────────────────────────
            Two shapes, because the spec asks for two: a plain account row on a
            phone, and the dark lockup pill at desk width. Both carry the same
            two things — who you are, and which language you are reading. */}
        <div className="portal-header">
          <div className="portal-header-phone">
            <span style={{ fontWeight: 700, fontSize: 15 }}>{farmNamed.name}</span>
            <LanguageSegment lang={lang} onLang={onLang} tone="light" />
          </div>

          <div className="portal-header-desk">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <span aria-hidden="true" className="portal-mark">DDP</span>
              <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-neutral-100)' }}>
                {t.portalTitle}
              </span>
              <span className="portal-account">{accountLabel}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <LanguageSegment lang={lang} onLang={onLang} tone="dark" />
              <button type="button" className="portal-signout" onClick={onSignOut}>
                {t.portalSignOut}
              </button>
            </div>
          </div>
        </div>

        <div className="portal-main">
          {/* Page title — desk only. On a phone the blocking task is the title. */}
          <div className="portal-titleblock">
            <p style={{ fontSize: 15, color: 'var(--color-neutral-700)', margin: '0 0 8px' }}>
              {t.portalToday}
            </p>
            <h1 className="portal-title" style={{ fontSize: 46, lineHeight: 1.08, maxWidth: '22ch', margin: 0 }}>
              {t.portalHeading}
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
  const t = T[lang]
  const copy = t.portalTask[kind]
  return (
    <section className="portal-task">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12 }}>
        <span className="tag tag-accent" style={{ fontSize: 10.5 }}>{copy.tag}</span>
        {/* Identifiers and metadata in mono; absent is an em dash. */}
        <span className="portal-age">{ageDays === null ? '—' : t.portalDaysOpen(ageDays)}</span>
      </div>
      <h2 className="portal-task-title">{copy.title}</h2>
      <p className="portal-task-body">{copy.body}</p>
      {/* One primary on the screen; the ghost sits directly beneath it at the
          same width so the pair reads as a choice, not a button and a link. */}
      <div className="portal-actions">
        <button type="button" className="btn btn-primary" onClick={onPrimary}>{copy.cta}</button>
        <button type="button" className="btn btn-secondary" onClick={onContact}>{t.portalMessageDdp}</button>
      </div>
    </section>
  )
}

function StockList({ lang, inventory, onAddBatch }: {
  lang: Lang; inventory: InventoryItem[]; onAddBatch: () => void
}) {
  const t = T[lang]
  return (
    <section className="portal-card portal-stock">
      <h3 className="portal-card-head">{t.portalYourStock}</h3>
      {inventory.length === 0 ? (
        <p className="portal-empty">{t.portalNoStock}</p>
      ) : (
        inventory.map(item => {
          const named = displayName(item.productName ?? '', t.portalNoName, item.id)
          const state = stockState(item)
          return (
            <div className="stock-row" key={item.id}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>{named.name}</div>
                <div className="portal-code">
                  {named.identifier
                    ? shortIdentifier(named.identifier)
                    : `${item.batchNumber || '—'} · ${item.quantityKg} kg`}
                </div>
              </div>
              <div className="stock-col-desk portal-num">{item.quantityKg} kg</div>
              <div className="stock-col-desk">{item.qualityGrade || '\u2014'}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end' }}>
                <span aria-hidden="true" className={`portal-dot portal-dot--${state}`} />
                <span style={{ fontSize: 14, color: 'var(--color-neutral-700)' }}>
                  {state === 'listed' ? t.portalListed : t.portalHeld}
                </span>
              </div>
            </div>
          )
        })
      )}
      <div className="portal-stock-foot">
        <button type="button" className="btn btn-secondary" onClick={onAddBatch}>{t.portalAddBatch}</button>
      </div>
    </section>
  )
}

function ProfileChecklist({ lang, completion, rows, onGoTo }: {
  lang: Lang; completion: number
  rows: Array<{ key: BlockingTaskKind; label: string; done: boolean }>
  onGoTo: (task: BlockingTaskKind) => void
}) {
  const t = T[lang]
  return (
    <section className="portal-card portal-checklist">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 className="portal-card-head" style={{ margin: 0 }}>{t.portalProfile}</h3>
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
              {t.portalAdd}
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

function ContactCard({ lang, onContact }: { lang: Lang; onContact: () => void }) {
  const t = T[lang]
  const name = t.portalContactName
  return (
    <section className="portal-contact">
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <span aria-hidden="true" className="portal-avatar">
          {name.split(' ').map(part => part[0]).slice(0, 2).join('')}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-accent-2-900)' }}>{name}</div>
          <div style={{ fontSize: 13.5, color: 'var(--color-accent-2-900)' }}>{t.portalContactRole}</div>
        </div>
      </div>
      <button type="button" className="btn btn-secondary" style={{ width: '100%', marginTop: 14 }} onClick={onContact}>
        {t.portalMessageDdp}
      </button>
    </section>
  )
}

function RecentActivity({ lang, entries }: { lang: Lang; entries: ReviewRequest[] }) {
  const t = T[lang]
  return (
    <section className="portal-card">
      <h3 className="portal-card-head">{t.portalActivity}</h3>
      {entries.length === 0 ? (
        <p className="portal-empty">{t.portalNoActivity}</p>
      ) : (
        entries.map(entry => (
          <div className="portal-activity-row" key={entry.id}>
            <div style={{ fontSize: 14.5, lineHeight: 1.5, color: 'var(--color-neutral-800)' }}>
              {entry.message}
            </div>
            <div className="portal-stamp">{t.portalWhen(entry.createdAt)}</div>
          </div>
        ))
      )}
    </section>
  )
}
