/**
 * When a decision may be recorded on a document, and what the screen says while
 * it may not.
 *
 * THIS MIRRORS THE DATABASE. Migration 66 refuses the same two conditions in a
 * trigger on farmer_documents: no decision without a recorded open by the
 * deciding reviewer, and no decision without a reason of substance. If the two
 * ever disagree, the database is the one that decides — this exists so the
 * screen can explain the refusal before the round trip, not instead of it.
 *
 * The predicate below is the SQL predicate transliterated:
 *   length(btrim(note)) > 9 AND btrim(note) !~ '^(.)\1*$'
 *
 * Pure and DOM-free.
 */

/** The floor for a recorded reason. Mirrors evidence_reason_is_substantive(). */
export function isSubstantiveReason(note: string | null | undefined): boolean {
  if (note === null || note === undefined) return false
  const trimmed = note.trim()
  if (trimmed.length <= 9) return false
  // One character repeated defeats a length test and records nothing.
  return !/^(.)\1*$/u.test(trimmed)
}

export interface EvidenceGate {
  /** Whether the controls that record an examined judgement may be used. */
  allowed: boolean
  /** Shown beneath them in every state — what is missing, or what will happen. */
  note: string
}

const READY =
  'Your name, the time, this reason and the document’s fingerprint will be written to its permanent record.'

/**
 * Resolved in order, so a reviewer who has done nothing is told to open the
 * document rather than handed two instructions at once.
 */
export function resolveEvidenceGate(input: {
  /** The register entry has a file that can be opened. */
  hasStoredFile: boolean
  /** This reviewer has opened it — recorded, not merely clicked. */
  opened: boolean
  reason: string
  recording: boolean
}): EvidenceGate {
  if (input.recording) return { allowed: false, note: 'Recording your decision…' }

  if (!input.hasStoredFile) {
    // Nothing to read, so the read condition cannot be met and must not be
    // imposed — it would leave the entry permanently undecidable.
    return isSubstantiveReason(input.reason)
      ? { allowed: true, note: `This entry has no stored file, so the decision rests on the register entry alone. ${READY}` }
      : {
          allowed: false,
          note:
            'This entry has no stored file to open, so any decision rests on the register entry alone. ' +
            'Write what you checked before recording one.',
        }
  }

  if (!input.opened) {
    return { allowed: false, note: 'Open and read the document before deciding.' }
  }

  if (!isSubstantiveReason(input.reason)) {
    return {
      allowed: false,
      note:
        'Write what you checked. More than nine characters, and something a colleague could act on — ' +
        'the database refuses a reason that says nothing.',
    }
  }

  return { allowed: true, note: READY }
}
