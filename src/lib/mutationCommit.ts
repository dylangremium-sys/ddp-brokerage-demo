/**
 * Enforces DB-first ordering for a state-changing operation, so the UI can
 * never claim a mutation succeeded that the database rejected.
 *
 * The unsafe pattern this replaces (see docs/MUTATION_TRUTHFULNESS_AUDIT_20260726.md)
 * updated React state synchronously and fired the write off with `.catch(onDbError)`:
 * the operator saw an approved farm / approved batch, and navigated away, while
 * the write was still in flight — or had already been rejected by RLS. Reloading
 * then silently reverted the row, with no record that the action never landed.
 *
 * Here `persist` must settle first. `onCommitted` runs only after it resolves, so
 * every visible consequence (state, navigation) is downstream of a real write. On
 * rejection `onCommitted` never runs and `onError` reports the gap.
 *
 * Only `persist` is wrapped: a throw from inside `onCommitted` propagates rather
 * than being funnelled into `onError`, which would report a render bug as a
 * database failure. Calling `persist` inside the try also catches a synchronous
 * throw, not just a rejected promise.
 *
 * Pure and dependency-free — no DOM, no React, no Supabase — so the ordering
 * contract is unit-testable with deferred promises.
 *
 * @returns true if the write landed and `onCommitted` ran, false if it failed.
 */
export async function commitMutation<T>(
  persist: () => Promise<T>,
  handlers: { onBegin?: () => void; onCommitted: (value: T) => void; onError: (err: unknown) => void },
): Promise<boolean> {
  handlers.onBegin?.()
  let value: T
  try {
    value = await persist()
  } catch (err) {
    handlers.onError(err)
    return false
  }
  handlers.onCommitted(value)
  return true
}
