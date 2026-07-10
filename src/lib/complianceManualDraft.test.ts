import { describe, expect, it } from 'vitest'
import {
  buildMonitoringDecision,
  decideDraftCreation,
  prepareMonitoringLegalUpdateIntake,
  type MonitoringDecision,
} from './complianceSourceMonitoring'

// Phase 2F draft-creation logic: the pure gate (decideDraftCreation) and the
// reused intake preparation (prepareMonitoringLegalUpdateIntake) applied to
// RSS-style monitoring decisions. No network, no AI, no persistence here.

const SAFE_GUARD = () => ({ isSafe: true })
const SOURCE_REF = { id: 'src-1', name: 'Thai FDA', url: 'https://www.fda.moph.go.th/rss.xml', jurisdiction: 'Thailand' }

// A real changed_pending_review decision (first-seen) keyed on a per-ITEM id.
async function changedDecision(): Promise<MonitoringDecision> {
  return buildMonitoringDecision('src-1::guid-a', 'Notice A raw content', null, [], '2026-07-10T00:00:00.000Z')
}

describe('decideDraftCreation — only changed_pending_review may become a draft', () => {
  it('allows a changed_pending_review decision', async () => {
    expect(decideDraftCreation(await changedDecision(), false, false)).toEqual({ action: 'create' })
  })

  it('rejects unchanged, duplicate, invalid_source, and error decisions', () => {
    const kinds: MonitoringDecision['kind'][] = ['unchanged', 'duplicate', 'invalid_source', 'error']
    for (const kind of kinds) {
      const decision: MonitoringDecision = { kind, sourceId: 'src-1::guid-a', reason: 'x' }
      expect(decideDraftCreation(decision, false, false).action).toBe('reject')
    }
  })

  it('rejects a changed decision that somehow lacks a proposed draft', () => {
    const decision: MonitoringDecision = { kind: 'changed_pending_review', sourceId: 's', reason: 'x' }
    expect(decideDraftCreation(decision, false, false).action).toBe('reject')
  })

  it('rejects when no decision, when creation is in progress, and when already drafted', async () => {
    const d = await changedDecision()
    expect(decideDraftCreation(null, false, false).action).toBe('reject')
    expect(decideDraftCreation(d, true, false).action).toBe('reject')      // in progress
    expect(decideDraftCreation(d, false, true).action).toBe('reject')      // already drafted
  })
})

describe('prepareMonitoringLegalUpdateIntake — reused for RSS drafts', () => {
  it('prepares a status "new" draft referencing the REGISTERED source, with no summary/analysis', async () => {
    const prep = prepareMonitoringLegalUpdateIntake(await changedDecision(), SOURCE_REF, SAFE_GUARD)
    expect(prep.outcome).toBe('ready')
    if (prep.outcome !== 'ready') return
    const intake = prep.intake
    expect(intake.status).toBe('new')
    expect(intake.sourceId).toBe('src-1')                    // registered source, not the per-item id
    expect(intake.sourceName).toBe('Thai FDA')
    expect(intake.sourceUrl).toBe('https://www.fda.moph.go.th/rss.xml')
    expect(intake.jurisdiction).toBe('Thailand')
    expect(intake.rawText).toBe('Notice A raw content')      // raw evidence, not a summary
    expect(intake.reviewerNotes).toMatch(/Checksum: [0-9a-f]{64}/) // provenance only, checksum captured
    // The intake carries no legal summary/interpretation/AI field.
    expect(Object.keys(intake)).not.toContain('summary')
    expect(Object.keys(intake)).not.toContain('aiSummary')
  })

  it('skips (creates nothing) for a non-changed decision', () => {
    const decision: MonitoringDecision = { kind: 'unchanged', sourceId: 'src-1::guid-a', reason: 'x' }
    expect(prepareMonitoringLegalUpdateIntake(decision, SOURCE_REF, SAFE_GUARD).outcome).toBe('skip')
  })

  it('is blocked by the wording-safety guard (no creation) when the guard trips', async () => {
    const prep = prepareMonitoringLegalUpdateIntake(await changedDecision(), SOURCE_REF, () => ({ isSafe: false }))
    expect(prep.outcome).toBe('blocked')
  })
})
