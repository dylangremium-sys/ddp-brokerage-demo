import { describe, expect, it } from 'vitest'
import {
  buildMonitoringDecision,
  buildSourceSnapshot,
  compareSourceSnapshot,
  computeSourceChecksum,
  normalizeSourceContent,
  shouldCreateLegalUpdateFromSourceChange,
  validateSourceContent,
} from './complianceSourceMonitoring'

describe('normalizeSourceContent', () => {
  it('collapses all whitespace runs (including line breaks) into single spaces, trims ends, normalizes CRLF', () => {
    const messy = 'Line one.\r\n\r\n   Line   two   with   extra   spaces.\r\n\n\nLine three.\n\n'
    expect(normalizeSourceContent(messy)).toBe('Line one. Line two with extra spaces. Line three.')
  })

  it('is idempotent — normalizing already-normalized content is a no-op', () => {
    const once = normalizeSourceContent('Some text. Another line.')
    expect(normalizeSourceContent(once)).toBe(once)
  })
})

describe('computeSourceChecksum — same content produces same checksum', () => {
  it('produces an identical SHA-256 hex digest for identical content', async () => {
    const a = await computeSourceChecksum('Some regulatory text.')
    const b = await computeSourceChecksum('Some regulatory text.')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a different checksum for different content', async () => {
    const a = await computeSourceChecksum('Version one.')
    const b = await computeSourceChecksum('Version two.')
    expect(a).not.toBe(b)
  })
})

describe('buildSourceSnapshot — whitespace-normalized content does not create a false change', () => {
  it('two raw inputs differing only in whitespace/formatting produce the same checksum', async () => {
    const snapshotA = await buildSourceSnapshot('source-1', 'The rule applies to all licensed cultivators.', '2026-01-01T00:00:00.000Z')
    const snapshotB = await buildSourceSnapshot('source-1', '  The rule   applies to all\r\nlicensed    cultivators.  \n\n', '2026-01-02T00:00:00.000Z')
    expect(snapshotA.checksum).toBe(snapshotB.checksum)
    expect(compareSourceSnapshot(snapshotA, snapshotB)).toBe('unchanged')
  })
})

describe('compareSourceSnapshot — changed content is detected', () => {
  it('detects a genuine content change', async () => {
    const previous = await buildSourceSnapshot('source-1', 'Original wording.', '2026-01-01T00:00:00.000Z')
    const current = await buildSourceSnapshot('source-1', 'Updated wording that materially differs.', '2026-01-02T00:00:00.000Z')
    expect(compareSourceSnapshot(previous, current)).toBe('changed')
  })

  it('treats a null previous snapshot as first_seen, not changed', async () => {
    const current = await buildSourceSnapshot('source-1', 'Content.', '2026-01-01T00:00:00.000Z')
    expect(compareSourceSnapshot(null, current)).toBe('first_seen')
  })

  it('throws if previous and current snapshots belong to different sources', async () => {
    const previous = await buildSourceSnapshot('source-1', 'Content.', '2026-01-01T00:00:00.000Z')
    const current = await buildSourceSnapshot('source-2', 'Content.', '2026-01-02T00:00:00.000Z')
    expect(() => compareSourceSnapshot(previous, current)).toThrow(/different sources/)
  })
})

describe('shouldCreateLegalUpdateFromSourceChange', () => {
  it('is true for "changed" and "first_seen", false for "unchanged"', () => {
    expect(shouldCreateLegalUpdateFromSourceChange('changed')).toBe(true)
    expect(shouldCreateLegalUpdateFromSourceChange('first_seen')).toBe(true)
    expect(shouldCreateLegalUpdateFromSourceChange('unchanged')).toBe(false)
  })
})

describe('validateSourceContent — invalid source detection', () => {
  it('rejects an empty sourceId', () => {
    expect(validateSourceContent('', 'some content').valid).toBe(false)
  })

  it('rejects empty content', () => {
    expect(validateSourceContent('source-1', '').valid).toBe(false)
  })

  it('rejects whitespace-only content', () => {
    expect(validateSourceContent('source-1', '   \n\n  \t ').valid).toBe(false)
  })

  it('accepts a valid sourceId and non-empty content', () => {
    expect(validateSourceContent('source-1', 'Real content.').valid).toBe(true)
  })
})

describe('buildMonitoringDecision — invalid source returns invalid_source', () => {
  it('returns invalid_source for empty content, with no snapshot or proposal', async () => {
    const decision = await buildMonitoringDecision('source-1', '', null, [])
    expect(decision.kind).toBe('invalid_source')
    expect(decision.snapshot).toBeUndefined()
    expect(decision.proposedLegalUpdate).toBeUndefined()
  })

  it('returns invalid_source for a missing sourceId', async () => {
    const decision = await buildMonitoringDecision('', 'Some content.', null, [])
    expect(decision.kind).toBe('invalid_source')
  })
})

describe('buildMonitoringDecision — duplicate checksum ignored', () => {
  it('returns duplicate when the checksum matches a known checksum, even for a source with no previous snapshot', async () => {
    const knownSnapshot = await buildSourceSnapshot('source-2', 'Shared regulatory text.', '2026-01-01T00:00:00.000Z')
    const decision = await buildMonitoringDecision('source-1', 'Shared regulatory text.', null, [knownSnapshot.checksum])
    expect(decision.kind).toBe('duplicate')
    expect(decision.proposedLegalUpdate).toBeUndefined()
  })

  it('does not flag as duplicate when the checksum is not in the known list', async () => {
    const decision = await buildMonitoringDecision('source-1', 'Genuinely new content.', null, ['deadbeef'])
    expect(decision.kind).not.toBe('duplicate')
  })
})

describe('buildMonitoringDecision — unchanged vs changed_pending_review', () => {
  it('returns unchanged when checksum matches the previous snapshot', async () => {
    const previous = await buildSourceSnapshot('source-1', 'Stable content.', '2026-01-01T00:00:00.000Z')
    const decision = await buildMonitoringDecision('source-1', 'Stable content.', previous, [])
    expect(decision.kind).toBe('unchanged')
    expect(decision.proposedLegalUpdate).toBeUndefined()
  })

  it('returns changed_pending_review when content differs from the previous snapshot', async () => {
    const previous = await buildSourceSnapshot('source-1', 'Old content.', '2026-01-01T00:00:00.000Z')
    const decision = await buildMonitoringDecision('source-1', 'New content that is materially different.', previous, [])
    expect(decision.kind).toBe('changed_pending_review')
    expect(decision.proposedLegalUpdate).toBeDefined()
  })

  it('returns changed_pending_review on first sighting (no previous snapshot, not a known duplicate)', async () => {
    const decision = await buildMonitoringDecision('source-1', 'Brand new content.', null, [])
    expect(decision.kind).toBe('changed_pending_review')
    expect(decision.proposedLegalUpdate).toBeDefined()
  })
})

describe('buildMonitoringDecision — decision output contains no rule-creation intent', () => {
  it('the full decision object never mentions rules, approval, or active status', async () => {
    const decision = await buildMonitoringDecision('source-1', 'New regulatory content requiring review.', null, [])
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toMatch(/rule/i)
    expect(serialized).not.toMatch(/approved/i)
    expect(serialized).not.toMatch(/\bactive\b/i)
  })

  it('MonitoringDecision has no field capable of representing a rule at the type level (structural check via key enumeration)', async () => {
    const decision = await buildMonitoringDecision('source-1', 'New content.', null, [])
    expect(Object.keys(decision).every(key => !key.toLowerCase().includes('rule'))).toBe(true)
  })
})

describe('buildMonitoringDecision — decision output only proposes pending review / new legal update', () => {
  it('proposedLegalUpdate.status is always the literal "new"', async () => {
    const decision = await buildMonitoringDecision('source-1', 'New regulatory content.', null, [])
    expect(decision.proposedLegalUpdate?.status).toBe('new')
  })

  it('preserves the original raw content and checksum metadata in the proposal', async () => {
    const rawContent = 'Exact original text as retrieved, with  extra   spacing.'
    const retrievedAt = '2026-03-01T12:00:00.000Z'
    const decision = await buildMonitoringDecision('source-1', rawContent, null, [], retrievedAt)
    expect(decision.proposedLegalUpdate?.rawContent).toBe(rawContent)
    expect(decision.proposedLegalUpdate?.checksum).toBe(decision.snapshot?.checksum)
    expect(decision.proposedLegalUpdate?.sourceId).toBe('source-1')
    expect(decision.proposedLegalUpdate?.retrievedAt).toBe(retrievedAt)
  })

  it('never produces a proposal for unchanged, duplicate, or invalid_source outcomes', async () => {
    const previous = await buildSourceSnapshot('source-1', 'Stable.', '2026-01-01T00:00:00.000Z')
    const unchanged = await buildMonitoringDecision('source-1', 'Stable.', previous, [])
    const invalid = await buildMonitoringDecision('source-1', '', null, [])
    const duplicateKnown = await buildSourceSnapshot('source-2', 'Dup.', '2026-01-01T00:00:00.000Z')
    const duplicate = await buildMonitoringDecision('source-1', 'Dup.', null, [duplicateKnown.checksum])

    expect(unchanged.proposedLegalUpdate).toBeUndefined()
    expect(invalid.proposedLegalUpdate).toBeUndefined()
    expect(duplicate.proposedLegalUpdate).toBeUndefined()
  })
})
