/**
 * Whether a compliance refetch has just become imminent — i.e. the {profile,
 * page} the compliance load state currently reflects differs from the active
 * one. Used by the App during render to move the load state to 'loading' before
 * the fetch effect re-runs, so the Operations Desk never shows a stale 'ready'
 * snapshot as an all-clear while a refetch is in flight.
 *
 * `profile` is compared by reference (identity), mirroring the effect's
 * currentProfile dependency, so a token refresh (a new profile object for the
 * same user) counts as a fresh fetch. Pure, so it is unit-testable.
 */
export interface ComplianceFetchTrigger {
  profile: unknown
  page: string
}

export function complianceRefetchStarted(
  reflected: ComplianceFetchTrigger | null,
  active: ComplianceFetchTrigger,
): boolean {
  return (
    reflected === null ||
    reflected.profile !== active.profile ||
    reflected.page !== active.page
  )
}
