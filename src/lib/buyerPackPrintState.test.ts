import { describe, it, expect, vi } from 'vitest'
import {
  deriveBuyerPackPrintState,
  installPrintTimestampListener,
  PRINT_AUTHORIZED_ATTR,
} from './buyerPackPrintState'
import type { BuyerPackReleaseConditions } from './buyerPackSnapshot'

// PR-2 F1/F3 — the media-level print gate and its provenance.
//
// The button gate was not a print gate: Cmd+P, File → Print and the context menu
// render the print stylesheet without ever calling handlePrint(). Authorization
// therefore lives in the DOM and is enforced by CSS.
//
// SCOPE OF THESE TESTS, stated plainly: they pin the INPUTS to that gate — the
// attribute value and the timestamp mechanism — behaviourally. They cannot
// prove the cascade itself, because no JS test environment evaluates
// `@media print`: jsdom does not implement print-media matching, so installing
// it would buy nothing here. The cascade is verified in a real browser and
// pinned structurally in scripts/buyer-pack-print-surface.test.mjs.

const OK: BuyerPackReleaseConditions = {
  isHumanApproved: true,
  storedDecision: { decision: 'progress', decidedAt: '2026-07-16T09:00:00.000Z' },
  approvedBy: 'Jane Reviewer',
}

// Every way release can fail. Each must close the media gate — that is the
// whole point of deriving it from one predicate.
const REFUSALS: Array<{ name: string; over: Partial<BuyerPackReleaseConditions> }> = [
  { name: 'not human-approved', over: { isHumanApproved: false } },
  { name: 'no recorded decision', over: { storedDecision: null } },
  { name: 'decision is not "progress"', over: { storedDecision: { decision: 'hold', decidedAt: '2026-07-16T09:00:00.000Z' } } },
  { name: 'approver identity is empty', over: { approvedBy: '' } },
  { name: 'approver identity is whitespace', over: { approvedBy: '   ' } },
]

describe('print authorization is represented in the DOM', () => {
  it('exposes a stable attribute name for the stylesheet to key on', () => {
    expect(PRINT_AUTHORIZED_ATTR).toBe('data-print-authorized')
  })

  it('authorizes only when every release condition is met', () => {
    const s = deriveBuyerPackPrintState(OK)
    expect(s.authorized).toBe(true)
    expect(s.attr).toBe('true')
    expect(s.refusalReason).toBeNull()
  })

  // All three gate inputs must control the media gate — not just the one with a
  // convenient boolean.
  for (const { name, over } of REFUSALS) {
    it(`refuses authorization when ${name}`, () => {
      const s = deriveBuyerPackPrintState({ ...OK, ...over })
      expect(s.authorized).toBe(false)
      expect(s.attr).toBe('false')
      expect(s.refusalReason).toBeTruthy()
    })
  }

  it('only ever emits "true" for the authorized case', () => {
    // The stylesheet opts in on exactly this string. Anything else must print
    // the refusal, so nothing but authorization may produce it.
    const attrs = REFUSALS.map(r => deriveBuyerPackPrintState({ ...OK, ...r.over }).attr)
    expect(attrs.every(a => a === 'false')).toBe(true)
    expect(deriveBuyerPackPrintState(OK).attr).toBe('true')
  })

  it('gives the refusal an established reason, never an invented one', () => {
    const s = deriveBuyerPackPrintState({ ...OK, isHumanApproved: false })
    expect(s.refusalReason).toBe('Batch is not human-approved for buyer discussion yet.')
  })
})

describe('print timestamp — every browser entry point', () => {
  // A minimal EventTarget stand-in. Node has a real EventTarget, but a hand-rolled
  // spy target proves the listener is registered under the right name and removed
  // on dispose, which is what actually matters.
  function fakeTarget() {
    const listeners: Record<string, Array<() => void>> = {}
    return {
      listeners,
      addEventListener: vi.fn((type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn)
      }),
      removeEventListener: vi.fn((type: string, fn: () => void) => {
        listeners[type] = (listeners[type] ?? []).filter(f => f !== fn)
      }),
      fire(type: string) { (listeners[type] ?? []).forEach(f => f()) },
    }
  }

  it('listens for beforeprint — the event every print path fires', () => {
    const t = fakeTarget()
    installPrintTimestampListener(t, () => {})
    expect(t.addEventListener).toHaveBeenCalledWith('beforeprint', expect.any(Function))
  })

  it('stamps on a native print, which never calls the click handler', () => {
    const t = fakeTarget()
    const stamp = vi.fn()
    installPrintTimestampListener(t, stamp)
    t.fire('beforeprint')
    expect(stamp).toHaveBeenCalledTimes(1)
  })

  it('stamps afresh on every print, so no timestamp is reused', () => {
    const t = fakeTarget()
    const stamps: number[] = []
    let n = 0
    installPrintTimestampListener(t, () => stamps.push(++n))
    t.fire('beforeprint')
    t.fire('beforeprint')
    t.fire('beforeprint')
    // Three prints, three distinct stamps — a stale time cannot survive a
    // subsequent print.
    expect(stamps).toEqual([1, 2, 3])
  })

  it('removes the listener on dispose, so it cannot stamp an unmounted pack', () => {
    const t = fakeTarget()
    const stamp = vi.fn()
    const dispose = installPrintTimestampListener(t, stamp)
    dispose()
    expect(t.removeEventListener).toHaveBeenCalledWith('beforeprint', expect.any(Function))
    t.fire('beforeprint')
    expect(stamp).not.toHaveBeenCalled()
  })

  it('removes exactly the handler it added', () => {
    const t = fakeTarget()
    const dispose = installPrintTimestampListener(t, () => {})
    const added = t.addEventListener.mock.calls[0][1]
    dispose()
    expect(t.removeEventListener.mock.calls[0][1]).toBe(added)
    expect(t.listeners['beforeprint']).toEqual([])
  })
})

describe('print error lifecycle — a refusal is scoped to the state that caused it', () => {
  // The component keys a stored refusal by this value and renders it only while
  // the key still matches, so eligibility changing invalidates it by derivation
  // rather than by an effect that would render the stale reason for a frame.
  const keyOf = (c: BuyerPackReleaseConditions) =>
    deriveBuyerPackPrintState(c).refusalReason ?? 'authorized'

  it('changes key when a refused pack becomes eligible', () => {
    const blocked = keyOf({ ...OK, isHumanApproved: false })
    const allowed = keyOf(OK)
    expect(blocked).not.toBe(allowed)
    expect(allowed).toBe('authorized')
  })

  it('changes key when the refusal reason changes', () => {
    const a = keyOf({ ...OK, isHumanApproved: false })
    const b = keyOf({ ...OK, approvedBy: '' })
    expect(a).not.toBe(b)
  })

  it('keeps the key stable while the same refusal persists', () => {
    // A stable key is what lets a live error stay on screen; only a real change
    // clears it.
    expect(keyOf({ ...OK, isHumanApproved: false })).toBe(keyOf({ ...OK, isHumanApproved: false }))
  })
})
