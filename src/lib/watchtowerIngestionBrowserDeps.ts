import type { RegulatorySource } from '../types.js'
import * as repo from './complianceRepository.js'
import { executeRssConnector } from './complianceRssConnector.js'
import { executeHtmlWatchConnector } from './complianceHtmlWatchConnector.js'
import { createServerProxyRssFetch } from './serverProxyRssFetch.js'
import { inferConnectorKind } from './complianceSourceConnectors.js'
import type { SourceContentSnapshot } from './complianceSourceMonitoring.js'
import type { IngestionDeps } from './watchtowerIngestionService.js'

// ─── Browser dependency wiring for Watchtower ingestion ─────────────────────
//
// Split out of watchtowerIngestionService.ts so that module can be imported by
// a Vercel Function. This file is the ONLY one that reaches the real
// complianceRepository, which transitively reaches supabase.ts and its
// `import.meta.env.VITE_*` module body — undefined under Node ESM, and
// therefore fatal at load in a serverless function.
//
// The scheduled path has its own repository (serverIngestionRepository.ts)
// against an injected client. Keeping the two wirings in separate files is what
// stops a server import accidentally dragging the browser Supabase singleton
// along with it; nothing here is reachable from api/.

/** Duplicated from the service rather than imported, because it is only used
 *  here and importing it back would recreate the coupling this split removes. */
function connectorKindForSource(source: RegulatorySource): string {
  if (source.monitoringMethod && source.monitoringMethod !== 'manual') {
    return source.monitoringMethod
  }
  return inferConnectorKind(source)
}

// ─── Default (real) dependency wiring ────────────────────────────────────────

export interface DefaultIngestionDepsConfig {
  allowedHosts: string[]
  userAgent: string
  trigger?: 'scheduled' | 'manual' | 'backfill'
  actorType?: 'admin' | 'system' | 'scheduler'
  actorId?: string | null
  timeoutMs?: number
  maxResponseBytes?: number
  /**
   * Returns the caller's Supabase access token for the server retrieval call.
   *
   * REQUIRED rather than defaulted. A default would let a call site forget it
   * and get an ingestion run that fails every source with "no active session" —
   * a failure that looks like eight unreachable regulators rather than one
   * missing argument.
   */
  getAccessToken: () => Promise<string | null>
  /**
   * Previously-seen page snapshots, keyed by htmlWatchItemId(source).
   *
   * Only html-monitored sources use this. Absent means every watched page reads
   * as first-seen, which produces one candidate per page on the first run and
   * then settles — the correct behaviour for a cold start, and the reason this
   * is optional rather than required.
   */
  previousSnapshots?: Map<string, SourceContentSnapshot>
}

/**
 * Wires the real repository + the existing RSS/Atom connector, retrieving
 * through the SERVER (api/compliance/feed-retrieve) rather than from the
 * browser. The host allowlist is REQUIRED and deny-by-default — the connector
 * refuses any source whose host is not listed. Only the RSS/Atom/feed modality
 * is auto-fetched today; other kinds surface as an 'unsupported_connector'
 * failed run, which is the correct fail-closed behaviour.
 *
 * The transport changed here on purpose and the connector did not. Browser
 * retrieval never worked and could not be made to work: the deployed CSP
 * refuses `connect-src` to any regulator, and both registered feeds send no
 * CORS header either (docs/CSP_FEED_RETRIEVAL_DECISION.md). Every "Run
 * ingestion now" before this change was guaranteed to record a failed run.
 *
 * The fetch implementation is built PER SOURCE because the server endpoint
 * takes a source ID, not a URL — see createServerProxyRssFetch for why that
 * asymmetry is load-bearing rather than accidental.
 */
export function createDefaultIngestionDeps(config: DefaultIngestionDepsConfig): IngestionDeps {
  return {
    runConnector: (source) => {
      const fetchImpl = createServerProxyRssFetch(source.id, { getAccessToken: config.getAccessToken })

      // Dispatch by modality. Until now this always called executeRssConnector,
      // which hard-rejects any kind that is not rss/atom — so all six
      // html-monitored Thai sources (FDA, MOPH, ONCB, Customs, DOA, the Royal
      // Gazette) recorded `unsupported_connector` on every run, and DDP
      // monitored the Czech and EU regulators only.
      if (connectorKindForSource(source) === 'html') {
        return executeHtmlWatchConnector(source, config.allowedHosts, fetchImpl, {
          userAgent: config.userAgent,
          timeoutMs: config.timeoutMs,
          maxResponseBytes: config.maxResponseBytes,
          previousSnapshots: config.previousSnapshots,
        })
      }

      return executeRssConnector(source, config.allowedHosts, fetchImpl, {
        userAgent: config.userAgent,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
      })
    },
    fetchKnownIdentity: () => repo.fetchKnownLegalUpdateIdentity(),
    openRun: (input) => repo.openIngestionRun(input),
    closeRun: (id, input) => repo.closeIngestionRun(id, input),
    insertItem: (input) => repo.insertIngestionItem(input),
    insertCandidate: (input) => repo.insertCandidateLegalUpdate(input),
    now: () => new Date().toISOString(),
    trigger: config.trigger ?? 'manual',
    actorType: config.actorType ?? 'admin',
    actorId: config.actorId ?? null,
  }
}
