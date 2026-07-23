import {
  EVIDENCE_REQUEST_STATUS_LABELS,
  EVIDENCE_RESPONSE_STATE_LABELS,
  isActiveEvidenceAttachment,
  type EvidenceAttachment,
  type EvidenceRequestDetail,
  type EvidenceRequestHistoryEvent,
  type EvidenceResponse,
} from '../../domain/evidenceRequests'

/**
 * Read-only rendering of an evidence request's response history, its evidence,
 * and its audit trail. Shared by the administrator and farmer detail pages so
 * both show the SAME facts from the same authoritative data.
 *
 * Contract points enforced by this component:
 * - §6.3/§6.4 Submitted responses and their attachments are immutable and stay
 *   visible after clarification, rejection, resolution or cancellation. Nothing
 *   here offers an edit or delete control.
 * - §7.8/§7.9 A tombstoned upload (`removalRequestedAt` set) is NOT evidence and
 *   is not listed as evidence.
 * - §12.4 History is append-only; it is displayed, never edited.
 * - §2.3 Every string states a workflow or evidence state. No label asserts
 *   compliance, verification, approval, certification or export readiness.
 */

const EVENT_LABELS: Record<EvidenceRequestHistoryEvent['eventType'], string> = {
  request_created: 'Request created',
  response_submitted: 'Farmer submitted a response',
  clarification_requested: 'Clarification requested',
  request_resolved: 'Reviewed and resolved',
  response_rejected: 'Evidence rejected',
  request_cancelled: 'Request cancelled',
  attachment_uploaded: 'Evidence uploaded',
  existing_document_linked: 'Existing document linked',
  draft_ownership_transferred: 'Draft edit authority transferred',
}

const ORIGIN_LABELS: Record<EvidenceAttachment['origin'], string> = {
  request_upload: 'Uploaded for this request',
  existing_farm_document: 'Linked farm document',
  existing_inventory_document: 'Linked inventory document',
}

function formatSize(bytes: number | null): string {
  // A linked existing document genuinely has no recorded size (§6.9(a)); an
  // invented number would be fabricated data, so it is shown as unknown.
  if (bytes === null) return 'Size not recorded'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function EvidenceAttachmentList({
  attachments,
  onOpen,
}: {
  attachments: EvidenceAttachment[]
  onOpen?: (attachment: EvidenceAttachment) => void
}) {
  const evidence = attachments.filter(isActiveEvidenceAttachment)

  if (evidence.length === 0) {
    return <p className="text-muted">No evidence attached to this response.</p>
  }

  return (
    <ul className="evidence-attachment-list">
      {evidence.map(attachment => (
        <li key={attachment.id}>
          <span className="dv">{attachment.originalFilename}</span>{' '}
          <span className="text-muted">
            — {ORIGIN_LABELS[attachment.origin]}, {attachment.mimeType},{' '}
            {formatSize(attachment.sizeBytes)}
          </span>
          {onOpen && attachment.origin === 'request_upload' && (
            <button className="btn btn-ghost" onClick={() => onOpen(attachment)}>
              Open
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export function EvidenceResponseCard({
  response,
  attachments,
  onOpenAttachment,
}: {
  response: EvidenceResponse
  attachments: EvidenceAttachment[]
  onOpenAttachment?: (attachment: EvidenceAttachment) => void
}) {
  const mine = attachments.filter(a => a.responseId === response.id)
  return (
    <section className="evidence-response-card">
      <h3>
        Response {response.responseNumber} —{' '}
        {EVIDENCE_RESPONSE_STATE_LABELS[response.state]}
      </h3>
      {response.submittedAt && (
        <p className="text-muted">Submitted {new Date(response.submittedAt).toLocaleString()}</p>
      )}
      {response.responseText
        ? <p className="dv">{response.responseText}</p>
        : <p className="text-muted">No response text was provided.</p>}
      <EvidenceAttachmentList attachments={mine} onOpen={onOpenAttachment} />
    </section>
  )
}

export function EvidenceHistoryList({ history }: { history: EvidenceRequestHistoryEvent[] }) {
  if (history.length === 0) {
    return <p className="text-muted">No history has been recorded for this request.</p>
  }
  return (
    <ol className="evidence-history-list">
      {history.map(event => (
        <li key={event.id}>
          <span className="dv">{EVENT_LABELS[event.eventType]}</span>{' '}
          <span className="text-muted">
            — {new Date(event.createdAt).toLocaleString()},{' '}
            {event.actorRole === 'ddp_admin' ? 'DDP administrator' : 'Farmer'}
            {event.previousStatus
              ? `, ${EVIDENCE_REQUEST_STATUS_LABELS[event.previousStatus]} → ${EVIDENCE_REQUEST_STATUS_LABELS[event.nextStatus]}`
              : `, ${EVIDENCE_REQUEST_STATUS_LABELS[event.nextStatus]}`}
          </span>
          {event.note && <p className="dv">{event.note}</p>}
        </li>
      ))}
    </ol>
  )
}

/**
 * The submitted responses, newest last, with their evidence. Drafts are excluded
 * — a draft is not submitted evidence and must not be presented as reviewed
 * material (§3 `draft`: "not visible as reviewed evidence").
 */
export function EvidenceSubmittedThread({
  detail,
  onOpenAttachment,
}: {
  detail: EvidenceRequestDetail
  onOpenAttachment?: (attachment: EvidenceAttachment) => void
}) {
  const submitted = detail.responses.filter(r => r.state === 'submitted')
  if (submitted.length === 0) {
    return <p className="text-muted">The farmer has not submitted a response yet.</p>
  }
  return (
    <>
      {submitted.map(response => (
        <EvidenceResponseCard
          key={response.id}
          response={response}
          attachments={detail.attachments}
          onOpenAttachment={onOpenAttachment}
        />
      ))}
    </>
  )
}
