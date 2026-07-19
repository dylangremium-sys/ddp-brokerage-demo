/**
 * Resolves the outcome of the coordinated admin farm/inventory load from the two
 * settled (allSettled) results.
 *
 * Applies whichever dataset succeeded — a transient or RLS failure in one table
 * must not discard the good half (Supabase mode starts these arrays empty, so
 * discarding a success blanks otherwise-usable admin pages) — while marking the
 * source `failed` unless BOTH succeeded, so the Operations Desk still reports the
 * gap and never shows an all-clear. A value is present only when its load was
 * fulfilled; a fulfilled empty array is a legitimate value, distinct from an
 * absent (rejected) one. Pure, so it is unit-testable.
 */
export interface AdminDataLoadOutcome<F, I> {
  farms?: F
  inventory?: I
  state: 'ready' | 'failed'
}

export function resolveAdminDataLoad<F, I>(
  farmsResult: PromiseSettledResult<F>,
  inventoryResult: PromiseSettledResult<I>,
): AdminDataLoadOutcome<F, I> {
  const bothOk = farmsResult.status === 'fulfilled' && inventoryResult.status === 'fulfilled'
  const outcome: AdminDataLoadOutcome<F, I> = { state: bothOk ? 'ready' : 'failed' }
  if (farmsResult.status === 'fulfilled') outcome.farms = farmsResult.value
  if (inventoryResult.status === 'fulfilled') outcome.inventory = inventoryResult.value
  return outcome
}

/**
 * The farm/inventory arrays the Operations Desk (and its rule-derived compliance
 * calculation) may safely consume, given per-dataset freshness for the CURRENT
 * admin load. Only data the current load actually fulfilled reaches the desk, so
 * a stale farmer-scoped subset lingering in the shared App arrays (the farmer
 * loader merges rather than clears) can never build queue rows or alerts while a
 * load is idle/loading, and a rejected dataset never leaks its retained prior
 * rows. Demo mode passes its settled seeded data through unchanged. This is a
 * projection for the desk only — the shared App arrays are untouched, so other
 * admin pages keep any retained rows. Pure, so it is unit-testable.
 */
export function deskAdminDataView<F, I>(
  isDemo: boolean,
  farms: F[],
  inventory: I[],
  farmsFresh: boolean,
  inventoryFresh: boolean,
): { farms: F[]; inventory: I[] } {
  if (isDemo) return { farms, inventory }
  return {
    farms: farmsFresh ? farms : [],
    inventory: inventoryFresh ? inventory : [],
  }
}
