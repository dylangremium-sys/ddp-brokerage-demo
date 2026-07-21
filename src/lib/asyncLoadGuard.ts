/**
 * Applies an async load's outcome only if the load is still the active one when
 * it settles. Prevents a superseded load — e.g. a farmer review-request fetch
 * still in flight when the session switches to admin — from overwriting the
 * now-active scope's shared state, in either the success OR the failure path.
 *
 * `isActive` is typically an effect-local flag flipped to false in the effect's
 * cleanup, so React's re-run-on-dependency-change gives us the "superseded"
 * signal for free. Pure and dependency-free, so the guard decision is unit-
 * testable with deferred promises (no DOM, no React).
 */
export async function runGuardedLoad<T>(
  load: Promise<T>,
  isActive: () => boolean,
  handlers: { onSuccess: (value: T) => void; onError: (err: unknown) => void },
): Promise<void> {
  try {
    const value = await load
    if (!isActive()) return
    handlers.onSuccess(value)
  } catch (err) {
    if (!isActive()) return
    handlers.onError(err)
  }
}
