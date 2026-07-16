import {
  deriveBuyerPackReleaseEligibility,
  type BuyerPackReleaseConditions,
} from './buyerPackSnapshot'

// ─── Buyer Pack print state ──────────────────────────────────────────────────
//
// Gating the Print button is not gating printing. Cmd+P, File → Print and the
// context menu all render the print stylesheet without ever calling the app's
// click handler, so a button-only gate leaves the artifact reachable. Nor can
// the dialog be reliably intercepted: `beforeprint` cannot cancel it, and no
// browser guarantees a JS hook on every entry point.
//
// So authorization is expressed in the DOM and enforced by the print stylesheet
// itself — the one layer every print entry point must pass through.
//
// This module is the single source for all four consumers: the root attribute,
// the Print button's disabled state, the click handler's gate, and the refusal
// text. They cannot disagree, because there is only one derivation.

/** How the DOM advertises print authorization. Read by `@media print`. */
export const PRINT_AUTHORIZED_ATTR = 'data-print-authorized'

/**
 * A discriminated union, so a caller cannot read a refusal reason off an
 * authorized pack or forget to handle one on a refused pack — the compiler
 * settles it.
 *
 * `attr` is the string the print stylesheet opts in on. It is 'true' only when
 * authorized: the stylesheet hides the dossier by default, so any other value,
 * a typo, or a missing attribute prints the refusal rather than the pack.
 * Fail-closed is a property of the CSS; this is the only key that unlocks it.
 */
export type BuyerPackPrintState =
  | { authorized: true; attr: 'true'; refusalReason: null }
  | { authorized: false; attr: 'false'; refusalReason: string }

/**
 * Derives print state from the same conditions that gate issuance.
 *
 * Pure, so the media-level gate's inputs can be tested without a browser — which
 * matters because no JS test environment evaluates `@media print` (jsdom does
 * not implement print-media cascade at all). The cascade itself is verified in a
 * real browser; this function pins what feeds it.
 */
export function deriveBuyerPackPrintState(
  conditions: BuyerPackReleaseConditions,
): BuyerPackPrintState {
  const gate = deriveBuyerPackReleaseEligibility(conditions)
  if (gate.eligible) {
    return { authorized: true, attr: 'true', refusalReason: null }
  }
  return { authorized: false, attr: 'false', refusalReason: gate.reason }
}

/**
 * Stamps a print time on every browser print entry point.
 *
 * `beforeprint` fires for Cmd+P, the File menu, the context menu and
 * `window.print()` alike, so it is the only place a printed timestamp can be
 * made honest. Stamping inside the click handler instead would leave a native
 * print showing a blank time, or — worse — the time of some earlier print,
 * which is a plausible fabrication on the one artifact whose purpose is
 * provenance.
 *
 * Returns a disposer; callers must call it on unmount or the listener outlives
 * the pack and stamps a batch the operator has navigated away from.
 */
export function installPrintTimestampListener(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  onBeforePrint: () => void,
): () => void {
  const handler = () => onBeforePrint()
  target.addEventListener('beforeprint', handler)
  return () => target.removeEventListener('beforeprint', handler)
}
