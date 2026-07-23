import { useState } from 'react'

/**
 * Clears scoped state the instant its scope key changes — during render, before
 * anything from the previous scope can be painted.
 *
 * Contract v1.5 §9.7 requires that an account change, role change, farm-scope
 * change or route change CLEARS protected data immediately, and that previous
 * data "may remain in memory but must not be rendered as current while
 * refetching". An effect cannot satisfy that on its own: an effect runs AFTER
 * the browser has already been given a frame in which the old scope's data was
 * the current render output. That frame is exactly the leak §9.7 forbids —
 * farmer A's requests visible for one paint after switching to farmer B.
 *
 * This uses React's documented "adjusting state when a prop changes" pattern:
 * calling a setter during render of the SAME component makes React discard the
 * in-progress output and immediately re-render with the reset state, without
 * committing the stale frame or running any child effects. It is also why this
 * is not a `useEffect` — moving it into one would reintroduce the stale paint
 * and trip the repo's `react-hooks/set-state-in-effect` rule.
 *
 * `reset` is called at most once per distinct scope key.
 */
export function useEvidenceScopeReset(scopeKey: string, reset: () => void): void {
  const [renderedScope, setRenderedScope] = useState(scopeKey)
  if (renderedScope !== scopeKey) {
    setRenderedScope(scopeKey)
    reset()
  }
}
