import { supabase, isSupabaseConfigured } from './supabase'
import { isEnforcedRuleStatus } from './complianceRules'
import type {
  ComplianceAlert,
  ComplianceAuditLog,
  ComplianceEntityStatus,
  ComplianceReview,
  ComplianceRule,
  LegalUpdate,
  RegulatorySource,
} from '../types'

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

/**
 * Shown when an actor cannot be resolved to a real person. The audit log must
 * never present a plausible-but-wrong identity: a fabricated name is worse than
 * no name, because a reader (or a regulator) trusts it. See
 * resolveActorDisplayName below.
 */
export const UNKNOWN_ACTOR_LABEL = 'Unknown actor'

/**
 * A privacy-safe reference to an unresolved actor: the leading segment of the
 * UUID, never an email. Enough to correlate two rows or to look the actor up
 * out-of-band; not enough to identify a person from the screen alone.
 */
export function shortActorRef(actorId: string): string {
  return actorId.split('-')[0] ?? actorId
}

/**
 * Resolves an actor id to a display name using names already fetched from
 * `profiles` (see fetchProfileNames).
 *
 * Pure and side-effect-free so the attribution rules can be unit tested without
 * a live database. The rules, in order:
 *
 *   - a known actor renders their real profile name;
 *   - an actor we hold an id for but cannot name renders UNKNOWN_ACTOR_LABEL
 *     plus a privacy-safe id fragment, so the row stays traceable;
 *   - a row with no actor id renders what its actorType actually says, never a
 *     person's name.
 *
 * It deliberately has no notion of "the current viewer": a viewer-relative
 * fallback is exactly how the previous implementation came to label every other
 * operator's actions 'DDP Admin'.
 */
export function resolveActorDisplayName(
  actorId: string | null | undefined,
  names: ReadonlyMap<string, string>,
  actorType?: ComplianceAuditLog['actorType'],
): string {
  if (actorId) {
    const known = names.get(actorId)
    if (known) return known
    return `${UNKNOWN_ACTOR_LABEL} (${shortActorRef(actorId)})`
  }
  if (actorType === 'system') return 'System'
  if (actorType === 'ai_assistant') return 'AI assistant'
  return UNKNOWN_ACTOR_LABEL
}

interface ProfileNameRow {
  id: string
  display_name: string | null
  email: string | null
}

/**
 * Resolves actor ids to profile display names in a single batched query.
 *
 * Readable under the applied RLS policy "profiles: select own or admin"
 * (RLS_ENABLE_STAGED.sql) — a ddp_admin may select all profiles, and the
 * Compliance Watchtower is already admin-gated. No policy change is required.
 *
 * Never throws. A name lookup is presentation, not evidence: if it fails or is
 * denied, callers fall back to UNKNOWN_ACTOR_LABEL rather than losing the audit
 * log itself. The ids are the record; the names are a convenience over them.
 */
export async function fetchProfileNames(
  actorIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const ids = Array.from(
    new Set(actorIds.map(asUuidOrNull).filter((id): id is string => id !== null)),
  )
  if (ids.length === 0 || !supabase) return names

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, email')
      .in('id', ids)
    if (error) return names
    for (const row of (data as ProfileNameRow[] | null) ?? []) {
      const name = (row.display_name ?? '').trim() || (row.email ?? '').trim()
      if (name) names.set(row.id, name)
    }
  } catch {
    return names
  }
  return names
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
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
    })
    .select('*')
    .single()
  raise('Creating compliance rule', error)
  return ruleFromRow(data as ComplianceRuleRow)
}

export async function updateRuleStatus(id: string, status: ComplianceRule['status'], approvedBy: string | null): Promise<ComplianceRule> {
  const client = requireClient()
  const isApproving = isEnforcedRuleStatus(status)
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

function auditLogFromRow(row: ComplianceAuditLogRow, actorName: string): ComplianceAuditLog {
  return {
    id: row.id,
    actorType: row.actor_type as ComplianceAuditLog['actorType'],
    actorId: row.actor_id,
    actorName,
    action: row.action as ComplianceAuditLog['action'],
    entityType: row.entity_type,
    entityId: row.entity_id,
    beforeState: row.before_state,
    afterState: row.after_state,
    reason: row.reason,
    createdAt: row.created_at,
  }
}

/**
 * Loads the audit log and resolves each row's actor from the persisted
 * `actor_id` — never from who is viewing.
 *
 * Two-phase by necessity: the actor ids are only known once the rows are read,
 * so names are fetched afterwards in one batched query and applied here. The
 * previous signature took an actorNameForId callback and baked a name in at map
 * time, which is what allowed a viewer-relative fallback to fabricate
 * 'DDP Admin' for every other operator.
 */
export async function fetchAuditLog(): Promise<ComplianceAuditLog[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500)
  raise('Loading audit log', error)
  const rows = (data as ComplianceAuditLogRow[] | null) ?? []
  const names = await fetchProfileNames(rows.map(row => row.actor_id))
  return rows.map(row =>
    auditLogFromRow(row, resolveActorDisplayName(
      row.actor_id,
      names,
      row.actor_type as ComplianceAuditLog['actorType'],
    )),
  )
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

/**
 * Writes one audit entry. `actorDisplayName` is the *writing* user's own name —
 * the actor is by definition the caller, so it is known and needs no lookup. It
 * is used only to label the row returned for optimistic display; `actor_name` is
 * never persisted (see buildAuditLogInsertPayload — the row stores `actor_id`
 * alone, and every reader resolves the name from it).
 */
export async function insertAuditLog(
  entry: Omit<ComplianceAuditLog, 'id' | 'actorType' | 'actorId' | 'actorName' | 'createdAt'>,
  actorId: string | null,
  actorDisplayName: string,
  actorType: ComplianceAuditLog['actorType'] = 'admin',
): Promise<ComplianceAuditLog> {
  const client = requireClient()
  const { data, error } = await client
    .from('compliance_audit_log')
    .insert(buildAuditLogInsertPayload(entry, actorId, actorType))
    .select('*')
    .single()
  raise('Writing audit log entry', error)
  return auditLogFromRow(data as ComplianceAuditLogRow, actorDisplayName)
}
