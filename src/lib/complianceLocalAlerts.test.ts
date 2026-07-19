import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { COMPLIANCE_ALERTS_STORAGE_KEY, loadStoredComplianceAlerts, COMPLIANCE_RULES_STORAGE_KEY, loadStoredComplianceRules } from './complianceLocalAlerts'
import { createBaselineComplianceRules } from './complianceRules'
import { makeRule } from './testFixtures'
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

describe('loadStoredComplianceRules', () => {
  let store: Map<string, string>
  beforeEach(() => { store = installLocalStorage() })
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage })

  it('falls back to the baseline rule set when nothing is stored', () => {
    // Compare by shape (baseline rules carry live timestamps, so not by identity).
    const out = loadStoredComplianceRules()
    const baseline = createBaselineComplianceRules()
    expect(out.length).toBe(baseline.length)
    expect(out.length).toBeGreaterThan(0)
    expect(out.map(r => r.ruleCode).sort()).toEqual(baseline.map(r => r.ruleCode).sort())
  })

  it('falls back to baseline on malformed stored data (never throws)', () => {
    store.set(COMPLIANCE_RULES_STORAGE_KEY, '{ not valid json')
    expect(loadStoredComplianceRules().length).toBe(createBaselineComplianceRules().length)
  })

  it('falls back to baseline on non-array stored data', () => {
    store.set(COMPLIANCE_RULES_STORAGE_KEY, JSON.stringify({ not: 'an array' }))
    expect(loadStoredComplianceRules().length).toBe(createBaselineComplianceRules().length)
  })

  it('returns the stored rule list as-is — it OVERRIDES baseline, not merges', () => {
    const stored = [makeRule({ ruleCode: 'BATCH_COA_REQUIRED', status: 'approved' })]
    store.set(COMPLIANCE_RULES_STORAGE_KEY, JSON.stringify(stored))
    const out = loadStoredComplianceRules()
    expect(out).toHaveLength(1) // exactly the stored list — no stale baseline rules mixed in
    expect(out[0].ruleCode).toBe('BATCH_COA_REQUIRED')
    expect(out[0].status).toBe('approved')
  })

  it('returns a genuinely empty stored list as [] (matches the Watchtower)', () => {
    store.set(COMPLIANCE_RULES_STORAGE_KEY, '[]')
    expect(loadStoredComplianceRules()).toEqual([])
  })

  it('reads the same key the Watchtower persists rules to', () => {
    expect(COMPLIANCE_RULES_STORAGE_KEY).toBe('ddp_compliance_rules')
  })

  it('performs no write — it is a reader only', () => {
    store.set(COMPLIANCE_RULES_STORAGE_KEY, JSON.stringify([makeRule({ status: 'draft' })]))
    const before = store.get(COMPLIANCE_RULES_STORAGE_KEY)
    loadStoredComplianceRules()
    expect(store.get(COMPLIANCE_RULES_STORAGE_KEY)).toBe(before)
  })
})
