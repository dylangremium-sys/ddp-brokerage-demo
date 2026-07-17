import { describe, it, expect } from 'vitest'
import {
  deriveCoaEvidence,
  isCoaFileReceived,
  COA_EVIDENCE_LABEL,
  COA_EVIDENCE_REASON,
  type CoaEvidenceInput,
} from './coaEvidence'

/**
 * The defect: a farmer answering "yes, we have a COA" sets coaAvailable = true
 * while coaStoragePath stays empty. The Overview labelled that "Documented",
 * reporting a claim as a received record.
 */
const batch = (o: Partial<CoaEvidenceInput> = {}): CoaEvidenceInput => ({
  coaStoragePath: undefined,
  coaAvailable: undefined,
  certFileName: '',
  ...o,
})

describe('deriveCoaEvidence — a received file is the only thing that documents evidence', () => {
  it('storage path present → Documented', () => {
    expect(deriveCoaEvidence(batch({ coaStoragePath: 'farm/coa-123.pdf' }))).toBe('documented')
  })

  it('claimed via coaAvailable with no storage path → Claimed, never Documented', () => {
    const claimed = batch({ coaAvailable: true })
    expect(deriveCoaEvidence(claimed)).toBe('claimed')
    expect(deriveCoaEvidence(claimed)).not.toBe('documented')
  })

  it('a filename alone is still only a claim — no file is stored against it', () => {
    const named = batch({ certFileName: 'coa-scan.pdf' })
    expect(deriveCoaEvidence(named)).toBe('claimed')
    expect(deriveCoaEvidence(named)).not.toBe('documented')
  })

  it('a claim plus a filename is still a claim without a stored file', () => {
    expect(deriveCoaEvidence(batch({ coaAvailable: true, certFileName: 'coa.pdf' }))).toBe('claimed')
  })

  it('neither claimed nor received → Missing Evidence', () => {
    expect(deriveCoaEvidence(batch())).toBe('missing')
    expect(deriveCoaEvidence(batch({ coaAvailable: false, certFileName: '' }))).toBe('missing')
  })

  it('a stored file documents the batch even when no claim flag was set', () => {
    expect(deriveCoaEvidence(batch({ coaStoragePath: 'p.pdf', coaAvailable: false }))).toBe('documented')
  })

  it('no claim can promote a batch to documented on its own', () => {
    for (const claim of [{ coaAvailable: true }, { certFileName: 'x.pdf' }, { coaAvailable: true, certFileName: 'x.pdf' }]) {
      expect(deriveCoaEvidence(batch(claim))).not.toBe('documented')
    }
  })

  it('an empty storage path is not receipt', () => {
    expect(deriveCoaEvidence(batch({ coaStoragePath: '', coaAvailable: true }))).toBe('claimed')
  })
})

describe('isCoaFileReceived — received evidence, not a claim', () => {
  it('is true only when a file is stored', () => {
    expect(isCoaFileReceived(batch({ coaStoragePath: 'p.pdf' }))).toBe(true)
  })

  it('is false for a claim without a received file', () => {
    // This is the property the missing-received-evidence view depends on: a
    // claim must not make a batch count as having evidence on file.
    expect(isCoaFileReceived(batch({ coaAvailable: true }))).toBe(false)
    expect(isCoaFileReceived(batch({ certFileName: 'coa.pdf' }))).toBe(false)
  })

  it('is false when nothing is claimed or received', () => {
    expect(isCoaFileReceived(batch())).toBe(false)
  })
})

describe('wording', () => {
  it('uses the approved vocabulary', () => {
    expect(COA_EVIDENCE_LABEL.documented).toBe('Documented')
    expect(COA_EVIDENCE_LABEL.claimed).toBe('Claimed')
    expect(COA_EVIDENCE_LABEL.missing).toBe('Missing Evidence')
  })

  it('never claims verification, compliance, certification or approval', () => {
    const all = [...Object.values(COA_EVIDENCE_LABEL), ...Object.values(COA_EVIDENCE_REASON)].join(' ')
    for (const banned of ['verified', 'compliant', 'certified', 'approved']) {
      expect(all.toLowerCase()).not.toContain(banned)
    }
  })

  it('each reason states what is actually on file', () => {
    expect(COA_EVIDENCE_REASON.documented).toBe('COA file received')
    expect(COA_EVIDENCE_REASON.claimed).toBe('COA claimed; file not received')
    expect(COA_EVIDENCE_REASON.missing).toBe('No COA evidence received')
  })
})

describe('matches the evidence rule the codebase already uses', () => {
  // procurementControl.deriveDocumentRequirement:
  //   hasCoaFile ? 'documented' : hasCoaClaim ? 'claimed' : 'missing'
  // DDPBuyerPreview gates: 'COA file received' → coaStoragePath.
  it('agrees with procurementControl for each state', () => {
    const cases: Array<[CoaEvidenceInput, string]> = [
      [batch({ coaStoragePath: 'p.pdf' }), 'documented'],
      [batch({ certFileName: 'c.pdf' }), 'claimed'],
      [batch(), 'missing'],
    ]
    for (const [item, expected] of cases) {
      const hasCoaFile = !!item.coaStoragePath
      const hasCoaClaim = !!item.certFileName || !!item.coaAvailable
      const procurementRule = hasCoaFile ? 'documented' : hasCoaClaim ? 'claimed' : 'missing'
      expect(deriveCoaEvidence(item)).toBe(expected)
      expect(deriveCoaEvidence(item)).toBe(procurementRule)
    }
  })
})
