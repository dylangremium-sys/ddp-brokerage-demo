import type { RegulatorySource } from '../types.js'
import { normalizeConnectorHost } from './complianceSourceUrlSafety.js'
import { runIngestionBatch, type BatchIngestionReport, type IngestionDeps } from './watchtowerIngestionService.js'
import type { ServerIngestionRepository } from './serverIngestionRepository.js'

// ─── Scheduled ingestion boundary — core ─────────────────────────────────────
//
// The framework-agnostic core of api/cron/ingest.ts. Pure aside from injected
// dependencies, so the authorisation gate and the allowlist construction are
// exercised by real tests rather than by reading the adapter.
//
// WHY A SHARED SECRET AND NOT A BEARER TOKEN
// There is no user behind a scheduled run, so there is no session to verify and
// no profile row to authorise against. Vercel invokes a cron over ordinary
// HTTPS, which means the route is publicly reachable and the ONLY thing
// standing between the internet and an unattended ingestion sweep is this
// header check. It is therefore compared in constant time and fails closed when
// the secret is unset — an absent CRON_SECRET must never mean "allow", which is
// what a naive `if (secret && secret !== provided)` would silently do.

export const CRON_INGEST_ROUTE = 'api/cron/ingest'

export interface ScheduledIngestionResult {
  status: number
  body: Record<string, unknown>
}

export interface ScheduledIngestionDeps {
  /** The configured secret. Null/empty when unset — which must fail closed. */
  cronSecret: string | null
  repository: ServerIngestionRepository
  /** Builds the per-source connector runner. Injected so tests never fetch. */
  buildRunConnector: (source: RegulatorySource) => IngestionDeps['runConnector']
  now: () => string
  userAgent?: string
}

/**
 * Constant-time string comparison.
 *
 * Written here rather than using node:crypto.timingSafeEqual because src/ is
 * compiled without @types/node. Length is compared first and the loop always
 * runs over the full expected secret, so the only thing an attacker can time is
 * the length — which a cron secret does not need to hide.
 */
export function secretsMatch(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Extracts the presented secret from either header Vercel Cron may use.
 *
 * `Authorization: Bearer <secret>` is what Vercel sends. `x-cron-secret` is
 * accepted so the route can be exercised by hand during an incident without
 * borrowing the Authorization header's meaning from the other endpoints.
 */
export function presentedSecret(headers: {
  authorization: string | null
  cronSecretHeader: string | null
}): string | null {
  if (headers.cronSecretHeader) return headers.cronSecretHeader
  const match = /^Bearer\s+(.+)$/i.exec((headers.authorization ?? '').trim())
  return match ? match[1].trim() : null
}

/**
 * The host allowlist for a scheduled run.
 *
 * Derived from the enabled sources' OWN hostnames, exactly as the admin panel
 * does it: an operator who registered and enabled a source has already vetted
 * that host. Deny-by-default — a source whose URL will not parse contributes
 * nothing, so it is refused at the connector's allowlist gate rather than
 * silently reaching the network.
 */
export function allowlistFromSources(sources: RegulatorySource[]): string[] {
  const hosts = new Set<string>()
  for (const source of sources) {
    const host = normalizeConnectorHost(source.url)
    if (host) hosts.add(host)
  }
  return [...hosts]
}

export async function runScheduledIngestion(
  headers: { authorization: string | null; cronSecretHeader: string | null },
  method: string,
  deps: ScheduledIngestionDeps,
): Promise<ScheduledIngestionResult> {
  // GET is what Vercel Cron issues. POST is accepted for a manual re-trigger.
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
  }

  // FAIL CLOSED ON AN UNSET SECRET. If CRON_SECRET is missing this route is an
  // unauthenticated trigger for an outbound fetch sweep, so a missing secret
  // must disable the route, never open it.
  if (!deps.cronSecret) {
    return { status: 503, body: { ok: false, error: 'server_misconfigured' } }
  }
  const provided = presentedSecret(headers)
  if (!provided || !secretsMatch(deps.cronSecret, provided)) {
    // Deliberately indistinguishable from "route does not exist" in wording,
    // and identical for a missing and a wrong secret.
    return { status: 401, body: { ok: false, error: 'unauthenticated' } }
  }

  let sources: RegulatorySource[]
  try {
    sources = await deps.repository.fetchActiveSources()
  } catch {
    return { status: 503, body: { ok: false, error: 'sources_unavailable' } }
  }

  // A 'manual' monitoring method means an operator has said "do not auto-fetch
  // this". runIngestionForSource records those as an explicit skipped run, so
  // they are passed through rather than filtered out here — the skip is
  // evidence, and dropping them would make the run report look shorter than
  // the registry.
  const allowedHosts = allowlistFromSources(sources)

  const ingestionDeps: IngestionDeps = {
    runConnector: (source) => deps.buildRunConnector(source)(source),
    fetchKnownIdentity: () => deps.repository.fetchKnownIdentity(),
    openRun: (input) => deps.repository.openRun(input),
    closeRun: (id, input) => deps.repository.closeRun(id, input),
    insertItem: (input) => deps.repository.insertItem(input),
    insertCandidate: (input) => deps.repository.insertCandidate(input),
    now: deps.now,
    trigger: 'scheduled',
    actorType: 'scheduler',
    // No user id: a scheduled run has no actor, and inventing one would put a
    // false attribution into the audit evidence.
    actorId: null,
  }

  let report: BatchIngestionReport
  try {
    report = await runIngestionBatch(sources, ingestionDeps)
  } catch {
    return { status: 500, body: { ok: false, error: 'ingestion_failed' } }
  }

  return {
    status: 200,
    body: {
      ok: true,
      trigger: 'scheduled',
      sources: sources.length,
      allowedHosts: allowedHosts.length,
      succeeded: report.succeeded,
      partial: report.partial,
      failed: report.failed,
      skipped: report.skipped,
      newCandidates: report.newCandidates,
      duplicates: report.duplicates,
      finishedAt: deps.now(),
    },
  }
}
