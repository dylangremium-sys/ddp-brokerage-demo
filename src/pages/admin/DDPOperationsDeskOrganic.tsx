import { useMemo, useState } from 'react'
import {
  buildOperationsDeskItems, CATEGORY_LABEL,
  type OperationsDeskItem, type OperationsDeskCategory,
} from '../../lib/operationsDesk'
import type { ComplianceAlert, FarmProfile, InventoryItem, ReviewRequest } from '../../types'
import { resolveOperationsDeskEmptyState } from '../../lib/operationsDeskEmptyState'
import { displayName, isIdentifier } from '../../lib/entityName'

/**
 * The Operations Desk on the Organic design system — handoff screen 4.
 *
 * THIS IS THE LIVE DESK. App.tsx:1139 routes here; DDPOperationsDesk.tsx is kept
 * on disk, unrouted (App.tsx:1893). The header used to say the reverse, left over
 * from when this was a pilot — and an audit that trusted it went and read the
 * wrong file, which is part of why the identifier defect below survived review.
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
 * CONFIRMED, 12 Aug 2026 — the design handoff's open question 2 has been
 * answered and its revision log records "Ops Desk SLA set to 3 days (was 5,
 * assumed)". Previously 5 and explicitly a guess; it is no longer one, so the
 * name no longer says assumed.
 *
 * WHAT TO WATCH. Shortening the target moves matters into the overdue colour.
 * If most of the queue turns terracotta, the screen has recreated the defect it
 * replaced — a signal that never varies — by a different mechanism. The answer
 * then is a second tier, not a longer target: the colour has to distinguish
 * something, and "everything is late" distinguishes nothing.
 */
const SLA_DAYS = 3

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

/**
 * What an empty queue means, per resolved state.
 *
 * Only 'all-clear' asserts that nothing is waiting. The other three say why the
 * queue is empty without making that claim, because a still-loading or failed
 * source rendered as "nothing to do" is a queue lying to its operator.
 */
const EMPTY_MESSAGE: Record<string, string> = {
  failed: 'Some matters could not be listed — a source failed to load, so this is not an all-clear.',
  loading: 'Still loading. This is not yet an all-clear.',
  'filtered-empty': 'No matter matches that filter. Clear the search or choose Everything.',
  'all-clear': 'Nothing is waiting on a person. This is the healthy state, not a missing feed.',
  'has-matters': '',
}

/* ── Shared style constants ───────────────────────────────────────────────
   Declared above the component rather than beneath it. `const` is not
   initialised until evaluation reaches it, so a reference from above works only
   because the component runs later — which is a fact about timing, not
   something a reader should have to reconstruct. */

const NOTICE_ACCENT: React.CSSProperties = {
  marginTop: 22, padding: '16px 20px', borderRadius: 'var(--radius-md)',
  background: 'var(--color-accent-100)', color: 'var(--color-accent-900)',
  fontSize: 14, lineHeight: 1.55,
}

const NOTICE_MUTED: React.CSSProperties = {
  margin: '14px 0 0', fontSize: 14, color: 'var(--color-neutral-700)',
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

export interface OperationsDeskOrganicProps {
  farms: FarmProfile[]
  inventory: InventoryItem[] | null
  /** null means the source could not be loaded — never collapsed into []. */
  reviewRequests: ReviewRequest[] | null
  /** null means the source could not be loaded — never collapsed into []. */
  complianceAlerts: ComplianceAlert[] | null
  /**
   * Source states. These are NOT presentation detail: a queue that renders
   * "nothing is waiting" while a source is still loading or has failed is a
   * false all-clear, and the operator acts on it. Carried over verbatim from
   * the desk this replaces, where they exist because that defect happened.
   */
  reviewRequestsLoading: boolean
  complianceLoading: boolean
  farmInventoryLoading: boolean
  farmInventoryFailed: boolean
  /** Opens the record where a matter is actually resolved. */
  onOpen: (item: OperationsDeskItem) => void
  /** True while a chase is being written, so the action cannot be double-sent. */
  busy?: boolean
  /**
   * Records ONE request per farm, listing that farm's selected matters — not one
   * request per matter. A farm that owes six documents should receive one
   * message, and the number on the button counts farms for the same reason.
   */
  onChaseFarms?: (chases: FarmChase[]) => void
}

/** One farm, and everything selected against it. */
export interface FarmChase {
  farmProfileId: string
  farmName: string
  /** The `reason` of each selected matter, in the order shown. */
  missing: string[]
}

/**
 * Title, search, and the screen's ONE primary button.
 *
 * The primary is the bulk chase, deliberately: chasing farms is the work this
 * queue exists to produce, and nothing else on the screen is filled.
 */
function DeskHeader({ total, search, onSearch, chaseCount, chaseEnabled, busy, onChase }: {
  total: number
  search: string
  onSearch: (value: string) => void
  chaseCount: number
  chaseEnabled: boolean
  busy: boolean
  onChase: () => void
}) {
  return (
    <header style={{ display: 'flex', justifyContent: 'space-between', gap: 32, alignItems: 'end', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <p style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: 'var(--color-neutral-600)', margin: '0 0 14px',
        }}>
          DDP Operations
        </p>
        {/* The count in words, because the number is the whole point of the page
            and a numeral in a heading reads as decoration. */}
        <h1 style={{ fontSize: 40, lineHeight: 1.1, margin: '0 0 10px' }}>
          {inWords(total)} {total === 1 ? 'matter needs' : 'matters need'} a human
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
          onChange={e => onSearch(e.target.value)}
          aria-label="Search matters"
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!chaseEnabled}
          style={chaseEnabled ? undefined : { opacity: 0.45, cursor: 'not-allowed' }}
          onClick={onChase}
        >
          {busy
            ? 'Recording\u2026'
            : chaseCount === 0
              ? 'Chase farms'
              : `Chase ${chaseCount} farm${chaseCount === 1 ? '' : 's'}`}
        </button>
      </div>
    </header>
  )
}

/**
 * A bare UUID is not a name.
 *
 * Measured in production: 11 of 24 matters render their farm as
 * `b1f4182c-3a2b-419b-b050-84609ac13492`, because the queue falls back to the
 * farm's id when the farm has no trading name. An identifier cannot be a record
 * title — an operator cannot tell two of these apart, and reading one aloud to
 * a colleague is impossible. The id is kept, demoted to metadata, and the row
 * says plainly what is actually wrong: the farm has no name on file.
 */
/**
 * The rule itself lives in lib/entityName, shared with the farm portal. This
 * screen used to keep its own copy, and the two had already drifted — the copy
 * stripped a dangling separator from one end where the shared rule strips both,
 * and it judged the whole label where the shared rule judges each part. That
 * second difference is why compliance rows still printed "farm · b1f4182c-…"
 * after #212/#213. One rule, one place, or the desk silently opts out of every
 * fix made to it.
 */
const UNNAMED_ENTITY = 'Farm with no name on file'

function entityDisplay(label: string, farm: { id: string; name: string } | null): {
  name: string; identifier?: string; unnamed: boolean
} {
  const shown = displayName(label, UNNAMED_ENTITY, farm?.id)
  // Kept from this screen's own version, and deliberately not pushed into the
  // shared module: the desk holds the farm record, so where the label yields no
  // name it can still name the farm. The portal has no equivalent to fall back on.
  if (shown.unnamed && farm && !isIdentifier(farm.name)) {
    return { name: farm.name, identifier: shown.identifier, unnamed: false }
  }
  return shown
}

/**
 * One matter in the queue.
 *
 * Extracted so the desk's own renderer stays readable: the row carries most of
 * the screen's branching (selectable or not, dated or not, overdue or not,
 * holding stock or not) and none of its state.
 */
function MatterRow({ item, farm, blockedKg, overdue, selected, onToggle, onOpen }: {
  item: OperationsDeskItem
  /** null when the matter cannot be tied to a farm on file — then it cannot be chased. */
  farm: { id: string; name: string } | null
  blockedKg?: number
  overdue: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const chaseable = farm !== null
  const entity = entityDisplay(item.entityLabel, farm)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={{ ...ROW, borderTop: '1px solid var(--color-neutral-200)', cursor: 'pointer', alignItems: 'center' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-100)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {/* Selection only. Navigation is the row itself. */}
      <input
        type="checkbox"
        checked={selected}
        disabled={!chaseable}
        title={chaseable ? undefined : 'This matter is not tied to a farm on file, so it cannot be chased from here.'}
        onClick={e => e.stopPropagation()}
        onChange={onToggle}
        aria-label={`Select ${item.title}`}
        style={{ width: 18, height: 18, cursor: chaseable ? 'pointer' : 'not-allowed', opacity: chaseable ? 1 : 0.4 }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, fontSize: 15.5 }}>{item.title}</span>
        <span style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>{CATEGORY_LABEL[item.category]}</span>
      </span>
      <span style={{ fontSize: 14.5, minWidth: 0 }}>
        <span style={entity.unnamed ? { color: 'var(--color-accent-700)' } : undefined}>
          {entity.name}
        </span>
        {entity.identifier && (
          <span style={{ display: 'block', fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: 'var(--color-neutral-600)' }}>
            {entity.identifier.slice(0, 8)}…
          </span>
        )}
        {blockedKg !== undefined && (
          <span style={{ display: 'block', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--color-neutral-600)' }}>
            {blockedKg.toLocaleString()} kg held
          </span>
        )}
      </span>
      <span style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--color-neutral-700)' }}>{item.reason}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
        <span style={{
          fontSize: 14, fontVariantNumeric: 'tabular-nums',
          // The ONLY signal in this column, and only past the target.
          color: overdue ? 'var(--color-accent-700)' : 'var(--color-neutral-700)',
          fontWeight: overdue ? 600 : 400,
        }}>
          {/* Absent is an em dash. The desk this replaces printed the words
              "No recorded date" here, 24 times in a 30-row queue. */}
          {item.ageInDays === undefined ? '\u2014' : `${item.ageInDays} day${item.ageInDays === 1 ? '' : 's'}`}
        </span>
        <span aria-hidden="true" style={{ fontSize: 18, color: 'var(--color-neutral-500)' }}>&rsaquo;</span>
      </span>
    </div>
  )
}

export default function DDPOperationsDeskOrganic({
  farms, inventory, reviewRequests, complianceAlerts,
  reviewRequestsLoading, complianceLoading, farmInventoryLoading, farmInventoryFailed,
  onOpen, onChaseFarms, busy = false,
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

  // A source still settling means the queue below is not yet an all-clear. The
  // farm/inventory source feeds most queues, so its states join the tally.
  const hasPendingSources = reviewRequestsLoading || complianceLoading || farmInventoryLoading
  const failureCount = result.failures.length + (farmInventoryFailed ? 1 : 0)
  const isFiltered = group !== 'all' || search.trim() !== ''
  const emptyState = resolveOperationsDeskEmptyState({
    visibleCount: visible.length,
    failureCount,
    hasPendingSources,
    isFiltered,
  })

  const alerts = complianceAlerts ?? []
  const overdue = result.items.filter(i => (i.ageInDays ?? 0) > SLA_DAYS).length
  const heldKg = [...blockedKg.values()].reduce((sum, kg) => sum + kg, 0)
  const farmsOwing = new Set(result.items.map(i => i.entityLabel)).size

  /**
   * The farm a matter belongs to.
   *
   * Taken from `farmProfileId` where the builder states it outright, otherwise
   * from `sourceEntityId`, otherwise from `destinationParams` — `farmId` for
   * farm-destined matters, `itemId` for batch-destined ones, a batch resolving
   * through inventory. Deliberately NOT parsed out of `entityLabel` — that is a
   * display string, and matching farms by their printed name is how the wrong
   * farm gets chased.
   *
   * Returns null when the matter cannot be tied to a farm on file. Those rows
   * cannot be selected, so the button's count can never overstate what will
   * actually be sent.
   */
  const farmIdFor = useMemo(() => {
    const batchToFarm = new Map((inventory ?? []).map(i => [i.id, i.farmId]))
    const known = new Map(farms.map(f => [f.id, f.tradingName || f.legalBusinessName || f.id]))
    return (item: OperationsDeskItem): { id: string; name: string } | null => {
      // Each queue carries its farm differently, and the first cut of this only
      // read destinationParams — which document matters do not have. Measured in
      // production: all 24 matters came back unchaseable, so the screen's one
      // primary action was dead on the day it shipped.
      //
      // Ordered most specific first. The builder's own answer wins where it has
      // one: a compliance matter's source is the ALERT, so no farm could ever be
      // derived from it and the whole category sat unselectable — the same dead
      // primary action as before, just for one queue instead of all of them.
      // sourceEntityType is the discriminator for the queues that carry their
      // farm in their source; destinationParams is a fallback for the rest.
      const bySource =
        item.sourceEntityType === 'farm'
          ? item.sourceEntityId
          // `${farm.id}:${requirement}` — the farm is the part before the colon.
          : item.sourceEntityType === 'document-requirement'
            ? item.sourceEntityId.split(':')[0]
            : item.sourceEntityType === 'inventory-batch'
              ? batchToFarm.get(item.sourceEntityId)
              : undefined

      const byParams = item.destinationParams?.farmId
        ?? (item.destinationParams?.itemId ? batchToFarm.get(item.destinationParams.itemId) : undefined)

      const id = item.farmProfileId ?? bySource ?? byParams
      // A resolved id that is not a farm we hold is not "a farm on file": the
      // chase would be written against something this console cannot show.
      if (!id || !known.has(id)) return null
      return { id, name: known.get(id) ?? item.entityLabel }
    }
  }, [farms, inventory])

  const unchaseable = useMemo(
    () => result.items.filter(i => farmIdFor(i) === null).length,
    [result.items, farmIdFor],
  )

  /** Grouped by farm, so one farm gets one message however many rows are ticked. */
  const chases = useMemo(() => {
    const byFarm = new Map<string, FarmChase>()
    for (const item of result.items) {
      if (!selected.has(item.id)) continue
      const farm = farmIdFor(item)
      if (!farm) continue
      const existing = byFarm.get(farm.id)
      if (existing) existing.missing.push(item.reason)
      else byFarm.set(farm.id, { farmProfileId: farm.id, farmName: farm.name, missing: [item.reason] })
    }
    return [...byFarm.values()]
  }, [result.items, selected, farmIdFor])

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <>
      <DeskHeader
        total={result.items.length}
        search={search}
        onSearch={setSearch}
        chaseCount={chases.length}
        chaseEnabled={chases.length > 0 && Boolean(onChaseFarms) && !busy}
        busy={busy}
        onChase={() => { onChaseFarms?.(chases); setSelected(new Set()) }}
      />

      {/* Selection can only include matters that resolve to a farm on file, so
          the button's count can never overstate what will be sent. Rows that do
          not resolve say so rather than looking merely unticked. */}
      {unchaseable > 0 && (
        <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--color-neutral-700)' }}>
          {unchaseable} {unchaseable === 1 ? 'matter is' : 'matters are'} not tied to a farm on
          file and cannot be chased from here. Open {unchaseable === 1 ? 'it' : 'them'} to see why.
        </p>
      )}

      {/* ── What the queue costs, in four numbers ───────────────────────────
          Backgrounds carry the meaning: terracotta needs a person, sage is
          cleared, plain neutral is a count with no opinion. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 18, marginTop: 32 }}>
        <Tile tone="accent" label="Needs a person" value={String(result.items.length)}
          note={`across ${farmsOwing} farm${farmsOwing === 1 ? '' : 's'}`} />
        <Tile tone="accent-soft" label={`Waiting over ${SLA_DAYS} days`} value={String(overdue)}
          note={overdue === 0 ? 'nothing has aged past the target' : 'these are the ones to open first'} />
        <Tile tone="sage" label="Stock held on paperwork" value={heldKg ? `${heldKg.toLocaleString()} kg` : '—'}
          note={heldKg ? 'released when the documents land' : 'no held stock is linked to a matter'} />
        {/* Not "0". A zero here is a healthy state and should say so. */}
        <Tile tone="neutral" label="Blocking alerts"
          value={alerts.length ? String(alerts.length) : 'None'}
          note={alerts.length ? 'compliance rules are stopping work' : 'no rule is stopping work today'} />
      </div>

      {/* Source states, said plainly and separately: which one is missing
          changes what the operator should do about it. */}
      {failureCount > 0 && (
        <div role="status" style={NOTICE_ACCENT}>
          <strong>This view is incomplete.</strong>{' '}
          {farmInventoryFailed
            ? 'Farm and inventory data could not be loaded — most matters are not represented below.'
            : 'A source failed to load, so some matters are missing.'}
        </div>
      )}
      {farmInventoryLoading && <p role="status" style={NOTICE_MUTED}>Loading farm and inventory matters…</p>}
      {reviewRequestsLoading && <p role="status" style={NOTICE_MUTED}>Loading follow-up requests…</p>}
      {complianceLoading && <p role="status" style={NOTICE_MUTED}>Loading compliance matters…</p>}

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
            {EMPTY_MESSAGE[emptyState]}
          </p>
        )}

        {visible.map(item => (
          <MatterRow
            key={item.id}
            item={item}
            farm={farmIdFor(item)}
            blockedKg={blockedKg.get(item.id)}
            overdue={(item.ageInDays ?? 0) > SLA_DAYS}
            selected={selected.has(item.id)}
            onToggle={() => toggle(item.id)}
            onOpen={() => onOpen(item)}
          />
        ))}

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


function Tile({ tone, label, value, note }: {
  tone: keyof typeof TONES; label: string; value: string; note: string
}) {
  const tone_ = TONES[tone]
  return (
    <div style={{
      background: tone_.bg, borderRadius: 'var(--radius-md)', padding: '24px 26px',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: tone_.label }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 40, lineHeight: 1.1, margin: '10px 0 6px', color: tone_.value }}>
        {value}
      </div>
      {/* Never a bare number: a count with no sentence is a number the reader
          has to interpret, and they will each interpret it differently. */}
      <div style={{ fontSize: 13.5, color: tone_.note }}>{note}</div>
    </div>
  )
}
