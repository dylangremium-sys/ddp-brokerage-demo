// Fail-closed detection of a forward migration WIDENING the default privileges
// that client roles hold on FUTURE tables in `public`.
//
// `ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES TO authenticated` is unlike
// every other GRANT in this repository: it is unbounded in time. It does not
// affect the tables the migration creates — it affects every table created in
// `public` afterwards, by any migration, forever, including ones not yet
// written. A reviewer reading the diff sees one line; the blast radius is the
// whole future of the schema.
//
// The pattern the repository actually follows is the opposite, and migrations
// 24, 36 and 44 each carry a comment explaining why: Supabase's baseline default
// privileges already grant client roles CRUD on new public tables, so a hardened
// migration REVOKEs them per table and lets row-level security do the gating.
// A migration that re-grants them schema-wide silently undoes that discipline
// for every table that follows it.
//
// This was not hypothetical. An untracked draft of migration 47 opened with
// `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON
// TABLES TO authenticated;` — no `FOR ROLE`, so it binds whichever role applies
// it — and then revoked the same privileges back off its own two tables, which
// hid the widening behind a local-looking fix. Every gate in CI passed on it.
//
// Two things are deliberately allowed:
//   * REVOKE. Narrowing the defaults is the direction this repository moves in
//     (migration 14).
//   * Any statement in a *_ROLLBACK.sql. A rollback's job is to restore the
//     prior state, so 14's rollback legitimately re-grants what 14 revoked.
//     Rollback risk is covered separately by rollbackSafety.mjs.

/** Strip block and line comments so prose is never read as code. Several files
 *  DESCRIBE this hazard in comments (20, 24, 36, 44); none of them performs it. */
export function stripSqlComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

// One statement at a time: from ALTER DEFAULT PRIVILEGES to the terminating
// semicolon. The clause order is fixed by PostgreSQL grammar
// (`[FOR ROLE ...] [IN SCHEMA ...] GRANT|REVOKE ... TO|FROM ...`), so the action
// keyword and the grantee list are both inside this span.
const ALTER_DEFAULT_PRIVILEGES_RE = /alter\s+default\s+privileges\b[^;]*;/gi

const CLIENT_ROLES = ['anon', 'authenticated', 'public']

/**
 * @param {Array<{name: string, body: string}>} files
 * @param {{ exemptionToken?: string }} [opts]
 * @returns {Array<{file: string, statement: string, roles: string[]}>} widening grants
 */
export function findClientDefaultPrivilegeGrants(files, { exemptionToken } = {}) {
  const offenders = []
  for (const { name, body } of files) {
    if (/_ROLLBACK\.sql$/i.test(name)) continue
    if (exemptionToken && body.includes(exemptionToken)) continue

    const sql = stripSqlComments(body)
    ALTER_DEFAULT_PRIVILEGES_RE.lastIndex = 0
    for (
      let match = ALTER_DEFAULT_PRIVILEGES_RE.exec(sql);
      match !== null;
      match = ALTER_DEFAULT_PRIVILEGES_RE.exec(sql)
    ) {
      const statement = match[0].replace(/\s+/g, ' ').trim()

      // The action keyword decides direction. Take the FIRST of the two so a
      // privilege list that merely contains the word (there is none today, but
      // the grammar permits future keywords) cannot flip the verdict.
      const grantAt = statement.search(/\bgrant\b/i)
      const revokeAt = statement.search(/\brevoke\b/i)
      if (grantAt === -1) continue
      if (revokeAt !== -1 && revokeAt < grantAt) continue

      // Only the grantee list matters — `TO ...` through the end of the
      // statement. A schema or role NAMED `public` earlier in the statement
      // (`IN SCHEMA public`) must not be read as the PUBLIC pseudo-role.
      const grantees = statement.slice(statement.search(/\bto\b/i))
      const roles = CLIENT_ROLES.filter((r) => new RegExp(`\\b${r}\\b`, 'i').test(grantees))
      if (roles.length === 0) continue

      offenders.push({ file: name, statement, roles })
    }
  }
  return offenders
}

/** Renders offenders as an operator-readable failure report. */
export function formatDefaultPrivilegeReport(offenders) {
  const lines = []
  for (const o of offenders) {
    lines.push(`${o.file} widens default privileges for ${o.roles.join(', ')}:`)
    lines.push(`      ${o.statement}`)
  }
  lines.push(
    '  FIX: delete the statement and GRANT on the specific tables this migration ' +
      'creates instead. Default privileges apply to every FUTURE table in the schema.',
  )
  return lines.join('\n')
}
