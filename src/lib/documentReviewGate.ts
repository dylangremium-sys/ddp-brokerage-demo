/**
 * When the evidence screen may record a decision about a document, and what it
 * tells the operator while it may not.
 *
 * WHY THIS EXISTS. Accepting a document is the moment an uploaded file becomes
 * something a buyer may eventually rely on, and the screen used to allow it
 * from a standing start: Accept was the only filled button in a row of five, so
 * the fastest click on the page was the irreversible one, and "open the file and
 * read it before deciding" was printed in a banner above as advice. Advice in a
 * banner is not a control. This makes the two conditions that ought to precede a
 * decision — the document was opened, and a reason was written — the actual
 * precondition for the buttons that record one.
 *
 * WHAT IT DOES NOT CLAIM. Opening a document is not reading it, and this module
 * cannot tell the difference. What it establishes is that the file was fetched
 * and put in front of the person whose name goes on the decision, so "I never
 * saw it" stops being available afterwards. That is a narrower claim than the
 * banner made, and it is one the product can actually keep.
 *
 * Pure and DOM-free, so every state below is unit-testable without a browser.
 */

/** A note of only whitespace is not a reason. Mirrors the database's test exactly. */
export function isBlank(note: string): boolean {
  return !/[^\s]/.test(note ?? '')
}

export interface DocumentDecisionGate {
  /** Whether the controls that record an examined judgement may be used. */
  allowed: boolean
  /**
   * Shown beneath those controls, in every state. When the gate is shut it says
   * which condition is outstanding; when it is open it says what recording the
   * decision will do, because that is the moment the operator should know.
   */
  note: string
}

const READY_NOTE =
  'Your name, the time and this reason will be written to the document’s permanent record.'

/**
 * Resolved in order. The first unmet condition is the one named, so an operator
 * who has done nothing yet is told to open the document rather than handed two
 * instructions at once.
 *
 *  - `recording`     → a decision is already in flight; do not offer a second.
 *  - no stored file  → nothing exists to open, so the read condition cannot be
 *                      met and must not be imposed. Requiring it would leave the
 *                      entry permanently undecidable. The note says plainly what
 *                      the decision is resting on instead.
 *  - not opened      → the register entry has a file and it has not been fetched.
 *  - blank reason    → opened, but nothing recorded about what was checked.
 *  - otherwise       → open.
 */
export function resolveDocumentDecisionGate(input: {
  /** The register entry has a file in storage that can be opened. */
  hasStoredFile: boolean
  /** That file has been fetched and handed to the browser in this session. */
  opened: boolean
  /** What the operator has typed as their reason, unsanitised. */
  reason: string
  /** A decision for this document is already being written. */
  recording: boolean
}): DocumentDecisionGate {
  if (input.recording) {
    return { allowed: false, note: 'Recording your decision…' }
  }

  if (!input.hasStoredFile) {
    // No file to read, so the gate reduces to the reason alone — and the note
    // stops pointing at a control that is itself disabled.
    return isBlank(input.reason)
      ? {
          allowed: false,
          note:
            'This entry has no stored file to open, so any decision rests on the register entry alone. ' +
            'Write what you checked before recording one.',
        }
      : {
          allowed: true,
          note: `This entry has no stored file, so the decision rests on the register entry alone. ${READY_NOTE}`,
        }
  }

  if (!input.opened) {
    return { allowed: false, note: 'Open and read the document before deciding.' }
  }

  if (isBlank(input.reason)) {
    return {
      allowed: false,
      note: 'Write what you checked — a decision cannot be recorded without a reason.',
    }
  }

  return { allowed: true, note: READY_NOTE }
}
