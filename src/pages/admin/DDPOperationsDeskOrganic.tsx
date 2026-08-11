import { useMemo, useState } from 'react'
import {
  buildOperationsDeskItems, CATEGORY_LABEL,
  type OperationsDeskItem, type OperationsDeskCategory,
} from '../../lib/operationsDesk'
import type { ComplianceAlert, FarmProfile, InventoryItem, ReviewRequest } from '../../types'

/**
 * The Operations Desk on the Organic design system — handoff screen 4.
 *
 * PILOT. Nothing routes here; the live desk is DDPOperationsDesk.tsx. This is a
 * sibling so it can be judged before anything replaces anything.
 *
 * THIS IS NOT A REPAINT. The audit's complaint about this screen was never that
 * it was ugly. It was that the screen tells its operator not to believe it:
 * 28 of 30 rows carry an identical HIGH pill, under a printed note explaining
 * that priority is "display-only … not a recorded status". A signal that never
 * varies is decoration, and a disclaimer under it is the screen conceding the
 * point. Four things change here, and three of them are behaviour:
 *
 *   1. The fake priority column is GONE. In its place are two facts the data
 *      already holds — how long a matter has waited, and how much stock it
 *      blocks. Neither needs a disclaimer.
 *   2. The whole row is the target. The live desk ends every row in its own
 *      button; at 30 rows that is 30 buttons doing one job.
 *   3. Selection and ONE bulk action, because the real work is chasing farms,
 *      and six farms owing documents is one message each, not twenty-four.
 *   4. Categories carry their counts in the filter, so the biggest blockage is
 *      visible without reading the table.
 *
 * ONE PRIMARY BUTTON ON THE SCREEN, and it is the bulk chase. Everything else
 * is secondary, ghost, or a plain row.
 */

/**
 * The age at which a matter is shown as overdue.
 *
 * ASSUMED, NOT CONFIRMED. Open question 2 in the design handoff asks DDP for
 * "the true SLA that colors the age column (5 days was assumed)". It is a named
 * constant so that answering the question is a one-line change rather than a
 * search through the markup.
 */
const ASSUMED_SLA_DAYS = 5

/** Categories the handoff groups the queue by, in the order it shows them. */
const GROUPS: Array<{ key: OperationsDeskCategory | 'all'; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'document', label: CATEGORY_LABEL.document },
  { key: 'coa', label: CATEGORY_LABEL.coa },
  { key: 'onboarding', label: CATEGORY_LABEL.onboarding },
  { key: 'follow-up', label: CATEGORY_LABEL['follow-up'] },
]

/** Ordinals up to the size of a queue anyone reads. Beyond that, digits. */
const WORDS = ['no', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const inWords = (n: number) => (n < WORDS.length ? WORDS[n] : String(n))

export interface OperationsDeskOrganicProps {
  farms: FarmProfile[]
  inventory: InventoryItem[] | null
  /** null means the source could not be loaded — never collapsed into []. */
  reviewRequests: ReviewRequest[] | null
  /** null means the source could not be loaded — never collapsed into []. */
  complianceAlerts: ComplianceAlert[] | null
  /** Opens the record where a matter is actually resolved. */
  onOpen: (item: OperationsDeskItem) => void
  /**
   * Records one chase per selected farm. Optional, and absent in the pilot:
   * there is no message-sending path in this product — outbound email was
   * removed in favour of an in-app activity log — so wiring this is real work,
   * not a callback. When it is absent the control says so rather than pretending.
   */
  onChaseFarms?: (farmLabels: string[]) => void
}

export default function DDPOperationsDeskOrganic({
  farms, inventory, reviewRequests, complianceAlerts, onOpen, onChaseFarms,
}: OperationsDeskOrganicProps) {
  const [group, setGroup] = useState<OperationsDeskCategory | 'all'>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const result = useMemo(
    () => buildOperationsDeskItems({ farms, inventory, reviewRequests, complianceAlerts }),
    [farms, inventory, reviewRequests, complianceAlerts],
  )

  /**
   * Kilograms of stock a matter is holding up.
   *
   * Joined from inventory rather than read off the matter: OperationsDeskItem
   * carries no quantity today. If this screen is adopted, that number belongs on
   * the model — a join here is right for one screen and wrong for the product.
   */
  const blockedKg = useMemo(() => {
    const byId = new Map((inventory ?? []).map(i => [i.id, i.quantityKg ?? 0]))
    const out = new Map<string, number>()
    for (const item of result.items) {
      const kg = byId.get(item.sourceEntityId)
      if (kg) out.set(item.id, kg)
    }
    return out
  }, [result.items, inventory])

  const sorted = useMemo(() => {
    // Oldest first. An undated matter sinks BELOW every dated one: it cannot
    // evidence the urgency that would put it at the top, and sorting undefined
    // among numbers is how a queue silently mis-orders itself.
    return [...result.items].sort((a, b) => {
      const aDated = a.ageInDays !== undefined
      const bDated = b.ageInDays !== undefined
      if (aDated !== bDated) return aDated ? -1 : 1
      if (!aDated) return a.title.localeCompare(b.title)
      return (b.ageInDays ?? 0) - (a.ageInDays ?? 0)
    })
  }, [result.items])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return sorted.filter(item => {
      if (group !== 'all' && item.category !== group) return false
      if (!needle) return true
      return `${item.title} ${item.entityLabel} ${item.reason}`.toLowerCase().includes(needle)
    })
  }, [sorted, group, search])

  const countFor = (key: OperationsDeskCategory | 'all') =>
    key === 'all' ? result.items.length : result.items.filter(i => i.category === key).length

  const alerts = complianceAlerts ?? []
  const overdue = result.items.filter(i => (i.ageInDays ?? 0) > ASSUMED_SLA_DAYS).length
  const heldKg = [...blockedKg.values()].reduce((sum, kg) => sum + kg, 0)
  const farmsOwing = new Set(result.items.map(i => i.entityLabel)).size

  const selectedFarms = useMemo(
    () => [...new Set(result.items.filter(i => selected.has(i.id)).map(i => i.entityLabel))],
    [result.items, selected],
  )

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 32, alignItems: 'end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <p style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: 'var(--color-neutral-600)', margin: '0 0 14px',
          }}>
            DDP Operations
          </p>
          {/* The count in words, because the number is the whole point of the
              page and a numeral in a heading reads as decoration. */}
          <h1 style={{ fontSize: 40, lineHeight: 1.1, margin: '0 0 10px' }}>
            {inWords(result.items.length)} {result.items.length === 1 ? 'matter needs' : 'matters need'} a human
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.55, maxWidth: '60ch', margin: 0, color: 'var(--color-neutral-700)' }}>
            Oldest first. Terracotta means someone must act; sage means cleared; plain ink is a
            count. Nothing else is tinted.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ minWidth: 260 }}
            placeholder="Search farm, batch, reason"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search matters"
          />
          {/* The screen's ONE primary button, and it is the bulk action —
              chasing farms is the job this queue exists to produce. */}
          <button
            type="button"
            className="btn btn-primary"
            disabled={selectedFarms.length === 0 || !onChaseFarms}
            style={selectedFarms.length === 0 || !onChaseFarms
              ? { opacity: 0.45, cursor: 'not-allowed' }
              : undefined}
            onClick={() => onChaseFarms?.(selectedFarms)}
          >
            {selectedFarms.length === 0
              ? 'Chase farms'
              : `Chase ${selectedFarms.length} farm${selectedFarms.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </header>

      {/* ── What the queue costs, in four numbers ───────────────────────────
          Backgrounds carry the meaning: terracotta needs a person, sage is
          cleared, plain neutral is a count with no opinion. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 18, marginTop: 32 }}>
        <Tile tone="accent" label="Needs a person" value={String(result.items.length)}
          note={`across ${farmsOwing} farm${farmsOwing === 1 ? '' : 's'}`} />
        <Tile tone="accent-soft" label={`Waiting over ${ASSUMED_SLA_DAYS} days`} value={String(overdue)}
          note={overdue === 0 ? 'nothing has aged past the target' : 'these are the ones to open first'} />
        <Tile tone="sage" label="Stock held on paperwork" value={heldKg ? `${heldKg.toLocaleString()} kg` : '—'}
          note={heldKg ? 'released when the documents land' : 'no held stock is linked to a matter'} />
        {/* Not "0". A zero here is a healthy state and should say so. */}
        <Tile tone="neutral" label="Blocking alerts"
          value={alerts.length ? String(alerts.length) : 'None'}
          note={alerts.length ? 'compliance rules are stopping work' : 'no rule is stopping work today'} />
      </div>

      {/* ── Category filter, counts in the label ────────────────────────────
          This replaces the priority pill: a count tells you where the blockage
          is, and it is a fact rather than a judgement. */}
      <div style={{ display: 'flex', gap: 8, marginTop: 30, flexWrap: 'wrap' }}>
        {GROUPS.map(g => {
          const n = countFor(g.key)
          const active = group === g.key
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => setGroup(g.key)}
              style={{
                borderRadius: 999, cursor: 'pointer', padding: '10px 18px',
                fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: active ? 600 : 500,
                background: active ? 'var(--color-accent-500)' : 'var(--color-neutral-100)',
                color: active ? 'var(--color-accent-900)' : 'var(--color-neutral-800)',
                border: active ? '1px solid var(--color-accent-500)' : '1px solid var(--color-neutral-300)',
              }}
            >
              {g.label} ({n})
            </button>
          )
        })}
      </div>

      {/* ── The queue ───────────────────────────────────────────────────────
          No priority column, and no per-row button. */}
      <div style={{
        marginTop: 20, background: 'var(--color-neutral-100)', borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
      }}>
        <div style={{ ...ROW, background: 'var(--color-neutral-200)', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-neutral-700)' }}>
          <span />
          <span>Matter</span>
          <span>Farm</span>
          <span>What is missing</span>
          <span style={{ textAlign: 'right' }}>Waiting</span>
        </div>

        {visible.length === 0 && (
          <p style={{ padding: '28px 26px', margin: 0, fontSize: 14.5, color: 'var(--color-neutral-700)' }}>
            {result.items.length === 0
              ? 'Nothing is waiting on a person. This is the healthy state, not a missing feed.'
              : 'No matter matches that filter. Clear the search or choose Everything.'}
          </p>
        )}

        {visible.map(item => {
          const kg = blockedKg.get(item.id)
          const isOverdue = (item.ageInDays ?? 0) > ASSUMED_SLA_DAYS
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(item)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item) } }}
              style={{ ...ROW, borderTop: '1px solid var(--color-neutral-200)', cursor: 'pointer', alignItems: 'center' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-100)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              {/* Selection only. Navigation is the row itself. */}
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onClick={e => e.stopPropagation()}
                onChange={() => toggle(item.id)}
                aria-label={`Select ${item.title}`}
                style={{ width: 18, height: 18, cursor: 'pointer' }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600, fontSize: 15.5 }}>{item.title}</span>
                <span style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>{CATEGORY_LABEL[item.category]}</span>
              </span>
              <span style={{ fontSize: 14.5, minWidth: 0 }}>
                {item.entityLabel}
                {kg !== undefined && (
                  <span style={{ display: 'block', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--color-neutral-600)' }}>
                    {kg.toLocaleString()} kg held
                  </span>
                )}
              </span>
              <span style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--color-neutral-700)' }}>{item.reason}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
                <span style={{
                  fontSize: 14, fontVariantNumeric: 'tabular-nums',
                  // The ONLY signal in this column, and only past the target.
                  color: isOverdue ? 'var(--color-accent-700)' : 'var(--color-neutral-700)',
                  fontWeight: isOverdue ? 600 : 400,
                }}>
                  {/* Absent is an em dash. The live desk prints the words "No
                      recorded date" here, 24 times in a 30-row queue. */}
                  {item.ageInDays === undefined
                    ? '—'
                    : `${item.ageInDays} day${item.ageInDays === 1 ? '' : 's'}`}
                </span>
                <span aria-hidden="true" style={{ fontSize: 18, color: 'var(--color-neutral-500)' }}>›</span>
              </span>
            </div>
          )
        })}

        <div style={{
          ...ROW, borderTop: '1px solid var(--color-neutral-200)',
          fontSize: 13.5, color: 'var(--color-neutral-600)',
        }}>
          <span />
          <span style={{ gridColumn: '2 / -1' }}>
            Showing {visible.length} of {result.items.length} · oldest first ·{' '}
            {onChaseFarms
              ? 'select rows to chase those farms in one message each'
              : 'chasing farms is not wired up in this preview'}
          </span>
        </div>
      </div>
    </>
  )
}

/** Shared row geometry, so the header, the rows and the footer cannot drift. */
const ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '26px 1.5fr 1.1fr 1.6fr 0.8fr',
  gap: 20,
  padding: '18px 26px',
}

const TONES = {
  accent: { bg: 'var(--color-accent-200)', label: 'var(--color-accent-800)', value: 'var(--color-accent-900)', note: 'var(--color-accent-800)' },
  'accent-soft': { bg: 'var(--color-accent-100)', label: 'var(--color-accent-800)', value: 'var(--color-accent-900)', note: 'var(--color-accent-800)' },
  sage: { bg: 'var(--color-accent-2-200)', label: 'var(--color-accent-2-800)', value: 'var(--color-accent-2-900)', note: 'var(--color-accent-2-800)' },
  neutral: { bg: 'var(--color-neutral-100)', label: 'var(--color-neutral-700)', value: 'var(--color-neutral-900)', note: 'var(--color-neutral-700)' },
} as const

function Tile({ tone, label, value, note }: {
  tone: keyof typeof TONES; label: string; value: string; note: string
}) {
  const t = TONES[tone]
  return (
    <div style={{
      background: t.bg, borderRadius: 'var(--radius-md)', padding: '24px 26px',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.label }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 40, lineHeight: 1.1, margin: '10px 0 6px', color: t.value }}>
        {value}
      </div>
      {/* Never a bare number: a count with no sentence is a number the reader
          has to interpret, and they will each interpret it differently. */}
      <div style={{ fontSize: 13.5, color: t.note }}>{note}</div>
    </div>
  )
}
