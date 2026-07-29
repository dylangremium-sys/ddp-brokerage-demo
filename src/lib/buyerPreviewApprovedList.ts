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
