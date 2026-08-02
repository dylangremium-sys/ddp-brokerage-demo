import type { RegulatorySource } from '../types.js'
import type { FeedItemFields, FeedItemFieldPolicy } from './complianceRssConnector.js'

// ─── Cannamonitor source policy — fail-closed, source-specific ───────────────
//
// STATUS: INACTIVE AND UNREACHABLE.
//
// Cannamonitor (cannamonitor.com) is treated as SECONDARY COMMERCIAL
// INTELLIGENCE: a non-governmental, non-authoritative publisher whose items may
// indicate that something happened worth investigating, but can never — alone —
// establish a legal change, compliance, non-compliance, export eligibility,
// pharmaceutical suitability, buyer/supplier/farm/batch approval, or COA
// acceptance. Those consequences are already structurally impossible for a
// monitoring decision to produce anywhere in this codebase (see
// complianceSourceMonitoring.ts, whose ProposedLegalUpdateIntent.status is the
// literal 'new'), and nothing here weakens that. This module only ADDS
// restrictions; it never grants a capability.
//
// This module exists for a legal reason, not a technical one. DDP's commercial
// permission to reproduce or process Cannamonitor content is UNVERIFIED, and
// that assumption must fail closed. So the policy is deny-by-default in two
// independent ways:
//
//   1. PERMISSION GATE. CANNAMONITOR_PERMISSION_STATUS is 'unverified'. While it
//      is 'unverified', monitoring and AI are DENIED before any network call is
//      attempted. Marking the source `isActive: true` does NOT bypass this:
//      retrieval requires BOTH an active source AND verified permission. No UI
//      control, environment variable, database field, or runtime input can flip
//      the constant — changing it is a reviewed source-code edit, which is a
//      legal decision, not a coding one. This task adds no such activation path.
//
//   2. METADATA-ONLY PROJECTION. Even under a hypothetical future verified
//      permission, the projection below discards description / summary /
//      content / content:encoded / HTML *before* the monitoring rawText is
//      assembled — it runs on the parsed FIELDS, ahead of the connector's
//      finalizeItem(). Prohibited content is therefore never concatenated,
//      hashed, carried into a monitoring decision or proposed draft, persisted,
//      or handed to an AI provider. It is not ingested and then scrubbed; it
//      never enters a retained value at all.
//
// Transport safety (HTTPS-only, exact-match deny-by-default host allowlist,
// SSRF guard for loopback / private / link-local / cloud-metadata addresses,
// port policy, redirect refusal) is NOT re-implemented here — it already lives
// in complianceSourceConnectorRuntime.ts + complianceRssConnector.ts and is
// reused unchanged. This module layers Cannamonitor-specific restrictions on
// top of those generic controls.
//
// Every export is pure and deterministic. Nothing here fetches, persists,
// writes to Supabase, creates a source row, schedules a fetch, creates a rule
// or alert, changes readiness, or mutates any farm / inventory / batch / COA /
// buyer / document / shipment state.

// ─── Permission state ────────────────────────────────────────────────────────

export type CannamonitorPermissionStatus = 'unverified' | 'verified'

/**
 * The single source of truth for whether DDP holds documented written
 * permission (or an appropriate licence) to retrieve and process Cannamonitor
 * content commercially.
 *
 * IT IS 'unverified' AND MUST STAY THAT WAY until such permission actually
 * exists in writing. It is a compile-time constant on purpose: there is no
 * admin toggle, no database column, no environment variable, and no runtime
 * parameter in any production caller that can flip it, so it cannot be enabled
 * by accident or by a non-legal actor. Any future activation must be a reviewed
 * code change (or a separately approved durable permission mechanism that does
 * not yet exist and is deliberately not added here).
 */
export const CANNAMONITOR_PERMISSION_STATUS: CannamonitorPermissionStatus = 'unverified'

// ─── Approved hosts ──────────────────────────────────────────────────────────

/**
 * The ONLY hosts that count as an approved Cannamonitor endpoint. Exact,
 * whole-host matches — never suffix matches, so `cannamonitor.com.evil.example`
 * can never satisfy an entry here. `www.` is listed intentionally: the site
 * serves both, and omitting it would silently route the www host down the
 * generic (unrestricted) connector path.
 */
export const APPROVED_CANNAMONITOR_HOSTS: readonly string[] = ['cannamonitor.com', 'www.cannamonitor.com']

/** The metadata fields this policy permits to be retained and hashed. */
export const CANNAMONITOR_RETAINED_METADATA: readonly string[] = [
  'title',
  'canonicalItemUrl',
  'itemIdOrGuid',
  'publicationDate',
]

/** Fields that must never be retained, hashed, persisted, or sent to an AI provider. */
export const CANNAMONITOR_DISCARDED_CONTENT: readonly string[] = [
  'description',
  'summary',
  'content',
  'content:encoded',
  'articleBody',
  'html',
  'images',
  'authorCommentary',
  'paidContent',
  'subscriberContent',
]

// ─── Decision model ──────────────────────────────────────────────────────────

export type CannamonitorDenialCode =
  | 'malformed_url'
  | 'unapproved_host'
  | 'not_https'
  | 'credentials_in_url'
  | 'unexpected_port'
  | 'permission_unverified'
  | 'source_inactive'

export interface CannamonitorPolicyDecision {
  /** True when this source is Cannamonitor-owned and the policy therefore applies. */
  matched: boolean
  permission: CannamonitorPermissionStatus
  /** May a network retrieval be attempted at all? False whenever `matched` and anything is unsatisfied. */
  monitoringAllowed: boolean
  /** May content derived from this source be submitted to an AI provider? */
  aiAllowed: boolean
  denialCode?: CannamonitorDenialCode
  reason: string
  /** Non-null only when the policy applies — the projection the connector must use. */
  fieldPolicy: FeedItemFieldPolicy | null
  retainedMetadata: readonly string[]
  discardedContent: readonly string[]
  // Capability guarantees (literal false): this policy can only ever RESTRICT.
  canCreateRule: false
  canCreateAlert: false
  canAlterReadiness: false
  canCreateSourceRow: false
  canScheduleFetch: false
}

// ─── Host matching (pure, fail-closed) ───────────────────────────────────────

function parse(url: string): URL | null {
  if (!url || !url.trim()) return null
  try {
    return new URL(url.trim())
  } catch {
    return null
  }
}

/** Lowercased hostname with any trailing FQDN dot removed. */
function hostOf(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/\.$/, '')
}

/** True only for an exact, whole-host match against APPROVED_CANNAMONITOR_HOSTS. */
export function isApprovedCannamonitorHost(host: string): boolean {
  return APPROVED_CANNAMONITOR_HOSTS.includes(host.toLowerCase().replace(/\.$/, ''))
}

/**
 * True when the URL belongs to Cannamonitor in ANY form — an approved host, an
 * unapproved subdomain, an http URL, a URL carrying credentials, an odd port,
 * or an unparseable string that still names cannamonitor.
 *
 * This is deliberately BROADER than "approved". Matching decides whether the
 * policy APPLIES, not whether retrieval is allowed — and it must be broad,
 * because a Cannamonitor URL that failed to match would fall through to the
 * generic connector, which would happily fetch and store the article body. The
 * denial codes, not the matcher, enforce the restrictions.
 *
 * A deceptive suffix domain such as `cannamonitor.com.evil.example` is a
 * DIFFERENT site owned by someone else, so it does NOT match: it must never be
 * able to inherit Cannamonitor's identity or (if ever granted) its permission.
 */
export function isCannamonitorSourceUrl(url: string): boolean {
  const parsed = parse(url)
  if (!parsed) {
    // Fail closed: an unparseable string that still names cannamonitor.com is
    // treated as Cannamonitor (and therefore denied) rather than waved through.
    return /(^|[^a-z0-9-])cannamonitor\.com([^a-z0-9-]|$)/i.test(url ?? '')
  }
  const host = hostOf(parsed)
  return isApprovedCannamonitorHost(host) || host === 'cannamonitor.com' || host.endsWith('.cannamonitor.com')
}

// ─── Metadata-only projection ────────────────────────────────────────────────

/**
 * Strips every prohibited field, keeping ONLY title / link (canonical URL) /
 * id (guid) / published (publication date).
 *
 * This runs on the parsed FIELDS, before the connector's finalizeItem() builds
 * `rawText` from them — so description, summary, content and content:encoded
 * never enter the concatenation, never reach the checksum, and never reach a
 * proposed draft. `summary` and `content` are hard-nulled here regardless of
 * what the parser produced: if a future change taught the RSS extractor to read
 * <content:encoded> (a natural-looking "improvement"), the full article body
 * still could not escape through this policy.
 */
export const CANNAMONITOR_METADATA_ONLY_PROJECTION: FeedItemFieldPolicy = {
  policyId: 'cannamonitor-metadata-only',
  projectFields(fields: FeedItemFields): FeedItemFields {
    return {
      title: fields.title,
      link: fields.link,
      id: fields.id,
      published: fields.published,
      // Prohibited while permission is unverified — discarded, never retained.
      summary: null,
      content: null,
    }
  },
}

// ─── Policy evaluation (pure) ────────────────────────────────────────────────

const NOT_MATCHED_REASON = 'Not a Cannamonitor source — the Cannamonitor policy does not apply.'

function decision(
  partial: Pick<CannamonitorPolicyDecision, 'matched' | 'permission' | 'monitoringAllowed' | 'aiAllowed' | 'reason'> &
    Partial<Pick<CannamonitorPolicyDecision, 'denialCode' | 'fieldPolicy'>>,
): CannamonitorPolicyDecision {
  return {
    ...partial,
    fieldPolicy: partial.fieldPolicy ?? null,
    retainedMetadata: CANNAMONITOR_RETAINED_METADATA,
    discardedContent: CANNAMONITOR_DISCARDED_CONTENT,
    canCreateRule: false,
    canCreateAlert: false,
    canAlterReadiness: false,
    canCreateSourceRow: false,
    canScheduleFetch: false,
  }
}

export type CannamonitorPolicySource = Pick<RegulatorySource, 'url'> & Partial<Pick<RegulatorySource, 'isActive'>>

/**
 * The single entry point. Decides whether the Cannamonitor policy applies to a
 * source and, if so, whether monitoring and AI are permitted.
 *
 * `permission` defaults to the module constant, so every production caller is
 * fail-closed and cannot opt out. The parameter exists ONLY so tests can prove
 * what happens in the hypothetical 'verified' world — notably that verified
 * permission STILL does not permit http, credentialled URLs, odd ports,
 * unapproved hosts, or an inactive source.
 *
 * Monitoring requires BOTH verified permission AND an active source: an active
 * source with unverified permission is denied, and verified permission on an
 * inactive source is denied. Setting `isActive: true` alone can never enable
 * retrieval.
 */
export function evaluateCannamonitorPolicy(
  source: CannamonitorPolicySource,
  permission: CannamonitorPermissionStatus = CANNAMONITOR_PERMISSION_STATUS,
): CannamonitorPolicyDecision {
  const url = source.url ?? ''

  if (!isCannamonitorSourceUrl(url)) {
    // Policy does not apply. Unrelated sources keep their existing behaviour
    // exactly — no projection, no extra gate, nothing changed for them.
    return decision({
      matched: false,
      permission,
      monitoringAllowed: true,
      aiAllowed: true,
      reason: NOT_MATCHED_REASON,
    })
  }

  // From here on the source IS Cannamonitor: the metadata-only projection always
  // applies. Every matched DENIAL blocks BOTH monitoring and AI — `aiAllowed` is
  // never derived from permission alone. A Cannamonitor URL refused for
  // transport / host / credential / port / permission / activity reasons must
  // not become AI-eligible just because permission is (hypothetically) verified;
  // otherwise a legal update attributed to a refused URL could still send its
  // evidence to the provider. Only the final fully-successful branch below sets
  // `aiAllowed: true`.
  const deny = (denialCode: CannamonitorDenialCode, reason: string): CannamonitorPolicyDecision =>
    decision({
      matched: true,
      permission,
      monitoringAllowed: false,
      aiAllowed: false,
      denialCode,
      reason,
      fieldPolicy: CANNAMONITOR_METADATA_ONLY_PROJECTION,
    })

  const parsed = parse(url)
  if (!parsed) {
    return deny('malformed_url', 'Cannamonitor source URL is malformed and cannot be validated. Monitoring denied.')
  }

  const host = hostOf(parsed)
  if (!isApprovedCannamonitorHost(host)) {
    return deny(
      'unapproved_host',
      `Host "${host}" is a Cannamonitor host that is not on the approved list (${APPROVED_CANNAMONITOR_HOSTS.join(', ')}). Monitoring denied.`,
    )
  }
  if (parsed.protocol !== 'https:') {
    return deny('not_https', `Cannamonitor must be retrieved over https; scheme "${parsed.protocol}" is refused.`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return deny(
      'credentials_in_url',
      'Cannamonitor source URL carries embedded credentials. Monitoring denied; no credentials are ever sent.',
    )
  }
  if (parsed.port !== '') {
    return deny('unexpected_port', `Cannamonitor must be retrieved on the default https port; port ${parsed.port} is refused.`)
  }

  // The licensing gate — the dominant, expected denial in the current world.
  if (permission !== 'verified') {
    return deny(
      'permission_unverified',
      'Cannamonitor commercial permission is UNVERIFIED. No retrieval may occur. This source is inactive and unreachable until written permission or an appropriate licence is documented and the policy is updated in a reviewed code change.',
    )
  }

  // Permission is verified — the registry's own active control still governs.
  // Fail closed: only an EXPLICITLY active source (isActive === true) may pass.
  // A missing / undefined isActive is treated as inactive, so a URL-only
  // evaluation (which carries no isActive — e.g. evaluateCannamonitorAiGate,
  // evaluatePastedMonitoringGate, evaluateCannamonitorManualIntakeGate) can
  // never reach the success branch without a proven active registry source.
  if (source.isActive !== true) {
    return deny('source_inactive', 'Cannamonitor source is not explicitly active in the registry. Monitoring denied.')
  }

  return decision({
    matched: true,
    permission,
    monitoringAllowed: true,
    aiAllowed: true,
    reason:
      'Cannamonitor permission is verified and the source is active. Metadata-only monitoring is permitted; article content remains prohibited.',
    fieldPolicy: CANNAMONITOR_METADATA_ONLY_PROJECTION,
  })
}

// ─── AI consumption gate (defence-in-depth, keyed on provenance URL) ─────────

export interface CannamonitorAiGateResult {
  /** True when the update is attributed to Cannamonitor and AI must be refused. */
  blocked: boolean
  reason: string
}

/**
 * Whether an update whose recorded source URL is `sourceUrl` must be blocked
 * from AI processing. This guards CONSUMPTION (the AI call reads whatever
 * `rawText` a legal_update carries, regardless of how it got there), which is
 * independent from the ingestion projection above.
 *
 * KNOWN LIMITATION, stated honestly: attribution is determined solely from the
 * recorded source URL. Content manually pasted with a blank, false, or
 * unrelated URL cannot be identified by this source-specific rule, and this
 * function does not claim otherwise. Content-sniffing is deliberately not used
 * (it would produce false positives and false negatives). Administrators must
 * record the correct canonical source URL.
 */
export function evaluateCannamonitorAiGate(sourceUrl: string | null | undefined): CannamonitorAiGateResult {
  const decisionForUrl = evaluateCannamonitorPolicy({ url: sourceUrl ?? '' })
  if (decisionForUrl.matched && !decisionForUrl.aiAllowed) {
    return {
      blocked: true,
      reason:
        'AI processing is blocked for Cannamonitor-attributed updates while commercial permission is unverified. Cannamonitor content may not be sent to an AI provider.',
    }
  }
  return { blocked: false, reason: 'Source is not Cannamonitor-attributed, or AI is permitted for it.' }
}

// ─── Manual Legal Update intake gate (arbitrary manual-body ingestion) ──────

export type CannamonitorManualIntakeDenialCode = 'cannamonitor_manual_intake_denied'

export type CannamonitorManualIntakeGate =
  | { action: 'proceed' }
  | { action: 'deny'; code: CannamonitorManualIntakeDenialCode; reason: string }

/**
 * Gate for the manual Legal Update form — a THIRD ingestion path (beside RSS and
 * the pasted Monitoring Queue) where an admin types a source URL plus arbitrary
 * raw body text that would be written straight to a legal_update (+ review +
 * audit log). That text is NOT metadata-only and cannot be projected, so a
 * Cannamonitor-attributed manual submission is denied outright — before any
 * payload, persistence, audit, or AI.
 *
 * Fail closed regardless of permission: this denies whenever the URL is a
 * Cannamonitor source (`matched`), NOT merely when monitoring is currently
 * disallowed. Even a hypothetical VERIFIED permission does not make arbitrary
 * manual body text persistable — the metadata-only guarantee covers only the RSS
 * projection path, and no separately-reviewed metadata-only manual-intake
 * mechanism exists (this task adds none). Attribution is by the recorded source
 * URL only (no content-sniffing); blank / false / unrelated attribution remains
 * the documented limitation. Unrelated sources always proceed.
 */
export function evaluateCannamonitorManualIntakeGate(
  sourceUrl: string | null | undefined,
): CannamonitorManualIntakeGate {
  const policy = evaluateCannamonitorPolicy({ url: sourceUrl ?? '' })
  if (policy.matched) {
    return {
      action: 'deny',
      code: 'cannamonitor_manual_intake_denied',
      reason: 'Cannamonitor raw evidence cannot be recorded through the manual Legal Update form.',
    }
  }
  return { action: 'proceed' }
}

// ─── Human-facing governance copy (single source of truth for UI + docs) ─────

export const CANNAMONITOR_REVIEW_HEADLINE = 'Potential development identified — primary-source verification required.'

export const CANNAMONITOR_NON_AUTHORITATIVE_NOTICE = [
  'Cannamonitor is not an official regulatory authority. It is a secondary commercial intelligence source.',
  'Cannamonitor cannot be the sole basis for an approved or active compliance rule.',
  'A qualified human must locate and assess an official primary source before any compliance conclusion is drawn.',
  'No readiness, alert, or enforcement consequence follows automatically from a Cannamonitor item.',
] as const

/**
 * Metadata-only monitoring compares title, canonical URL, item id, and
 * publication date. It CANNOT detect a body-only edit: if an article's text is
 * silently rewritten while its title, URL, id and date are unchanged, this
 * system will report "unchanged". That is an accepted, deliberate consequence
 * of not copying the body — detection is traded away for permission compliance.
 */
export const CANNAMONITOR_DETECTION_LIMITATION =
  'Metadata-only monitoring cannot detect body-only article edits. An article whose text changes without any change to its title, URL, id, or publication date will be reported as unchanged.'
