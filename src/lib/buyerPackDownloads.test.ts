import { beforeEach, describe, expect, it } from 'vitest'
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

describe('appendBuyerPackDownload — append-only download history', () => {
  it('records a download with only the required fields populated', () => {
    const record = appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 1, user: 'buyer-1', format: 'pdf' })
    expect(record.downloadId).toBeTruthy()
    expect(record.timestamp).toBeTruthy()
    expect(record.format).toBe('pdf')
    expect(record.buyerOrganisation).toBeUndefined()
  })

  it('supports optional future-expansion fields when supplied', () => {
    const record = appendBuyerPackDownload({
      packId: 'pack-1',
      snapshotVersion: 1,
      user: 'buyer-1',
      format: 'pdf',
      buyerOrganisation: 'Acme Imports',
      browser: 'Chrome 141',
      ipAddress: '203.0.113.4',
      device: 'desktop',
      reason: 'commercial review',
    })
    expect(record.buyerOrganisation).toBe('Acme Imports')
    expect(record.browser).toBe('Chrome 141')
    expect(record.ipAddress).toBe('203.0.113.4')
    expect(record.device).toBe('desktop')
    expect(record.reason).toBe('commercial review')
  })

  it('accumulates multiple downloads for the same pack without losing earlier ones', () => {
    appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 1, user: 'buyer-1', format: 'pdf' })
    appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 1, user: 'buyer-2', format: 'print' })
    appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 2, user: 'buyer-1', format: 'pdf' })

    const history = getBuyerPackDownloadHistory('pack-1')
    expect(history).toHaveLength(3)
    expect(history.map(r => r.format)).toEqual(['pdf', 'print', 'pdf'])
  })

  it('keeps download history for different packs independent', () => {
    appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 1, user: 'buyer-1', format: 'pdf' })
    appendBuyerPackDownload({ packId: 'pack-2', snapshotVersion: 1, user: 'buyer-1', format: 'pdf' })
    expect(getBuyerPackDownloadHistory('pack-1')).toHaveLength(1)
    expect(getBuyerPackDownloadHistory('pack-2')).toHaveLength(1)
  })

  it('returns records frozen — download history is never modified in place', () => {
    const record = appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 1, user: 'buyer-1', format: 'pdf' })
    const mutable: { format: string } = record
    expect(Object.isFrozen(record)).toBe(true)
    expect(() => {
      mutable.format = 'print'
    }).toThrow(TypeError)
  })

  it('returns an empty array for a pack with no recorded downloads', () => {
    expect(getBuyerPackDownloadHistory('never-downloaded-pack')).toEqual([])
  })

  it('returns download history sorted chronologically, oldest first', () => {
    appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 1, user: 'buyer-1', format: 'pdf' })
    appendBuyerPackDownload({ packId: 'pack-1', snapshotVersion: 1, user: 'buyer-2', format: 'print' })
    const history = getBuyerPackDownloadHistory('pack-1')
    expect(new Date(history[0].timestamp).getTime()).toBeLessThanOrEqual(new Date(history[1].timestamp).getTime())
  })
})
