/**
 * Turns the two settled (allSettled) results of a coordinated admin farm/
 * inventory load into an explicit apply plan.
 *
 * A fulfilled dataset is SET (including a genuine empty array — distinct from a
 * rejection). A REJECTED dataset is CLEARED, not retained: once a load has
 * definitively failed, keeping the previous rows would let any admin page (Farm
 * Review, Inventory Review, …) silently reuse stale/prior-scope data, so the
 * shared array is emptied and its selected detail id dropped (fail closed). The
 * fulfilled half of a partial failure is preserved. The source is `ready` only
 * when BOTH succeed, else `failed`. Pure, so it is unit-testable.
 */
export type DatasetApply<T> = { kind: 'set'; value: T } | { kind: 'clear' }

export interface AdminDataApplyPlan<F, I> {
  farms: DatasetApply<F>
  inventory: DatasetApply<I>
  farmsAvailable: boolean
  inventoryAvailable: boolean
  clearFarmDetail: boolean
  clearItemDetail: boolean
  state: 'ready' | 'failed'
}

export function resolveAdminDataApply<F, I>(
  farmsResult: PromiseSettledResult<F>,
  inventoryResult: PromiseSettledResult<I>,
): AdminDataApplyPlan<F, I> {
  const farmsOk = farmsResult.status === 'fulfilled'
  const inventoryOk = inventoryResult.status === 'fulfilled'
  return {
    farms: farmsOk ? { kind: 'set', value: farmsResult.value } : { kind: 'clear' },
    inventory: inventoryOk ? { kind: 'set', value: inventoryResult.value } : { kind: 'clear' },
    farmsAvailable: farmsOk,
    inventoryAvailable: inventoryOk,
    // Drop the selected detail id whose backing dataset was cleared, so an
    // already-open Farm/Inventory Review fails closed instead of showing a stale
    // record.
    clearFarmDetail: !farmsOk,
    clearItemDetail: !inventoryOk,
    state: farmsOk && inventoryOk ? 'ready' : 'failed',
  }
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
): { farms: F[]; inventory: I[] | null } {
  if (isDemo) return { farms, inventory }
  return {
    // Farms: [] when unavailable — an empty farm list simply yields no farm
    // matters (no false positives). Inventory: null when unavailable — distinct
    // from a genuine [] so the desk never treats it as "no batches" and fabricates
    // document gaps; only a fulfilled inventory load reaches the desk as an array.
    farms: farmsFresh ? farms : [],
    inventory: inventoryFresh ? inventory : null,
  }
}
