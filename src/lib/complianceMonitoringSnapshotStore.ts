import { isValidBaseline, type MonitoringBaseline } from './complianceMonitoringSnapshot'
import type { MonitoringSnapshotRepository } from './complianceMonitoringSnapshotRepository'

// The localStorage implementation of MonitoringSnapshotRepository — the demo
// persistence convention already used across this codebase (buyerPackSnapshotStore,
// buyerPackAudit, buyerPackDownloads). Technical baselines only; no Supabase,
// no migration, no legal/compliance state. Nothing outside this file knows
// localStorage is involved.
//
// All reads are corruption-safe: a malformed JSON blob resets to empty, and
// any individual baseline that fails isValidBaseline() is dropped rather than
// trusted. Writes are append-only per source (history preserved).

const STORAGE_KEY = 'ddp_compliance_monitoring_baselines'

type BaselinesBySourceId = Record<string, MonitoringBaseline[]>

function readAll(): BaselinesBySourceId {
  let parsed: unknown
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

  // Keep only well-formed baselines; silently drop anything corrupt.
  const clean: BaselinesBySourceId = {}
  for (const [sourceId, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const valid = list.filter(isValidBaseline)
    if (valid.length > 0) clean[sourceId] = valid
  }
  return clean
}

function writeAll(all: BaselinesBySourceId): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

function byNewest(a: MonitoringBaseline, b: MonitoringBaseline): number {
  return b.baselineVersion - a.baselineVersion
}

export function createLocalStorageMonitoringSnapshotRepository(): MonitoringSnapshotRepository {
  return {
    getCurrentBaseline(sourceId: string): MonitoringBaseline | null {
      const list = readAll()[sourceId] ?? []
      if (list.length === 0) return null
      return [...list].sort(byNewest)[0]
    },

    saveBaseline(baseline: MonitoringBaseline): void {
      if (!isValidBaseline(baseline)) {
        throw new Error('Refusing to save a malformed monitoring baseline.')
      }
      const all = readAll()
      const existing = all[baseline.sourceId] ?? []
      if (existing.some(b => b.baselineVersion === baseline.baselineVersion)) {
        throw new Error(`Baseline version ${baseline.baselineVersion} already exists for this source.`)
      }
      all[baseline.sourceId] = [...existing, baseline]
      writeAll(all)
    },

    listBaselineHistory(sourceId: string): MonitoringBaseline[] {
      return [...(readAll()[sourceId] ?? [])].sort(byNewest)
    },
  }
}
