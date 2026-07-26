import { beforeEach, describe, expect, it } from 'vitest'
import { recordRiskOverride, recordRequirementOverride } from './procurementOverrideStore'

/**
 * Where the fail-closed override contract stops.
 *
 * Two deliberate behaviour changes arrived with the override-store adoption.
 * They were reviewed separately and settled differently, and this file pins
 * both outcomes so neither drifts back silently:
 *
 *   KEPT     — a reason is required to record an override in demo mode too.
 *              Reverting it would mean reintroducing the raw save* calls the
 *              adoption exists to remove.
 *   REVERTED — override controls are no longer disabled while the authoritative
 *              read is loading or unavailable. Fail-closed governs DISPLAY: an
 *              unverified status must never be rendered as verified. It does
 *              not extend to locking the operator out of input. The write is an
 *              absolute set against the server, not a delta off the displayed
 *              baseline, and both surfaces re-resolve after it lands.
 *
 * The .tsx assertions read source text — this repo's vitest environment is
 * 'node' with no jsdom, so components are never rendered under test (see
 * operationsDeskRouting.test.ts for the convention).
 */
function raw(glob: Record<string, string>): string {
  return Object.values(glob)[0] ?? ''
}

/** The vitest environment is 'node' — no localStorage. Same stub as procurementOverrideStore.test.ts. */
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

const RISK_SRC = raw(import.meta.glob('../pages/admin/DDPRiskRegister.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
const MATRIX_SRC = raw(import.meta.glob('../pages/admin/DDPMissingDocuments.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('override input availability — source fixtures are readable', () => {
  it('loads both override surfaces', () => {
    expect(RISK_SRC.length).toBeGreaterThan(1000)
    expect(MATRIX_SRC.length).toBeGreaterThan(1000)
  })
})

describe('REVERTED — an unread or unavailable override read does not disable input', () => {
  it('the Risk Register status control is gated on the in-flight write only', () => {
    expect(RISK_SRC).not.toContain('disabled={!overridesLive || saving}')
    expect(RISK_SRC).toContain('disabled={saving}')
  })

  it('the Missing Document Matrix override control is gated on the in-flight write only', () => {
    expect(MATRIX_SRC).not.toContain("disabled={overrideState !== 'resolved' || saving}")
    expect(MATRIX_SRC).toContain('disabled={saving}')
  })

  it('neither surface still tells the operator that overrides are disabled', () => {
    expect(RISK_SRC).not.toContain('Overrides cannot be changed until')
    expect(MATRIX_SRC).not.toContain('Overrides are disabled until')
    expect(MATRIX_SRC).not.toContain('Recording new overrides is disabled')
  })

  it('warns instead of blocking when the authoritative state is not read', () => {
    expect(RISK_SRC).toContain('the status shown may not be the recorded one')
    expect(MATRIX_SRC).toContain('the status shown may not be the recorded one')
  })
})

describe('UNCHANGED — fail-closed still governs display', () => {
  it('the matrix still distinguishes loading from unavailable', () => {
    expect(MATRIX_SRC).toContain("overrideState === 'loading'")
    expect(MATRIX_SRC).toContain("overrideState === 'unavailable'")
  })

  it('the matrix still refuses to render an unreadable state as "no overrides"', () => {
    expect(MATRIX_SRC).toContain('This is <strong>not</strong> a statement that none exist.')
  })

  it('the matrix still labels the counts as derived, not authoritative', () => {
    expect(MATRIX_SRC).toContain('are not authoritative')
  })
})

describe('KEPT — a reason is required to record an override, demo mode included', () => {
  it('refuses a blank risk override reason with no client at all', async () => {
    const result = await recordRiskOverride({ riskId: 'r-1', status: 'accepted', reason: '   ' }, null)
    expect(result).toEqual({
      ok: false,
      persistedTo: 'none',
      error: 'A reason is required to override a risk.',
    })
  })

  it('refuses a blank requirement override reason with no client at all', async () => {
    const result = await recordRequirementOverride(
      { farmId: 'f-1', type: 'coa', status: 'documented', reason: '' },
      null,
    )
    expect(result).toEqual({
      ok: false,
      persistedTo: 'none',
      error: 'A reason is required to override a requirement.',
    })
  })

  it('accepts a stated reason in demo mode and says where it persisted', async () => {
    const result = await recordRiskOverride({ riskId: 'r-2', status: 'accepted', reason: 'Signed waiver on file' }, null)
    expect(result.ok).toBe(true)
    expect(result.persistedTo).toBe('local-cache')
  })

  it('keeps the confirm buttons gated on a non-blank reason on both surfaces', () => {
    expect(RISK_SRC).toContain('disabled={!pendingReason.trim() || saving}')
    expect(MATRIX_SRC).toContain('disabled={!pending.reason.trim() || saving}')
  })
})
