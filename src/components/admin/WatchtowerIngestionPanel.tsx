import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RegulatorySource, WatchtowerIngestionRun } from '../../types'
import * as repo from '../../lib/complianceRepository'
import { runIngestionBatch, type BatchIngestionReport } from '../../lib/watchtowerIngestionService'
import { createDefaultIngestionDeps } from '../../lib/watchtowerIngestionBrowserDeps'
import { detectStaleSources } from '../../lib/watchtowerIngestionRun'
import { getSession } from '../../services/auth'

// ─── Watchtower Ingestion Runs — admin panel (Phase C, minimal UI) ───────────
//
// A deliberately self-contained, read-mostly panel: it lists ingestion run
// evidence and offers ONE explicit "Run ingestion now" trigger. It holds no
// business logic — all orchestration lives in watchtowerIngestionService.ts and
// all persistence in complianceRepository.ts. It never fetches a feed directly,
// never creates a rule, never calls AI.
//
// The host allowlist is deny-by-default and derived from the admin-registered
// enabled sources' own hostnames: an operator who added a source has already
// vetted that host. The connector's SSRF guard (private/link-local/metadata,
// non-HTTPS, non-standard ports) still applies on top, independently.

const STALE_HOURS = 24

interface Props {
  sources: RegulatorySource[]
  isSupabaseConfigured: boolean
  isAdmin: boolean
}

function statusClass(status: WatchtowerIngestionRun['status']): string {
  switch (status) {
    case 'succeeded': return 'status-verified'
    case 'partial': return 'status-claimed'
    case 'failed': return 'status-missing'
    case 'skipped': return 'status-hold'
    default: return 'status-hold'
  }
}

function allowlistFromSources(sources: RegulatorySource[]): string[] {
  const hosts = new Set<string>()
  for (const s of sources) {
    if (!s.isActive) continue
    try {
      hosts.add(new URL(s.url).hostname.toLowerCase())
    } catch {
      // Unparseable URL — the connector will reject it as url_unsafe anyway.
    }
  }
  return [...hosts]
}

export function WatchtowerIngestionPanel({ sources, isSupabaseConfigured, isAdmin }: Props) {
  const [runs, setRuns] = useState<WatchtowerIngestionRun[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [lastReport, setLastReport] = useState<BatchIngestionReport | null>(null)

  const enabledAutoSources = useMemo(
    () => sources.filter(s => s.isActive && s.monitoringMethod && s.monitoringMethod !== 'manual'),
    [sources],
  )

  const loadRuns = useCallback(async () => {
    if (!isSupabaseConfigured) return
    setLoading(true)
    try {
      setRuns(await repo.fetchIngestionRuns(100))
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load ingestion runs.' })
    } finally {
      setLoading(false)
    }
  }, [isSupabaseConfigured])

  // Initial load. Kept separate from loadRuns() (used by the button) so no
  // setState runs synchronously inside the effect body — the fetch is awaited
  // first, then state is set only if the component is still mounted.
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let cancelled = false
    void (async () => {
      try {
        const data = await repo.fetchIngestionRuns(100)
        if (!cancelled) setRuns(data)
      } catch (err) {
        if (!cancelled) setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load ingestion runs.' })
      }
    })()
    return () => { cancelled = true }
  }, [isSupabaseConfigured])

  // Stale-source detection from the loaded run history: an enabled auto-source
  // with no SUCCESSFUL run inside the window is flagged. This is monitoring
  // health, surfaced explicitly rather than left silent.
  const staleSourceIds = useMemo(() => {
    const lastSuccessBySource = new Map<string, string>()
    for (const run of runs) {
      if (run.status !== 'succeeded' || !run.sourceId) continue
      const prev = lastSuccessBySource.get(run.sourceId)
      if (!prev || run.startedAt > prev) lastSuccessBySource.set(run.sourceId, run.startedAt)
    }
    const now = new Date().toISOString()
    return new Set(detectStaleSources(
      enabledAutoSources.map(s => ({ sourceId: s.id, lastSuccessfulRunAt: lastSuccessBySource.get(s.id) ?? null })),
      STALE_HOURS,
      now,
    ))
  }, [runs, enabledAutoSources])

  async function handleRunIngestion(): Promise<void> {
    setMessage(null)
    if (!isSupabaseConfigured) {
      setMessage({ type: 'error', text: 'Ingestion requires the Supabase backend; not available in local/demo mode.' })
      return
    }
    if (!isAdmin) {
      setMessage({ type: 'error', text: 'Admin access is required to run ingestion.' })
      return
    }
    if (enabledAutoSources.length === 0) {
      setMessage({ type: 'info', text: 'No enabled sources with an automatic monitoring method. Set a source to rss/atom/html/pdf/government_api first.' })
      return
    }

    const session = await getSession()
    const allowedHosts = allowlistFromSources(enabledAutoSources)

    setRunning(true)
    try {
      const deps = createDefaultIngestionDeps({
        allowedHosts,
        userAgent: 'DDP-Watchtower-Ingestion/1.0 (+admin-triggered)',
        trigger: 'manual',
        actorType: 'admin',
        actorId: session?.user?.id ?? null,
        // Read per retrieval rather than captured from the `session` above: a
        // full registry sweep can outlive a short-lived access token, and a
        // token that expires mid-run would fail the remaining sources with
        // "no active session" — which reads as unreachable regulators.
        getAccessToken: async () => (await getSession())?.access_token ?? null,
      })
      const report = await runIngestionBatch(enabledAutoSources, deps)
      setLastReport(report)
      setMessage({
        type: report.failed > 0 || report.partial > 0 ? 'info' : 'success',
        text: `Ingestion complete: ${report.succeeded} ok, ${report.partial} partial, ${report.failed} failed, ${report.skipped} skipped · ${report.newCandidates} new candidate(s), ${report.duplicates} duplicate(s).`,
      })
      await loadRuns()
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Ingestion failed unexpectedly.' })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Scheduled / Triggerable Ingestion</h2>
        <p className="td-muted">
          Runs the enabled, auto-monitored sources through the read-only connector, deduplicates against
          existing records, and creates candidate legal updates in <strong>draft (new)</strong> status only —
          which still pass through the same human Review Queue. It never approves, enforces, summarises, or
          calls AI. An unavailable source is recorded as a <strong>failed run</strong>, never as a silent
          no-change.
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={running || !isAdmin} onClick={() => { void handleRunIngestion() }}>
            {running ? 'Running ingestion…' : 'Run ingestion now'}
          </button>
          <button className="btn btn-review" disabled={loading} onClick={() => { void loadRuns() }}>
            {loading ? 'Refreshing…' : 'Refresh run history'}
          </button>
          <span className="td-muted" style={{ fontSize: 12 }}>
            {enabledAutoSources.length} enabled auto-source(s)
            {staleSourceIds.size > 0 && ` · ${staleSourceIds.size} stale (>${STALE_HOURS}h without a successful run)`}
          </span>
        </div>

        {message && (
          <div className="disclaimer-box" style={{ marginTop: 12 }}>
            <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: message.type === 'error' ? 'var(--warning)' : 'var(--success, #2e7d32)' }}>
              {message.type === 'error' ? 'INGESTION ERROR' : message.type === 'info' ? 'INGESTION NOTICE' : 'INGESTION OK'}
            </span>
            <div>{message.text}</div>
          </div>
        )}

        {lastReport && (
          <div className="td-muted" style={{ marginTop: 10, fontSize: 12 }}>
            Last batch: {lastReport.totalSources} source(s) · {lastReport.aborted} aborted (could not record).
          </div>
        )}
      </div>

      {staleSourceIds.size > 0 && (
        <div className="card" style={{ padding: 16, marginTop: 16, borderLeft: '3px solid #d9822b' }}>
          <strong>Stale sources</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {enabledAutoSources.filter(s => staleSourceIds.has(s.id)).map(s => (
              <li key={s.id}>{s.name} — no successful run in the last {STALE_HOURS}h</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card table-card" style={{ marginTop: 16 }}>
        <div className="table-scroll">
          <table className="inv-table inv-table--cards">
            <thead>
              <tr>
                <th>Source</th><th>Kind</th><th>Trigger</th><th>Status</th><th>Reason</th>
                <th>Seen</th><th>New</th><th>Dup</th><th>Unch.</th><th>Failed</th><th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <tr key={run.id}>
                  <td><span className="td-bold">{run.sourceNameSnapshot || '—'}</span></td>
                  <td>{run.connectorKind}</td>
                  <td>{run.triggerType}</td>
                  <td><span className={`status-pill ${statusClass(run.status)}`}>{run.status}</span></td>
                  <td className="td-muted" style={{ fontSize: 12 }}>{run.failureReason ?? '—'}</td>
                  <td>{run.itemsSeen}</td>
                  <td>{run.itemsNew}</td>
                  <td>{run.itemsDuplicate}</td>
                  <td>{run.itemsUnchanged}</td>
                  <td>{run.itemsFailed}</td>
                  <td className="td-muted" style={{ fontSize: 12 }}>{run.startedAt}</td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign: 'center', padding: 28 }}>
                  {isSupabaseConfigured ? 'No ingestion runs recorded yet.' : 'Ingestion history is available with the Supabase backend.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
