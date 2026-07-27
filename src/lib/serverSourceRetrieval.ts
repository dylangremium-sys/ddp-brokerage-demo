// ─── Server-side official-source retrieval (Gate P0 — issue #77) ────────────
//
// The first module in this codebase that actually FETCHES a regulatory source.
// Until now the transport-safety layer (complianceSourceConnectorRuntime.ts)
// was a pure gate with no fetcher behind it, and the only real fetch adapter
// was browser-side. Browser fetching cannot satisfy this gate: it is subject to
// CORS, it exposes the request to the client, and its result cannot be trusted
// as provenance. This module runs server-side only.
//
// It does NOT re-implement the safety rules. Host allowlisting, HTTPS-only, the
// private/link-local/metadata SSRF guard and port policy are all delegated to
// the existing validators. What it adds is the part the skeleton explicitly
// deferred: following redirects MANUALLY and re-running the full validation on
// every hop, so an allowlisted host cannot bounce the request to an internal
// address.
//
// Transport limits enforced here: request timeout, response size cap (streamed,
// so a lying Content-Length cannot exhaust memory), and a content-type
// allowlist.
//
// The COA is never involved in a request. Retrieval is GET-only with no body,
// no query parameters derived from document content, and no credentials — the
// gate forbids sending COA contents to regulatory sites.

import { sha256Hex } from './sha256.js'
import type { RegulatorySource } from '../types.js'
// Imported from the extracted safety module rather than from
// complianceSourceConnectorRuntime: the runtime also pulls in connector-kind
// classification and, transitively, the Supabase repository, which must not be
// dragged into a Vercel Function. Same rules, one definition.
import {
  isPrivateOrUnsafeHost,
  validateConnectorAllowlist,
  validateConnectorUrlSafety,
} from './complianceSourceUrlSafety.js'

export type SourceRetrievalStatus =
  | 'retrieved'
  | 'rejected_invalid_url'
  | 'rejected_not_https'
  | 'rejected_not_allowlisted'
  | 'rejected_private_network'
  | 'rejected_resolved_private'
  | 'rejected_disallowed_port'
  | 'rejected_redirect'
  | 'too_many_redirects'
  | 'rejected_content_type'
  | 'too_large'
  | 'timeout'
  | 'http_error'
  | 'fetch_failed'

export interface SourceRetrievalPolicy {
  /** Deny-by-default. An empty list allows nothing. */
  allowedHosts: string[]
  /** Non-standard ports permitted in addition to HTTPS 443. */
  allowedPorts?: number[]
  maxRedirects?: number
  timeoutMs?: number
  maxBytes?: number
  /** Lower-cased media types (without parameters) that may be accepted. */
  allowedContentTypes?: string[]
}

export const DEFAULT_RETRIEVAL_POLICY: Required<Omit<SourceRetrievalPolicy, 'allowedHosts' | 'allowedPorts'>> = {
  maxRedirects: 3,
  timeoutMs: 12_000,
  maxBytes: 2 * 1024 * 1024,
  allowedContentTypes: ['text/html', 'text/plain', 'application/xhtml+xml', 'application/xml', 'text/xml'],
}

export interface SourceRetrievalRecord {
  status: SourceRetrievalStatus
  requestedUrl: string
  /** The URL that actually served the content, after any validated redirects. */
  finalUrl: string | null
  httpStatus: number | null
  contentType: string | null
  byteLength: number
  /** SHA-256 of the retrieved bytes — the source VERSION identity. */
  contentFingerprint: string | null
  /** Supplied by the caller so this module stays clock-free and testable. */
  retrievedAt: string
  /** Every URL visited, in order, including the original. */
  redirectChain: string[]
  /** Safe explanation of a non-'retrieved' outcome. */
  reason: string | null
  /** Retrieved text, normalised from HTML. Null unless status is 'retrieved'. */
  content: string | null
}

export interface SourceFetchResponse {
  status: number
  headers: { get(name: string): string | null }
  url?: string
  /** Present in real fetch; when absent the body is read via arrayBuffer(). */
  body?: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface SourceFetchInit {
  method: 'GET'
  redirect: 'manual'
  credentials: 'omit'
  headers: Record<string, string>
  signal?: AbortSignal
}

export type SourceFetchImpl = (url: string, init: SourceFetchInit) => Promise<SourceFetchResponse>

/**
 * Resolves a hostname to its IP addresses.
 *
 * Injected rather than imported so this module stays free of node:dns and can
 * still be unit-tested. The Vercel Functions supply the real resolver; when
 * absent, name-based validation alone applies (documented, not silent).
 */
export type HostResolver = (hostname: string) => Promise<string[]>

export interface SourceRetrievalInput {
  url: string
  policy: SourceRetrievalPolicy
  /** Caller-supplied so the module never reads a clock. */
  retrievedAt: string
  fetchImpl?: SourceFetchImpl
  /** Supply in a server context to enable resolved-IP SSRF checking. */
  resolveHost?: HostResolver
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** A minimal source shape — the validators only read `url`. */
function asSource(url: string): RegulatorySource {
  return { url } as unknown as RegulatorySource
}

function failure(
  status: SourceRetrievalStatus,
  requestedUrl: string,
  retrievedAt: string,
  reason: string,
  redirectChain: string[] = [requestedUrl],
  httpStatus: number | null = null,
): SourceRetrievalRecord {
  return {
    status,
    requestedUrl,
    finalUrl: null,
    httpStatus,
    contentType: null,
    byteLength: 0,
    contentFingerprint: null,
    retrievedAt,
    redirectChain,
    reason,
    content: null,
  }
}

/**
 * Run the full safety gate against one URL.
 *
 * Applied to the original request AND to every redirect target, which is the
 * property that makes redirect-based SSRF impossible: an allowlisted host that
 * 302s to 169.254.169.254 is rejected at the hop, not followed.
 */
export function validateRetrievalTarget(
  url: string,
  policy: SourceRetrievalPolicy,
): { ok: true } | { ok: false; status: SourceRetrievalStatus; reason: string } {
  const source = asSource(url)

  const safety = validateConnectorUrlSafety(source, policy.allowedPorts ?? [])
  if (!safety.safe) {
    const statusMap: Record<string, SourceRetrievalStatus> = {
      invalid_url: 'rejected_invalid_url',
      not_https: 'rejected_not_https',
      private_network: 'rejected_private_network',
      disallowed_port: 'rejected_disallowed_port',
    }
    return {
      ok: false,
      status: statusMap[safety.status] ?? 'rejected_invalid_url',
      reason: safety.reason,
    }
  }

  const allowlist = validateConnectorAllowlist(source, policy.allowedHosts)
  if (!allowlist.allowed) {
    return { ok: false, status: 'rejected_not_allowlisted', reason: allowlist.reason }
  }

  return { ok: true }
}

/**
 * Second SSRF gate: check where the hostname actually POINTS.
 *
 * validateRetrievalTarget is name-based — it classifies the hostname string. A
 * public name that resolves to an internal address (the classic DNS-rebinding
 * shape) would pass it. This resolves the name and rejects the request if ANY
 * returned address is loopback/private/link-local/metadata.
 *
 * Applied to the original URL and to every redirect hop. A resolver failure is
 * treated as fatal — failing closed, because an unresolvable host cannot be
 * shown to be safe.
 */
export async function validateResolvedAddresses(
  hostname: string,
  resolveHost: HostResolver,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let addresses: string[]
  try {
    addresses = await resolveHost(hostname)
  } catch {
    return { ok: false, reason: `host "${hostname}" could not be resolved` }
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `host "${hostname}" resolved to no addresses` }
  }

  const unsafe = addresses.filter((address) => isPrivateOrUnsafeHost(address.toLowerCase()))
  if (unsafe.length > 0) {
    return {
      ok: false,
      reason: `host "${hostname}" resolves to a private/loopback/link-local address (${unsafe.join(', ')})`,
    }
  }

  return { ok: true }
}

/** Media type without parameters, lower-cased. */
function parseMediaType(contentType: string | null): string | null {
  if (!contentType) return null
  return contentType.split(';')[0].trim().toLowerCase()
}

/**
 * Read the body with a hard byte ceiling.
 *
 * Streamed where possible so an oversized or dishonestly-declared response is
 * abandoned partway rather than fully buffered.
 */
async function readCapped(
  response: SourceFetchResponse,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  const stream = response.body
  if (!stream || typeof stream.getReader !== 'function') {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.length > maxBytes) return { bytes: buffer.slice(0, maxBytes), exceeded: true }
    return { bytes: buffer, exceeded: false }
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { bytes: new Uint8Array(0), exceeded: true }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, exceeded: false }
}

/**
 * Reduce an HTML document to readable text.
 *
 * Deliberately mechanical: script/style/noscript are dropped, tags are removed,
 * entities are decoded and whitespace collapsed. Nothing is summarised,
 * inferred or reworded — the stored text is what the authority published.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    // \u00A0 is a non-breaking space, written as an escape so the source file
    // contains no irregular whitespace of its own.
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

/**
 * Select the passage of the retrieved document most relevant to the given terms.
 *
 * Deterministic and extractive: it scores each line by how many distinct terms
 * it contains and returns a window around the best match, VERBATIM. If nothing
 * matches it returns the opening of the document rather than inventing a
 * summary — an unmatched source is still a real retrieval, and the operator
 * must be able to see what was actually fetched.
 */
export function selectRelevantSection(
  text: string,
  terms: string[],
  maxChars = 1500,
): { section: string; matchedTerms: string[]; matched: boolean } {
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { section: '', matchedTerms: [], matched: false }

  const lowerTerms = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0)

  let bestIndex = -1
  let bestScore = 0
  let bestMatches: string[] = []

  lines.forEach((line, index) => {
    const lower = line.toLowerCase()
    const matches = lowerTerms.filter((term) => lower.includes(term))
    if (matches.length > bestScore) {
      bestScore = matches.length
      bestIndex = index
      bestMatches = matches
    }
  })

  if (bestIndex === -1) {
    return { section: lines.join('\n').slice(0, maxChars), matchedTerms: [], matched: false }
  }

  const start = Math.max(0, bestIndex - 2)
  const window = lines.slice(start, start + 12).join('\n')
  return { section: window.slice(0, maxChars), matchedTerms: bestMatches, matched: true }
}

/** The production adapter — the only place a real network call is made. */
export const nodeSourceFetch: SourceFetchImpl = async (url, init) =>
  fetch(url, init as unknown as RequestInit) as unknown as Promise<SourceFetchResponse>

/**
 * Retrieve one official source, failing closed on every unsafe condition.
 *
 * Never throws: an unreachable or rejected source is a legitimate, recordable
 * outcome that the Watchtower must be able to persist and display as an
 * UNVERIFIED state — which is precisely what blocks a regulatory suggestion.
 */
export async function retrieveOfficialSource(input: SourceRetrievalInput): Promise<SourceRetrievalRecord> {
  const { url, policy, retrievedAt, fetchImpl = nodeSourceFetch, resolveHost } = input

  const maxRedirects = policy.maxRedirects ?? DEFAULT_RETRIEVAL_POLICY.maxRedirects
  const timeoutMs = policy.timeoutMs ?? DEFAULT_RETRIEVAL_POLICY.timeoutMs
  const maxBytes = policy.maxBytes ?? DEFAULT_RETRIEVAL_POLICY.maxBytes
  const allowedContentTypes = (policy.allowedContentTypes ?? DEFAULT_RETRIEVAL_POLICY.allowedContentTypes)
    .map((t) => t.toLowerCase())

  const initial = validateRetrievalTarget(url, policy)
  if (!initial.ok) return failure(initial.status, url, retrievedAt, initial.reason)

  if (resolveHost) {
    const resolved = await validateResolvedAddresses(new URL(url).hostname, resolveHost)
    if (!resolved.ok) return failure('rejected_resolved_private', url, retrievedAt, resolved.reason)
  }

  const redirectChain: string[] = [url]
  let currentUrl = url

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: SourceFetchResponse
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          // Identifies the caller honestly; carries no credential.
          'User-Agent': 'DDP-Compliance-Watchtower/1.0 (+regulatory source verification)',
          Accept: allowedContentTypes.join(', '),
        },
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const aborted = controller.signal.aborted || (error as { name?: string })?.name === 'AbortError'
      return failure(
        aborted ? 'timeout' : 'fetch_failed',
        url,
        retrievedAt,
        aborted ? `request exceeded ${timeoutMs}ms` : 'the request to the source failed',
        redirectChain,
      )
    }
    clearTimeout(timer)

    // ── Redirect: revalidate the target before following ────────────────────
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        return failure('rejected_redirect', url, retrievedAt,
          `source returned ${response.status} with no Location header`, redirectChain, response.status)
      }

      let nextUrl: string
      try {
        nextUrl = new URL(location, currentUrl).toString()
      } catch {
        return failure('rejected_redirect', url, retrievedAt,
          'source redirected to an unparseable location', redirectChain, response.status)
      }

      if (hop === maxRedirects) {
        return failure('too_many_redirects', url, retrievedAt,
          `exceeded ${maxRedirects} redirects`, [...redirectChain, nextUrl], response.status)
      }

      // The whole point of manual redirects: the hop is re-gated.
      const hopCheck = validateRetrievalTarget(nextUrl, policy)
      if (!hopCheck.ok) {
        return failure('rejected_redirect', url, retrievedAt,
          `redirect target rejected: ${hopCheck.reason}`, [...redirectChain, nextUrl], response.status)
      }

      if (resolveHost) {
        const resolved = await validateResolvedAddresses(new URL(nextUrl).hostname, resolveHost)
        if (!resolved.ok) {
          return failure('rejected_redirect', url, retrievedAt,
            `redirect target rejected: ${resolved.reason}`, [...redirectChain, nextUrl], response.status)
        }
      }

      redirectChain.push(nextUrl)
      currentUrl = nextUrl
      continue
    }

    // ── Terminal response ───────────────────────────────────────────────────
    if (response.status < 200 || response.status >= 300) {
      return failure('http_error', url, retrievedAt,
        `source responded with HTTP ${response.status}`, redirectChain, response.status)
    }

    const contentType = response.headers.get('content-type')
    const mediaType = parseMediaType(contentType)
    if (!mediaType || !allowedContentTypes.includes(mediaType)) {
      return failure('rejected_content_type', url, retrievedAt,
        `unsupported content type "${mediaType ?? 'none'}"`, redirectChain, response.status)
    }

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return failure('too_large', url, retrievedAt,
        `source declared ${declaredLength} bytes, above the ${maxBytes}-byte limit`, redirectChain, response.status)
    }

    let bytes: Uint8Array
    let exceeded: boolean
    try {
      ;({ bytes, exceeded } = await readCapped(response, maxBytes))
    } catch {
      return failure('fetch_failed', url, retrievedAt,
        'the response body could not be read', redirectChain, response.status)
    }

    if (exceeded) {
      return failure('too_large', url, retrievedAt,
        `response exceeded the ${maxBytes}-byte limit`, redirectChain, response.status)
    }

    const rawText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const isHtml = mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
    const content = isHtml ? htmlToText(rawText) : rawText.trim()

    return {
      status: 'retrieved',
      requestedUrl: url,
      finalUrl: currentUrl,
      httpStatus: response.status,
      contentType: mediaType,
      byteLength: bytes.length,
      // Fingerprint the BYTES, not the normalised text, so the stored version
      // identity is of what the authority actually served.
      contentFingerprint: await sha256Hex(bytes),
      retrievedAt,
      redirectChain,
      reason: null,
      content,
    }
  }

  return failure('too_many_redirects', url, retrievedAt, `exceeded ${maxRedirects} redirects`, redirectChain)
}
