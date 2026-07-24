import type {
  RegulatorySource,
  RegulatorySourceAuthorityType,
  RegulatorySourceCategory,
  RegulatorySourceMonitoringMethod,
  RegulatorySourceTier,
} from '../types'
import * as repo from './complianceRepository'
import { validateSourceGovernance } from './complianceSourceGovernance'

// ─── Compliance Source Registry — service layer ─────────────────────────────
//
// This is the trusted registry that future monitoring will consume — it is
// NOT monitoring, NOT AI, NOT web scraping, and NOT rule creation. It owns
// validation, duplicate detection, and the application-level status model
// for regulatory_sources. Raw persistence stays in complianceRepository.ts;
// nothing in this file talks to Supabase directly except by calling that
// module's exported functions.
//
// No polling, no fetch, no scheduling, no external network call of any kind
// happens here or is triggered by anything in this file.

export type RegulatorySourceType =
  | 'government_regulator'
  | 'legal_database'
  | 'industry_association'
  | 'news_press_release'
  | 'other'

export const SUPPORTED_SOURCE_TYPES: RegulatorySourceType[] = [
  'government_regulator',
  'legal_database',
  'industry_association',
  'news_press_release',
  'other',
]

// ─── Application-level status model ──────────────────────────────────────────
//
// Derived entirely from existing regulatory_sources columns — no new database
// column is added or required for this. See deriveRegulatorySourceStatus for
// exactly what is (and isn't) reliably derivable today.

export type RegulatorySourceStatus = 'ACTIVE' | 'DISABLED' | 'TEST' | 'ARCHIVED'

// Simplest available convention for marking a source as a test/sandbox entry
// without a dedicated column: "test" as a whole word in the name or URL.
const TEST_NAME_PATTERN = /\btest\b/i

/**
 * Derives an application-level status from existing fields only.
 *
 * ACTIVE / DISABLED / TEST are reliably derivable from `is_active`, `name`,
 * and `url` today. ARCHIVED is part of the model but is NOT currently
 * derivable — a disabled source and a deliberately-archived source look
 * identical with only `is_active` to go on. A dedicated `archived_at
 * TIMESTAMPTZ` column would be needed to distinguish them reliably. That
 * field is documented here as a recommendation, not implemented — this
 * function will never return 'ARCHIVED' until such a column exists.
 */
export function deriveRegulatorySourceStatus(source: RegulatorySource): RegulatorySourceStatus {
  const looksLikeTest = TEST_NAME_PATTERN.test(source.name) || TEST_NAME_PATTERN.test(source.url)
  if (looksLikeTest) return 'TEST'
  return source.isActive ? 'ACTIVE' : 'DISABLED'
}

// ─── Validation ───────────────────────────────────────────────────────────

export interface RegulatorySourceCandidate {
  name: string
  jurisdiction: string
  sourceType: string
  url: string
  isActive: boolean
}

export interface RegulatorySourceValidationResult {
  valid: boolean
  errors: string[]
}

function isValidHttpUrl(value: string): boolean {
  if (!value || !value.trim()) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

// Canonical comparison key for a source URL — the SINGLE source of truth for
// "are these the same source?", shared by registry duplicate detection and
// starter-source missing detection so the two never drift apart.
//
// Regulatory source URLs are a single official domain, so the conservative
// choice (fewer accidental duplicates) is case-insensitive comparison. On top
// of that this collapses the semantic equivalents that the previous
// trim+lowercase key missed and that caused duplicate insertions:
//   - default ports          (https://x.gov:443 == https://x.gov)
//   - trailing-slash paths    (/feed == /feed/, and / == root)
//   - hash fragments          (…/feed#top == …/feed — hash never identifies a source)
// Query strings are preserved (they can be semantically significant, e.g.
// ?rssId=222). Deterministic; a non-parseable input falls back to the prior
// trim+lowercase behaviour rather than throwing.
export function canonicalizeSourceUrl(value: string): string {
  const trimmed = value.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return trimmed.toLowerCase()
  }
  const isDefaultPort =
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  const host = isDefaultPort ? parsed.hostname : parsed.host
  const path = parsed.pathname.replace(/\/+$/, '')
  // hash intentionally excluded from the key
  return `${parsed.protocol}//${host}${path}${parsed.search}`.toLowerCase()
}

/**
 * Pure validation — no Supabase, no side effects. `existingSources` is
 * supplied by the caller (already fetched) so this function never performs
 * I/O itself and is fully unit-testable. Pass `excludeId` when validating an
 * update, so a source doesn't collide with its own existing URL.
 */
export function validateRegulatorySource(
  candidate: RegulatorySourceCandidate,
  existingSources: RegulatorySource[],
  excludeId?: string,
): RegulatorySourceValidationResult {
  const errors: string[] = []

  if (!candidate.name || !candidate.name.trim()) {
    errors.push('name is required')
  }

  if (!candidate.jurisdiction || !candidate.jurisdiction.trim()) {
    errors.push('jurisdiction is required')
  }

  if (typeof candidate.isActive !== 'boolean') {
    errors.push('isActive must be a boolean')
  }

  if (!SUPPORTED_SOURCE_TYPES.includes(candidate.sourceType as RegulatorySourceType)) {
    errors.push(`sourceType must be one of: ${SUPPORTED_SOURCE_TYPES.join(', ')}`)
  }

  if (!isValidHttpUrl(candidate.url)) {
    errors.push('url must be a valid absolute http(s) URL (e.g. https://example.gov)')
  } else {
    const normalized = canonicalizeSourceUrl(candidate.url)
    const isDuplicate = existingSources.some(
      source => source.id !== excludeId && canonicalizeSourceUrl(source.url) === normalized,
    )
    if (isDuplicate) {
      errors.push('url already exists in the registry (duplicate source)')
    }
  }

  return { valid: errors.length === 0, errors }
}

// ─── Write decision (validation gate) ────────────────────────────────────
//
// The mechanism that makes "validation failures never reach repository
// writes" true: createRegulatorySource/updateRegulatorySource only ever call
// the repository when decideRegulatorySourceWrite returns action: 'write'.
// Pure and Supabase-free, so this gate itself is directly unit-testable.

export interface RegulatorySourceWriteDecision {
  action: 'reject' | 'write'
  errors: string[]
  payload?: RegulatorySourceCandidate
}

export function decideRegulatorySourceWrite(
  candidate: RegulatorySourceCandidate,
  existingSources: RegulatorySource[],
  excludeId?: string,
): RegulatorySourceWriteDecision {
  const validation = validateRegulatorySource(candidate, existingSources, excludeId)
  if (!validation.valid) {
    return { action: 'reject', errors: validation.errors }
  }
  return { action: 'write', errors: [], payload: candidate }
}

// ─── Reads ────────────────────────────────────────────────────────────────

export async function listRegulatorySources(): Promise<RegulatorySource[]> {
  return repo.fetchRegulatorySources()
}

/** Pure filter, exported separately so "inactive filtering" is testable without Supabase. */
export function filterActiveRegulatorySources(sources: RegulatorySource[]): RegulatorySource[] {
  return sources.filter(source => source.isActive)
}

export async function listActiveRegulatorySources(): Promise<RegulatorySource[]> {
  return filterActiveRegulatorySources(await listRegulatorySources())
}

export async function getRegulatorySource(id: string): Promise<RegulatorySource | null> {
  const sources = await listRegulatorySources()
  return sources.find(source => source.id === id) ?? null
}

// ─── Writes ───────────────────────────────────────────────────────────────

// Governance fields a caller may supply on create/update. All optional: when
// omitted the database applies the conservative Tier-3 signal default. When any
// ONE is supplied, the FULL set must be supplied and valid — a half-classified
// source is refused rather than silently defaulted, so a mistaken partial edit
// cannot leave a source in an ambiguous authority state.
export interface SourceGovernanceInput {
  tier?: RegulatorySourceTier
  authorityType?: RegulatorySourceAuthorityType
  category?: RegulatorySourceCategory
  monitoringMethod?: RegulatorySourceMonitoringMethod
  priority?: number
}

function hasAnyGovernanceField(g: SourceGovernanceInput): boolean {
  return (
    g.tier !== undefined ||
    g.authorityType !== undefined ||
    g.category !== undefined ||
    g.monitoringMethod !== undefined ||
    g.priority !== undefined
  )
}

/**
 * Validates governance fields when the caller supplied any. Returns the errors
 * (empty when valid, or when the caller supplied none and is happy to accept the
 * DB default). Mirrors the DB CHECK constraints so the UI fails closed early.
 */
export function validateGovernanceInputForWrite(g: SourceGovernanceInput): string[] {
  if (!hasAnyGovernanceField(g)) return []
  const result = validateSourceGovernance({
    tier: g.tier,
    authorityType: g.authorityType,
    category: g.category,
    monitoringMethod: g.monitoringMethod,
    priority: g.priority,
  })
  return result.errors
}

function governancePayload(g: SourceGovernanceInput): SourceGovernanceInput {
  return {
    ...(g.tier !== undefined ? { tier: g.tier } : {}),
    ...(g.authorityType !== undefined ? { authorityType: g.authorityType } : {}),
    ...(g.category !== undefined ? { category: g.category } : {}),
    ...(g.monitoringMethod !== undefined ? { monitoringMethod: g.monitoringMethod } : {}),
    ...(g.priority !== undefined ? { priority: g.priority } : {}),
  }
}

export interface CreateRegulatorySourceInput extends SourceGovernanceInput {
  name: string
  jurisdiction: string
  sourceType: string
  url: string
  isActive?: boolean
}

export async function createRegulatorySource(input: CreateRegulatorySourceInput): Promise<RegulatorySource> {
  const existing = await listRegulatorySources()
  const candidate: RegulatorySourceCandidate = {
    name: input.name.trim(),
    jurisdiction: input.jurisdiction.trim(),
    sourceType: input.sourceType,
    url: input.url.trim(),
    isActive: input.isActive ?? true,
  }
  const decision = decideRegulatorySourceWrite(candidate, existing)
  if (decision.action === 'reject') {
    throw new Error(`Cannot create regulatory source: ${decision.errors.join('; ')}`)
  }
  const governanceErrors = validateGovernanceInputForWrite(input)
  if (governanceErrors.length > 0) {
    throw new Error(`Cannot create regulatory source: ${governanceErrors.join('; ')}`)
  }
  return repo.insertRegulatorySource({
    ...(decision.payload as RegulatorySourceCandidate),
    ...governancePayload(input),
  })
}

export interface UpdateRegulatorySourceInput extends SourceGovernanceInput {
  name?: string
  jurisdiction?: string
  sourceType?: string
  url?: string
  isActive?: boolean
}

export async function updateRegulatorySource(id: string, patch: UpdateRegulatorySourceInput): Promise<RegulatorySource> {
  const existing = await listRegulatorySources()
  const current = existing.find(source => source.id === id)
  if (!current) {
    throw new Error(`Regulatory source not found: ${id}`)
  }

  const candidate: RegulatorySourceCandidate = {
    name: (patch.name ?? current.name).trim(),
    jurisdiction: (patch.jurisdiction ?? current.jurisdiction).trim(),
    sourceType: patch.sourceType ?? current.sourceType,
    url: (patch.url ?? current.url).trim(),
    isActive: patch.isActive ?? current.isActive,
  }
  const decision = decideRegulatorySourceWrite(candidate, existing, id)
  if (decision.action === 'reject') {
    throw new Error(`Cannot update regulatory source: ${decision.errors.join('; ')}`)
  }
  // A governance edit must classify the source completely against its resulting
  // state — validate the merge of the current classification and the patch, so
  // e.g. re-tiering a source to 1 while it is still an aggregator is refused.
  const governancePatch: SourceGovernanceInput = governancePayload(patch)
  if (hasAnyGovernanceField(governancePatch)) {
    const merged: SourceGovernanceInput = {
      tier: patch.tier ?? current.tier ?? undefined,
      authorityType: patch.authorityType ?? current.authorityType ?? undefined,
      category: patch.category ?? current.category ?? undefined,
      monitoringMethod: patch.monitoringMethod ?? current.monitoringMethod ?? undefined,
      priority: patch.priority ?? current.priority ?? undefined,
    }
    const governanceErrors = validateGovernanceInputForWrite(merged)
    if (governanceErrors.length > 0) {
      throw new Error(`Cannot update regulatory source: ${governanceErrors.join('; ')}`)
    }
  }
  return repo.updateRegulatorySource(id, {
    ...(decision.payload as RegulatorySourceCandidate),
    ...governancePatch,
  })
}

export async function deactivateRegulatorySource(id: string): Promise<RegulatorySource> {
  return updateRegulatorySource(id, { isActive: false })
}
