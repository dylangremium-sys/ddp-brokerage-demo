// ─── Connector URL safety: HTTPS + SSRF guard + allowlist (pure) ────────────
//
// The transport-safety rules, extracted so they have exactly ONE definition and
// no dependencies beyond a type import.
//
// They were originally defined inside complianceSourceConnectorRuntime.ts, which
// also pulls in connector-kind classification and, transitively, the Supabase
// repository. That is fine in the browser bundle but unacceptable inside a
// Vercel Function, where the server-side retriever needs these checks and
// nothing else. Splitting them keeps the SERVER fetcher and the BROWSER runtime
// enforcing the identical rules rather than two drifting copies.
//
// complianceSourceConnectorRuntime.ts re-exports everything here, so every
// existing caller and test is unaffected.
//
// Every function is pure: no I/O, no clock, no network.

import type { RegulatorySource } from '../types.js'

/** Granular URL-safety outcome. `disallowed_port` collapses to a
 *  `rejected_private_network` run status (both are SSRF-guard rejections),
 *  but is kept distinct here for precise diagnostics. */
export type ConnectorUrlSafetyStatus =
  | 'safe'
  | 'invalid_url'
  | 'not_https'
  | 'private_network'
  | 'disallowed_port'

export interface ConnectorAllowlistDecision {
  allowed: boolean
  normalizedHost: string | null
  reason: string
}

export interface ConnectorUrlSafetyDecision {
  safe: boolean
  status: ConnectorUrlSafetyStatus
  normalizedHost: string | null
  reason: string
}

// ─── URL parsing helpers (pure) ──────────────────────────────────────────────

function parseUrl(url: string): URL | null {
  if (!url || !url.trim()) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * Lowercased hostname of a URL, with any surrounding IPv6 brackets stripped,
 * or null when the URL is absent/unparseable. Pure.
 */
export function normalizeConnectorHost(url: string): string | null {
  const parsed = parseUrl(url)
  if (!parsed) return null
  let host = parsed.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  return host
}

/** True only for a parseable absolute https URL. Pure. */
export function isHttpsRegulatoryUrl(url: string): boolean {
  const parsed = parseUrl(url)
  return parsed !== null && parsed.protocol === 'https:'
}

// ─── SSRF host classification (pure) ─────────────────────────────────────────

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * True when the host is a loopback / private / link-local / cloud-metadata
 * address (IPv4 or IPv6) or a localhost name — i.e. anything a regulatory
 * fetcher must never be pointed at. Deliberately conservative. `host` is
 * expected already normalized (lowercased, no IPv6 brackets).
 */
function isPrivateOrUnsafeHost(host: string): boolean {
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  const v4 = IPV4_RE.exec(host)
  if (v4) {
    const octets = v4.slice(1).map(Number)
    if (octets.some(o => o > 255)) return true // malformed dotted-quad — reject
    const [a, b] = octets
    if (a === 127) return true                       // 127.0.0.0/8 loopback
    if (a === 10) return true                        // 10.0.0.0/8 private
    if (a === 192 && b === 168) return true          // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
    if (a === 169 && b === 254) return true          // 169.254.0.0/16 link-local (+ 169.254.169.254 metadata)
    if (a === 0) return true                         // 0.0.0.0/8 "this network" / unspecified
    return false
  }

  // IPv6 (normalized, bracket-free). Covers loopback, unspecified,
  // link-local (fe80::/10), and unique-local fc00::/7 (incl. fd00:ec2::254
  // AWS IPv6 metadata).
  if (host.includes(':')) {
    if (host === '::1') return true
    if (host === '::') return true
    if (/^fe[89ab]/.test(host)) return true
    if (/^f[cd]/.test(host)) return true
    return false
  }

  return false
}

// ─── Allowlist validation (pure, deny-by-default) ────────────────────────────

/**
 * Deny-by-default host allowlist. The source host must exactly match (host
 * for host, case-insensitively) an entry in `allowedHosts`; an empty list
 * allows nothing. Exact-match, not suffix-match, so `evil-example.gov` can
 * never satisfy an `example.gov` entry. Pure.
 */
export function validateConnectorAllowlist(
  source: RegulatorySource,
  allowedHosts: string[],
): ConnectorAllowlistDecision {
  const normalizedHost = normalizeConnectorHost(source.url)
  if (!normalizedHost) {
    return { allowed: false, normalizedHost: null, reason: 'source url is absent or unparseable' }
  }

  const normalizedAllowed = allowedHosts
    .map(h => h.trim().toLowerCase())
    .filter(h => h.length > 0)

  if (normalizedAllowed.length === 0) {
    return { allowed: false, normalizedHost, reason: 'allowlist is empty — deny by default' }
  }

  if (normalizedAllowed.includes(normalizedHost)) {
    return { allowed: true, normalizedHost, reason: `host "${normalizedHost}" is allowlisted` }
  }

  return { allowed: false, normalizedHost, reason: `host "${normalizedHost}" is not on the allowlist` }
}

// ─── URL safety validation (pure, SSRF guard) ────────────────────────────────

/**
 * HTTPS-only + SSRF guard + port policy. Does NOT consult the allowlist —
 * that is validateConnectorAllowlist's job. `allowedPorts` names any
 * non-standard ports to permit in addition to the implicit HTTPS 443 (an
 * explicit `:443` is normalized away by URL and always allowed). Pure.
 */
export function validateConnectorUrlSafety(
  source: RegulatorySource,
  allowedPorts: number[] = [],
): ConnectorUrlSafetyDecision {
  const parsed = parseUrl(source.url)
  if (!parsed) {
    return { safe: false, status: 'invalid_url', normalizedHost: null, reason: 'source url is absent or unparseable' }
  }

  if (parsed.protocol !== 'https:') {
    return {
      safe: false,
      status: 'not_https',
      normalizedHost: normalizeConnectorHost(source.url),
      reason: `scheme "${parsed.protocol}" is not https`,
    }
  }

  const normalizedHost = normalizeConnectorHost(source.url) as string

  if (isPrivateOrUnsafeHost(normalizedHost)) {
    return {
      safe: false,
      status: 'private_network',
      normalizedHost,
      reason: `host "${normalizedHost}" resolves to a localhost/private/link-local/metadata address`,
    }
  }

  // parsed.port is '' for the default https port (443 is normalized away), so
  // any non-empty port is non-standard and must be explicitly allowed.
  if (parsed.port !== '') {
    const port = Number(parsed.port)
    if (!allowedPorts.includes(port)) {
      return {
        safe: false,
        status: 'disallowed_port',
        normalizedHost,
        reason: `non-standard port ${port} is not permitted`,
      }
    }
  }

  return { safe: true, status: 'safe', normalizedHost, reason: 'url passed https + ssrf + port checks' }
}
