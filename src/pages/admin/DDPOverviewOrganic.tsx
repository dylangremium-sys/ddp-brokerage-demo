import { useMemo } from 'react'
import { isFarmScored } from '../../data'
import { displayName, shortIdentifier, daysOpen } from '../../lib/entityName'
import type { FarmProfile, InventoryItem } from '../../types'
import '../../styles/overview.css'

/**
 * Overview — handoff screen 6, the console landing page.
 *
 * WHAT THIS REPLACES. Eight rigid tiles in which two different zeros were gold
 * and dark red, a 2 was green while another 2 was dark red, and every empty
 * table read "NO RECORDS ON FILE". The colour followed no rule, so it carried
 * no meaning; and "NO RECORDS ON FILE" cannot tell a clear queue apart from a
 * feed that failed.
 *
 * FOUR TILES, NOT EIGHT — and the four numbers the old strip carried that these
 * do not are still on the screen, in the queue below, where each one is a row
 * naming the farm or batch it belongs to. A count nobody can act on is a worse
 * summary than the list it summarises.
 *
 * COLOUR HAS ONE MEANING, and the page states its own rule in the subline
 * rather than leaving it to a style guide: terracotta means a named human must
 * decide or chase, sage means cleared, ink is a plain count. Nothing else is
 * tinted, and there is no fourth tint in overview.css.
 *
 * NOTHING HERE ASSERTS A SCORE. `isFarmScored` exists because nothing computes
 * scores for a real farm, so every Supabase-backed farm totals 0 — and a
 * "top-scored" list of unscored farms is a ranking of things that were never
 * ranked. The rail says so in words instead.
 */

interface Props {
  farms: FarmProfile[]
  inventory: InventoryItem[]
  onReviewFarm: (id: string) => void
  onReviewItem: (id: string) => void
  /** The desk is where the queue is worked; this page only points at it. */
  onOpenDesk: () => void
}

/**
 * The Operations Desk sets the age at which waiting becomes a problem, and it
 * reads the threshold from one constant so the tile label, the row colour and
 * the chase eligibility cannot disagree. This page colours a row's age by the
 * same number for the same reason.
 */
const SLA_DAYS = 3

/** Statuses that mean a named human still has to do something. */
const FARM_NEEDS_PERSON: ReadonlySet<string> = new Set([
  'Submitted to DDP', 'Under Review', 'More Information Required',
])
const BATCH_NEEDS_PERSON: ReadonlySet<string> = new Set([
  'Pending Review', 'Missing Document',
])

type QueueRow = {
  key: string
  title: string
  identifier?: string
  kind: 'farm' | 'batch'
  submittedAt: string
  action: string
  open: () => void
}

/** English plural without a library, and without "1 things". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The headline says the workload in words, because "6" alone does not say
 * whether six is a normal Tuesday or a problem.
 */
function headline(n: number): string {
  if (n === 0) return 'Nothing is waiting on a person'
  if (n === 1) return 'One thing is waiting on a person'
  return `${n} things are waiting on a person`
}

export default function DDPOverviewOrganic({
  farms, inventory, onReviewFarm, onReviewItem, onOpenDesk,
}: Props) {
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })

  const queue = useMemo<QueueRow[]>(() => {
    const farmRows: QueueRow[] = farms
      .filter(f => FARM_NEEDS_PERSON.has(f.status))
      .map(f => {
        const named = displayName(f.tradingName ?? '', 'Farm with no name on file', f.id)
        return {
          key: `farm-${f.id}`,
          title: named.name,
          // `identifier` is only set when the name is missing, which is the
          // only case this renders it — but the type does not know that.
          identifier: named.unnamed && named.identifier
            ? shortIdentifier(named.identifier)
            : undefined,
          kind: 'farm' as const,
          submittedAt: f.submittedAt,
          action: 'Review the farm →',
          open: () => onReviewFarm(f.id),
        }
      })

    const batchRows: QueueRow[] = inventory
      .filter(i => BATCH_NEEDS_PERSON.has(i.status))
      .map(i => ({
        key: `batch-${i.id}`,
        title: i.productName,
        kind: 'batch' as const,
        submittedAt: i.submittedAt,
        action: i.status === 'Missing Document' ? 'Request from farm →' : 'Review the batch →',
        open: () => onReviewItem(i.id),
      }))

    // Oldest first: the thing that has been waiting longest is the thing that
    // has been failed longest.
    return [...farmRows, ...batchRows]
      .sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
  }, [farms, inventory, onReviewFarm, onReviewItem])

  const heldKg = inventory
    .filter(i => i.status !== 'Approved')
    .reduce((sum, i) => sum + i.quantityKg, 0)
  const clearedKg = inventory
    .filter(i => i.status === 'Approved')
    .reduce((sum, i) => sum + i.quantityKg, 0)

  const scoredFarms = farms.filter(isFarmScored).length
  const shown = queue.slice(0, 6)

  return (
    <div className="ov">
      <header className="ov-head">
        <div>
          <div className="ov-eyebrow">{today}</div>
          <h1 className="ov-title">{headline(queue.length)}</h1>
          {/* The rule, on the screen it governs. */}
          <p className="ov-rule">
            Terracotta needs a decision, sage is cleared, ink is a plain count.
            Nothing else is tinted.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onOpenDesk}>
          Open the desk
        </button>
      </header>

      {/* ── Four tiles. Every note is plain language, never a bare number. ── */}
      <div className="ov-kpis">
        <div className={`ov-kpi ${queue.length > 0 ? 'is-person' : ''}`}>
          <div className="ov-kpi-label">Needs a person</div>
          <div className="ov-kpi-value">{queue.length}</div>
          <div className="ov-kpi-note">
            {queue.length === 0
              ? 'Nothing is waiting. This is the healthy state, not a missing feed.'
              : 'Farms and batches where someone must decide or chase.'}
          </div>
        </div>

        <div className={`ov-kpi ${heldKg > 0 ? 'is-held' : ''}`}>
          <div className="ov-kpi-label">Held on paperwork</div>
          <div className="ov-kpi-value">{heldKg.toLocaleString()} kg</div>
          <div className="ov-kpi-note">
            {heldKg === 0
              ? 'No stock is waiting on a document.'
              : 'Stock a buyer cannot see until its documents clear.'}
          </div>
        </div>

        <div className="ov-kpi is-cleared">
          <div className="ov-kpi-label">Cleared for buyers</div>
          <div className="ov-kpi-value">{clearedKg.toLocaleString()} kg</div>
          <div className="ov-kpi-note">
            {clearedKg === 0
              ? 'Nothing has cleared yet — stock appears here once its documents are accepted.'
              : 'Documented stock, visible to verified buyers.'}
          </div>
        </div>

        <div className="ov-kpi">
          <div className="ov-kpi-label">Registered farms</div>
          <div className="ov-kpi-value">{farms.length}</div>
          <div className="ov-kpi-note">
            {farms.length === 0
              ? 'No farm has completed registration yet.'
              : scoredFarms === 0
                ? 'None has been scored — scoring has not run for a real farm.'
                : `${count(scoredFarms, 'farm has', 'farms have')} been scored.`}
          </div>
        </div>
      </div>

      <div className="ov-body">
        {/* ── Oldest first ─────────────────────────────────────────────── */}
        <section className="ov-panel">
          <div className="ov-panel-head">
            <span className="ov-panel-title">Oldest first</span>
            <span className="ov-panel-meta">
              {queue.length > shown.length
                ? `Showing ${shown.length} of ${queue.length}`
                : count(queue.length, 'matter', 'matters')}
            </span>
          </div>

          {shown.length === 0 ? (
            <div style={{ padding: '24px 28px' }}>
              <div className="ov-empty-title">Nothing is waiting on a person</div>
              <p className="ov-empty-body" style={{ color: 'var(--color-neutral-700)' }}>
                Every farm and batch on file has been dealt with. This is the healthy
                state — if you expected something here, the feed is worth checking, not
                the queue.
              </p>
            </div>
          ) : shown.map(row => {
            const age = daysOpen(row.submittedAt)
            const overdue = typeof age === 'number' && age > SLA_DAYS
            return (
              <button type="button" key={row.key} className="ov-row" onClick={row.open}>
                <span>
                  <span className="ov-row-title">{row.title}</span>
                  {row.identifier && (
                    <span className="ov-row-meta" style={{ fontFamily: '"IBM Plex Mono", monospace' }}>
                      {row.identifier}
                    </span>
                  )}
                  <span className={`ov-row-meta${overdue ? ' is-overdue' : ''}`}>
                    {row.kind === 'farm' ? 'Farm' : 'Batch'}
                    {typeof age === 'number' && ` · waiting ${count(age, 'day', 'days')}`}
                  </span>
                </span>
                <span className="ov-row-action">{row.action}</span>
              </button>
            )
          })}
        </section>

        {/* ── Rail: states that explain themselves ─────────────────────── */}
        <aside className="ov-rail">
          {queue.length === 0 && (
            <div className="ov-empty is-healthy">
              <div className="ov-empty-title">Nothing awaiting review</div>
              <p className="ov-empty-body">
                The queue is clear. This is the healthy state, not a missing feed.
              </p>
              <button type="button" className="ov-empty-action" onClick={onOpenDesk}>
                Open the desk →
              </button>
            </div>
          )}

          {/*
            NOT "no data". Nothing in this product computes a score for a real
            farm, so a scored count of zero is a statement about the feature,
            not about the farms — and the old screen's "top-scored" table listed
            unscored farms at "0 / 900", which is a ranking of things that were
            never ranked.
          */}
          {scoredFarms === 0 && (
            <div className="ov-empty is-neutral">
              <div className="ov-empty-title">No farm profiles scored yet</div>
              <p className="ov-empty-body">
                Scoring has not run for any registered farm, so there is nothing to rank.
                {farms.length > 0 && ` ${count(farms.length, 'farm is', 'farms are')} registered.`}
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
