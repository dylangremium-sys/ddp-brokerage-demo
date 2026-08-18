/**
 * Decides what the Qualified Buyer Preview shows in place of its
 * "Human-Approved Available Inventory" table, so a still-loading or failed
 * authoritative read is never presented as a confirmed "nothing is approved".
 *
 * Listing a batch under that heading, next to the DDP Verified Supply Seal, is
 * itself a buyer-visible disclosure claim. The single-batch pack already fails
 * closed on source === 'unavailable' (DDPBuyerPreview.tsx:129-137); the list
 * read raw localStorage instead, so admin A's list still showed batch X as
 * approved after admin B recorded a hold. Same bar, same semantics, one contract.
 *
 * The state order mirrors resolveOperationsDeskEmptyState — failed before
 * loading before empty — and for the same reason: only ONE state may assert
 * that nothing is approved, and it is reachable only from a settled successful
 * read.
 *
 * Pure and DOM-free so the user-visible state is unit-testable.
 */
export type ApprovedListState =
  /** The authoritative read has not settled. Says nothing about approval yet. */
  | 'loading'
  /** The read failed. The approval state of every batch is UNKNOWN, not "none". */
  | 'unavailable'
  /** Settled, successful, and no batch cleared the bar. The only all-clear. */
  | 'none-approved'
  /** At least one batch is server-confirmed approved. */
  | 'has-approved'

export function resolveApprovedListState(input: {
  /** null while the batch resolve is in flight. */
  resolution: { unavailable: boolean } | null
  /** Batches that cleared the gate against the AUTHORITATIVE decision. */
  approvedCount: number
}): ApprovedListState {
  if (input.resolution === null) return 'loading'
  // Checked before approvedCount: on a failed read nothing may be approved
  // anyway, but stating the failure is what stops an operator reading a blank
  // table as "DDP has approved nothing".
  if (input.resolution.unavailable) return 'unavailable'
  if (input.approvedCount > 0) return 'has-approved'
  return 'none-approved'
}

/**
 * Folds EVERY authoritative read that gates the list into the single settled/
 * failed value `resolveApprovedListState` consumes.
 *
 * This exists because the previous inline fold was the bug. Rule enforcement was
 * added as a third gate on the `approved` array but never added here, so a failed
 * rule read produced zero approved batches AND a settled-successful gate — which
 * is precisely the 'none-approved' all-clear, the one state that may never be
 * reached from an unread source. The screen told operators "No batches are
 * currently human approved" on data it had failed to load.
 *
 * Taking the reads as a LIST rather than as named fields keeps THIS fold from
 * silently omitting one: a caller passes what gates the list, and every entry is
 * treated identically. It does NOT unify the two gates — the `approved` filter in
 * DDPBuyerPreview.tsx keeps its inline chain because it must narrow each read to
 * non-null for the filter body. Adding a fourth authoritative read therefore
 * still means editing BOTH, and the paired assertions in this module's tests are
 * what enforce that, not shared code.
 *
 * A null read is "not settled yet" and dominates — it must surface as 'loading',
 * never as a failure and never as an all-clear.
 */
export function resolveApprovedListGate(
  reads: ReadonlyArray<{ unavailable: boolean } | null>,
): { unavailable: boolean } | null {
  if (reads.some(read => read === null)) return null
  // `read?.` rather than a non-null assertion: the guard above already proves no
  // entry is null, and an assertion here would only trade that proof for a
  // runtime throw if the guard ever changed.
  return { unavailable: reads.some(read => read?.unavailable === true) }
}

/**
 * Whether a resolved decision may count as approval for the LIST.
 *
 * Deliberately identical to the single-batch pack's rule
 * (DDPBuyerPreview.tsx:129-132): a decision is usable only if it is 'progress',
 * carries a timestamp, and did NOT come from a failed read. 'local-cache' is
 * accepted here for the same reason it is there — it is reachable only when
 * migration 17 is genuinely absent, which is the documented pre-server
 * compatibility path, not a fallback from an error.
 */
export function isListApprovalDecision(resolved: {
  decision: string | null
  decidedAt: string | null
  source: string
} | undefined): boolean {
  if (!resolved) return false
  return resolved.decision === 'progress'
    && resolved.source !== 'unavailable'
    && !!resolved.decidedAt
}
