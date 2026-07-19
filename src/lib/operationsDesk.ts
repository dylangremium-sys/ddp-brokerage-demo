import type {
  ComplianceAlert,
  DocumentRequirementType,
  FarmProfile,
  InventoryItem,
  Page,
  ReviewRequest,
} from '../types'
import {
  applyRequirementOverrides,
  applyRiskOverrides,
  deriveAutoRisks,
  deriveCoaIntelligence,
  deriveFarmDocumentRequirements,
  DOCUMENT_REQUIREMENT_LABELS,
} from './procurementControl'

/**
 * Document requirements derived ENTIRELY from FarmProfile fields — safe to show
 * even when the inventory source is unavailable. A fail-closed whitelist: any
 * requirement type not listed here is treated as inventory/batch-dependent and
 * suppressed while inventory is unavailable, so a future requirement type is
 * hidden by default until it is deliberately classified as farm-only.
 */
const FARM_ONLY_REQUIREMENT_TYPES: ReadonlySet<DocumentRequirementType> = new Set<DocumentRequirementType>([
  'farm_identity',
  'farm_license',
  'gacp_evidence',
  'gmp_evidence',
  'export_readiness_docs',
  'responsible_contact',
])
import { farmForItem } from './complianceEvidence'
import {
  classifyOperationsDeskPriority,
  type OperationsDeskPriority,
} from './operationsDeskPriority'

/**
 * Operations Desk — read-only aggregation.
 *
 * This module builds a PRESENTATION PROJECTION over records that already
 * exist. It is not a source of truth and holds no authority:
 *
 *  - it never writes, and exposes no mutation path;
 *  - every inclusion condition is read from an existing authoritative
 *    derivation (procurementControl, complianceEvidence) or from a persisted
 *    status field — never re-implemented and never inferred from a rendered
 *    label or CSS class;
 *  - every item points back at the authoritative page where the matter is
 *    actually resolved.
 *
 * DELIBERATELY NOT IMPLEMENTED — Buyer Pack blockers (see OperationsDesk docs):
 * the authoritative blocking-issues half of the Buyer Pack gate lives in
 * computeBuyerDisclosureStatus, which is module-private inside
 * pages/admin/DDPBuyerPreview.tsx. Re-deriving it here would create a second,
 * weaker copy of the release gate, so that queue is omitted rather than
 * approximated. See buyerApprovalGate.ts and 23_BUYER_PACK_SERVER_
 * AUTHORITATIVE_ISSUANCE.sql for the real gate.
 *
 * DELIBERATELY NOT IMPLEMENTED — "document approaching expiry": no
 * expiry-window rule exists anywhere in this codebase, so any warning
 * threshold would be invented here. Only states existing logic already
 * treats as actionable (`missing`, `expired`, `rejected`) are queued.
 */

export type OperationsDeskCategory =
  | 'farmer-approval'
  | 'onboarding'
  | 'document'
  | 'coa'
  | 'inventory-review'
  | 'compliance'
  | 'follow-up'

export const OPERATIONS_DESK_CATEGORIES: OperationsDeskCategory[] = [
  'farmer-approval',
  'onboarding',
  'document',
  'coa',
  'inventory-review',
  'compliance',
  'follow-up',
]

export const CATEGORY_LABEL: Record<OperationsDeskCategory, string> = {
  'farmer-approval': 'Farmer approval',
  onboarding: 'Onboarding',
  document: 'Documents',
  coa: 'COA',
  'inventory-review': 'Inventory review',
  compliance: 'Compliance review',
  'follow-up': 'Follow-up',
}

export interface OperationsDeskItem {
  /** Deterministic and stable across renders — also the dedup key. */
  id: string
  category: OperationsDeskCategory
  priority: OperationsDeskPriority
  title: string
  entityLabel: string
  /** Plain-language explanation of why this is in the queue. */
  reason: string
  /** Factual timestamp already recorded on the source record, when one exists. */
  occurredAt?: string
  ageInDays?: number
  statusLabel: string
  /** The authoritative page where this matter is actually resolved. */
  destinationPage: Page
  destinationParams?: Record<string, string>
  actionLabel: string
  sourceEntityType: string
  sourceEntityId: string
}

/** A queue that could not be built, or a source that could not be loaded. */
export interface OperationsDeskFailure {
  category: OperationsDeskCategory
  message: string
}

export interface OperationsDeskResult {
  items: OperationsDeskItem[]
  /**
   * Non-empty means the desk is showing an INCOMPLETE picture. The UI must
   * say so — an empty queue with failures is never an "all clear".
   */
  failures: OperationsDeskFailure[]
}

export interface OperationsDeskInput {
  farms: FarmProfile[]
  /**
   * `null` means the inventory source is unavailable (the current admin load did
   * not fulfil it) — distinct from `[]`, which means loaded and genuinely empty.
   * Never collapse the two: a null inventory must not be read as proof a farm has
   * no batches, or the document queue emits false batch-dependent gaps.
   */
  inventory: InventoryItem[] | null
  /**
   * `null` means the review-request source could not be loaded — distinct from
   * `[]`, which means loaded and genuinely empty. Never collapse the two: an
   * admin whose request fetch failed must not be shown "no open requests".
   */
  reviewRequests: ReviewRequest[] | null
  /**
   * `null` means the compliance source could not be loaded (or was not
   * available in this mode) — distinct from `[]`, which means loaded and
   * genuinely empty. Never collapse the two.
   */
  complianceAlerts: ComplianceAlert[] | null
  /** Injected so ordering and age are deterministic under test. */
  now?: Date
}

/** Farm statuses that represent a matter sitting with DDP for a decision. */
const AWAITING_DDP_REVIEW: ReadonlySet<string> = new Set<string>(['Submitted to DDP', 'Under Review'])

/** Evidence states existing logic already treats as actionable. */
const ACTIONABLE_EVIDENCE: ReadonlySet<string> = new Set<string>(['missing', 'expired', 'rejected'])

/** Compliance alert states that still require a human. */
const UNRESOLVED_ALERT: ReadonlySet<string> = new Set<string>(['open', 'in_review', 'blocked'])

function farmLabel(farm: FarmProfile): string {
  return farm.tradingName || farm.legalBusinessName || farm.id
}

function daysBetween(fromIso: string | undefined, now: Date): number | undefined {
  if (!fromIso) return undefined
  const then = new Date(fromIso).getTime()
  if (Number.isNaN(then)) return undefined
  const diff = now.getTime() - then
  if (diff < 0) return 0
  return Math.floor(diff / 86_400_000)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Runs one queue builder in isolation. A queue that throws degrades to a
 * visible failure rather than taking the whole desk down or, worse, silently
 * reporting nothing to review.
 */
function safeQueue(
  category: OperationsDeskCategory,
  build: () => OperationsDeskItem[],
  into: OperationsDeskItem[],
  failures: OperationsDeskFailure[],
): void {
  try {
    into.push(...build())
  } catch (err) {
    failures.push({ category, message: message(err) })
  }
}

export function buildOperationsDeskItems(input: OperationsDeskInput): OperationsDeskResult {
  const now = input.now ?? new Date()
  const farms = input.farms ?? []
  // `null` = inventory unavailable (current admin load did not fulfil it). Keep
  // that distinct from a genuine [] — inventory-dependent derivations must not
  // treat unavailable as "the farm has no batches". Normalize only for iteration.
  const inventoryAvailable = input.inventory !== null
  const inventory = input.inventory ?? []

  const collected: OperationsDeskItem[] = []
  const failures: OperationsDeskFailure[] = []

  // ── 10.1 Farmer approvals ────────────────────────────────────────────────
  // Source: persisted FarmProfile.status. 'Submitted to DDP' and 'Under Review'
  // are the two states of the existing FarmStatus vocabulary that denote a
  // matter sitting with DDP. No new threshold is introduced.
  safeQueue('farmer-approval', () =>
    farms
      .filter(farm => AWAITING_DDP_REVIEW.has(farm.status))
      .map(farm => ({
        id: `farmer-approval:farm:${farm.id}`,
        category: 'farmer-approval' as const,
        priority: classifyOperationsDeskPriority({ awaitingHumanReview: true }),
        title: farm.status === 'Under Review' ? 'Farm review in progress' : 'Farm submitted for DDP review',
        entityLabel: farmLabel(farm),
        reason:
          farm.status === 'Under Review'
            ? 'Farm review has been opened and no outcome has been recorded yet.'
            : 'Farm has been submitted to DDP and is waiting for a reviewer.',
        occurredAt: farm.submittedAt,
        ageInDays: daysBetween(farm.submittedAt, now),
        statusLabel: farm.status,
        destinationPage: 'ddp-farm-review' as Page,
        destinationParams: { farmId: farm.id },
        actionLabel: 'Open farm',
        sourceEntityType: 'farm',
        sourceEntityId: farm.id,
      })), collected, failures)

  // ── 10.2 Onboarding ──────────────────────────────────────────────────────
  // Source: persisted FarmProfile.completionPct. Reported factually; no
  // completeness threshold is invented here. (Two different bars already exist
  // in this codebase — 60 in deriveComplianceTier, 90 in deriveExportReadiness
  // — so a third would only add ambiguity.)
  safeQueue('onboarding', () =>
    farms
      .filter(farm => farm.status === 'Draft' && (farm.completionPct ?? 0) < 100)
      .map(farm => ({
        id: `onboarding:farm:${farm.id}`,
        category: 'onboarding' as const,
        priority: classifyOperationsDeskPriority({}),
        title: 'Onboarding incomplete',
        entityLabel: farmLabel(farm),
        reason: `Farm profile is still a draft — ${farm.completionPct ?? 0}% of profile fields recorded.`,
        occurredAt: farm.submittedAt,
        ageInDays: daysBetween(farm.submittedAt, now),
        statusLabel: farm.status,
        destinationPage: 'ddp-farm-review' as Page,
        destinationParams: { farmId: farm.id },
        actionLabel: 'Open farm',
        sourceEntityType: 'farm',
        sourceEntityId: farm.id,
      })), collected, failures)

  // ── 10.3 Documents ───────────────────────────────────────────────────────
  // Source: applyRequirementOverrides(deriveFarmDocumentRequirements(...)) —
  // the same pairing DDPMissingDocuments and DDPBuyerPreview both use.
  safeQueue('document', () =>
    farms.flatMap(farm => {
      // While inventory is unavailable, deriveFarmDocumentRequirements would read
      // its batch-dependent statuses (COA, batch number, photos, storage…) from an
      // empty batch list and report them missing — false positives. Keep only the
      // farm-only requirements (fail-closed whitelist), and apply overrides to just
      // those eligible ones. When inventory IS available (including a genuine []),
      // the complete original behaviour is preserved.
      const derived = deriveFarmDocumentRequirements(farm, inventory)
      const eligible = inventoryAvailable
        ? derived
        : derived.filter(req => FARM_ONLY_REQUIREMENT_TYPES.has(req.type))
      const requirements = applyRequirementOverrides(eligible)
      return requirements
        .filter(req => ACTIONABLE_EVIDENCE.has(req.status))
        .map(req => ({
          id: `document:farm:${farm.id}:${req.type}`,
          category: 'document' as const,
          priority: classifyOperationsDeskPriority({ evidenceStatus: req.status }),
          title: `${DOCUMENT_REQUIREMENT_LABELS[req.type] ?? req.type} — ${req.status}`,
          entityLabel: farmLabel(farm),
          reason:
            req.status === 'missing'
              ? `${DOCUMENT_REQUIREMENT_LABELS[req.type] ?? req.type} is required and has not been received.`
              : req.status === 'expired'
                ? `${DOCUMENT_REQUIREMENT_LABELS[req.type] ?? req.type} was on file but has passed its recorded validity date.`
                : `${DOCUMENT_REQUIREMENT_LABELS[req.type] ?? req.type} was reviewed and found unsuitable.`,
          statusLabel: req.status,
          destinationPage: 'ddp-missing-documents' as Page,
          actionLabel: 'View evidence',
          sourceEntityType: 'document-requirement',
          sourceEntityId: `${farm.id}:${req.type}`,
        }))
    }), collected, failures)

  // ── 10.4 COAs ────────────────────────────────────────────────────────────
  // Source: deriveCoaIntelligence — its own evidenceStatus and redFlags.
  // File age alone is never used as a quality or legal conclusion here; the
  // only date-derived flag is the one deriveCoaIntelligence itself records.
  safeQueue('coa', () =>
    inventory.flatMap(item => {
      const coa = deriveCoaIntelligence(item)
      const actionable = ACTIONABLE_EVIDENCE.has(coa.evidenceStatus)
      if (!actionable && coa.redFlags.length === 0) return []
      return [{
        id: `coa:batch:${item.id}`,
        category: 'coa' as const,
        priority: classifyOperationsDeskPriority({
          evidenceStatus: actionable ? coa.evidenceStatus : undefined,
          awaitingHumanReview: coa.redFlags.length > 0,
        }),
        title: coa.evidenceStatus === 'missing' ? 'COA not on file' : 'COA requires review',
        entityLabel: `${item.productName} · ${item.farmName}`,
        reason:
          coa.redFlags.length > 0
            ? coa.redFlags.join('; ')
            : `COA evidence is recorded as ${coa.evidenceStatus}.`,
        occurredAt: item.submittedAt,
        ageInDays: daysBetween(item.submittedAt, now),
        statusLabel: coa.evidenceStatus,
        destinationPage: 'ddp-coa-intelligence' as Page,
        actionLabel: 'View evidence',
        sourceEntityType: 'inventory-batch',
        sourceEntityId: item.id,
      }]
    }), collected, failures)

  // ── 10.5 Inventory review ────────────────────────────────────────────────
  // Source: persisted InventoryItem.status for the review queue itself.
  safeQueue('inventory-review', () =>
    inventory
      .filter(item => item.status === 'Pending Review' || item.status === 'Missing Document')
      .map(item => ({
        id: `inventory-review:batch:${item.id}`,
        category: 'inventory-review' as const,
        priority: classifyOperationsDeskPriority(
          item.status === 'Missing Document'
            ? { evidenceStatus: 'missing' }
            : { awaitingHumanReview: true },
        ),
        title: item.status === 'Missing Document' ? 'Batch missing a required document' : 'Batch awaiting review',
        entityLabel: `${item.productName} · ${item.farmName}`,
        reason:
          item.status === 'Missing Document'
            ? 'Batch has been flagged as missing a required document.'
            : 'Batch has been submitted and no review decision has been recorded.',
        occurredAt: item.submittedAt,
        ageInDays: daysBetween(item.submittedAt, now),
        statusLabel: item.status,
        destinationPage: 'ddp-inventory-review' as Page,
        destinationParams: { itemId: item.id },
        actionLabel: 'Review',
        sourceEntityType: 'inventory-batch',
        sourceEntityId: item.id,
      })), collected, failures)

  // ── 10.5 Inventory review — unresolved blockers ──────────────────────────
  // Source: applyRiskOverrides(deriveAutoRisks(...)) — severity and status are
  // that module's own, not re-derived. 'resolved' and 'accepted' are the two
  // closed states in RiskStatus.
  safeQueue('inventory-review', () =>
    applyRiskOverrides(deriveAutoRisks(farms, inventory))
      .filter(risk => risk.status !== 'resolved' && risk.status !== 'accepted')
      .filter(risk => risk.severity === 'blocker' || risk.severity === 'high')
      .map(risk => {
        const item = risk.batchId ? inventory.find(i => i.id === risk.batchId) : undefined
        const farm = risk.farmId
          ? farms.find(f => f.id === risk.farmId)
          : item
            ? farmForItem(item, farms)
            : undefined
        return {
          id: `inventory-review:risk:${risk.riskId}`,
          category: 'inventory-review' as const,
          priority: classifyOperationsDeskPriority({ riskSeverity: risk.severity }),
          title: risk.severity === 'blocker' ? 'Unresolved blocker' : 'Unresolved risk',
          entityLabel: item ? `${item.productName} · ${item.farmName}` : farm ? farmLabel(farm) : risk.riskId,
          reason: `${risk.issue} Required action: ${risk.requiredAction}`,
          statusLabel: risk.status,
          destinationPage: 'ddp-risk-register' as Page,
          actionLabel: 'Open',
          sourceEntityType: 'risk',
          sourceEntityId: risk.riskId,
        }
      }), collected, failures)

  // ── 10.7 Compliance review ───────────────────────────────────────────────
  // Source: stored ComplianceAlert records. The desk links to Watchtower and
  // never activates, pauses, retires, approves or rejects anything.
  if (input.complianceAlerts === null) {
    failures.push({
      category: 'compliance',
      message: 'Compliance alerts could not be loaded — compliance matters are not represented below.',
    })
  } else {
    const alerts = input.complianceAlerts
    safeQueue('compliance', () =>
      alerts
        .filter(alert => UNRESOLVED_ALERT.has(alert.status))
        .map(alert => ({
          id: `compliance:alert:${alert.id}`,
          category: 'compliance' as const,
          priority: classifyOperationsDeskPriority({ complianceSeverity: alert.severity }),
          title: alert.alertTitle,
          entityLabel: `${alert.entityType} · ${alert.entityId}`,
          reason: alert.alertDetail,
          occurredAt: alert.createdAt,
          ageInDays: daysBetween(alert.createdAt, now),
          statusLabel: alert.status,
          destinationPage: 'ddp-compliance-watchtower' as Page,
          actionLabel: 'Resolve in Watchtower',
          sourceEntityType: 'compliance-alert',
          sourceEntityId: alert.id,
        })), collected, failures)
  }

  // ── 10.8 Follow-up ───────────────────────────────────────────────────────
  // Source: existing ReviewRequest records (open) and farms already marked
  // 'More Information Required'. Both are real recorded next actions — no
  // generic task system is introduced.
  //
  // A null reviewRequests source means the fetch failed (admin RLS load error),
  // NOT that there are no open requests. Report the gap rather than presenting a
  // silent zero; the farm-based follow-ups below still run from the loaded farms.
  if (input.reviewRequests === null) {
    failures.push({
      category: 'follow-up',
      message: 'Open information requests could not be loaded — they are not represented below.',
    })
  } else {
  const reviewRequests = input.reviewRequests
  safeQueue('follow-up', () =>
    reviewRequests
      .filter(req => req.status === 'open')
      .map(req => ({
        id: `follow-up:review-request:${req.id}`,
        category: 'follow-up' as const,
        priority: classifyOperationsDeskPriority({}),
        title: 'Information request still open',
        entityLabel: req.productName || req.farmName || req.requestType,
        reason: `${req.message} (request type: ${req.requestType})`,
        occurredAt: req.createdAt,
        ageInDays: daysBetween(req.createdAt, now),
        statusLabel: req.status,
        // Route to the authoritative record: a batch-linked request opens the
        // inventory review; a farm-level request (farmProfileId, no batch —
        // these are now surfaced by the admin loader) opens that farm's review
        // rather than a generic farm list; a request with neither identifier
        // keeps the safe farm-list fallback.
        destinationPage: (req.stockItemId
          ? 'ddp-inventory-review'
          : req.farmProfileId
            ? 'ddp-farm-review'
            : 'ddp-farms') as Page,
        destinationParams: (req.stockItemId
          ? { itemId: req.stockItemId }
          : req.farmProfileId
            ? { farmId: req.farmProfileId }
            : undefined) as Record<string, string> | undefined,
        actionLabel: req.stockItemId ? 'Review' : req.farmProfileId ? 'Open farm' : 'Open',
        sourceEntityType: 'review-request',
        sourceEntityId: req.id,
      })), collected, failures)
  }

  // Farm 'More Information Required' follow-ups come from the already-loaded
  // farms, so they run whether or not the review-request source loaded.
  safeQueue('follow-up', () =>
    farms
      .filter(farm => farm.status === 'More Information Required')
      .map(farm => ({
        id: `follow-up:farm:${farm.id}`,
        category: 'follow-up' as const,
        priority: classifyOperationsDeskPriority({}),
        title: 'More information requested from farm',
        entityLabel: farmLabel(farm),
        reason: 'DDP has requested more information and no updated submission has been recorded.',
        occurredAt: farm.submittedAt,
        ageInDays: daysBetween(farm.submittedAt, now),
        statusLabel: farm.status,
        destinationPage: 'ddp-farm-review' as Page,
        destinationParams: { farmId: farm.id },
        actionLabel: 'Open farm',
        sourceEntityType: 'farm',
        sourceEntityId: farm.id,
      })), collected, failures)

  // Dedup on the deterministic id — duplicate underlying records (e.g. the
  // same risk surfaced twice) must never produce two rows. First write wins.
  const deduped = new Map<string, OperationsDeskItem>()
  for (const item of collected) {
    if (!deduped.has(item.id)) deduped.set(item.id, item)
  }

  return { items: [...deduped.values()], failures }
}
