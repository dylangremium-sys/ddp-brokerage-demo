import { beforeEach, describe, expect, it } from 'vitest'
import { appendBuyerPackAuditEvent, getBuyerPackAuditTrail, mergeBuyerPackHistory } from './buyerPackAudit'
import { appendBuyerPackDownload, getBuyerPackDownloadHistory } from './buyerPackDownloads'

// See buyerPackSnapshot.test.ts for why this stand-in is installed per test
// rather than changing vite.config.ts / build tooling.
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  } as Storage
}

beforeEach(() => {
  installMemoryLocalStorage()
})

describe('appendBuyerPackAuditEvent — append-only audit trail', () => {
  it('records an event and returns it with a generated id and timestamp', () => {
    const event = appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 1, action: 'pack_generated', user: 'admin-1' })
    expect(event.eventId).toBeTruthy()
    expect(event.timestamp).toBeTruthy()
    expect(event.action).toBe('pack_generated')
  })

  it('accumulates multiple events for the same pack without losing earlier ones', () => {
    appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 1, action: 'pack_generated', user: 'admin-1' })
    appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 1, action: 'pack_viewed', user: 'buyer-1' })
    appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 2, action: 'pack_generated', user: 'admin-1' })

    const trail = getBuyerPackAuditTrail('pack-1')
    expect(trail).toHaveLength(3)
    expect(trail.map(e => e.action)).toEqual(['pack_generated', 'pack_viewed', 'pack_generated'])
  })

  it('keeps audit trails for different packs independent', () => {
    appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 1, action: 'pack_generated', user: 'admin-1' })
    appendBuyerPackAuditEvent({ packId: 'pack-2', snapshotVersion: 1, action: 'pack_generated', user: 'admin-1' })
    expect(getBuyerPackAuditTrail('pack-1')).toHaveLength(1)
    expect(getBuyerPackAuditTrail('pack-2')).toHaveLength(1)
  })

  it('returns events frozen — no event may ever be edited', () => {
    const event = appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 1, action: 'pack_generated', user: 'admin-1' })
    const mutable: { action: string } = event
    expect(Object.isFrozen(event)).toBe(true)
    expect(() => {
      mutable.action = 'pack_archived'
    }).toThrow(TypeError)
  })

  it('returns the audit trail sorted chronologically, oldest first', () => {
    appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 1, action: 'pack_generated', user: 'admin-1' })
    appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 1, action: 'pack_viewed', user: 'buyer-1' })
    const trail = getBuyerPackAuditTrail('pack-1')
    expect(new Date(trail[0].timestamp).getTime()).toBeLessThanOrEqual(new Date(trail[1].timestamp).getTime())
  })

  it('returns an empty array for a pack with no recorded events', () => {
    expect(getBuyerPackAuditTrail('never-seen-pack')).toEqual([])
  })
})

describe('mergeBuyerPackHistory — merged chronological history', () => {
  it('interleaves audit events and download records in timestamp order', () => {
    const auditEvents = [
      { eventId: 'e1', packId: 'pack-1', snapshotVersion: 1, action: 'pack_generated' as const, timestamp: '2026-01-01T00:00:00.000Z', user: 'admin-1' },
      { eventId: 'e2', packId: 'pack-1', snapshotVersion: 1, action: 'pack_viewed' as const, timestamp: '2026-01-03T00:00:00.000Z', user: 'buyer-1' },
    ]
    const downloadRecords = [
      { downloadId: 'd1', packId: 'pack-1', snapshotVersion: 1, timestamp: '2026-01-02T00:00:00.000Z', user: 'buyer-1', format: 'pdf' },
    ]

    const merged = mergeBuyerPackHistory(auditEvents, downloadRecords)
    expect(merged.map(m => m.kind)).toEqual(['audit', 'download', 'audit'])
    expect(merged.map(m => m.timestamp)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ])
  })

  it('carries the download format into the merged entry detail', () => {
    const merged = mergeBuyerPackHistory([], [
      { downloadId: 'd1', packId: 'pack-1', snapshotVersion: 1, timestamp: '2026-01-01T00:00:00.000Z', user: 'buyer-1', format: 'pdf' },
    ])
    expect(merged[0].detail).toBe('pdf')
    expect(merged[0].action).toBe('pack_downloaded')
  })

  it('reflects real appended events end-to-end, reading both stores independently and merging on read', () => {
    appendBuyerPackAuditEvent({ packId: 'pack-1', snapshotVersion: 1, action: 'pack_generated', user: 'admin-1' })
    appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 1, user: 'buyer-1', format: 'pdf' })

    const merged = mergeBuyerPackHistory(getBuyerPackAuditTrail('pack-1'), getBuyerPackDownloadHistory('pack-1'))
    expect(merged).toHaveLength(2)
    expect(merged.map(m => m.kind).sort()).toEqual(['audit', 'download'])
  })
})
