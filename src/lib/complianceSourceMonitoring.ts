// ─── Compliance Source Monitoring — skeleton (Phase 1D) ─────────────────────
//
// Defines how a source content change would be detected and decided on —
// nothing here fetches anything, calls Supabase, calls an AI provider, or
// writes anything. Every exported function is pure (or, for checksums,
// pure-modulo-hashing) and returns a decision only. Wiring a real fetch, a
// schedule, and a persistence call is explicitly out of scope for this
// phase — see buildMonitoringDecision's own comment for exactly what a
// decision may and may never propose.
//
// Hashing reuses the same technique already proven elsewhere in this
// codebase (src/lib/buyerPackSnapshot.ts's sha256Hex) — Web Crypto's
// crypto.subtle.digest, available natively in both the browser and this
// project's Node test environment, so no new dependency is needed.

export interface SourceContentSnapshot {
  sourceId: string
  normalizedContent: string
  checksum: string
  retrievedAt: string
}

export type SourceSnapshotComparison = 'unchanged' | 'changed' | 'first_seen'

export type MonitoringDecisionKind = 'unchanged' | 'changed_pending_review' | 'invalid_source' | 'duplicate' | 'error'

/**
 * What a decision may propose creating. `status` is deliberately typed as
 * the literal 'new' — not the general LegalUpdateStatus — so it is
 * structurally impossible for this type to ever propose 'approved' or
 * 'active'. There is no rule-related field anywhere in this interface: a
 * monitoring decision can propose a legal_update draft, and nothing else.
 */
export interface ProposedLegalUpdateIntent {
  status: 'new'
  sourceId: string
  rawContent: string
  normalizedContent: string
  checksum: string
  retrievedAt: string
}

export interface MonitoringDecision {
  kind: MonitoringDecisionKind
  sourceId: string
  reason: string
  snapshot?: SourceContentSnapshot
  proposedLegalUpdate?: ProposedLegalUpdateIntent
}

// ─── Normalization ────────────────────────────────────────────────────────

/**
 * Collapses every run of whitespace (spaces, tabs, line breaks of any
 * style) into a single space, then trims the ends. Deliberately treats line
 * breaks as insignificant, not just horizontal spacing — a source re-fetch
 * commonly reflows where line breaks fall (HTML-to-text conversion, PDF
 * extraction, a page re-render) without the underlying content changing at
 * all, and that reflow must not register as a content change. Pure,
 * synchronous, deterministic.
 */
export function normalizeSourceContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

// ─── Checksum ─────────────────────────────────────────────────────────────

/**
 * SHA-256 hex digest of the given content. Same technique as
 * buyerPackSnapshot.ts's sha256Hex — Web Crypto API, no dependency.
 */
export async function computeSourceChecksum(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Normalizes then hashes in one step — the standard way to build a snapshot. */
export async function buildSourceSnapshot(
  sourceId: string,
  rawContent: string,
  retrievedAt: string = new Date().toISOString(),
): Promise<SourceContentSnapshot> {
  const normalizedContent = normalizeSourceContent(rawContent)
  const checksum = await computeSourceChecksum(normalizedContent)
  return { sourceId, normalizedContent, checksum, retrievedAt }
}

// ─── Change detection ─────────────────────────────────────────────────────

/**
 * Compares two snapshots for the same source. `previous: null` means no
 * prior snapshot is on record for this source — reported as 'first_seen'
 * rather than 'changed' so callers can distinguish "genuinely new source"
 * from "content actually differs from what we had."
 */
export function compareSourceSnapshot(
  previous: SourceContentSnapshot | null,
  current: SourceContentSnapshot,
): SourceSnapshotComparison {
  if (!previous) return 'first_seen'
  if (previous.sourceId !== current.sourceId) {
    throw new Error('compareSourceSnapshot: previous and current snapshots belong to different sources')
  }
  return previous.checksum === current.checksum ? 'unchanged' : 'changed'
}

export function shouldCreateLegalUpdateFromSourceChange(comparison: SourceSnapshotComparison): boolean {
  return comparison === 'changed' || comparison === 'first_seen'
}

// ─── Validation ───────────────────────────────────────────────────────────

export interface SourceContentValidationResult {
  valid: boolean
  reason?: string
}

export function validateSourceContent(sourceId: string, rawContent: string): SourceContentValidationResult {
  if (!sourceId || !sourceId.trim()) {
    return { valid: false, reason: 'sourceId is required' }
  }
  if (!rawContent || normalizeSourceContent(rawContent).length === 0) {
    return { valid: false, reason: 'source content is empty after normalization' }
  }
  return { valid: true }
}

// ─── Decision ─────────────────────────────────────────────────────────────

/**
 * The single entry point. Returns intent only — never fetches, never calls
 * Supabase, never calls an AI provider, and never performs a write of any
 * kind. Callers (a future phase) remain responsible for actually creating a
 * legal_update from `proposedLegalUpdate`, and that legal_update still goes
 * through the exact same human Review Queue as a manually-pasted one — this
 * function has no ability to approve, enforce, or create a compliance_rule.
 *
 * `knownChecksums` lets a caller flag content that has already been turned
 * into a legal_update from a different poll/source (e.g. the same notice
 * mirrored on two pages) — distinct from `previousSnapshot`, which is
 * specifically "the last snapshot recorded for this exact source."
 */
export async function buildMonitoringDecision(
  sourceId: string,
  rawContent: string,
  previousSnapshot: SourceContentSnapshot | null,
  knownChecksums: string[] = [],
  retrievedAt: string = new Date().toISOString(),
): Promise<MonitoringDecision> {
  const validation = validateSourceContent(sourceId, rawContent)
  if (!validation.valid) {
    return { kind: 'invalid_source', sourceId, reason: validation.reason ?? 'invalid source content' }
  }

  let snapshot: SourceContentSnapshot
  try {
    snapshot = await buildSourceSnapshot(sourceId, rawContent, retrievedAt)
  } catch (err) {
    return { kind: 'error', sourceId, reason: err instanceof Error ? err.message : 'failed to build source snapshot' }
  }

  if (knownChecksums.includes(snapshot.checksum)) {
    return {
      kind: 'duplicate',
      sourceId,
      reason: 'checksum matches an already-known snapshot; not proposing a new legal update',
      snapshot,
    }
  }

  const comparison = compareSourceSnapshot(previousSnapshot, snapshot)
  if (!shouldCreateLegalUpdateFromSourceChange(comparison)) {
    return {
      kind: 'unchanged',
      sourceId,
      reason: 'checksum matches the previous snapshot for this source',
      snapshot,
    }
  }

  return {
    kind: 'changed_pending_review',
    sourceId,
    reason: comparison === 'first_seen'
      ? 'no previous snapshot on record for this source — treated as a change requiring review'
      : 'content checksum differs from the previous snapshot for this source',
    snapshot,
    proposedLegalUpdate: {
      status: 'new',
      sourceId,
      rawContent,
      normalizedContent: snapshot.normalizedContent,
      checksum: snapshot.checksum,
      retrievedAt: snapshot.retrievedAt,
    },
  }
}
