import type { Page } from '../types'

/**
 * Load-state rules for the Operations overview.
 *
 * These are pure so the false-absence guarantees are provable in tests. The
 * defect class they close: the Overview presented values derived from data that
 * had never arrived — "Missing evidence: 0" while the inventory read was still
 * in flight, "No batches on file" when the query had actually failed, and
 * "No unresolved alerts" when the compliance fetch had never been triggered.
 *
 * The single rule behind every function here: an unresolved or failed query is
 * not a zero. A count may only be reported once every source it derives from
 * has completed successfully.
 */

/** Lifecycle of one independently-loaded data source. */
export type SourceLoadState =
  /** Not started. Nothing is known. */
  | 'idle'
  /** In flight. Nothing is known yet. */
  | 'loading'
  /** Completed successfully. Values derived from it are authoritative. */
  | 'loaded'
  /** Failed. Nothing is known. */
  | 'error'
  /** No such source exists in this mode. Settled, but contributes nothing. */
  | 'unavailable'

/** Retained name — compliance is one source among several. */
export type ComplianceLoadState = SourceLoadState

/**
 * Whether a page's presentation consumes compliance rules/alerts.
 *
 * Takes the Supply Ledger page list as an argument rather than duplicating it,
 * so this rule cannot drift from the router's own list.
 */
export function shouldLoadComplianceData(
  page: Page,
  supplyLedgerPages: readonly Page[],
): boolean {
  // The Operations overview renders Compliance signals and a Blocked decisions
  // measure, so it needs this data on direct entry — an operator must not have
  // to visit a Supply Ledger page first to see unresolved items.
  if (page === 'ddp-overview') return true
  return supplyLedgerPages.includes(page)
}

/**
 * Resolve a measure drawn from several sources to a single state.
 *
 * A measure is only as trustworthy as its weakest source: any failure makes it
 * unreportable, and any pending source keeps it unresolved. 'unavailable' is
 * settled — a source that cannot exist here contributes nothing rather than
 * blocking the measure forever — but a measure whose every source is
 * unavailable is itself unavailable.
 */
export function combineLoadStates(...states: SourceLoadState[]): SourceLoadState {
  if (states.length === 0) return 'unavailable'
  if (states.some(s => s === 'error')) return 'error'
  if (states.some(s => s === 'idle' || s === 'loading')) return 'loading'
  return states.every(s => s === 'unavailable') ? 'unavailable' : 'loaded'
}

/**
 * A count that is only reportable once the data behind it actually arrived.
 * `known: false` means "we have not established this", never "zero".
 */
export type CountMeasure = { known: true; value: number } | { known: false }

export function deriveCountMeasure(
  state: SourceLoadState,
  value: number,
): CountMeasure {
  return state === 'loaded' ? { known: true, value } : { known: false }
}

/** What a data-backed panel is entitled to say. */
export type PanelMode =
  /** Query unresolved — no claim may be made. */
  | 'loading'
  /** Query failed — no claim may be made. */
  | 'error'
  /** No source exists here — no claim may be made. */
  | 'unavailable'
  /** Query resolved and returned nothing. A confirmed zero. */
  | 'empty'
  /** Query resolved and returned items. */
  | 'list'

export function derivePanelMode(
  state: SourceLoadState,
  itemCount: number,
): PanelMode {
  if (state === 'error') return 'error'
  if (state === 'unavailable') return 'unavailable'
  // 'idle' is not yet a query. It may never present as a confirmed zero.
  if (state === 'idle' || state === 'loading') return 'loading'
  return itemCount > 0 ? 'list' : 'empty'
}

/** Retained name for the Compliance signals call site. */
export const deriveSignalsPanelMode = derivePanelMode

/**
 * Copy. Only the *_EMPTY strings assert absence, and derivePanelMode returns
 * 'empty' exclusively after a successful fetch.
 */
export const SIGNALS_LOADING = 'Loading compliance signals…'
export const SIGNALS_ERROR = 'Compliance signals could not be loaded'
export const SIGNALS_UNAVAILABLE = 'Compliance signals unavailable in this mode.'
/** Caption when farm signals are listed but no compliance source exists. */
export const SIGNALS_UNAVAILABLE_NOTE = 'Compliance signals unavailable in this mode'
export const SIGNALS_EMPTY = 'No unresolved alerts or rules awaiting decision.'

export const SUPPLY_LOADING = 'Loading supply position…'
export const SUPPLY_ERROR = 'Supply position could not be loaded'
export const SUPPLY_UNAVAILABLE = 'Supply position is not available in this mode'
export const SUPPLY_EMPTY = 'No batches on file'

/** Placeholder for a measure whose data has not arrived. Never "0". */
export const MEASURE_UNKNOWN = '—'
/** Sub-label shown beneath an unreportable measure. */
export const MEASURE_PENDING_NOTE = 'Loading…'
export const MEASURE_ERROR_NOTE = 'Could not be confirmed'

export function formatCountMeasure(m: CountMeasure): string {
  return m.known ? String(m.value) : MEASURE_UNKNOWN
}

/** Truthful sub-label for a measure that cannot yet be reported. */
export function measureNote(state: SourceLoadState): string | null {
  if (state === 'loaded' || state === 'unavailable') return null
  if (state === 'error') return MEASURE_ERROR_NOTE
  return MEASURE_PENDING_NOTE
}
