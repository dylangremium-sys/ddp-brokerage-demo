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

/* ────────────────────────────────────────────────────────────────────────────
   Selecting batches by evidence, not by workflow status.

   The defect: the Overview selected "missing evidence" with
   `status === 'Missing Document'`. That is a review decision, not an evidence
   field, so it omitted a Pending Review / Approved batch with no received COA,
   and kept counting a batch after its COA arrived — the upload handlers patch
   coaStoragePath without touching status.
   ──────────────────────────────────────────────────────────────────────────── */

type Batch = CoaEvidenceInput & { id: string; status: string }

const b = (id: string, status: string, coa: Partial<CoaEvidenceInput>): Batch => ({
  id, status, coaStoragePath: undefined, coaAvailable: undefined, certFileName: '', ...coa,
})

/** The Overview's selection rules, stated exactly as the page derives them. */
const selectMissing = (inv: Batch[]) => inv.filter(i => deriveCoaEvidence(i) === 'missing')
const selectClaimed = (inv: Batch[]) => inv.filter(i => deriveCoaEvidence(i) === 'claimed')

describe('missing evidence is selected from evidence fields, not workflow status', () => {
  it('an Approved batch with no received COA is still identified', () => {
    const inv = [b('1', 'Approved', {})]
    expect(selectMissing(inv).map(i => i.id)).toEqual(['1'])
    // The old status filter found nothing here.
    expect(inv.filter(i => i.status === 'Missing Document')).toHaveLength(0)
  })

  it('a Pending Review batch with no received COA is still identified', () => {
    expect(selectMissing([b('2', 'Pending Review', {})]).map(i => i.id)).toEqual(['2'])
  })

  it('a batch stops counting as missing once its COA file arrives, even though status is unchanged', () => {
    // Exactly what handleCoaUpload does: sets coaStoragePath/coaAvailable/
    // certFileName and leaves status alone.
    const uploaded = b('3', 'Missing Document', {
      coaStoragePath: 'farm/coa.pdf', coaAvailable: true, certFileName: 'coa.pdf',
    })
    expect(deriveCoaEvidence(uploaded)).toBe('documented')
    expect(selectMissing([uploaded])).toHaveLength(0)
    expect(selectClaimed([uploaded])).toHaveLength(0)
    // The old status filter would still have counted it.
    expect([uploaded].filter(i => i.status === 'Missing Document')).toHaveLength(1)
  })

  it('a claimed-only batch is selected as claimed, never as documented', () => {
    const inv = [b('4', 'Approved', { coaAvailable: true })]
    expect(selectClaimed(inv).map(i => i.id)).toEqual(['4'])
    expect(selectMissing(inv)).toHaveLength(0)
    expect(deriveCoaEvidence(inv[0])).not.toBe('documented')
  })

  it('workflow status never changes the evidence position', () => {
    for (const status of ['Approved', 'Pending Review', 'Missing Document', 'Rejected']) {
      expect(deriveCoaEvidence(b('x', status, { coaStoragePath: 'p.pdf' }))).toBe('documented')
      expect(deriveCoaEvidence(b('x', status, { coaAvailable: true }))).toBe('claimed')
      expect(deriveCoaEvidence(b('x', status, {}))).toBe('missing')
    }
  })

  it('every panel selecting on this rule agrees for the same batch', () => {
    // KPI, priority queue and supply table all call deriveCoaEvidence, so one
    // batch cannot be missing in one panel and documented in another.
    const inv = [
      b('doc', 'Missing Document', { coaStoragePath: 'p.pdf' }),
      b('claim', 'Approved', { coaAvailable: true }),
      b('none', 'Pending Review', {}),
    ]
    expect(selectMissing(inv).map(i => i.id)).toEqual(['none'])
    expect(selectClaimed(inv).map(i => i.id)).toEqual(['claim'])
    expect(inv.filter(i => deriveCoaEvidence(i) === 'documented').map(i => i.id)).toEqual(['doc'])
    // Each batch lands in exactly one bucket.
    expect(inv.every(i => [selectMissing, selectClaimed].filter(f => f(inv).includes(i)).length <= 1)).toBe(true)
  })

  it('a batch flagged for its evidence gap is not also listed as a routine review row', () => {
    const inv = [b('5', 'Pending Review', { coaAvailable: true })]
    const flagged = new Set([...selectMissing(inv), ...selectClaimed(inv)].map(i => i.id))
    const routine = inv.filter(i => i.status === 'Pending Review' && !flagged.has(i.id))
    expect(flagged.has('5')).toBe(true)
    expect(routine).toHaveLength(0)
  })
})
