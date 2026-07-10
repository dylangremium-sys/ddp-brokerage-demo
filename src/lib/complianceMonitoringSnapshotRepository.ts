import type { MonitoringBaseline } from './complianceMonitoringSnapshot'

// Storage-agnostic contract for persisting manual-monitoring technical
// baselines. The UI and domain layers depend only on this narrow interface —
// they must never import a concrete storage mechanism directly. A
// Supabase-backed implementation could be added later purely by writing a new
// file that satisfies this interface (that would be a separate phase, since it
// requires a table + migration); no call-site logic would need to change.
//
// The interface is deliberately narrow: read the current baseline, append a
// new baseline (preserving prior ones as history), and list history. There is
// no generic/arbitrary write, no delete, and no update-in-place — a new
// baseline is always an append, so history is never silently lost.
export interface MonitoringSnapshotRepository {
  /** The most recent (current) baseline for a source, or null if none. */
  getCurrentBaseline(sourceId: string): MonitoringBaseline | null
  /** Append a baseline as the new current one; prior baselines are retained. */
  saveBaseline(baseline: MonitoringBaseline): void
  /** All baselines for a source, newest first. */
  listBaselineHistory(sourceId: string): MonitoringBaseline[]
}
