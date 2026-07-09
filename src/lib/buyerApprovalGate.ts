// The single place that decides whether a buyer pack may claim "DDP Reviewed —
// Human Approved for Buyer Discussion". Absence of blocking issues is a
// necessary condition for disclosure, but it is NOT approval — a mechanical
// scan finding "nothing wrong" must never be presented as a human review
// outcome. The pack may only claim approval once a DDP staffer has recorded
// an explicit "progress" procurement decision against the batch. Absent that
// recorded decision, the pack must read as still pending a human call, even
// when no blockers are present.
//
// The label deliberately says "Human Approved for Buyer Discussion" rather
// than a bare "Approved" — the latter reads too easily as approval of the
// goods/export/legal status, not approval to proceed with a buyer
// conversation about DDP's own review pack.

export interface BuyerApprovalGateResult {
  isHumanApproved: boolean
  packStatusLabel: string
}

export function deriveBuyerApprovalGate(
  hasBlockingIssues: boolean,
  isProgressDecisionRecorded: boolean,
): BuyerApprovalGateResult {
  const isHumanApproved = !hasBlockingIssues && isProgressDecisionRecorded
  const packStatusLabel = hasBlockingIssues
    ? 'Decision Required'
    : isHumanApproved
      ? 'DDP Reviewed — Human Approved for Buyer Discussion'
      : 'No Blocking Issues Detected — Approval Required'
  return { isHumanApproved, packStatusLabel }
}
