/**
 * Bootstrap guard for the auth-loading screen.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *   `authLoading` starts true whenever Supabase is configured, and the ONLY thing
 *   that ever set it false was the `onAuthStateChange` callback in App.tsx. There
 *   was no timeout, no error path and no fallback. So if Supabase never delivered
 *   that first auth event, the app rendered the "Loading…" screen FOREVER — a
 *   permanent blank blue page on the public domain, with no way for the visitor to
 *   reach the landing page, sign in, or even see that anything was wrong.
 *
 *   `subscribeToAuthChanges` already races the *profile* query against an 8s
 *   timeout, but that only helps once the event has fired. Nothing guarded the
 *   event itself. The realistic trigger is a stale stored session whose refresh
 *   hangs or fails before the client emits its first event; blocked or corrupt
 *   localStorage does the same.
 *
 * WHY FAILING OPEN IS CORRECT HERE, AND ONLY HERE
 *   Timing out marks auth *resolution* finished — it does NOT grant anything. The
 *   profile stays null, so the app renders exactly what a signed-out visitor sees:
 *   the public landing page, with a sign-in button. Every permission check
 *   downstream still fails closed on a null profile.
 *
 *   So the choice is between showing an anonymous visitor the public page, and
 *   showing every visitor an indefinite blue screen. The first is the safe
 *   direction. A late auth event is still honoured — App's bootstrap routing runs
 *   on the first resolution and will route a restored session to its role page.
 */

/**
 * How long to wait for the first auth event before giving up and rendering the
 * public app.
 *
 * MUST EXCEED the profile-lookup budget in services/auth.ts, which is now two
 * attempts of PROFILE_LOOKUP_TIMEOUT_MS (4s each = 8s worst case). If this fired
 * first it would render the signed-out app WHILE THE RETRY WAS STILL IN FLIGHT —
 * defeating the retry and logging out an operator whose session was valid, which
 * is the exact production symptom the retry exists to fix.
 *
 * 12s leaves 4s of headroom over that 8s worst case. Pinned by a test against the
 * auth constant so the two cannot drift into that failure.
 */
export const AUTH_BOOTSTRAP_TIMEOUT_MS = 12000

/**
 * Start the guard. Calls `onTimeout` once if it is still pending when the timer
 * fires. Returns a cancel function — call it when auth resolves normally, and on
 * unmount, so a resolved bootstrap cannot fire a late spurious callback.
 *
 * Cancelling after the timer has already fired is a no-op, and calling cancel
 * twice is safe: both are ordinary in React effect cleanup.
 */
export function startAuthBootstrapGuard(
  onTimeout: () => void,
  timeoutMs: number = AUTH_BOOTSTRAP_TIMEOUT_MS,
): () => void {
  let fired = false
  const handle = setTimeout(() => {
    fired = true
    onTimeout()
  }, timeoutMs)

  return () => {
    if (fired) return
    clearTimeout(handle)
  }
}
