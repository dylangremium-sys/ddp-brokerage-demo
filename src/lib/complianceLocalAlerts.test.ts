import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { COMPLIANCE_ALERTS_STORAGE_KEY, loadStoredComplianceAlerts } from './complianceLocalAlerts'
import type { ComplianceAlert } from '../types'

// Minimal localStorage stub — the vitest env is 'node' (no DOM).
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
  return store
}

const alert = (over: Partial<ComplianceAlert> = {}): ComplianceAlert => ({
  id: 'a1',
  entityType: 'farm',
  entityId: 'farm-1',
  alertTitle: 'Manual compliance alert',
  alertDetail: 'Created in the demo Watchtower.',
  severity: 'high',
  status: 'open',
  createdAt: '2026-02-01T00:00:00.000Z',
  ...over,
} as ComplianceAlert)

describe('loadStoredComplianceAlerts', () => {
  let store: Map<string, string>
  beforeEach(() => { store = installLocalStorage() })
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage })

  it('returns [] when nothing is stored (a genuine empty state)', () => {
    expect(loadStoredComplianceAlerts()).toEqual([])
  })

  it('returns a stored unresolved alert', () => {
    store.set(COMPLIANCE_ALERTS_STORAGE_KEY, JSON.stringify([alert({ id: 'manual-1', status: 'open' })]))
    const alerts = loadStoredComplianceAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].id).toBe('manual-1')
    expect(alerts[0].status).toBe('open')
  })

  it('reads the same key the Watchtower persists to', () => {
    expect(COMPLIANCE_ALERTS_STORAGE_KEY).toBe('ddp_compliance_alerts')
  })

  it('falls back to [] on malformed stored data (never throws)', () => {
    store.set(COMPLIANCE_ALERTS_STORAGE_KEY, '{ not valid json')
    expect(loadStoredComplianceAlerts()).toEqual([])
  })

  it('performs no write — it is a reader only', () => {
    store.set(COMPLIANCE_ALERTS_STORAGE_KEY, JSON.stringify([alert()]))
    const before = store.get(COMPLIANCE_ALERTS_STORAGE_KEY)
    loadStoredComplianceAlerts()
    expect(store.get(COMPLIANCE_ALERTS_STORAGE_KEY)).toBe(before)
    expect(store.size).toBe(1)
  })
})
