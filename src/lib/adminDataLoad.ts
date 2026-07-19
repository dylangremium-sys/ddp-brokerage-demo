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
