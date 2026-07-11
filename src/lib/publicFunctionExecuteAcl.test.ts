import { describe, it, expect } from 'vitest'

// ─── Repository ACL enforcement — public function EXECUTE privileges ─────────
//
// Rule (see docs/SECURITY_TEST_LOG.md §13/§14): every public PostgreSQL function
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
// normalise its ACLs in a dedicated later migration (e.g. 3_, 11_, 12_).
//
// EXEMPTION — exact token only. A SQL file is excluded from this validation
// ONLY when it carries the EXACT token `ACL-TEST-EXEMPT: INTENTIONAL-DRAFT`
// (inside a comment). This replaces an earlier broad phrase match that also
// caught ordinary status prose ("NOT APPLIED TO PRODUCTION", "DO NOT RUN
// AUTOMATICALLY", "DRAFT — FOR REVIEW ONLY"). That broad rule silently dropped
// *active* migrations (whose stale headers still said "NOT APPLIED") from the
// validated corpus — a false negative. Exemption is now an explicit, greppable,
// deliberate opt-out that no active migration may carry, and every exempt file
// is reported in the test output even when the suite passes.
//
// SQL files are read with Vite's `import.meta.glob('...?raw')`, the same
// source-sweep convention used by aiSummaryBoundaryIntegration.test.ts.

const SQL_FILES = import.meta.glob('../../*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

// The ONE exact token that exempts a whole SQL file. Matched as a case-sensitive
// substring — ordinary English status text must never satisfy this.
export const ACL_EXEMPTION_TOKEN = 'ACL-TEST-EXEMPT: INTENTIONAL-DRAFT'

export function isAclExempt(raw: string): boolean {
  // Exact, case-sensitive containment. No regex over general prose.
  return raw.includes(ACL_EXEMPTION_TOKEN)
}

// Functions intentionally left executable by PUBLIC/anon (none today). Add a
// name here ONLY with a documented justification.
const INTENTIONALLY_PUBLIC = new Set<string>()

interface FnDef { file: string; name: string; line: number }
interface AclRef { name: string; roles: string[] }

export interface AnalyzeResult {
  defs: FnDef[]
  revokes: AclRef[]
  grants: AclRef[]
  noGrant: Set<string>
  exemptFiles: string[]
  violations: string[]
}

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

function roleListed(refs: AclRef[], name: string, role: string): boolean {
  return refs.some((x) => x.name === name && x.roles.includes(role))
}

// Pure, corpus-agnostic analyzer. The real suite feeds it the globbed repo SQL;
// the regression tests feed it small in-memory fixtures so behaviour is proven
// deterministically and no temporary files are ever written to the repo.
export function analyze(files: Record<string, string>): AnalyzeResult {
  const defs: FnDef[] = []
  const revokes: AclRef[] = []
  const grants: AclRef[] = []
  const noGrant = new Set<string>()
  const exemptFiles: string[] = []

  for (const [path, raw] of Object.entries(files)) {
    const file = basename(path)

    // Exact-token exemption — the ONLY reason a whole file is skipped.
    if (isAclExempt(raw)) {
      exemptFiles.push(file)
      continue
    }

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

  // Violations: every defined (non-exempt) function needs REVOKE PUBLIC, REVOKE
  // anon, and a GRANT or explicit no-grant decision — reported with file:line.
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

  exemptFiles.sort()
  return { defs, revokes, grants, noGrant, exemptFiles, violations }
}

// Active migrations that must NEVER be exempt (they are applied to production).
const ACTIVE_MIGRATIONS_NEVER_EXEMPT = [
  '11_COMPLIANCE_AUDIT_LOG_TRUNCATE_HARDENING.sql',
  '11_COMPLIANCE_AUDIT_LOG_TRUNCATE_VERIFY.sql',
  '11_COMPLIANCE_AUDIT_LOG_TRUNCATE_ROLLBACK.sql',
  '12_PUBLIC_FUNCTION_EXECUTE_HARDENING.sql',
  '12_PUBLIC_FUNCTION_EXECUTE_VERIFY.sql',
  '12_PUBLIC_FUNCTION_EXECUTE_ROLLBACK.sql',
  '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_HARDENING.sql',
  '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_VERIFY.sql',
  '14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_ROLLBACK.sql',
  '15_EXISTING_TABLE_AND_AUDIT_LOG_HARDENING.sql',
  '15_EXISTING_TABLE_AND_AUDIT_LOG_VERIFY.sql',
  '15_EXISTING_TABLE_AND_AUDIT_LOG_ROLLBACK.sql',
]

describe('public function EXECUTE ACL enforcement (repository corpus)', () => {
  const result = analyze(SQL_FILES)
  const { defs, exemptFiles, violations } = result

  it('finds at least the known application functions (sanity)', () => {
    const names = new Set(defs.map((d) => d.name))
    for (const fn of ['is_ddp_admin', 'has_farm_membership', 'prevent_compliance_audit_log_mutation']) {
      expect(names, `expected to find CREATE FUNCTION for ${fn}`).toContain(fn)
    }
  })

  it('reports the set of exempt files (visible even when passing)', () => {
    // Surfaced so exemptions can never hide silently. If this list changes,
    // the change must be a deliberate, reviewed opt-out.
    console.log(`ACL-exempt SQL files (${exemptFiles.length}): ${exemptFiles.join(', ') || '(none)'}`)
    expect(exemptFiles).toEqual([
      '10_BUYER_PACK_SNAPSHOTS_MVP.sql',
      'FARM_ADMIN_ROLE_CHECK_FIX.sql',
      'FARM_RESAVE_PERSISTENCE_MIGRATION.sql',
    ])
  })

  it('never exempts an active production migration', () => {
    const wronglyExempt = ACTIVE_MIGRATIONS_NEVER_EXEMPT.filter((f) => exemptFiles.includes(f))
    expect(
      wronglyExempt,
      wronglyExempt.length
        ? `Active migrations must not carry the exemption token: ${wronglyExempt.join(', ')}`
        : 'ok',
    ).toEqual([])
  })

  it('every defined public function has explicit REVOKE PUBLIC, REVOKE anon, and a GRANT/no-grant decision', () => {
    expect(
      violations,
      violations.length
        ? `Public function(s) defined without explicit EXECUTE ACLs:\n  ${violations.join('\n  ')}`
        : 'ok',
    ).toEqual([])
  })
})

describe('exemption-token semantics (in-memory fixtures, no files written)', () => {
  const PLAIN_FN =
    'CREATE OR REPLACE FUNCTION public.fixture_fn() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;'

  it('Test A — active-status prose does NOT exempt a file', () => {
    const files = {
      '../../ZZZ_fixture_active.sql': [
        '-- STATUS: NOT APPLIED TO PRODUCTION',
        '-- DO NOT RUN AUTOMATICALLY',
        '-- DRAFT STATUS',
        PLAIN_FN,
      ].join('\n'),
    }
    const r = analyze(files)
    expect(r.exemptFiles, 'ordinary status prose must not exempt').toEqual([])
    expect(r.violations.length, 'the function must still be validated (and fail)').toBeGreaterThan(0)
    expect(r.violations.join('\n')).toContain('fixture_fn')
  })

  it('Test B — the exact token DOES exempt a file and reports it', () => {
    const files = {
      '../../ZZZ_fixture_draft.sql': [
        `-- ${ACL_EXEMPTION_TOKEN}`,
        PLAIN_FN,
      ].join('\n'),
    }
    const r = analyze(files)
    expect(r.exemptFiles).toEqual(['ZZZ_fixture_draft.sql'])
    expect(r.violations, 'exempt file must not raise violations').toEqual([])
  })

  it('Test B2 — a case/format-mangled near-token does NOT exempt', () => {
    const files = {
      '../../ZZZ_fixture_nearmiss.sql': [
        '-- acl-test-exempt: intentional-draft',   // wrong case
        '-- ACL TEST EXEMPT INTENTIONAL DRAFT',      // wrong punctuation
        PLAIN_FN,
      ].join('\n'),
    }
    const r = analyze(files)
    expect(r.exemptFiles, 'near-miss tokens must not exempt').toEqual([])
    expect(r.violations.length).toBeGreaterThan(0)
  })

  it('Test C — a normal violation reports file, line, function, and missing controls', () => {
    const files = {
      '../../ZZZ_fixture_violation.sql': [
        '-- ordinary active migration with no ACL normalization',
        PLAIN_FN, // line 2
      ].join('\n'),
    }
    const r = analyze(files)
    expect(r.violations.length).toBe(1)
    const v = r.violations[0]
    expect(v).toContain('ZZZ_fixture_violation.sql')
    expect(v).toContain(':2') // line number preserved
    expect(v).toContain('fixture_fn') // function name preserved
    expect(v).toContain('REVOKE EXECUTE ... FROM PUBLIC')
    expect(v).toContain('REVOKE EXECUTE ... FROM anon')
    expect(v).toContain('GRANT EXECUTE ... TO <role>')
  })

  it('Test D — a fully normalized active function passes (control)', () => {
    const files = {
      '../../ZZZ_fixture_ok.sql': [
        PLAIN_FN,
        'REVOKE EXECUTE ON FUNCTION public.fixture_fn() FROM PUBLIC, anon, authenticated;',
        'GRANT  EXECUTE ON FUNCTION public.fixture_fn() TO service_role;',
      ].join('\n'),
    }
    const r = analyze(files)
    expect(r.exemptFiles).toEqual([])
    expect(r.violations).toEqual([])
  })
})
