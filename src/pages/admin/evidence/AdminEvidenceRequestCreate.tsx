import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_EVIDENCE_REQUEST_PRIORITY,
  EVIDENCE_REQUEST_CATEGORY_LABELS,
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_PRIORITY_LABELS,
  EVIDENCE_REQUEST_TARGET_TYPES,
  EVIDENCE_REQUEST_TARGET_TYPE_LABELS,
  EVIDENCE_TEXT_LIMITS,
  categoriesForEvidenceTarget,
  isEvidenceCategoryAllowedForTarget,
  isTrimmedLengthWithin,
  type EvidenceRequestCategory,
  type EvidenceRequestPriority,
  type EvidenceRequestTargetType,
  type EvidenceServiceError,
} from '../../../domain/evidenceRequests'
import {
  createEvidenceRequest,
  listEvidenceTargetOptions,
  type EvidenceTargetOption,
} from '../../../lib/evidenceRequests'
import { runGuardedLoad } from '../../../lib/asyncLoadGuard'
import { useEvidenceScopeReset } from '../../../lib/useEvidenceScopeReset'

/**
 * Administrator create page (contract v1.5 §10.3).
 *
 * Rules enforced here:
 * - Target data loads from authoritative services; the page never invents one.
 * - Submit is DISABLED while the target list is unavailable, the form is
 *   invalid, or a mutation is pending — which is also what prevents duplicate
 *   clicks creating duplicate requests.
 * - Success navigates to the created request's detail page.
 * - Failure PRESERVES the typed content and shows a non-success state. Nothing
 *   the administrator wrote is discarded by a failed submit.
 *
 * Client validation mirrors §4.5 and §5.3 for usability. It is never
 * authoritative: `create_evidence_request` re-validates the category/target
 * matrix and re-derives `farm_id` from the target itself (§4.5, §6.2, §19.7).
 */

type TargetsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; options: EvidenceTargetOption[] }
  | { kind: 'failed'; error: EvidenceServiceError }

export default function AdminEvidenceRequestCreate({
  presetTargetType,
  presetTargetId,
  onCreated,
  onCancel,
}: {
  presetTargetType?: EvidenceRequestTargetType
  presetTargetId?: string
  onCreated: (requestId: string) => void
  onCancel: () => void
}) {
  const [targetType, setTargetType] = useState<EvidenceRequestTargetType>(
    presetTargetType ?? 'farm_profile',
  )
  const [targetId, setTargetId] = useState<string>(presetTargetId ?? '')
  const [category, setCategory] = useState<EvidenceRequestCategory | ''>('')
  const [title, setTitle] = useState('')
  const [explanation, setExplanation] = useState('')
  const [priority, setPriority] = useState<EvidenceRequestPriority>(
    DEFAULT_EVIDENCE_REQUEST_PRIORITY,
  )
  const [dueDate, setDueDate] = useState('')

  const [targets, setTargets] = useState<TargetsState>({ kind: 'loading' })
  const [pending, setPending] = useState(false)
  const [submitError, setSubmitError] = useState<EvidenceServiceError | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const activeTargetType = useRef(targetType)

  // Switching target type discards the previous type's options during render —
  // a farm-profile list must never be visible under an inventory-batch label.
  useEvidenceScopeReset(targetType, () => setTargets({ kind: 'loading' }))

  useEffect(() => {
    activeTargetType.current = targetType

    let isActive = true
    void runGuardedLoad(listEvidenceTargetOptions(targetType), () => isActive, {
      onSuccess: result => {
        if (activeTargetType.current !== targetType) return
        if (result.ok) setTargets({ kind: 'loaded', options: result.data })
        else setTargets({ kind: 'failed', error: result.error })
      },
      onError: () => {
        if (activeTargetType.current !== targetType) return
        setTargets({
          kind: 'failed',
          error: {
            code: 'DATA_UNAVAILABLE',
            message: 'Targets could not be loaded.',
            retryable: true,
          },
        })
      },
    })

    return () => {
      isActive = false
    }
  }, [targetType, reloadToken])

  const categories = useMemo(() => categoriesForEvidenceTarget(targetType), [targetType])

  // Changing the target type can invalidate the chosen category (§4.5). Rather
  // than storing a stale value and correcting it in an effect, the effective
  // category is DERIVED: a category not permitted for the current target type is
  // simply not selected, so an invalid pair can never be submitted or displayed.
  const effectiveCategory: EvidenceRequestCategory | '' =
    category !== '' && isEvidenceCategoryAllowedForTarget(category, targetType) ? category : ''

  const todayIso = new Date().toISOString().slice(0, 10)

  const titleValid = isTrimmedLengthWithin(title, EVIDENCE_TEXT_LIMITS.title)
  const explanationValid = isTrimmedLengthWithin(explanation, EVIDENCE_TEXT_LIMITS.explanation)
  // §3.2: a due date is optional and must not be earlier than the creation date.
  const dueDateValid = dueDate === '' || dueDate >= todayIso
  const targetsUsable = targets.kind === 'loaded' && targets.options.length > 0
  const formValid =
    targetsUsable && targetId !== '' && effectiveCategory !== '' && titleValid && explanationValid && dueDateValid

  const canSubmit = formValid && !pending

  async function submit() {
    // `canSubmit` implies `category !== ''` via `formValid`, which TypeScript
    // tracks through the aliased condition — so no redundant re-check is needed
    // and `category` is already narrowed to a real category below.
    if (!canSubmit) return
    setPending(true)
    setSubmitError(null)

    const result = await createEvidenceRequest({
      targetType,
      targetId,
      category: effectiveCategory,
      title: title.trim(),
      explanation: explanation.trim(),
      priority,
      dueDate: dueDate === '' ? null : dueDate,
    })

    setPending(false)
    if (result.ok) {
      onCreated(result.data.id)
      return
    }
    // Typed content is intentionally left untouched so nothing is lost.
    setSubmitError(result.error)
  }

  return (
    <div className="page-wrap ddp-wrap" style={{ maxWidth: 760 }}>
      <div className="page-header">
        <h1 className="page-title">Request evidence</h1>
        <p className="page-desc">
          Ask a farmer for a specific document or record. This creates a request for
          human review; it makes no compliance or approval finding.
        </p>
      </div>

      {targets.kind === 'loading' && (
        <div className="loading-panel" role="status">Loading targets…</div>
      )}

      {targets.kind === 'failed' && (
        <div className="error-panel" role="alert">
          <strong>Targets could not be loaded.</strong>
          <p>{targets.error.message}</p>
          <button className="btn btn-ghost" onClick={() => setReloadToken(t => t + 1)}>Retry</button>
        </div>
      )}

      {targets.kind === 'loaded' && targets.options.length === 0 && (
        <div className="empty-state-hero">
          <p className="empty-state-message">
            No {EVIDENCE_REQUEST_TARGET_TYPE_LABELS[targetType].toLowerCase()} records are
            available to request evidence against.
          </p>
        </div>
      )}

      <div className="form-grid">
        <label>
          <span className="dl">Target type</span>
          <select
            value={targetType}
            disabled={pending}
            onChange={e => {
              setTargetType(e.target.value as EvidenceRequestTargetType)
              setTargetId('')
            }}
          >
            {EVIDENCE_REQUEST_TARGET_TYPES.map(t => (
              <option key={t} value={t}>{EVIDENCE_REQUEST_TARGET_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </label>

        <label>
          <span className="dl">Target</span>
          <select
            value={targetId}
            disabled={pending || !targetsUsable}
            onChange={e => setTargetId(e.target.value)}
          >
            <option value="">Select a target…</option>
            {targets.kind === 'loaded' &&
              targets.options.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
          </select>
        </label>

        <label>
          <span className="dl">Category</span>
          <select
            value={effectiveCategory}
            disabled={pending}
            onChange={e => setCategory(e.target.value as EvidenceRequestCategory)}
          >
            <option value="">Select a category…</option>
            {categories.map(c => (
              <option key={c} value={c}>{EVIDENCE_REQUEST_CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </label>

        <label>
          <span className="dl">Priority</span>
          <select
            value={priority}
            disabled={pending}
            onChange={e => setPriority(e.target.value as EvidenceRequestPriority)}
          >
            {EVIDENCE_REQUEST_PRIORITIES.map(p => (
              <option key={p} value={p}>{EVIDENCE_REQUEST_PRIORITY_LABELS[p]}</option>
            ))}
          </select>
        </label>

        <label>
          <span className="dl">Title</span>
          <input
            type="text"
            value={title}
            disabled={pending}
            maxLength={EVIDENCE_TEXT_LIMITS.title.max}
            onChange={e => setTitle(e.target.value)}
          />
          {!titleValid && title !== '' && (
            <span className="text-missing">
              Between {EVIDENCE_TEXT_LIMITS.title.min} and {EVIDENCE_TEXT_LIMITS.title.max} characters.
            </span>
          )}
        </label>

        <label>
          <span className="dl">What the farmer must provide</span>
          <textarea
            rows={6}
            value={explanation}
            disabled={pending}
            maxLength={EVIDENCE_TEXT_LIMITS.explanation.max}
            onChange={e => setExplanation(e.target.value)}
          />
          {!explanationValid && explanation !== '' && (
            <span className="text-missing">
              Between {EVIDENCE_TEXT_LIMITS.explanation.min} and{' '}
              {EVIDENCE_TEXT_LIMITS.explanation.max} characters.
            </span>
          )}
        </label>

        <label>
          <span className="dl">Due date (optional)</span>
          <input
            type="date"
            value={dueDate}
            min={todayIso}
            disabled={pending}
            onChange={e => setDueDate(e.target.value)}
          />
          {!dueDateValid && (
            <span className="text-missing">A due date cannot be earlier than today.</span>
          )}
        </label>
      </div>

      {submitError && (
        <div className="error-panel" role="alert">
          <strong>The request was not created.</strong>
          <p>{submitError.message}</p>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
          {pending ? 'Creating…' : 'Create request'}
        </button>
        <button className="btn btn-ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
