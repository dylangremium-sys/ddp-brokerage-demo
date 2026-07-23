/**
 * Operations Desk adapter for evidence requests.
 *
 * Contract of record: v1.5 §11. The desk is READ-ONLY, AGGREGATION-ONLY and
 * NAVIGATION-ONLY (§11.1). This module produces rows and an order; it exposes no
 * mutation of any kind, and the row's only action is a navigation to
 * `admin-evidence-request-detail`, the authoritative page that owns the decision.
 *
 * Three rules are load-bearing:
 *
 * - §11.2 Only `open`, `clarification_requested` and `farmer_submitted` appear.
 *   Terminal requests are excluded here and remain in the administrator archive.
 * - §11.4 A request whose target could not be resolved KEEPS ITS ROW, labelled
 *   "Target unavailable — human review required", and its action still opens the
 *   detail page. It is never dropped, because dropping it would hide work.
 * - §11.6 Ordering is Urgent overdue, Urgent, High overdue, High, Normal
 *   overdue, Normal, Low overdue, Low; oldest `status_changed_at` first within a
 *   group. That is expressed as `secondaryRank` below.
 */

import {
  EVIDENCE_REQUEST_CATEGORY_LABELS,
  EVIDENCE_REQUEST_STATUS_LABELS,
  TARGET_UNAVAILABLE_LABEL,
  isActiveEvidenceRequestStatus,
  isEvidenceRequestOverdue,
  type EvidenceRequestListItem,
  type EvidenceRequestPriority,
} from '../domain/evidenceRequests'
import type { OperationsDeskItem } from './operationsDesk'
import type { OperationsDeskPriority } from './operationsDeskPriority'

/**
 * §11.6 group index, 0 (first) to 7 (last).
 *
 * The request's own four-value priority is authoritative here; `overdue` is a
 * derived display condition only and never changes status (§3.2).
 */
export function evidenceDeskGroupIndex(
  priority: EvidenceRequestPriority,
  overdue: boolean,
): number {
  const base: Record<EvidenceRequestPriority, number> = { urgent: 0, high: 2, normal: 4, low: 6 }
  return base[priority] + (overdue ? 0 : 1)
}

/**
 * Projects the request's four-value priority onto the desk's existing
 * three-value display priority. This is a PRESENTATION projection for the shared
 * priority column and the desk's coarse grouping; the exact §11.6 order is
 * preserved independently by `secondaryRank`, so nothing is lost.
 *
 * The mapping is monotonic — a higher request priority never projects to a lower
 * desk priority — so the coarse bucket can never contradict the fine order.
 */
export function evidenceDeskPriority(priority: EvidenceRequestPriority): OperationsDeskPriority {
  switch (priority) {
    case 'urgent':
      return 'critical'
    case 'high':
      return 'high'
    default:
      return 'normal'
  }
}

function ageInDays(fromIso: string, now: Date): number | undefined {
  const then = new Date(fromIso).getTime()
  if (Number.isNaN(then)) return undefined
  const diff = now.getTime() - then
  return diff < 0 ? 0 : Math.floor(diff / 86_400_000)
}

/**
 * Builds the desk rows. Terminal requests are filtered out per §11.2 — this is
 * the ONLY filtering performed, and it is a contract requirement, not a
 * visibility decision: a target-unavailable row always survives.
 */
export function buildEvidenceRequestDeskItems(
  requests: EvidenceRequestListItem[],
  now: Date,
): OperationsDeskItem[] {
  return requests
    .filter(request => isActiveEvidenceRequestStatus(request.status))
    .map(request => {
      const overdue = isEvidenceRequestOverdue(request, now)
      const statusLabel = EVIDENCE_REQUEST_STATUS_LABELS[request.status]
      const targetLabel = request.targetAvailable
        ? (request.targetLabel ?? TARGET_UNAVAILABLE_LABEL)
        : TARGET_UNAVAILABLE_LABEL

      return {
        // Deterministic and stable, and namespaced so it can never collide with
        // another queue's id.
        id: `evidence-request:${request.id}`,
        category: 'evidence-request' as const,
        priority: evidenceDeskPriority(request.priority),
        secondaryRank: evidenceDeskGroupIndex(request.priority, overdue),
        title: request.title,
        entityLabel: targetLabel,
        // Factual only: what state the request is in and what it concerns. No
        // compliance, approval or export conclusion is stated or implied (§2.3).
        reason:
          `${EVIDENCE_REQUEST_CATEGORY_LABELS[request.category]} evidence requested. ` +
          `${statusLabel}.${overdue ? ' Past its due date.' : ''}`,
        // §11.3: age is measured from status_changed_at, not created_at.
        occurredAt: request.statusChangedAt,
        ageInDays: ageInDays(request.statusChangedAt, now),
        statusLabel,
        destinationPage: 'admin-evidence-request-detail' as const,
        destinationParams: { requestId: request.id },
        actionLabel: 'Open request',
        sourceEntityType: 'evidence-request',
        sourceEntityId: request.id,
      }
    })
}
