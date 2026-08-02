import type { RegulatorySource } from '../types'
import {
  inferConnectorKind,
  selectConnectorForSource,
  type ConnectorKind,
} from './complianceSourceConnectors'

// The transport-safety rules live in their own dependency-free module so the
// server-side retriever can reuse them without dragging this file's connector
// registry (and the Supabase repository behind it) into a serverless function.
// Re-exported here so this module's public API is unchanged.
import {
  validateConnectorAllowlist,
  validateConnectorUrlSafety,
} from './complianceSourceUrlSafety'
import type {
  ConnectorUrlSafetyStatus,
  ConnectorAllowlistDecision,
  ConnectorUrlSafetyDecision,
} from './complianceSourceUrlSafety'
export {
  normalizeConnectorHost,
  isHttpsRegulatoryUrl,
  validateConnectorAllowlist,
  validateConnectorUrlSafety,
} from './complianceSourceUrlSafety'
export type {
  ConnectorUrlSafetyStatus,
  ConnectorAllowlistDecision,
  ConnectorUrlSafetyDecision,
} from './complianceSourceUrlSafety'


// ─── Compliance Source Connector Runtime — skeleton (Phase 2B) ──────────────
//
// The safety gate that a future fetcher must pass *before* any real request is
// ever made. This phase performs NO external fetching: every export here is a
// pure, synchronous function that inspects a source and returns a decision or
// an intent-only run plan. Nothing in this file opens a socket, calls fetch,
// touches Supabase, calls an AI provider, writes a legal_update, or creates a
// rule — and the literal-`false` capability flags on every result/plan make
// that a compile-time guarantee, not merely a convention (the same idiom used
// by complianceSourceConnectors.ts and complianceSourceMonitoring.ts).
//
// Connector-kind classification is NOT re-implemented here: it is delegated
// wholesale to the Phase 2A.5 contract (inferConnectorKind /
// selectConnectorForSource). This module owns only the transport-safety
// layer: HTTPS-only, a deny-by-default host allowlist, and an SSRF guard that
// blocks localhost, private, link-local, and cloud-metadata addresses, plus
// non-standard ports. Redirect following is explicitly out of scope — a real
// fetcher must re-run validateConnectorUrlSafety + validateConnectorAllowlist
// against every redirect hop later; this skeleton neither follows nor
// validates redirects (see `redirectsValidated: false` on the run plan).

// ─── Status + result types ───────────────────────────────────────────────────

export type ConnectorRuntimeStatus =
  | 'ready'
  | 'rejected_invalid_url'
  | 'rejected_not_https'
  | 'rejected_not_allowlisted'
  | 'rejected_private_network'
  | 'rejected_unsupported_connector'
  | 'error'


export interface ConnectorRunInput {
  source: RegulatorySource
  /** Deny-by-default: an empty list allows nothing. Compared case-insensitively. */
  allowedHosts: string[]
  /** Non-standard ports to permit in addition to the implicit HTTPS 443. Empty = 443 only. */
  allowedPorts?: number[]
}



/**
 * The intent-only plan produced when — and only when — every safety gate
 * passes. It records which gates were satisfied (for auditability) and
 * carries the same literal-`false` capability guarantees as the contract
 * layer. `redirectsValidated` is the literal `false`: redirect handling is a
 * later phase, so a real fetcher must not treat a ready plan as permission to
 * follow redirects unchecked.
 */
export interface ConnectorRunPlan {
  sourceId: string
  connectorKind: ConnectorKind
  requestUrl: string
  normalizedHost: string
  httpMethod: 'GET'
  httpsOnly: true
  allowlisted: true
  ssrfChecked: true
  redirectsValidated: false
  performsNetwork: false
  canCreateLegalUpdate: false
  canCreateRule: false
  canCallAI: false
}

export interface ConnectorRunResult {
  status: ConnectorRuntimeStatus
  sourceId: string
  connectorKind: ConnectorKind
  /** Present only when `status === 'ready'`. */
  plan?: ConnectorRunPlan
  reason: string
  urlSafety?: ConnectorUrlSafetyDecision
  allowlist?: ConnectorAllowlistDecision
  performsNetwork: false
  canCreateLegalUpdate: false
  canCreateRule: false
  canCallAI: false
}

// ─── Run plan (pure, intent only) ─────────────────────────────────────────────

const URL_SAFETY_TO_RUNTIME_STATUS: Record<
  Exclude<ConnectorUrlSafetyStatus, 'safe'>,
  ConnectorRuntimeStatus
> = {
  invalid_url: 'rejected_invalid_url',
  not_https: 'rejected_not_https',
  private_network: 'rejected_private_network',
  disallowed_port: 'rejected_private_network', // SSRF-guard rejection bucket
}

function reject(
  status: ConnectorRuntimeStatus,
  sourceId: string,
  connectorKind: ConnectorKind,
  reason: string,
  extra: Partial<Pick<ConnectorRunResult, 'urlSafety' | 'allowlist'>> = {},
): ConnectorRunResult {
  return {
    status,
    sourceId,
    connectorKind,
    reason,
    ...extra,
    performsNetwork: false,
    canCreateLegalUpdate: false,
    canCreateRule: false,
    canCallAI: false,
  }
}

/**
 * Assembles an intent-only run result for a source. Returns `status: 'ready'`
 * with a ConnectorRunPlan only when the URL is a safe https non-private
 * address on an allowlisted host with an acceptable port AND the connector
 * kind is supported (per the Phase 2A.5 contract). Every other outcome is a
 * typed rejection. Performs no I/O of any kind — see {@link ConnectorRunInput}
 * for the bundled input shape callers may use.
 *
 * Gate order (fail-fast, most fundamental first): url safety → allowlist →
 * connector kind. This ordering is what makes each rejection status map
 * cleanly to exactly one cause.
 */
export function buildConnectorRunPlan(
  source: RegulatorySource,
  allowedHosts: string[],
  allowedPorts: number[] = [],
): ConnectorRunResult {
  try {
    // Kind is informational on rejections; recomputed via the contract so no
    // kind logic is duplicated here.
    const inferredKind = inferConnectorKind(source)

    const urlSafety = validateConnectorUrlSafety(source, allowedPorts)
    if (!urlSafety.safe) {
      return reject(
        URL_SAFETY_TO_RUNTIME_STATUS[urlSafety.status as Exclude<ConnectorUrlSafetyStatus, 'safe'>],
        source.id,
        inferredKind,
        urlSafety.reason,
        { urlSafety },
      )
    }

    const allowlist = validateConnectorAllowlist(source, allowedHosts)
    if (!allowlist.allowed) {
      return reject('rejected_not_allowlisted', source.id, inferredKind, allowlist.reason, { urlSafety, allowlist })
    }

    const selection = selectConnectorForSource(source)
    if (!selection.supported || !selection.connector) {
      return reject('rejected_unsupported_connector', source.id, selection.kind, selection.reason, { urlSafety, allowlist })
    }

    const plan: ConnectorRunPlan = {
      sourceId: source.id,
      connectorKind: selection.kind,
      requestUrl: source.url,
      normalizedHost: urlSafety.normalizedHost as string,
      httpMethod: 'GET',
      httpsOnly: true,
      allowlisted: true,
      ssrfChecked: true,
      redirectsValidated: false,
      performsNetwork: false,
      canCreateLegalUpdate: false,
      canCreateRule: false,
      canCallAI: false,
    }

    return {
      status: 'ready',
      sourceId: source.id,
      connectorKind: selection.kind,
      plan,
      reason: `ready: ${selection.kind} connector for allowlisted host "${plan.normalizedHost}"`,
      urlSafety,
      allowlist,
      performsNetwork: false,
      canCreateLegalUpdate: false,
      canCreateRule: false,
      canCallAI: false,
    }
  } catch (err) {
    return reject(
      'error',
      source.id,
      'unsupported',
      err instanceof Error ? err.message : 'unexpected error building connector run plan',
    )
  }
}
