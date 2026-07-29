// Rollback-safety invariants (DDP audit A3/A4).
//
// A ROLLBACK script is emergency, break-glass code: it runs rarely, under
// pressure, usually on a degraded system. Two properties must therefore hold.
//
// A3 — a rollback must fail EARLY and ACTIONABLY, not late and opaquely. Migration
// 21's rollback restores a CHECK that permits only ('ddp_admin','farmer'); if any
// profile is still 'pending' the ADD CONSTRAINT fails at the very end with a bare
// "check constraint is violated by some row". The precondition must be an
// executable guard at the top, in the same style as that file's ordering guard.
//
// A4 — a rollback must never restore an UNAUTHENTICATED write path. Re-granting
// UPDATE/DELETE on the append-only compliance_audit_log to `anon` restores no
// functionality (nothing writes it as anon; the RLS insert policy requires
// is_ddp_admin()) while re-opening a write vector on the one table whose value is
// that it cannot be rewritten.

/** Strip block and line comments so a documented precondition is not mistaken for an enforced one. */
export function stripSqlComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/**
 * True iff the SQL *executably* refuses when pending profiles exist: it must both
 * test for role = 'pending' and RAISE. A comment describing the precondition does
 * not count.
 */
export function hasExecutablePendingGuard(sql) {
  const code = stripSqlComments(sql)
  return /role\s*=\s*'pending'/i.test(code) && /raise\s+exception/i.test(code)
}

/**
 * True iff the RLS full-rollback (which strips tenant isolation from every core
 * table) refuses to run without an explicit, session-scoped operator opt-in. A
 * warning comment is not enough: an operator pasting the block during an outage
 * must be stopped by SQL, not by prose.
 */
export function hasRlsFullRollbackOptIn(sql) {
  const code = stripSqlComments(sql)
  return /current_setting\s*\(\s*'rls\.disable_tenant_isolation'/i.test(code) &&
    /raise\s+exception/i.test(code)
}

/**
 * Every per-table block in the TARGETED ROLLBACKS section is independently
 * copy-pasteable, so each `DISABLE ROW LEVEL SECURITY` there needs its OWN opt-in
 * guard — a single guard at the top of the file is bypassed by pasting one block.
 * (The FULL ROLLBACK block is covered separately by hasRlsFullRollbackOptIn: one
 * guard inside its BEGIN/COMMIT protects all of its statements.)
 *
 * @returns {string[]} tables whose targeted DISABLE is not preceded by a guard
 */
export function findUnguardedTargetedRlsDisables(sql) {
  // The section marker lives in a COMMENT, so it must be located in the RAW text.
  // Stripping comments first would delete the marker and make this return [] —
  // a silent false pass. Locate first, strip second.
  const raw = String(sql)
  const marker = raw.search(/TARGETED ROLLBACKS/i)
  if (marker === -1) return []
  const targeted = stripSqlComments(raw.slice(marker))

  const OPT_IN = /current_setting\s*\(\s*'rls\.disable_tenant_isolation'/i
  const DISABLE = /ALTER\s+TABLE\s+(?:public\.)?([a-z_]+)\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/gi

  const unguarded = []
  let lastIndex = 0
  DISABLE.lastIndex = 0
  for (let match = DISABLE.exec(targeted); match !== null; match = DISABLE.exec(targeted)) {
    const preceding = targeted.slice(lastIndex, match.index)
    if (!OPT_IN.test(preceding)) unguarded.push(match[1])
    lastIndex = DISABLE.lastIndex
  }
  return unguarded
}

/**
 * A rollback that DROPs an append-only / audit-critical table must refuse while
 * rows exist unless the operator opts in deliberately (the pattern migration 24
 * established). Returns the specs whose file lacks that guard.
 *
 * @param {Array<{name: string, body: string}>} files
 * @param {Array<{file: string, setting: string}>} specs
 */
export function findUnguardedDestructiveRollbacks(files, specs) {
  const byName = new Map(files.map((f) => [f.name, f.body]))
  const offenders = []
  for (const spec of specs) {
    const body = byName.get(spec.file)
    if (body === undefined) continue
    const code = stripSqlComments(body)
    const hasOptIn = new RegExp(`current_setting\\s*\\(\\s*'${spec.setting.replace('.', '\\.')}'`, 'i').test(code)
    const refuses = /raise\s+exception/i.test(code)
    if (!hasOptIn || !refuses) offenders.push(spec.file)
  }
  return offenders
}

// GRANT <privs> ON [TABLE] public.compliance_audit_log TO <roles>
const AUDIT_GRANT_RE =
  /grant\s+([\s\S]*?)\s+on\s+(?:table\s+)?(?:public\.)?compliance_audit_log\s+to\s+([^;]+);/gi
const WRITE_PRIVS = /\b(update|delete|insert|truncate|all)\b/i

/**
 * Return files that grant a WRITE privilege on compliance_audit_log to `anon`.
 * @param {Array<{name: string, body: string}>} files
 * @returns {Array<{file: string, privileges: string}>}
 */
export function findAnonAuditLogWriteGrants(files) {
  const offenders = []
  for (const { name, body } of files) {
    const code = stripSqlComments(body).replace(/\s+/g, ' ')
    AUDIT_GRANT_RE.lastIndex = 0
    for (let match = AUDIT_GRANT_RE.exec(code); match !== null; match = AUDIT_GRANT_RE.exec(code)) {
      const privileges = match[1].trim()
      const roles = match[2].split(',').map((r) => r.trim().replace(/^"|"$/g, '').toLowerCase())
      if (roles.includes('anon') && WRITE_PRIVS.test(privileges)) {
        offenders.push({ file: name, privileges })
      }
    }
  }
  return offenders
}
