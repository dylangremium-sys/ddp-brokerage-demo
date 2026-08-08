// ─── When an in-app anchor may be intercepted ───────────────────────────────
//
// THE DEFECT THIS EXISTS FOR
//   The public corporate pages are linked with real <a href> elements so that a
//   crawler can follow them. Each one also calls preventDefault() and routes
//   in-app, so the SPA does not hard-reload on an ordinary click.
//
//   Done unconditionally — which is how it was first written — that second part
//   destroys the first. Ctrl-click and Cmd-click, the gestures for "open in a
//   new tab", are ordinary click events with a modifier set. Swallowing them
//   navigates the CURRENT tab instead, so the visitor loses the page they were
//   on and never gets the tab they asked for. Shift-click (new window) and a
//   middle-click that a browser reports as a primary click fail the same way,
//   as does an anchor carrying target="_blank".
//
//   It is a particularly quiet bug: the link works, it just refuses to work the
//   way the browser promises. Nothing throws, nothing renders wrong, and no
//   existing test in this repository could observe it.
//
// THE RULE
//   Intercept ONLY a plain primary-button click on a same-tab link. Anything
//   else is a gesture with a defined browser meaning, and the browser is
//   entitled to perform it.
//
// Kept pure and DOM-free so it is testable in the suite's default
// `environment: 'node'`; it reads only the fields any click event carries.

/** The subset of a mouse/click event this decision depends on. */
export interface AnchorClickLike {
  /** 0 is the primary button. Auxiliary buttons carry their own semantics. */
  button?: number
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  /** True once another handler has already claimed the event. */
  defaultPrevented?: boolean
  /** The anchor's target, when it has one. */
  currentTarget?: { target?: string } | null
}

/**
 * True when the SPA may handle this click itself.
 *
 * False for every modified click, every non-primary button, an event another
 * handler has already claimed, and any anchor that asks for a different
 * browsing context — in all of which the browser's own behaviour is what the
 * visitor asked for.
 */
export function shouldInterceptAnchorClick(event: AnchorClickLike): boolean {
  // Someone upstream already handled it; do not act twice.
  if (event.defaultPrevented) return false

  // `button` is absent on a synthetic or keyboard-originated click, which is a
  // primary activation — treat undefined as 0 rather than rejecting it, or
  // Enter on a focused link would stop working.
  if ((event.button ?? 0) !== 0) return false

  // Cmd/Ctrl: new tab. Shift: new window. Alt: download in most browsers.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false

  // target="_blank" (or a named frame) is an explicit request for another
  // browsing context, which in-app routing cannot honour.
  const target = event.currentTarget?.target
  if (target && target !== '_self') return false

  return true
}
