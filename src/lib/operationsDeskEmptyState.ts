/**
 * Decides what the Operations Desk shows when no matters are visible, so a
 * still-loading or failed source is never presented as a confirmed all-clear.
 *
 * Order matters:
 *  - `has-matters`   → there are rows; no empty-state message at all.
 *  - `failed`        → a source failed/was unavailable; never claim all-clear.
 *  - `loading`       → a source is still settling; never claim all-clear.
 *  - `filtered-empty`→ settled and empty, but the user's filters hid everything.
 *  - `all-clear`     → the ONLY state that asserts nothing is awaiting: all
 *                      required sources settled successfully and produced nothing.
 *
 * Pure and DOM-free so the user-visible state is unit-testable.
 */
export type OperationsDeskEmptyState =
  | 'has-matters'
  | 'failed'
  | 'loading'
  | 'filtered-empty'
  | 'all-clear'

export function resolveOperationsDeskEmptyState(input: {
  visibleCount: number
  failureCount: number
  hasPendingSources: boolean
  isFiltered: boolean
}): OperationsDeskEmptyState {
  if (input.visibleCount > 0) return 'has-matters'
  if (input.failureCount > 0) return 'failed'
  if (input.hasPendingSources) return 'loading'
  if (input.isFiltered) return 'filtered-empty'
  return 'all-clear'
}
