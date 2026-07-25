// Migration 27 shape checks — compliance_audit_log actor is server-authoritative
// (DDP audit client-authz #3).
//
// The audit log must stamp the actor from auth.uid(), never from a client-supplied
// value. These predicates are extracted from the gate script so they can be
// NEGATIVELY tested: a check that only ever runs against a passing corpus proves
// nothing about whether it would catch a weakened migration.

/** Strip block and line comments so prose can never satisfy a check. */
export function stripSqlComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** Problems with the forward migration. Empty array = sound. */
export function findHardeningProblems(sql) {
  const fwd = stripSqlComments(sql)
  const problems = []
  if (!/create\s+or\s+replace\s+function\s+public\.fn_compliance_audit_log_set_actor/i.test(fwd)) problems.push('does not create fn_compliance_audit_log_set_actor')
  if (!/new\.actor_id\s*:=\s*auth\.uid\s*\(\s*\)/i.test(fwd)) problems.push('does not force NEW.actor_id := auth.uid() (client value not overridden)')
  if (!/set\s+search_path\s*=/i.test(fwd)) problems.push('trigger function has no pinned search_path')
  if (!/create\s+trigger\s+compliance_audit_log_set_actor\s+before\s+insert\s+on\s+public\.compliance_audit_log/is.test(fwd)) problems.push('trigger is not BEFORE INSERT on public.compliance_audit_log')
  if (!/revoke\s+execute\s+on\s+function\s+public\.fn_compliance_audit_log_set_actor[\s\S]*\bauthenticated\b/i.test(fwd)) problems.push('does not revoke EXECUTE from authenticated (client-callable)')
  // Scope: must not touch policies, table privileges, or migration 9's guard.
  if (/create\s+policy|drop\s+policy/i.test(fwd)) problems.push('changes an RLS policy (out of scope)')
  if (/\bon\s+table\b|alter\s+table/i.test(fwd)) problems.push('contains a table-level privilege/ALTER change (out of scope)')
  if (/compliance_audit_log_no_update_delete/i.test(fwd)) problems.push('touches the migration-9 append-only trigger (out of scope)')
  return problems
}

/** Problems with the VERIFY companion. Empty array = sound. */
export function findVerifyProblems(sql) {
  const ver = stripSqlComments(sql)
  const residueTail = ver.slice(ver.lastIndexOf('rollback;'))
  const problems = []
  if (/\bcommit\b/i.test(ver)) problems.push('VERIFY contains COMMIT (must be BEGIN/ROLLBACK only)')
  if (!/\bbegin\b/i.test(ver) || !/\brollback\b/i.test(ver)) problems.push('VERIFY lacks BEGIN/ROLLBACK')
  if (!/insert\s+into\s+public\.compliance_audit_log/i.test(ver)) problems.push('VERIFY has no behavioural INSERT (vacuous)')
  if (!/raise\s+exception/i.test(ver)) problems.push('VERIFY has no RAISE assertions (vacuous)')
  if (!/request\.jwt\.claims/i.test(ver)) problems.push('VERIFY does not impersonate a caller via the request JWT')
  if (!/victim/i.test(ver)) problems.push('VERIFY does not exercise a forged (different) actor_id')
  if (!/leftover|residue/i.test(residueTail)) problems.push('VERIFY has no post-rollback residue check')
  return problems
}

/** Problems with the ROLLBACK companion. Empty array = sound. */
export function findRollbackProblems(sql) {
  const rb = stripSqlComments(sql)
  const problems = []
  if (!/drop\s+trigger\s+if\s+exists\s+compliance_audit_log_set_actor\s+on\s+public\.compliance_audit_log/i.test(rb)) problems.push('does not drop the trigger')
  if (!/drop\s+function\s+if\s+exists\s+public\.fn_compliance_audit_log_set_actor/i.test(rb)) problems.push('does not drop the function')
  if (/drop\s+(table|policy)\b|compliance_audit_log_no_update_delete/i.test(rb)) problems.push('drops the table/policy/append-only trigger (overreach)')
  return problems
}
