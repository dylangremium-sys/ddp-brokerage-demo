import { describe, expect, it } from 'vitest'
import { isBlank, resolveDocumentDecisionGate } from './documentReviewGate'

// Accepting a document is the moment an uploaded file becomes something a buyer
// may eventually rely on. These tests pin the two conditions that must hold
// before that is possible, the one case where the read condition cannot apply,
// and the requirement that a shut gate always says which condition is missing.

const OPEN_AND_REASONED = {
  hasStoredFile: true,
  opened: true,
  reason: 'Cannabinoid figures match the batch record.',
  recording: false,
}

describe('resolveDocumentDecisionGate — both conditions, in order', () => {
  it('refuses when the document has not been opened, however good the reason', () => {
    const gate = resolveDocumentDecisionGate({ ...OPEN_AND_REASONED, opened: false })
    expect(gate.allowed).toBe(false)
    expect(gate.note).toMatch(/open and read the document/i)
  })

  it('refuses when opened but no reason has been written', () => {
    const gate = resolveDocumentDecisionGate({ ...OPEN_AND_REASONED, reason: '' })
    expect(gate.allowed).toBe(false)
    expect(gate.note).toMatch(/cannot be recorded without a reason/i)
  })

  it('names the read condition first when neither has been met', () => {
    // An operator who has done nothing yet gets one instruction, not two.
    const gate = resolveDocumentDecisionGate({
      ...OPEN_AND_REASONED,
      opened: false,
      reason: '   ',
    })
    expect(gate.allowed).toBe(false)
    expect(gate.note).toMatch(/open and read the document/i)
  })

  it('allows only when the document was opened AND a reason was written', () => {
    const gate = resolveDocumentDecisionGate(OPEN_AND_REASONED)
    expect(gate.allowed).toBe(true)
    // The open state is where the operator is told what recording will do.
    expect(gate.note).toMatch(/permanent record/i)
  })

  it('treats a whitespace-only reason as no reason', () => {
    const gate = resolveDocumentDecisionGate({ ...OPEN_AND_REASONED, reason: ' \n\t ' })
    expect(gate.allowed).toBe(false)
  })

  it('refuses while a decision is already being recorded', () => {
    const gate = resolveDocumentDecisionGate({ ...OPEN_AND_REASONED, recording: true })
    expect(gate.allowed).toBe(false)
  })
})

describe('resolveDocumentDecisionGate — a register entry with no stored file', () => {
  // The read condition cannot be met when there is nothing to read. Imposing it
  // anyway would leave the entry permanently undecidable, which is worse than
  // deciding on the register row with that fact stated.
  it('does not impose the read condition, and says what the decision rests on', () => {
    const gate = resolveDocumentDecisionGate({
      hasStoredFile: false,
      opened: false,
      reason: 'No file was ever uploaded against this entry; rejecting it.',
      recording: false,
    })
    expect(gate.allowed).toBe(true)
    expect(gate.note).toMatch(/no stored file/i)
    expect(gate.note).toMatch(/permanent record/i)
  })

  it('still requires a reason, and does not point at the disabled open control', () => {
    const gate = resolveDocumentDecisionGate({
      hasStoredFile: false,
      opened: false,
      reason: '',
      recording: false,
    })
    expect(gate.allowed).toBe(false)
    expect(gate.note).toMatch(/no stored file/i)
    // Telling someone to open a document whose Open button is itself disabled
    // is the state this branch exists to avoid.
    expect(gate.note).not.toMatch(/open and read/i)
  })
})

describe('the gate always explains itself', () => {
  it('returns a non-empty note in every combination', () => {
    for (const hasStoredFile of [true, false]) {
      for (const opened of [true, false]) {
        for (const reason of ['', '  ', 'a real reason']) {
          for (const recording of [true, false]) {
            const gate = resolveDocumentDecisionGate({ hasStoredFile, opened, reason, recording })
            expect(gate.note.trim().length, JSON.stringify({ hasStoredFile, opened, reason, recording })).toBeGreaterThan(0)
          }
        }
      }
    }
  })
})

describe('isBlank', () => {
  it('mirrors the database test: whitespace is not a reason', () => {
    expect(isBlank('')).toBe(true)
    expect(isBlank('   ')).toBe(true)
    expect(isBlank('\n\t')).toBe(true)
    expect(isBlank('x')).toBe(false)
  })
})
