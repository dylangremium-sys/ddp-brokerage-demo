// ─── Where a compliance audit entry is allowed to go (pure) ─────────────────
//
// Extracted from DDPComplianceWatchtower's logAudit() so the decision can be
// tested, for the same reason navigationGuard.ts was extracted from goTo():
// vitest runs `environment: 'node'` for lib tests, and a decision this small
// should not need a DOM to assert on.
//
// WHY THIS EXISTS
//
//   logAudit() had two branches and no third. It wrote to the database when
//   `isSupabaseAdmin && currentUser`, and OTHERWISE appended the entry to
//   React state and localStorage — then returned normally. In a demo build
//   that is correct: localStorage IS the database there, and the whole demo
//   depends on it.
//
//   In a hosted build it is not a fallback, it is a loss. The compliance audit
//   log is the artefact that makes a decision attributable; an entry that
//   lands in one administrator's browser is not a record, and the caller could
//   not tell the two outcomes apart because both returned void.
//
//   Measured on production 2026-08-17: `compliance_audit_log` held 0 rows.
//   That is not evidence this branch fired — the 261 legal updates arrived
//   through the scheduled cron path, which never calls logAudit — but an empty
//   ledger is exactly the state in which nobody would notice if it had.
//
// WHY IT IS A REFUSAL AND NOT A REPAIR
//
//   Every one of the six hosted write handlers already refuses before it
//   writes anything (`if (!isSupabaseAdmin) { … return }`), and
//   `isSupabaseAdmin` folds in `!!currentUser`, so today the refusal below is
//   UNREACHABLE from the screen. That is the point. The property "a hosted
//   build never files an audit entry in a browser" currently holds only
//   because six call sites each remembered to check; this makes it hold
//   because the sink itself will not do it. A guard that depends on every
//   caller remembering is one layer pretending to be two.
//
//   It refuses rather than silently dropping the entry, because a compliance
//   action whose audit record cannot be written should be visible as a
//   failure, not completed quietly.
//
// WHAT THIS DOES NOT FIX
//
//   The entity write and the audit write are still two round trips with no
//   transaction between them, so a refusal here surfaces AFTER the entity has
//   already changed. That is the long-standing non-atomicity in this codebase
//   (`db.ts` status_history has the same shape) and it needs a server-side
//   RPC, not a UI guard. This change makes the loss loud; it does not make the
//   pair atomic.

export type AuditSinkDecision =
  /** Write it to compliance_audit_log through the repository. */
  | { kind: 'database' }
  /** Demo build: localStorage is the database, and this is the real record. */
  | { kind: 'local-demo' }
  /** Hosted build that cannot write the ledger — do not degrade, refuse. */
  | { kind: 'refuse'; reason: string }

export interface AuditSinkContext {
  /** True when the app is wired to a real Supabase project. */
  isSupabaseConfigured: boolean
  /**
   * True when the caller is a signed-in `ddp_admin` on a configured project.
   * Already folds in `!!currentUser`, which is why the call sites can check
   * this alone.
   */
  isSupabaseAdmin: boolean
}

/**
 * The one place that decides where an audit entry may be written.
 *
 * INVARIANT, asserted directly in the tests: `local-demo` is returned only
 * when Supabase is NOT configured. There is no input for which a hosted build
 * writes a compliance audit entry to a browser.
 */
export function resolveAuditSink(ctx: AuditSinkContext): AuditSinkDecision {
  if (!ctx.isSupabaseConfigured) return { kind: 'local-demo' }
  if (ctx.isSupabaseAdmin) return { kind: 'database' }
  return {
    kind: 'refuse',
    reason: 'This compliance action was not recorded in the audit log: the entry could not be written as a signed-in DDP administrator. Sign in again and repeat the action.',
  }
}
