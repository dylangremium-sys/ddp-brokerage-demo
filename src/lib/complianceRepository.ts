import { supabase, isSupabaseConfigured } from './supabase.js'
import { isHumanApprovedRuleStatus } from './complianceRules.js'
import { selectBlockingRuleAlerts } from './complianceRuleEnforcement.js'
import { parseRuleCondition } from './complianceRuleCondition.js'
import type { RuleCondition } from './complianceRuleConditionTypes.js'
import type { RuleEnforcementState } from './complianceRuleEnforcement.js'
import { loadStoredComplianceRules, loadStoredComplianceAlerts } from './complianceLocalAlerts.js'
import type {
  ComplianceAlert,
  ComplianceAuditLog,
  ComplianceEntityStatus,
  ComplianceReview,
  ComplianceRule,
  LegalUpdate,
  RegulatorySource,
  WatchtowerIngestionItem,
  WatchtowerIngestionRun,
} from '../types.js'

/** Postgres unique-violation SQLSTATE. Surfaced so the ingestion service can
 *  treat a lost dedup race as a duplicate outcome rather than a hard failure. */
export const PG_UNIQUE_VIOLATION = '23505'

export function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === PG_UNIQUE_VIOLATION
}

// Compliance Watchtower Supabase persistence.
// All reads/writes go through the existing browser (anon-key) client from lib/supabase.
// RLS (public.is_ddp_admin()) is the real enforcement layer; this module never uses a
// service-role key and never bypasses RLS. Callers should still gate write actions on
// currentUser.role === 'ddp_admin' so the UI fails closed with a clear message instead
// of surfacing a raw Postgres RLS error.

export { isSupabaseConfigured }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function asUuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null
}

function requireClient() {
  if (!supabase) throw new Error('Supabase is not configured for this environment.')
  return supabase
}

function raise(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`${context}: ${error.message}`)
}

// ---------- regulatory_sources ----------
// Raw persistence only — no validation, no duplicate detection, no business
// rules. Callers should go through src/lib/complianceSourceRegistry.ts,
// which owns those concerns and calls these functions only after a source
// candidate has already passed validation.

interface RegulatorySourceRow {
  id: string
  name: string
  jurisdiction: string
  source_type: string
  url: string
  is_active: boolean
  last_checked_at: string | null
  // Governance fields (Phase B / migration 26). Optional on the row so a read
  // against a pre-migration-26 database still maps cleanly to null.
  tier?: number | null
  authority_type?: string | null
  category?: string | null
  monitoring_method?: string | null
  priority?: number | null
  created_at: string
  updated_at: string
}

function regulatorySourceFromRow(row: RegulatorySourceRow): RegulatorySource {
  return {
    id: row.id,
    name: row.name,
    jurisdiction: row.jurisdiction,
    sourceType: row.source_type,
    url: row.url,
    isActive: row.is_active,
    lastCheckedAt: row.last_checked_at,
    tier: (row.tier ?? null) as RegulatorySource['tier'],
    authorityType: (row.authority_type ?? null) as RegulatorySource['authorityType'],
    category: (row.category ?? null) as RegulatorySource['category'],
    monitoringMethod: (row.monitoring_method ?? null) as RegulatorySource['monitoringMethod'],
    priority: row.priority ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function fetchRegulatorySources(): Promise<RegulatorySource[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('regulatory_sources')
    .select('*')
    .order('created_at', { ascending: false })
  raise('Loading regulatory sources', error)
  return (data as RegulatorySourceRow[] ?? []).map(regulatorySourceFromRow)
}

export async function insertRegulatorySource(
  input: Omit<RegulatorySource, 'id' | 'lastCheckedAt' | 'createdAt' | 'updatedAt'>,
): Promise<RegulatorySource> {
  const client = requireClient()
  const { data, error } = await client
    .from('regulatory_sources')
    .insert({
      name: input.name,
      jurisdiction: input.jurisdiction,
      source_type: input.sourceType,
      url: input.url,
      is_active: input.isActive,
      // Governance fields are written only when supplied; otherwise the DB
      // defaults them to the conservative Tier-3 signal shape (migration 26).
      ...(input.tier != null ? { tier: input.tier } : {}),
      ...(input.authorityType != null ? { authority_type: input.authorityType } : {}),
      ...(input.category != null ? { category: input.category } : {}),
      ...(input.monitoringMethod != null ? { monitoring_method: input.monitoringMethod } : {}),
      ...(input.priority != null ? { priority: input.priority } : {}),
    })
    .select('*')
    .single()
  raise('Creating regulatory source', error)
  return regulatorySourceFromRow(data as RegulatorySourceRow)
}

export async function updateRegulatorySource(
  id: string,
  patch: Partial<Omit<RegulatorySource, 'id' | 'lastCheckedAt' | 'createdAt' | 'updatedAt'>>,
): Promise<RegulatorySource> {
  const client = requireClient()
  const { data, error } = await client
    .from('regulatory_sources')
    .update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.jurisdiction !== undefined ? { jurisdiction: patch.jurisdiction } : {}),
      ...(patch.sourceType !== undefined ? { source_type: patch.sourceType } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.isActive !== undefined ? { is_active: patch.isActive } : {}),
      ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
      ...(patch.authorityType !== undefined ? { authority_type: patch.authorityType } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.monitoringMethod !== undefined ? { monitoring_method: patch.monitoringMethod } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single()
  raise('Updating regulatory source', error)
  return regulatorySourceFromRow(data as RegulatorySourceRow)
}

// ---------- legal_updates ----------

interface LegalUpdateRow {
  id: string
  source_id: string | null
  title: string
  jurisdiction: string
  source_name: string
  source_url: string
  published_at: string | null
  detected_at: string
  raw_text: string
  summary: string
  affected_areas: string[]
  ai_risk_level: string | null
  status: string
  reviewer_notes: string
  content_hash?: string | null
  canonical_url?: string | null
  external_document_id?: string | null
  source_tier?: number | null
  ingestion_run_id?: string | null
  ingestion_item_key?: string | null
  created_at: string
  updated_at: string
}

function legalUpdateFromRow(row: LegalUpdateRow): LegalUpdate {
  return {
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    jurisdiction: row.jurisdiction,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    publishedAt: row.published_at,
    detectedAt: row.detected_at,
    rawText: row.raw_text,
    summary: row.summary,
    affectedAreas: (row.affected_areas ?? []) as LegalUpdate['affectedAreas'],
    aiRiskLevel: row.ai_risk_level as LegalUpdate['aiRiskLevel'],
    status: row.status as LegalUpdate['status'],
    reviewerNotes: row.reviewer_notes,
    contentHash: row.content_hash ?? null,
    canonicalUrl: row.canonical_url ?? null,
    externalDocumentId: row.external_document_id ?? null,
    sourceTier: (row.source_tier ?? null) as LegalUpdate['sourceTier'],
    ingestionRunId: row.ingestion_run_id ?? null,
    ingestionItemKey: row.ingestion_item_key ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function fetchLegalUpdates(): Promise<LegalUpdate[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('legal_updates')
    .select('*')
    .order('detected_at', { ascending: false })
  raise('Loading legal updates', error)
  return (data as LegalUpdateRow[] ?? []).map(legalUpdateFromRow)
}

export async function insertLegalUpdate(input: Omit<LegalUpdate, 'id' | 'createdAt' | 'updatedAt' | 'detectedAt'>): Promise<LegalUpdate> {
  const client = requireClient()
  const { data, error } = await client
    .from('legal_updates')
    .insert({
      source_id: input.sourceId ?? null,
      title: input.title,
      jurisdiction: input.jurisdiction,
      source_name: input.sourceName,
      source_url: input.sourceUrl,
      published_at: input.publishedAt ?? null,
      raw_text: input.rawText,
      summary: input.summary,
      affected_areas: input.affectedAreas,
      ai_risk_level: input.aiRiskLevel ?? null,
      status: input.status,
      reviewer_notes: input.reviewerNotes,
    })
    .select('*')
    .single()
  raise('Creating legal update', error)
  return legalUpdateFromRow(data as LegalUpdateRow)
}

export async function updateLegalUpdateStatus(id: string, status: LegalUpdate['status']): Promise<LegalUpdate> {
  const client = requireClient()
  const { data, error } = await client
    .from('legal_updates')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  raise('Updating legal update status', error)
  return legalUpdateFromRow(data as LegalUpdateRow)
}

// ---------- compliance_reviews ----------
// Note: the applied schema does not store riskLevel/affectedEntities/summary/recommendedAction
// for reviews. Those display-only fields are derived from the linked legal_update at read time
// (see enrichReview) rather than persisted, to avoid an additional SQL migration.

interface ComplianceReviewRow {
  id: string
  legal_update_id: string | null
  alert_id: string | null
  rule_id: string | null
  title: string
  review_type: string
  status: string
  reviewer_notes: string
  decision: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
}

function reviewFromRow(row: ComplianceReviewRow): ComplianceReview {
  return {
    id: row.id,
    legalUpdateId: row.legal_update_id,
    alertId: row.alert_id,
    ruleId: row.rule_id,
    title: row.title,
    reviewType: row.review_type as ComplianceReview['reviewType'],
    status: row.status as ComplianceReview['status'],
    riskLevel: 'info',
    affectedEntities: [],
    summary: '',
    recommendedAction: '',
    reviewerNotes: row.reviewer_notes,
    decision: row.decision,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function enrichReview(review: ComplianceReview, legalUpdates: LegalUpdate[]): ComplianceReview {
  const linked = review.legalUpdateId ? legalUpdates.find(update => update.id === review.legalUpdateId) : undefined
  if (!linked) return review
  return {
    ...review,
    riskLevel: linked.aiRiskLevel ?? review.riskLevel,
    affectedEntities: linked.affectedAreas,
    summary: review.summary || linked.summary || linked.rawText.slice(0, 280),
    recommendedAction: review.recommendedAction || (
      (linked.aiRiskLevel === 'high' || linked.aiRiskLevel === 'critical')
        ? 'Review before operational status changes.'
        : 'Classify and monitor.'
    ),
  }
}

export async function fetchReviews(): Promise<ComplianceReview[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_reviews')
    .select('*')
    .order('created_at', { ascending: false })
  raise('Loading review queue', error)
  return (data as ComplianceReviewRow[] ?? []).map(reviewFromRow)
}

export async function insertReview(input: {
  legalUpdateId: string | null
  title: string
  reviewType: ComplianceReview['reviewType']
  status: ComplianceReview['status']
  reviewerNotes: string
}): Promise<ComplianceReview> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_reviews')
    .insert({
      legal_update_id: input.legalUpdateId,
      title: input.title,
      review_type: input.reviewType,
      status: input.status,
      reviewer_notes: input.reviewerNotes,
    })
    .select('*')
    .single()
  raise('Creating review item', error)
  return reviewFromRow(data as ComplianceReviewRow)
}

export async function updateReview(id: string, patch: {
  status: ComplianceReview['status']
  decision: string | null
  reviewedBy: string | null
  reviewerNotes?: string
}): Promise<ComplianceReview> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_reviews')
    .update({
      status: patch.status,
      decision: patch.decision,
      reviewed_by: asUuidOrNull(patch.reviewedBy),
      reviewed_at: new Date().toISOString(),
      ...(patch.reviewerNotes !== undefined ? { reviewer_notes: patch.reviewerNotes } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single()
  raise('Updating review decision', error)
  return reviewFromRow(data as ComplianceReviewRow)
}

// ---------- compliance_rules ----------

interface ComplianceRuleRow {
  id: string
  rule_code: string
  title: string
  description: string
  jurisdiction: string | null
  entity_type: string
  severity: string
  is_blocking: boolean
  status: string
  source_legal_update_id: string | null
  approved_by: string | null
  approved_at: string | null
  // Added to the table by migration 41. `select('*')` has been returning these
  // all along; ruleFromRow simply dropped them, so nothing downstream could see
  // whether a rule was actually in force. Rule enforcement needs them.
  effective_from: string | null
  effective_to: string | null
  // Migration 62. Optional on the row so a read against a pre-62 database still
  // maps cleanly to null rather than throwing.
  condition?: unknown
  created_at: string
  updated_at: string
}

function ruleFromRow(row: ComplianceRuleRow): ComplianceRule {
  return {
    id: row.id,
    ruleCode: row.rule_code,
    title: row.title,
    description: row.description,
    jurisdiction: row.jurisdiction,
    entityType: row.entity_type as ComplianceRule['entityType'],
    severity: row.severity as ComplianceRule['severity'],
    isBlocking: row.is_blocking,
    status: row.status as ComplianceRule['status'],
    sourceLegalUpdateId: row.source_legal_update_id,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    effectiveFrom: row.effective_from ?? null,
    effectiveTo: row.effective_to ?? null,
    // A stored condition is UNTRUSTED until parsed. The column's CHECK guards
    // shape only, and a row could predate a registry change or have been written
    // by something that bypassed the application. An unparseable condition maps
    // to null, which means "no automatic condition" — the rule still exists and
    // is still human-linkable, it simply cannot self-evaluate. Silently keeping
    // a malformed predicate would be worse: it would evaluate as UNEVALUABLE
    // against every batch and bury an operator in triage items.
    condition: parseStoredCondition(row.condition),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Turns whatever is in the column into a condition, or null. Never throws: a
 * bad row must not take down the whole rules list.
 */
function parseStoredCondition(raw: unknown): RuleCondition | null {
  if (raw === null || raw === undefined) return null
  const parsed = parseRuleCondition(raw)
  return parsed.ok ? parsed.condition : null
}

/**
 * Validates a condition on the way IN, so an invalid one is refused at
 * authoring time with a message naming the failing path — rather than being
 * stored and discovered later as a rule that cannot decide anything.
 * `undefined` means "leave it alone"; `null` means "clear it".
 */
function conditionForWrite(condition: RuleCondition | null | undefined): unknown {
  if (condition === undefined || condition === null) return null
  const parsed = parseRuleCondition(condition)
  if (!parsed.ok) {
    throw new Error(`Invalid rule condition: ${parsed.errors.join('; ')}`)
  }
  return parsed.condition
}

export async function fetchRules(): Promise<ComplianceRule[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_rules')
    .select('*')
    .order('created_at', { ascending: false })
  raise('Loading compliance rules', error)
  return (data as ComplianceRuleRow[] ?? []).map(ruleFromRow)
}

export async function insertRule(input: Omit<ComplianceRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<ComplianceRule> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_rules')
    .insert({
      rule_code: input.ruleCode,
      title: input.title,
      description: input.description,
      jurisdiction: input.jurisdiction ?? null,
      entity_type: input.entityType,
      severity: input.severity,
      is_blocking: input.isBlocking,
      status: input.status,
      source_legal_update_id: input.sourceLegalUpdateId ?? null,
      approved_by: asUuidOrNull(input.approvedBy),
      approved_at: input.approvedAt ?? null,
      condition: conditionForWrite(input.condition),
    })
    .select('*')
    .single()
  raise('Creating compliance rule', error)
  return ruleFromRow(data as ComplianceRuleRow)
}

export async function updateRuleStatus(id: string, status: ComplianceRule['status'], approvedBy: string | null): Promise<ComplianceRule> {
  const client = requireClient()
  const isApproving = isHumanApprovedRuleStatus(status)
  const { data, error } = await client
    .from('compliance_rules')
    .update({
      status,
      ...(isApproving ? { approved_by: asUuidOrNull(approvedBy), approved_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single()
  raise('Updating rule status', error)
  return ruleFromRow(data as ComplianceRuleRow)
}

// ---------- compliance_alerts ----------

interface ComplianceAlertRow {
  id: string
  entity_type: string
  entity_id: string
  rule_id: string | null
  legal_update_id: string | null
  alert_title: string
  alert_detail: string
  severity: string
  status: string
  created_at: string
  resolved_at: string | null
  resolution_notes: string | null
}

function alertFromRow(row: ComplianceAlertRow): ComplianceAlert {
  return {
    id: row.id,
    entityType: row.entity_type as ComplianceAlert['entityType'],
    entityId: row.entity_id,
    ruleId: row.rule_id,
    legalUpdateId: row.legal_update_id,
    alertTitle: row.alert_title,
    alertDetail: row.alert_detail,
    severity: row.severity as ComplianceAlert['severity'],
    status: row.status as ComplianceAlert['status'],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolutionNotes: row.resolution_notes,
  }
}

/**
 * The authoritative rule-enforcement state for ONE entity, for the buyer-pack
 * gate. Reads compliance rules and the alerts raised against this entity, and
 * returns the subset that must block right now.
 *
 * FAILS CLOSED, and that is the whole point of the function. Every failure path
 * — Supabase unconfigured, either query erroring, an unexpected throw — returns
 * `{ blockingAlerts: [], unavailable: true }`, which the gate reads as blocking.
 * It deliberately does NOT use `raise()` like its neighbours: a throw here would
 * surface as an unhandled rejection in the caller's effect and leave the gate
 * state at `null`, which also blocks but tells the operator nothing. An explicit
 * `unavailable` lets the screen say WHY it is blocked.
 *
 * Note the two reads are NOT a transaction. A rule promoted between them could
 * be missed for one render; the next resolve catches it. That is acceptable
 * because every inconsistency here resolves toward blocking or a stale unblock
 * that self-corrects, never toward a permanent silent unblock.
 */
export async function resolveEnforcedRuleAlerts(
  entityType: ComplianceRule['entityType'],
  entityId: string,
): Promise<RuleEnforcementState> {
  const unavailable: RuleEnforcementState = { blockingAlerts: [], unavailable: true }
  if (!entityId) return unavailable

  // DEMO MODE (no Supabase): the local cache IS the store, exactly as it is for
  // procurement overrides. This must NOT report `unavailable` — doing so would
  // block every buyer pack in the demo build, and it would be a lie: the rules
  // and alerts are readable, they just live in localStorage. It also means the
  // enforcement gate is demonstrable without a database, which is the point of
  // the demo build.
  if (!isSupabaseConfigured || !supabase) {
    return {
      blockingAlerts: selectBlockingRuleAlerts(
        entityType,
        entityId,
        loadStoredComplianceRules(),
        loadStoredComplianceAlerts(),
      ),
      unavailable: false,
    }
  }

  try {
    const client = supabase
    const [rulesResult, alertsResult] = await Promise.all([
      client.from('compliance_rules').select('*'),
      client.from('compliance_alerts').select('*').eq('entity_type', entityType).eq('entity_id', entityId),
    ])
    if (rulesResult.error || alertsResult.error) return unavailable

    const rules = (rulesResult.data as ComplianceRuleRow[] ?? []).map(ruleFromRow)
    const alerts = (alertsResult.data as ComplianceAlertRow[] ?? []).map(alertFromRow)
    return {
      blockingAlerts: selectBlockingRuleAlerts(entityType, entityId, rules, alerts),
      unavailable: false,
    }
  } catch {
    return unavailable
  }
}

/**
 * The same question as resolveEnforcedRuleAlerts, asked for many batches at
 * once, for the Qualified Buyer Preview list. One pair of queries rather than
 * one pair per candidate.
 *
 * FAILS CLOSED AS A WHOLE. If either read fails, `unavailable` is true for the
 * entire set and the caller must treat every candidate as blocked — not just
 * the ones it happened to get rows for. A partial answer here would silently
 * approve exactly the batches whose alerts did not come back.
 *
 * A batch with no alerts gets a settled, clean state — absence of an alert is a
 * real answer, distinct from a failed read.
 */
export async function resolveEnforcedRuleAlertsForBatches(
  batchIds: string[],
): Promise<{ byBatchId: Map<string, RuleEnforcementState>; unavailable: boolean }> {
  const empty = new Map<string, RuleEnforcementState>()
  if (batchIds.length === 0) return { byBatchId: empty, unavailable: false }

  // DEMO MODE: same contract as the single-entity resolver above.
  if (!isSupabaseConfigured || !supabase) {
    const rules = loadStoredComplianceRules()
    const alerts = loadStoredComplianceAlerts()
    return {
      byBatchId: new Map(batchIds.map(id => [
        id,
        { blockingAlerts: selectBlockingRuleAlerts('batch', id, rules, alerts), unavailable: false },
      ])),
      unavailable: false,
    }
  }

  try {
    const client = supabase
    const [rulesResult, alertsResult] = await Promise.all([
      client.from('compliance_rules').select('*'),
      client.from('compliance_alerts').select('*').eq('entity_type', 'batch').in('entity_id', batchIds),
    ])
    if (rulesResult.error || alertsResult.error) return { byBatchId: empty, unavailable: true }

    const rules = (rulesResult.data as ComplianceRuleRow[] ?? []).map(ruleFromRow)
    const alerts = (alertsResult.data as ComplianceAlertRow[] ?? []).map(alertFromRow)
    const byBatchId = new Map<string, RuleEnforcementState>(
      batchIds.map(id => [
        id,
        { blockingAlerts: selectBlockingRuleAlerts('batch', id, rules, alerts), unavailable: false },
      ]),
    )
    return { byBatchId, unavailable: false }
  } catch {
    return { byBatchId: empty, unavailable: true }
  }
}

export async function fetchAlerts(): Promise<ComplianceAlert[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_alerts')
    .select('*')
    .order('created_at', { ascending: false })
  raise('Loading compliance alerts', error)
  return (data as ComplianceAlertRow[] ?? []).map(alertFromRow)
}

export async function insertAlert(input: Omit<ComplianceAlert, 'id' | 'createdAt' | 'resolvedAt' | 'resolutionNotes'>): Promise<ComplianceAlert> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_alerts')
    .insert({
      entity_type: input.entityType,
      entity_id: input.entityId,
      rule_id: input.ruleId ?? null,
      legal_update_id: input.legalUpdateId ?? null,
      alert_title: input.alertTitle,
      alert_detail: input.alertDetail,
      severity: input.severity,
      status: input.status,
    })
    .select('*')
    .single()
  raise('Creating compliance alert', error)
  return alertFromRow(data as ComplianceAlertRow)
}

export async function updateAlertStatus(id: string, status: ComplianceAlert['status'], resolutionNotes: string | null): Promise<ComplianceAlert> {
  const client = requireClient()
  const resolved = status === 'resolved' || status === 'dismissed'
  const { data, error } = await client
    .from('compliance_alerts')
    .update({
      status,
      ...(resolved ? { resolved_at: new Date().toISOString(), resolution_notes: resolutionNotes } : {}),
    })
    .eq('id', id)
    .select('*')
    .single()
  raise('Updating alert status', error)
  return alertFromRow(data as ComplianceAlertRow)
}

// ---------- compliance_entity_status ----------

interface ComplianceEntityStatusRow {
  id: string
  entity_type: string
  entity_id: string
  readiness_status: string
  risk_level: string
  missing_requirements: string[]
  blocking_alert_count: number
  last_evaluated_at: string
  created_at: string
  updated_at: string
}

function entityStatusFromRow(row: ComplianceEntityStatusRow): ComplianceEntityStatus {
  return {
    id: row.id,
    entityType: row.entity_type as ComplianceEntityStatus['entityType'],
    entityId: row.entity_id,
    readinessStatus: row.readiness_status as ComplianceEntityStatus['readinessStatus'],
    riskLevel: row.risk_level as ComplianceEntityStatus['riskLevel'],
    missingRequirements: row.missing_requirements ?? [],
    blockingAlertCount: row.blocking_alert_count,
    lastEvaluatedAt: row.last_evaluated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function upsertEntityStatus(status: Omit<ComplianceEntityStatus, 'id' | 'createdAt' | 'updatedAt'>): Promise<ComplianceEntityStatus> {
  const client = requireClient()
  const now = new Date().toISOString()
  const { data, error } = await client
    .from('compliance_entity_status')
    .upsert({
      entity_type: status.entityType,
      entity_id: status.entityId,
      readiness_status: status.readinessStatus,
      risk_level: status.riskLevel,
      missing_requirements: status.missingRequirements,
      blocking_alert_count: status.blockingAlertCount,
      last_evaluated_at: status.lastEvaluatedAt,
      updated_at: now,
    }, { onConflict: 'entity_type,entity_id' })
    .select('*')
    .single()
  raise('Saving export readiness status', error)
  return entityStatusFromRow(data as ComplianceEntityStatusRow)
}

// ---------- compliance_audit_log ----------
// Insert-only from the frontend. Never update/delete (also enforced server-side by trigger).

interface ComplianceAuditLogRow {
  id: string
  actor_type: string
  actor_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  before_state: unknown
  after_state: unknown
  reason: string | null
  created_at: string
}

function auditLogFromRow(row: ComplianceAuditLogRow, actorNameForId: (actorId: string | null) => string): ComplianceAuditLog {
  return {
    id: row.id,
    actorType: row.actor_type as ComplianceAuditLog['actorType'],
    actorId: row.actor_id,
    actorName: actorNameForId(row.actor_id),
    action: row.action as ComplianceAuditLog['action'],
    entityType: row.entity_type,
    entityId: row.entity_id,
    beforeState: row.before_state,
    afterState: row.after_state,
    reason: row.reason,
    createdAt: row.created_at,
  }
}

export async function fetchAuditLog(actorNameForId: (actorId: string | null) => string): Promise<ComplianceAuditLog[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500)
  raise('Loading audit log', error)
  return (data as ComplianceAuditLogRow[] ?? []).map(row => auditLogFromRow(row, actorNameForId))
}

export interface ComplianceAuditLogInsertPayload {
  actor_type: ComplianceAuditLog['actorType']
  actor_id: string | null
  action: ComplianceAuditLog['action']
  entity_type: string
  entity_id: string | null
  before_state: unknown
  after_state: unknown
  reason: string | null
}

/**
 * Builds the exact row payload insertAuditLog() sends to Supabase. Pure and
 * side-effect-free (no Supabase client involved) so actor-type attribution
 * can be unit tested without a live database connection. Defaults
 * actor_type to 'admin' so every existing call site — which passes no
 * actorType argument — keeps writing 'admin' unchanged.
 *
 * NOTE: `actor_id` here is NOT trusted as the source of truth. Migration 27
 * (27_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql) installs a
 * BEFORE INSERT trigger that OVERRIDES the stored actor_id with auth.uid(), so a
 * forged or stale client value cannot mis-attribute an append-only audit entry.
 * The value sent here is retained only for the honest path (it already equals the
 * caller's own id); the database is authoritative.
 */
export function buildAuditLogInsertPayload(
  entry: Omit<ComplianceAuditLog, 'id' | 'actorType' | 'actorId' | 'actorName' | 'createdAt'>,
  actorId: string | null,
  actorType: ComplianceAuditLog['actorType'] = 'admin',
): ComplianceAuditLogInsertPayload {
  return {
    actor_type: actorType,
    actor_id: asUuidOrNull(actorId),
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    before_state: entry.beforeState ?? null,
    after_state: entry.afterState ?? null,
    reason: entry.reason ?? null,
  }
}

export async function insertAuditLog(
  entry: Omit<ComplianceAuditLog, 'id' | 'actorType' | 'actorId' | 'actorName' | 'createdAt'>,
  actorId: string | null,
  actorNameForId: (actorId: string | null) => string,
  actorType: ComplianceAuditLog['actorType'] = 'admin',
): Promise<ComplianceAuditLog> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_audit_log')
    .insert(buildAuditLogInsertPayload(entry, actorId, actorType))
    .select('*')
    .single()
  raise('Writing audit log entry', error)
  return auditLogFromRow(data as ComplianceAuditLogRow, actorNameForId)
}

// ---------- legal_updates: candidate creation with provenance (Phase C) ----------
// A candidate is always created in draft/new status only. Provenance columns
// (migration 25) are populated so the record is deduplicable and reproducible.
// This is a SEPARATE function from insertLegalUpdate so the manual-paste path is
// untouched. The DB partial-unique indexes are the real dedup authority; a lost
// race surfaces as a unique violation the caller reclassifies as a duplicate.

export interface CandidateLegalUpdateInput {
  sourceId: string | null
  sourceName: string
  sourceUrl: string
  jurisdiction: string
  title: string
  rawText: string
  contentHash: string
  canonicalUrl: string | null
  externalDocumentId: string | null
  sourceTier: number | null
  ingestionRunId: string | null
  ingestionItemKey: string | null
  publishedAt: string | null
}

export interface CandidateLegalUpdateResult {
  ok: boolean
  legalUpdate?: LegalUpdate
  duplicate?: boolean
  error?: string
}

export async function insertCandidateLegalUpdate(input: CandidateLegalUpdateInput): Promise<CandidateLegalUpdateResult> {
  const client = requireClient()
  const { data, error } = await client
    .from('legal_updates')
    .insert({
      source_id: input.sourceId,
      title: input.title,
      jurisdiction: input.jurisdiction,
      source_name: input.sourceName,
      source_url: input.sourceUrl,
      published_at: input.publishedAt,
      raw_text: input.rawText,
      summary: '',
      affected_areas: [],
      ai_risk_level: null,
      // Structural guarantee: an ingested candidate can only ever be 'new'.
      status: 'new',
      reviewer_notes: '',
      content_hash: input.contentHash,
      canonical_url: input.canonicalUrl,
      external_document_id: input.externalDocumentId,
      source_tier: input.sourceTier,
      ingestion_run_id: input.ingestionRunId,
      ingestion_item_key: input.ingestionItemKey,
    })
    .select('*')
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      // Another record already carries this content hash / external id: this is
      // a duplicate, not a failure. Report it so the item is recorded as such.
      return { ok: false, duplicate: true }
    }
    return { ok: false, error: error.message }
  }
  return { ok: true, legalUpdate: legalUpdateFromRow(data as LegalUpdateRow) }
}

/** The already-persisted identity a run deduplicates against. Read once at run
 *  start. Only reads columns migration 25 added; safe with RLS (admin-only). */
export async function fetchKnownLegalUpdateIdentity(): Promise<{
  contentHashes: string[]
  sourceExternalIds: string[]
}> {
  const client = requireClient()
  const { data, error } = await client
    .from('legal_updates')
    .select('source_id, content_hash, external_document_id')
  raise('Loading known legal-update identity for dedup', error)
  const rows = (data as { source_id: string | null; content_hash: string | null; external_document_id: string | null }[]) ?? []
  const contentHashes: string[] = []
  const sourceExternalIds: string[] = []
  for (const r of rows) {
    if (r.content_hash) contentHashes.push(r.content_hash)
    if (r.source_id && r.external_document_id) sourceExternalIds.push(`${r.source_id}::${r.external_document_id}`)
  }
  return { contentHashes, sourceExternalIds }
}

// ---------- watchtower_ingestion_runs / _items (Phase C) ----------

interface IngestionRunRow {
  id: string
  source_id: string | null
  source_name_snapshot: string
  source_url_snapshot: string
  source_tier_snapshot: number | null
  connector_kind: string
  trigger_type: string
  actor_type: string
  status: string
  failure_reason: string | null
  error_detail: string | null
  started_at: string
  finished_at: string | null
  items_seen: number
  items_new: number
  items_duplicate: number
  items_unchanged: number
  items_failed: number
  created_at: string
  updated_at: string
}

function ingestionRunFromRow(row: IngestionRunRow): WatchtowerIngestionRun {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceNameSnapshot: row.source_name_snapshot,
    sourceUrlSnapshot: row.source_url_snapshot,
    sourceTierSnapshot: row.source_tier_snapshot as WatchtowerIngestionRun['sourceTierSnapshot'],
    connectorKind: row.connector_kind,
    triggerType: row.trigger_type as WatchtowerIngestionRun['triggerType'],
    actorType: row.actor_type as WatchtowerIngestionRun['actorType'],
    status: row.status as WatchtowerIngestionRun['status'],
    failureReason: row.failure_reason,
    errorDetail: row.error_detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    itemsSeen: row.items_seen,
    itemsNew: row.items_new,
    itemsDuplicate: row.items_duplicate,
    itemsUnchanged: row.items_unchanged,
    itemsFailed: row.items_failed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface OpenIngestionRunInput {
  sourceId: string | null
  sourceNameSnapshot: string
  sourceUrlSnapshot: string
  sourceTierSnapshot: number | null
  connectorKind: string
  triggerType: WatchtowerIngestionRun['triggerType']
  actorType: WatchtowerIngestionRun['actorType']
  actorId: string | null
}

/** Opens a run in status 'running'. finished_at/failure_reason stay NULL (the
 *  migration-25 CHECK forbids them on a running row). */
export async function openIngestionRun(input: OpenIngestionRunInput): Promise<WatchtowerIngestionRun> {
  const client = requireClient()
  const { data, error } = await client
    .from('watchtower_ingestion_runs')
    .insert({
      source_id: input.sourceId,
      source_name_snapshot: input.sourceNameSnapshot,
      source_url_snapshot: input.sourceUrlSnapshot,
      source_tier_snapshot: input.sourceTierSnapshot,
      connector_kind: input.connectorKind,
      trigger_type: input.triggerType,
      actor_type: input.actorType,
      actor_id: asUuidOrNull(input.actorId),
      status: 'running',
    })
    .select('*')
    .single()
  raise('Opening ingestion run', error)
  return ingestionRunFromRow(data as IngestionRunRow)
}

export interface CloseIngestionRunInput {
  status: 'succeeded' | 'partial' | 'failed' | 'skipped'
  failureReason: string | null
  errorDetail: string | null
  itemsSeen: number
  itemsNew: number
  itemsDuplicate: number
  itemsUnchanged: number
  itemsFailed: number
  finishedAt?: string
}

/** Closes a running run exactly once. The migration-25 trigger enforces that a
 *  terminal run can never be reopened or re-characterised. */
export async function closeIngestionRun(id: string, input: CloseIngestionRunInput): Promise<WatchtowerIngestionRun> {
  const client = requireClient()
  const { data, error } = await client
    .from('watchtower_ingestion_runs')
    .update({
      status: input.status,
      failure_reason: input.failureReason,
      error_detail: input.errorDetail,
      finished_at: input.finishedAt ?? new Date().toISOString(),
      items_seen: input.itemsSeen,
      items_new: input.itemsNew,
      items_duplicate: input.itemsDuplicate,
      items_unchanged: input.itemsUnchanged,
      items_failed: input.itemsFailed,
    })
    .eq('id', id)
    .eq('status', 'running')
    .select('*')
    .single()
  raise('Closing ingestion run', error)
  return ingestionRunFromRow(data as IngestionRunRow)
}

export interface InsertIngestionItemInput {
  runId: string
  sourceId: string | null
  itemKey: string
  externalDocumentId: string | null
  canonicalUrl: string | null
  title: string
  publishedAt: string | null
  contentHash: string | null
  normalizedLength: number | null
  dedupDecision: string
  dedupMatchedLegalUpdateId: string | null
  legalUpdateId: string | null
  failureReason: string | null
  errorDetail: string | null
}

export async function insertIngestionItem(input: InsertIngestionItemInput): Promise<void> {
  const client = requireClient()
  const { error } = await client
    .from('watchtower_ingestion_items')
    .insert({
      run_id: input.runId,
      source_id: input.sourceId,
      item_key: input.itemKey,
      external_document_id: input.externalDocumentId,
      canonical_url: input.canonicalUrl,
      title: input.title,
      published_at: input.publishedAt,
      content_hash: input.contentHash,
      normalized_length: input.normalizedLength,
      dedup_decision: input.dedupDecision,
      dedup_matched_legal_update_id: input.dedupMatchedLegalUpdateId,
      legal_update_id: input.legalUpdateId,
      failure_reason: input.failureReason,
      error_detail: input.errorDetail,
    })
  raise('Recording ingestion item', error)
}

export async function fetchIngestionRuns(limit = 100): Promise<WatchtowerIngestionRun[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('watchtower_ingestion_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit)
  raise('Loading ingestion runs', error)
  return (data as IngestionRunRow[] ?? []).map(ingestionRunFromRow)
}

interface IngestionItemRow {
  id: string
  run_id: string
  source_id: string | null
  item_key: string
  external_document_id: string | null
  canonical_url: string | null
  title: string
  published_at: string | null
  content_hash: string | null
  normalized_length: number | null
  dedup_decision: string
  dedup_matched_legal_update_id: string | null
  legal_update_id: string | null
  failure_reason: string | null
  error_detail: string | null
  created_at: string
}

function ingestionItemFromRow(row: IngestionItemRow): WatchtowerIngestionItem {
  return {
    id: row.id,
    runId: row.run_id,
    sourceId: row.source_id,
    itemKey: row.item_key,
    externalDocumentId: row.external_document_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    publishedAt: row.published_at,
    contentHash: row.content_hash,
    normalizedLength: row.normalized_length,
    dedupDecision: row.dedup_decision,
    dedupMatchedLegalUpdateId: row.dedup_matched_legal_update_id,
    legalUpdateId: row.legal_update_id,
    failureReason: row.failure_reason,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
  }
}

export async function fetchIngestionItems(runId: string): Promise<WatchtowerIngestionItem[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('watchtower_ingestion_items')
    .select('*')
    .eq('run_id', runId)
    .order('created_at', { ascending: true })
  raise('Loading ingestion items', error)
  return (data as IngestionItemRow[] ?? []).map(ingestionItemFromRow)
}
