import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerIngestionRepository, type IngestionDbClient } from '../../src/lib/serverIngestionRepository.js'
import { createDirectSourceRssFetch } from '../../src/lib/serverDirectRssFetch.js'
import { executeRssConnector } from '../../src/lib/complianceRssConnector.js'
import { executeHtmlWatchConnector } from '../../src/lib/complianceHtmlWatchConnector.js'
import { inferConnectorKind } from '../../src/lib/complianceSourceConnectors.js'
import {
  CRON_INGEST_ROUTE,
  allowlistFromSources,
  runScheduledIngestion,
} from '../../src/lib/serverScheduledIngestion.js'
import { retrieveOfficialSource, nodeSourceFetch } from '../../src/lib/serverSourceRetrieval.js'
import { nodeHostResolver } from '../_lib/nodeHostResolver.js'
import { logServerError, newRequestId } from '../../src/lib/observability.js'
import type { RegulatorySource } from '../../src/types.js'

// ─── Scheduled Watchtower ingestion (Vercel Cron) ───────────────────────────
//
// Runs the whole registry sweep unattended: retrieve every enabled source,
// parse or fingerprint it, deduplicate, and create candidate legal updates in
// status 'new' for a human to triage in the Review Queue. It is the answer to
// "keep up to date with new laws without anyone remembering to click".
//
// It creates NOTHING a human has not triaged: candidates are always status
// 'new', and no rule, alert, readiness change or AI call happens on this path.
//
// SCHEDULE lives in vercel.json. AUTHORISATION is a shared secret compared in
// constant time, which fails closed when unset — see serverScheduledIngestion.
//
// Server-only environment variables:
//   CRON_SECRET                — the shared secret Vercel Cron presents.
//   SUPABASE_URL               — project URL.
//   SUPABASE_SERVICE_ROLE_KEY  — unavoidable here: an unattended job has no
//                                user session whose RLS it could inherit. The
//                                blast radius is bounded in
//                                serverIngestionRepository, which is the only
//                                server-side writer and touches three tables.

interface VercelRequestLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
}
interface VercelResponseLike {
  status(code: number): VercelResponseLike
  json(body: unknown): void
}

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

const USER_AGENT = 'DDP-Watchtower-Ingestion/1.0 (+scheduled)'

/**
 * Chooses the connector for a source, mirroring createDefaultIngestionDeps.
 *
 * Kept in step with the browser path deliberately: if the scheduled sweep and
 * the manual sweep dispatched differently, a source could succeed when a human
 * clicked and fail overnight, which is the hardest class of bug to notice.
 */
function connectorKindForSource(source: RegulatorySource): string {
  if (source.monitoringMethod && source.monitoringMethod !== 'manual') {
    return source.monitoringMethod
  }
  return inferConnectorKind(source)
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const requestId = newRequestId()
  const method = req.method ?? 'GET'

  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceRoleKey) {
      logServerError({ event: 'api_error', requestId, category: 'server_misconfigured', status: 503, method, route: CRON_INGEST_ROUTE })
      res.status(503).json({ ok: false, error: 'server_misconfigured', requestId })
      return
    }

    const client: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const repository = createServerIngestionRepository(client as unknown as IngestionDbClient)

    // The allowlist is recomputed per source from the enabled registry, so a
    // source can only ever reach its own host.
    const buildRunConnector = (source: RegulatorySource) => {
      const allowedHosts = allowlistFromSources([source])
      const fetchImpl = createDirectSourceRssFetch(source, {
        retrieve: ({ url, allowedHosts: hosts, retrievedAt }) =>
          retrieveOfficialSource({
            url,
            policy: { allowedHosts: hosts },
            retrievedAt,
            fetchImpl: nodeSourceFetch,
            // The resolver is what makes the SSRF guard check RESOLVED
            // addresses rather than merely the hostname.
            resolveHost: nodeHostResolver,
          }),
        now: () => new Date().toISOString(),
      })

      return async (s: RegulatorySource) =>
        connectorKindForSource(s) === 'html'
          ? executeHtmlWatchConnector(s, allowedHosts, fetchImpl, { userAgent: USER_AGENT })
          : executeRssConnector(s, allowedHosts, fetchImpl, { userAgent: USER_AGENT })
    }

    const result = await runScheduledIngestion(
      {
        authorization: headerValue(req.headers['authorization']),
        cronSecretHeader: headerValue(req.headers['x-cron-secret']),
      },
      method,
      {
        cronSecret: process.env.CRON_SECRET ?? null,
        repository,
        buildRunConnector,
        now: () => new Date().toISOString(),
        userAgent: USER_AGENT,
      },
    )

    if (result.status >= 500) {
      logServerError({ event: 'api_error', requestId, category: String(result.body.error ?? 'internal_error'), status: result.status, method, route: CRON_INGEST_ROUTE })
    }
    res.status(result.status).json({ ...result.body, requestId })
  } catch {
    logServerError({ event: 'api_error', requestId, category: 'internal_error', status: 500, method, route: CRON_INGEST_ROUTE })
    res.status(500).json({ ok: false, error: 'internal_error', requestId })
  }
}
