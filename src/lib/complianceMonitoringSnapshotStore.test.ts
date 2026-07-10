import { beforeEach, describe, expect, it } from 'vitest'
import { createLocalStorageMonitoringSnapshotRepository } from './complianceMonitoringSnapshotStore'
import type { MonitoringBaseline } from './complianceMonitoringSnapshot'

const STORAGE_KEY = 'ddp_compliance_monitoring_baselines'

// Same in-memory localStorage stand-in convention as the other buyer-pack /
// monitoring tests (node env has no working localStorage).
function installMemoryLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
  return store
}

function makeBaseline(overrides: Partial<MonitoringBaseline> = {}): MonitoringBaseline {
  return {
    id: 'bl-' + (overrides.baselineVersion ?? 1),
    sourceId: 'source-1',
    connectorKind: 'rss',
    feedTitle: 'Feed',
    feedUrl: 'https://x/rss.xml',
    capturedAt: '2026-07-10T00:00:00.000Z',
    baselineVersion: 1,
    itemCount: 1,
    items: [{ stableId: 'source-1::guid-a', itemTitle: 'A', itemUrl: null, publishedAt: null, checksum: 'abc' }],
    ...overrides,
  }
}

let backing: Map<string, string>
beforeEach(() => { backing = installMemoryLocalStorage() })

describe('createLocalStorageMonitoringSnapshotRepository', () => {
  it('has no baseline initially', () => {
    const repo = createLocalStorageMonitoringSnapshotRepository()
    expect(repo.getCurrentBaseline('source-1')).toBeNull()
    expect(repo.listBaselineHistory('source-1')).toEqual([])
  })

  it('saves a baseline and reads it back as current', () => {
    const repo = createLocalStorageMonitoringSnapshotRepository()
    repo.saveBaseline(makeBaseline({ baselineVersion: 1 }))
    expect(repo.getCurrentBaseline('source-1')?.baselineVersion).toBe(1)
    expect(repo.listBaselineHistory('source-1')).toHaveLength(1)
  })

  it('preserves prior baselines as history when a new one is saved (newest first)', () => {
    const repo = createLocalStorageMonitoringSnapshotRepository()
    repo.saveBaseline(makeBaseline({ baselineVersion: 1 }))
    repo.saveBaseline(makeBaseline({ baselineVersion: 2 }))
    const history = repo.listBaselineHistory('source-1')
    expect(history.map(b => b.baselineVersion)).toEqual([2, 1])
    expect(repo.getCurrentBaseline('source-1')?.baselineVersion).toBe(2)
  })

  it('rejects a duplicate version and a malformed baseline', () => {
    const repo = createLocalStorageMonitoringSnapshotRepository()
    repo.saveBaseline(makeBaseline({ baselineVersion: 1 }))
    expect(() => repo.saveBaseline(makeBaseline({ baselineVersion: 1 }))).toThrow(/already exists/)
    // @ts-expect-error deliberately malformed
    expect(() => repo.saveBaseline({ id: 'x' })).toThrow(/malformed/)
  })

  it('resets safely on a corrupt JSON blob', () => {
    backing.set(STORAGE_KEY, '{not json')
    const repo = createLocalStorageMonitoringSnapshotRepository()
    expect(repo.getCurrentBaseline('source-1')).toBeNull()
    // A subsequent valid save still works (corrupt data was ignored, not thrown).
    repo.saveBaseline(makeBaseline({ baselineVersion: 1 }))
    expect(repo.getCurrentBaseline('source-1')?.baselineVersion).toBe(1)
  })

  it('drops individual malformed baselines but keeps valid ones', () => {
    backing.set(STORAGE_KEY, JSON.stringify({
      'source-1': [makeBaseline({ baselineVersion: 1 }), { id: 'garbage' }],
    }))
    const repo = createLocalStorageMonitoringSnapshotRepository()
    const history = repo.listBaselineHistory('source-1')
    expect(history).toHaveLength(1)
    expect(history[0].baselineVersion).toBe(1)
  })

  it('isolates baselines by source id', () => {
    const repo = createLocalStorageMonitoringSnapshotRepository()
    repo.saveBaseline(makeBaseline({ baselineVersion: 1, sourceId: 'source-1', id: 'a' }))
    repo.saveBaseline(makeBaseline({ baselineVersion: 1, sourceId: 'source-2', id: 'b' }))
    expect(repo.getCurrentBaseline('source-1')?.id).toBe('a')
    expect(repo.getCurrentBaseline('source-2')?.id).toBe('b')
  })
})
