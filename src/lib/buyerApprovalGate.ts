// The single place that decides whether a buyer pack may claim "DDP Reviewed —
// Approved for Buyer Disclosure". Absence of blocking issues is a necessary
// condition for disclosure, but it is NOT approval — a mechanical scan
// finding "nothing wrong" must never be presented as a human review outcome.
// The pack may only claim approval once a DDP staffer has recorded an
// explicit "progress" procurement decision against the batch. Absent that
// recorded decision, the pack must read as still pending a human call, even
// when no blockers are present.

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
      ? 'DDP Reviewed — Approved for Buyer Disclosure'
      : 'No Blocking Issues Detected — Approval Required'
  return { isHumanApproved, packStatusLabel }
}
