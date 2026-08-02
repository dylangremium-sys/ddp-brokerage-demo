import type {
  RegulatorySource,
  RegulatorySourceAuthorityType,
  RegulatorySourceCategory,
  RegulatorySourceMonitoringMethod,
  RegulatorySourceTier,
} from '../types.js'

// ─── Compliance Source Governance & Tiering — service layer (Phase B) ────────
//
// Owns the authority-classification model for regulatory sources: tier,
// authority type, category, monitoring method, and priority — plus the single
// most important governance rule in this phase:
//
//   A Tier 3 source is an INTELLIGENCE SIGNAL, never a direct authority. It may
//   surface a candidate legal update for human review, but it must never be
//   allowed to drive downstream compliance STATE (an approved rule, an
//   entity's readiness/authority determination, an export decision). That guard
//   is enforced here by canActAsDirectAuthority() / assertNotTier3Authority().
//
// This file is pure and Supabase-free: it validates and decides only. Raw
// persistence stays in complianceRepository.ts; source CRUD orchestration stays
// in complianceSourceRegistry.ts. Nothing here fetches, schedules, persists,
// or calls an AI provider.

// ─── Allowed-value vocabularies (ground truth for app-layer validation) ──────
//
// These MUST stay in lockstep with the CHECK constraints in
// 26_WATCHTOWER_SOURCE_GOVERNANCE_HARDENING.sql. The DB is the real authority;
// these exist so the UI fails closed with a clear message instead of surfacing
// a raw Postgres constraint error.

export const SUPPORTED_SOURCE_TIERS: readonly RegulatorySourceTier[] = [1, 2, 3]

export const SUPPORTED_AUTHORITY_TYPES: readonly RegulatorySourceAuthorityType[] = [
  'primary_regulator',
  'ministry',
  'official_gazette',
  'court',
  'standards_body',
  'industry_association',
  'news_media',
  'aggregator',
  'other',
]

export const SUPPORTED_SOURCE_CATEGORIES: readonly RegulatorySourceCategory[] = [
  'cultivation',
  'export_import',
  'pharmaceutical',
  'data_protection',
  'licensing',
  'testing_quality',
  'general',
]

export const SUPPORTED_MONITORING_METHODS: readonly RegulatorySourceMonitoringMethod[] = [
  'rss',
  'atom',
  'html',
  'pdf',
  'government_api',
  'manual',
]

export const MIN_SOURCE_PRIORITY = 1
export const MAX_SOURCE_PRIORITY = 100

// Human-facing tier labels — deliberately careful wording. Tier 3 is never
// described as authoritative anywhere in the product.
export const SOURCE_TIER_LABELS: Record<RegulatorySourceTier, string> = {
  1: 'Tier 1 — Primary authority',
  2: 'Tier 2 — Authoritative secondary',
  3: 'Tier 3 — Intelligence signal',
}

// ─── The Tier-3 authority guard ──────────────────────────────────────────────

/**
 * Whether a source may act as a DIRECT authority for downstream compliance
 * state. Tier 1 and Tier 2 may; Tier 3 (intelligence signal) may not, and an
 * unclassified source (no tier yet) may not either — fail closed. A Tier 3
 * source can still produce a candidate legal update for the human Review Queue;
 * "direct authority" here specifically means driving an approved rule, an
 * entity authority/readiness determination, or an export decision without a
 * human corroborating it against a Tier 1/2 source first.
 */
export function canActAsDirectAuthority(tier: RegulatorySourceTier | null | undefined): boolean {
  return tier === 1 || tier === 2
}

export interface Tier3AuthorityGuardResult {
  allowed: boolean
  reason: string
}

/**
 * Pure gate a downstream consumer (rule activation, authority determination,
 * export state) calls before letting a source drive state. Returns a decision;
 * it does not throw, so callers choose how to surface the block. `context`
 * names the downstream action for a precise message.
 */
export function guardTier3Authority(
  source: Pick<RegulatorySource, 'id' | 'tier'> | null | undefined,
  context: string,
): Tier3AuthorityGuardResult {
  if (!source) {
    return { allowed: false, reason: `${context}: no source supplied; cannot treat an absent source as authority.` }
  }
  if (source.tier == null) {
    return {
      allowed: false,
      reason: `${context}: source ${source.id} is unclassified (no tier); classify it as Tier 1/2 before it can drive compliance state.`,
    }
  }
  if (!canActAsDirectAuthority(source.tier)) {
    return {
      allowed: false,
      reason: `${context}: source ${source.id} is Tier ${source.tier} (intelligence signal). A Tier 3 source can raise an item for human review but must never directly drive compliance state.`,
    }
  }
  return { allowed: true, reason: `${context}: source ${source.id} is Tier ${source.tier} and may act as a direct authority.` }
}

/**
 * Throwing form for code paths where a Tier-3 source reaching this point is a
 * programming error that must fail loudly rather than silently no-op.
 */
export function assertNotTier3Authority(
  source: Pick<RegulatorySource, 'id' | 'tier'> | null | undefined,
  context: string,
): void {
  const result = guardTier3Authority(source, context)
  if (!result.allowed) {
    throw new Error(result.reason)
  }
}

// ─── Governance validation ───────────────────────────────────────────────────

export interface SourceGovernanceFields {
  tier: RegulatorySourceTier
  authorityType: RegulatorySourceAuthorityType
  category: RegulatorySourceCategory
  monitoringMethod: RegulatorySourceMonitoringMethod
  priority: number
}

export interface SourceGovernanceValidationResult {
  valid: boolean
  errors: string[]
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * Pure validation of the governance fields — no Supabase, no side effects. Any
 * out-of-vocabulary value, or a priority outside [1,100], is rejected with an
 * explicit message. This is the app-layer mirror of the DB CHECK constraints.
 *
 * A cross-field integrity rule is also enforced here: a Tier 1 (primary
 * authority) source may not be classified with a non-authoritative authority
 * type (news_media / aggregator). That combination is contradictory — a primary
 * authority is by definition not a news aggregator — and letting it through
 * would let a mis-tiered source act as direct authority.
 */
export function validateSourceGovernance(fields: {
  tier: unknown
  authorityType: unknown
  category: unknown
  monitoringMethod: unknown
  priority: unknown
}): SourceGovernanceValidationResult {
  const errors: string[] = []

  if (!SUPPORTED_SOURCE_TIERS.includes(fields.tier as RegulatorySourceTier)) {
    errors.push(`tier must be one of: ${SUPPORTED_SOURCE_TIERS.join(', ')}`)
  }
  if (!SUPPORTED_AUTHORITY_TYPES.includes(fields.authorityType as RegulatorySourceAuthorityType)) {
    errors.push(`authorityType must be one of: ${SUPPORTED_AUTHORITY_TYPES.join(', ')}`)
  }
  if (!SUPPORTED_SOURCE_CATEGORIES.includes(fields.category as RegulatorySourceCategory)) {
    errors.push(`category must be one of: ${SUPPORTED_SOURCE_CATEGORIES.join(', ')}`)
  }
  if (!SUPPORTED_MONITORING_METHODS.includes(fields.monitoringMethod as RegulatorySourceMonitoringMethod)) {
    errors.push(`monitoringMethod must be one of: ${SUPPORTED_MONITORING_METHODS.join(', ')}`)
  }
  if (!isInteger(fields.priority) || (fields.priority as number) < MIN_SOURCE_PRIORITY || (fields.priority as number) > MAX_SOURCE_PRIORITY) {
    errors.push(`priority must be an integer in [${MIN_SOURCE_PRIORITY}, ${MAX_SOURCE_PRIORITY}]`)
  }

  // Cross-field contradiction: a primary authority cannot be a news/aggregator.
  if (
    fields.tier === 1 &&
    (fields.authorityType === 'news_media' || fields.authorityType === 'aggregator')
  ) {
    errors.push('a Tier 1 primary authority cannot have authorityType news_media or aggregator (contradictory classification)')
  }

  return { valid: errors.length === 0, errors }
}

// ─── Defaulting ──────────────────────────────────────────────────────────────

/**
 * The conservative governance default for a source that carries no explicit
 * classification (e.g. a legacy row from before migration 26, or a create form
 * that omitted the fields). Deliberately the LEAST authoritative shape: Tier 3
 * signal, aggregator, general category, manual monitoring, lowest priority — so
 * an unclassified source can never accidentally act as authority. The operator
 * must consciously promote it.
 */
export function defaultSourceGovernance(): SourceGovernanceFields {
  return {
    tier: 3,
    authorityType: 'aggregator',
    category: 'general',
    monitoringMethod: 'manual',
    priority: MAX_SOURCE_PRIORITY, // lowest urgency
  }
}

// ─── Ordering (pure) ─────────────────────────────────────────────────────────

/**
 * Deterministic monitoring order: authoritative tiers first (1 before 3), then
 * by ascending priority (1 = most urgent), then by name for stability. An
 * unclassified (null-tier) source sorts last. Pure; used to schedule which
 * sources a run checks first.
 */
export function compareSourcesForMonitoring(a: RegulatorySource, b: RegulatorySource): number {
  const tierA = a.tier ?? 99
  const tierB = b.tier ?? 99
  if (tierA !== tierB) return tierA - tierB
  const prioA = a.priority ?? MAX_SOURCE_PRIORITY
  const prioB = b.priority ?? MAX_SOURCE_PRIORITY
  if (prioA !== prioB) return prioA - prioB
  return a.name.localeCompare(b.name)
}
