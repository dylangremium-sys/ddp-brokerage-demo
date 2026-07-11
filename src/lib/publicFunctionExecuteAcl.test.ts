import { describe, it, expect } from 'vitest'

// ─── Repository ACL enforcement — public function EXECUTE privileges ─────────
//
// Rule (see docs/SECURITY_TEST_LOG.md §13): every public PostgreSQL function
// DEFINED by a committed migration must have explicit EXECUTE ACL handling in
// the committed SQL corpus:
//   • REVOKE EXECUTE ... FROM PUBLIC
//   • REVOKE EXECUTE ... FROM anon
//   • at least one GRANT EXECUTE ... TO <role>, OR an explicit no-grant token
//     comment  `acl-no-grant: <function_name>`  (trigger-only functions that
//     intentionally grant EXECUTE to no client role).
//
// Rationale: ALTER DEFAULT PRIVILEGES cannot suppress PostgreSQL's built-in
// PUBLIC EXECUTE grant on new functions, so hardening MUST be explicit per
// function. This test fails the build if a future migration forgets it.
//
// Enforcement is corpus-wide by function name (not same-file), because the
// existing committed migrations legitimately define a function in one file and
// normalise its ACLs in a dedicated later migration (e.g. 3_, 11_, 12_). Files
// explicitly marked as not-applied drafts are exempt, analogous to test-only
// fixtures — they are never applied to a database.
//
// SQL files are read with Vite's `import.meta.glob('...?raw')`, the same
// source-sweep convention used by aiSummaryBoundaryIntegration.test.ts.

const SQL_FILES = import.meta.glob('../../*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const DRAFT_MARKER = /NOT APPLIED|DRAFT — FOR REVIEW ONLY|do not run (?:this file|sql) automatically/i

// Functions intentionally left executable by PUBLIC/anon (none today). Add a
// name here ONLY with a documented justification.
const INTENTIONALLY_PUBLIC = new Set<string>()

interface FnDef { file: string; name: string; line: number }
interface AclRef { name: string; roles: string[] }

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}

function collect() {
  const defs: FnDef[] = []
  const revokes: AclRef[] = []
  const grants: AclRef[] = []
  const noGrant = new Set<string>()

  for (const [path, raw] of Object.entries(SQL_FILES)) {
    if (DRAFT_MARKER.test(raw)) continue
    const file = basename(path)

    // `acl-no-grant: <name>` opt-out tokens are read from raw (inside comments).
    for (const m of raw.matchAll(/acl-no-grant:\s*([a-z0-9_]+)/gi)) {
      noGrant.add(m[1].toLowerCase())
    }

    const body = stripComments(raw)

    // Definitions (name + opening paren appear on the CREATE line).
    body.split('\n').forEach((line, i) => {
      const re = /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        defs.push({ file, name: m[1].toLowerCase(), line: i + 1 })
      }
    })

    // REVOKE / GRANT EXECUTE ON FUNCTION statements (whole-body, roles listed).
    const revRe = /\brevoke\s+execute\s+on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\([^)]*\)\s+from\s+([^;]+);/gi
    let r: RegExpExecArray | null
    while ((r = revRe.exec(body)) !== null) {
      revokes.push({ name: r[1].toLowerCase(), roles: r[2].toLowerCase().split(',').map((s) => s.trim()) })
    }
    const graRe = /\bgrant\s+execute\s+on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\([^)]*\)\s+to\s+([^;]+);/gi
    let g: RegExpExecArray | null
    while ((g = graRe.exec(body)) !== null) {
      grants.push({ name: g[1].toLowerCase(), roles: g[2].toLowerCase().split(',').map((s) => s.trim()) })
    }
  }
  return { defs, revokes, grants, noGrant }
}

function roleListed(refs: AclRef[], name: string, role: string): boolean {
  return refs.some((x) => x.name === name && x.roles.includes(role))
}

describe('public function EXECUTE ACL enforcement', () => {
  const { defs, revokes, grants, noGrant } = collect()

  it('finds at least the known application functions (sanity)', () => {
    const names = new Set(defs.map((d) => d.name))
    for (const fn of ['is_ddp_admin', 'has_farm_membership', 'prevent_compliance_audit_log_mutation']) {
      expect(names, `expected to find CREATE FUNCTION for ${fn}`).toContain(fn)
    }
  })

  it('every defined public function has explicit REVOKE PUBLIC, REVOKE anon, and a GRANT/no-grant decision', () => {
    const distinct = [...new Set(defs.map((d) => d.name))].filter((n) => !INTENTIONALLY_PUBLIC.has(n))
    const violations: string[] = []

    for (const name of distinct) {
      const missing: string[] = []
      if (!roleListed(revokes, name, 'public')) missing.push('REVOKE EXECUTE ... FROM PUBLIC')
      if (!roleListed(revokes, name, 'anon')) missing.push('REVOKE EXECUTE ... FROM anon')
      const hasGrant = grants.some((x) => x.name === name)
      if (!hasGrant && !noGrant.has(name)) {
        missing.push(`GRANT EXECUTE ... TO <role>  (or an \`acl-no-grant: ${name}\` comment)`)
      }
      if (missing.length > 0) {
        for (const site of defs.filter((d) => d.name === name)) {
          violations.push(`${site.file}:${site.line}  public.${name}(…)  missing: ${missing.join('; ')}`)
        }
      }
    }

    expect(
      violations,
      violations.length
        ? `Public function(s) defined without explicit EXECUTE ACLs:\n  ${violations.join('\n  ')}`
        : 'ok',
    ).toEqual([])
  })
})
