import { describe, it, expect } from 'vitest'
import { resolveOperationsDeskEmptyState } from './operationsDeskEmptyState'

const base = { visibleCount: 0, failureCount: 0, hasPendingSources: false, isFiltered: false }

describe('resolveOperationsDeskEmptyState', () => {
  it('review requests loading + zero matters → loading, never all-clear', () => {
    expect(resolveOperationsDeskEmptyState({ ...base, hasPendingSources: true })).toBe('loading')
  })

  it('compliance loading + zero matters → loading (same pending signal)', () => {
    // hasPendingSources is reviewRequestsLoading || complianceLoading in the page.
    expect(resolveOperationsDeskEmptyState({ ...base, hasPendingSources: true })).toBe('loading')
  })

  it('both sources loading + zero matters → loading', () => {
    expect(resolveOperationsDeskEmptyState({ ...base, hasPendingSources: true })).toBe('loading')
  })

  it('a loading source but an already-derived matter exists → has-matters (matter stays visible)', () => {
    const s = resolveOperationsDeskEmptyState({ ...base, visibleCount: 1, hasPendingSources: true })
    expect(s).toBe('has-matters')
  })

  it('all sources settled successfully and empty → all-clear', () => {
    expect(resolveOperationsDeskEmptyState({ ...base })).toBe('all-clear')
  })

  it('a source failed and empty → failed, never all-clear', () => {
    expect(resolveOperationsDeskEmptyState({ ...base, failureCount: 1 })).toBe('failed')
  })

  it('failure takes precedence over a still-pending source', () => {
    expect(resolveOperationsDeskEmptyState({ ...base, failureCount: 1, hasPendingSources: true })).toBe('failed')
  })

  it('settled, empty, but filtered → filtered-empty (not all-clear)', () => {
    expect(resolveOperationsDeskEmptyState({ ...base, isFiltered: true })).toBe('filtered-empty')
  })

  it('demo settled and empty (nothing pending) → all-clear', () => {
    // Demo sources are settled once read; hasPendingSources is false in demo.
    expect(resolveOperationsDeskEmptyState({ ...base, hasPendingSources: false })).toBe('all-clear')
  })
})
