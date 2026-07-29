import type { RegulatorySource } from '../types'
import type { FeedItemFields, FeedItemFieldPolicy } from './complianceRssConnector'

// ─── Cannamonitor source policy — fail-closed, source-specific ───────────────
//
// Cannamonitor (cannamonitor.com) is a SECONDARY COMMERCIAL INTELLIGENCE
// source. It is not a regulator, not a government body, and not an
// authoritative statement of law. An item from it may indicate that something
// happened worth investigating; it can never establish legal truth, approve
// compliance, certify export eligibility, create an enforceable rule, or alter
// readiness. Those consequences are impossible for a monitoring decision to
// produce anywhere in this codebase (see complianceSourceMonitoring.ts, whose
// ProposedLegalUpdateIntent.status is the literal 'new'), and nothing here
// weakens that.
//
// This module exists because of a licensing fact, not a technical one. The
// Cannamonitor legal notice expressly prohibits reproduction, distribution and
// public communication of "all or part of the contents of this website for
// commercial purposes, in any format and by any technical means, without
// authorization". DDP is a commercial brokerage. The site's public RSS feed
// carries an item <description> excerpt AND a full article body in
// <content:encoded>. Retrieving that feed through the generic connector would
// copy prohibited text into legal_updates.raw_text and forward it to an AI
// provider. Public accessibility of a feed is not a licence.
//
// So this module is deliberately DENY-BY-DEFAULT in two independent ways:
//
//   1. PERMISSION GATE. CANNAMONITOR_PERMISSION_STATUS is 'unverified' and no
//      runtime input can change it. While it is 'unverified', monitoring and AI
//      are denied BEFORE any network call is attempted. Marking the source
//      `isActive: true` in the registry does NOT bypass this: monitoring
//      requires BOTH an active source AND verified permission. Flipping the
//      constant requires a reviewed code change — it cannot be done from the
//      admin UI, from the database, or from an environment variable, and there
//      is deliberately no override parameter in production callers.
//
//   2. METADATA-ONLY PROJECTION. Even if permission were later verified, the
//      projection below strips description / summary / content / content:encoded
//      / HTML *before* the monitoring rawText is assembled — not afterwards. It
//      is not possible for prohibited text to enter the concatenation and then
//      be scrubbed, because the projection runs on the parsed FIELDS, ahead of
//      finalizeItem(). Prohibited content therefore cannot reach the checksum,
//      the monitoring decision, a proposed draft, the repository, or an AI
//      provider — it never exists in a retained value at all.
//
// Transport safety is NOT re-implemented here. HTTPS-only, the exact-match
// deny-by-default host allowlist, the SSRF guard (loopback / private /
// link-local / cloud-metadata), the port policy and the redirect refusal all
// already live in complianceSourceConnectorRuntime.ts + complianceRssConnector.ts
// and are reused unchanged. This module only ADDS restrictions on top.
//
// Every export is pure and deterministic.

// ─── Permission state ────────────────────────────────────────────────────────

export type CannamonitorPermissionStatus = 'unverified' | 'verified'

/**
 * The single source of truth for whether DDP holds documented written
 * permission or a licence to retrieve and process Cannamonitor content
 * commercially.
 *
 * IT IS 'unverified' AND MUST STAY THAT WAY until such permission actually
 * exists in writing. Changing it is a legal decision, not a coding one:
 * flipping this constant without a signed licence would put the project in
 * breach of the Cannamonitor legal notice. It is a compile-time constant on
 * purpose — there is no admin toggle, no database column, and no env var that
 * can flip it, so it cannot be enabled by accident or by a non-legal actor.
 */
export const CANNAMONITOR_PERMISSION_STATUS: CannamonitorPermissionStatus = 'unverified'

// ─── Approved hosts ──────────────────────────────────────────────────────────

/**
 * The ONLY hosts that count as an approved Cannamonitor endpoint. Exact,
 * whole-host matches — never suffix matches, so `cannamonitor.com.evil.example`
 * can never satisfy an entry here. `www.` is included intentionally: the site
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
  'subscriberContent',
]

// ─── Decision model ──────────────────────────────────────────────────────────

export type CannamonitorDenialCode =
  | 'malformed_url'
  | 'unapproved_subdomain'
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
 * unapproved subdomain, an http URL, a URL carrying credentials, or an
 * unparseable string that still names cannamonitor.
 *
 * This is deliberately BROADER than "approved". Matching decides whether the
 * policy APPLIES, not whether retrieval is allowed — and it must be broad,
 * because a Cannamonitor URL that failed to match would fall through to the
 * generic connector, which would happily fetch and store the article body. The
 * denial codes, not the matcher, are what enforce the restrictions.
 *
 * A deceptive suffix domain such as `cannamonitor.com.evil.example` is a
 * DIFFERENT site owned by someone else, so it does NOT match: it must never be
 * able to inherit Cannamonitor's permission if that permission is ever granted.
 */
export function isCannamonitorSourceUrl(url: string): boolean {
  const parsed = parse(url)
  if (!parsed) {
    // Fail closed: an unparseable string that still names cannamonitor is
    // treated as Cannamonitor (and denied) rather than waved through.
    return /(^|[^a-z0-9-])cannamonitor\.com([^a-z0-9-]|$)/i.test(url ?? '')
  }
  const host = hostOf(parsed)
  return isApprovedCannamonitorHost(host) || host.endsWith('.cannamonitor.com') || host === 'cannamonitor.com'
}

// ─── Metadata-only projection ────────────────────────────────────────────────

/**
 * Strips every prohibited field, keeping ONLY title / link / id / published.
 *
 * This runs on the parsed FIELDS, before the connector's finalizeItem() builds
 * `rawText` — so description, summary, content and content:encoded never enter
 * the concatenation, never reach the checksum, and never reach a proposed
 * draft. Crucially, `summary` and `content` are hard-nulled here regardless of
 * what the parser produced: if a future change teaches the RSS extractor to
 * read <content:encoded> (a natural-looking "improvement"), the full article
 * body still cannot escape through this policy.
 */
export const CANNAMONITOR_METADATA_ONLY_PROJECTION: FeedItemFieldPolicy = {
  policyId: 'cannamonitor-metadata-only',
  projectFields(fields: FeedItemFields): FeedItemFields {
    return {
      title: fields.title,
      link: fields.link,
      id: fields.id,
      published: fields.published,
      // Prohibited under the Cannamonitor legal notice — discarded, never retained.
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
 * unapproved subdomains, or an inactive source.
 *
 * Monitoring requires BOTH conditions, which is the point: an active source
 * with unverified permission is denied, and verified permission on an inactive
 * source is denied. Setting `isActive: true` alone can never enable retrieval.
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

  // From here on the source IS Cannamonitor: the projection always applies, and
  // AI is permitted only when permission is verified.
  const aiAllowed = permission === 'verified'
  const deny = (denialCode: CannamonitorDenialCode, reason: string): CannamonitorPolicyDecision =>
    decision({
      matched: true,
      permission,
      monitoringAllowed: false,
      aiAllowed,
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
      'unapproved_subdomain',
      `Host "${host}" is a Cannamonitor host that is not on the approved list (${APPROVED_CANNAMONITOR_HOSTS.join(', ')}). Monitoring denied.`,
    )
  }
  if (parsed.protocol !== 'https:') {
    return deny('not_https', `Cannamonitor must be retrieved over https; scheme "${parsed.protocol}" is refused.`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return deny('credentials_in_url', 'Cannamonitor source URL carries embedded credentials. Monitoring denied; no credentials are ever sent.')
  }
  if (parsed.port !== '') {
    return deny('unexpected_port', `Cannamonitor must be retrieved on the default https port; port ${parsed.port} is refused.`)
  }

  // The licensing gate — the dominant, expected denial in the current world.
  if (permission !== 'verified') {
    return deny(
      'permission_unverified',
      'Cannamonitor commercial permission is UNVERIFIED. The Cannamonitor legal notice prohibits commercial reproduction of any part of its contents without authorization, so no retrieval may occur. This source is inactive and unreachable until written permission or a licence is documented and the policy is updated in a reviewed code change.',
    )
  }

  // Permission is verified — the registry's own active control still governs.
  if (source.isActive === false) {
    return deny('source_inactive', 'Cannamonitor source is inactive in the registry. Monitoring denied.')
  }

  return decision({
    matched: true,
    permission,
    monitoringAllowed: true,
    aiAllowed: true,
    reason: 'Cannamonitor permission is verified and the source is active. Metadata-only monitoring is permitted; article content remains prohibited.',
    fieldPolicy: CANNAMONITOR_METADATA_ONLY_PROJECTION,
  })
}

// ─── Human-facing governance copy (single source of truth for UI + docs) ─────

export const CANNAMONITOR_REVIEW_HEADLINE = 'Potential development identified — primary-source verification required.'

export const CANNAMONITOR_NON_AUTHORITATIVE_NOTICE = [
  'Cannamonitor is not an official regulatory authority. It is a secondary commercial intelligence source.',
  'Cannamonitor cannot be the sole basis for an approved or active compliance rule.',
  'A qualified human must locate and assess an official primary source before any compliance conclusion is drawn.',
  'No readiness, alert or enforcement consequence follows from a Cannamonitor item.',
] as const

/**
 * Metadata-only monitoring compares title, canonical URL, item id and
 * publication date. It CANNOT detect a body-only edit: if an article's text is
 * silently rewritten while its title, URL, id and date are unchanged, this
 * system will report "unchanged". That is an accepted, deliberate consequence
 * of not copying the body — detection is traded away for licence compliance.
 */
export const CANNAMONITOR_DETECTION_LIMITATION =
  'Metadata-only monitoring cannot detect body-only article edits. An article whose text changes without any change to its title, URL, id or publication date will be reported as unchanged.'
