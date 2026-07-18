// Single client-side policy for whether a Buyer Pack may emit BUYER-FACING
// output — in-app Print, browser Print/PDF, and Copy Summary.
//
// It consumes the already-derived authoritative eligibility result
// (`isHumanApproved`, from `deriveBuyerApprovalGate` via
// `computeBuyerDisclosureStatus` = zero blocking issues AND a recorded
// "progress" procurement decision) and adds NO independent reconstruction of
// blockers, decisions, requirements, risks, or inventory status. Inventory
// `status === 'Approved'` is NOT buyer-pack approval and is deliberately not an
// input here.
//
// Scope: this governs only browser OUTPUT. The internal Buyer Pack review screen
// stays visible to an authenticated DDP administrator (blockers must be
// inspectable), and server-authoritative immutable snapshot issuance is gated
// separately (UI disabled + prepareBuyerPackSnapshotInput + createBuyerPackSnapshot
// + the issue RPC) and is intentionally unchanged by this policy.

/** True only when the pack is human-approved for buyer discussion. */
export function canEmitBuyerPackOutput(isHumanApproved: boolean): boolean {
  return isHumanApproved === true
}

/** Heading for the print-only blocking document and the on-screen blocked note. */
export const BUYER_PACK_OUTPUT_BLOCKED_TITLE = 'NOT APPROVED — MUST NOT BE ISSUED TO A BUYER'

/** Shared safe wording used for BOTH the on-screen note and the print-only notice. */
export const BUYER_PACK_OUTPUT_BLOCKED_DETAIL =
  'This batch is not human-approved for buyer discussion. Buyer-facing output (print, PDF, and copy) is blocked ' +
  'until all blocking issues are cleared and a DDP staffer records a "Progress" procurement decision.'
