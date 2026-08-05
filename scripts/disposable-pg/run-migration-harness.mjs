#!/usr/bin/env node
// run-migration-harness.mjs — reusable disposable-Postgres migration verification.
//
// Given a migration-set fixture, on an ISOLATED, EPHEMERAL, SOCKET-ONLY PostgreSQL
// cluster it created: bootstraps a minimal Supabase substrate, applies the forward
// stages, runs VERIFY (asserting every section passes and is non-vacuous), rolls
// back in the declared order, exercises the destructive-rollback guard, captures
// evidence, and tears everything down with zero residue.
//
// General over the repo's N_NAME_{...}.sql convention — driven entirely by fixture
// descriptors, never hardcoded to migration 24 (brief §7).
//
// Exit codes (brief §13): 0 ok · 10 apply · 20 verify · 30 rollback/postcondition
//   · 40 destructive guard · 41 unexpected-pass (negative fixture) · 50 environment
//   · 60 teardown residue.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertNoRemoteTargets, assertSocketOnlyConnection, assertListenAddressesEmpty } from './lib/guards.mjs';
import { loadFixture, FIXTURES_DIR, REPO_ROOT } from './lib/fixtures.mjs';
import { assertNoNumberCollisions } from './lib/migration-numbering.mjs';
import { DisposableCluster, DEFAULT_PG_MAJOR, PG_MAJOR_OVERRIDE } from './lib/cluster.mjs';
import {
  applyBootstrap,
  assertDeclaredSubstratePresent,
  assertNoForceRls,
  assertNoUndeclaredSubstrate,
} from './lib/supabase-shim.mjs';
import { parseVerifyOutput, evaluateVerify } from './lib/verify-parser.mjs';
import { EvidenceBuilder, newRunId } from './lib/evidence.mjs';
import { snapshotCatalog, assertCatalogSymmetry } from './lib/rollback-symmetry.mjs';
import { applyKnownAsymmetries } from './lib/known-asymmetries.mjs';

export const EXIT = Object.freeze({
  OK: 0, APPLY: 10, VERIFY: 20, ROLLBACK: 30, GUARD: 40, UNEXPECTED_PASS: 41, ENV: 50, TEARDOWN: 60,
});

class PhaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'PhaseError';
  }
}

/**
 * Compute fixture coverage over the repo's numbered migrations.
 *
 * Pure and exported ON PURPOSE. The value this function produces is a claim about
 * how much of the migration set a green run actually exercised, and that claim was
 * wrong for months while living inline in main(): it counted `*_HARDENING.sql`, a
 * set every fixture already covered by construction, and so printed "32/32" — a
 * ratio arithmetically incapable of falling. Nobody noticed, because testing it
 * required standing up a PostgreSQL cluster.
 *
 * Extracted so the falsification is a unit test that runs in milliseconds:
 * remove a fixture, the numerator MUST drop. A coverage number that cannot go
 * down is not a measurement, and the only way to keep proving it can go down is
 * to make proving it cheap.
 *
 * @param {string[]} repoFiles   filenames in the repo root (not paths)
 * @param {string[]} fixtureIds  fixture ids being run, e.g. '24_evidence'
 */
export function computeFixtureCoverage(repoFiles, fixtureIds) {
  const covered = new Set(
    fixtureIds.map((id) => (id.match(/^(\d+)_/) || [])[1]).filter(Boolean),
  );
  // Any `<number>_*.sql` in the repo root is a migration an operator means when
  // they say "the migrations". Matching on _HARDENING instead let 11 of 43 escape
  // the denominator purely by being named differently.
  const onDisk = [...new Set(
    repoFiles.map((f) => (f.match(/^(\d+)_.*\.sql$/) || [])[1]).filter(Boolean),
  )].sort((a, b) => Number(a) - Number(b));

  const uncovered = onDisk.filter((n) => !covered.has(n));
  // A migration shipping a ROLLBACK that no fixture executes is worse than one
  // with no rollback: the file's mere existence gets read as proven reversibility.
  const uncoveredWithRollback = uncovered.filter((n) =>
    repoFiles.some((f) => new RegExp(`^${n}_.*_ROLLBACK\\.sql$`).test(f)));

  return {
    total: onDisk.length,
    coveredCount: onDisk.length - uncovered.length,
    uncovered,
    uncoveredWithRollback,
  };
}

function gitSha() {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : (process.env.GITHUB_SHA || null);
}

// Run a scalar query and THROW on a non-zero psql exit. A failed/errored query
// must never be silently read as "object absent" (that would be a false green in
// the post-rollback removed-object checks). Callers get a trustworthy string.
function scalar(cluster, sql) {
  const r = cluster.query(sql);
  if (r.status !== 0) {
    throw new PhaseError(EXIT.ROLLBACK, `assertion query failed (exit ${r.status}): ${sql}\n${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}
function regclassPresent(cluster, qualified) {
  return scalar(cluster, `SELECT to_regclass('${qualified}') IS NOT NULL`) === 't';
}
function functionPresent(cluster, qualified) {
  const [schema, name] = qualified.split('.');
  return Number(scalar(cluster,
    `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}' AND p.proname='${name}'`,
  )) > 0;
}
function policyPresent(cluster, name) {
  const esc = name.replace(/'/g, "''");
  return Number(scalar(cluster, `SELECT count(*) FROM pg_policies WHERE policyname='${esc}'`)) > 0;
}
function bucketPresent(cluster, id) {
  return Number(scalar(cluster, `SELECT count(*) FROM storage.buckets WHERE id='${id}'`)) > 0;
}
function countRows(cluster, table) {
  return Number(scalar(cluster, `SELECT count(*) FROM ${table}`));
}
function constraintPresent(cluster, table, name) {
  const esc = name.replace(/'/g, "''");
  return Number(scalar(cluster,
    `SELECT count(*) FROM pg_constraint WHERE conrelid = '${table}'::regclass AND conname = '${esc}'`,
  )) > 0;
}

/**
 * Effective privileges a role holds on a table, as a sorted array.
 *
 * Reads through coalesce(relacl, acldefault(...)) for the same reason the catalog
 * snapshot does: a NULL relacl means "the built-in defaults", not "no privileges".
 */
function tablePrivileges(cluster, table, role) {
  const out = scalar(cluster, `
    SELECT coalesce(string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type), '')
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
           LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     WHERE n.nspname || '.' || c.relname = '${table}'
       AND a.grantee = '${role}'::regrole`);
  return out ? out.split(',') : [];
}

/**
 * Assertions about the state AFTER the forward migration, BEFORE any rollback.
 *
 * The harness had no such phase, and its absence is defect D9. Rollback symmetry
 * compares pre-apply against post-rollback, so it can only ever prove that a
 * migration was REVERSED — never that it DID anything. A migration whose forward
 * statement silently matched nothing produces a perfectly symmetric run: nothing
 * happened, and nothing was undone.
 *
 * That is exactly how migration 15's `REVOKE UPDATE, DELETE ... FROM anon`
 * escaped verification. Making the substrate honest exposes the rollback's
 * failure to restore anon, but still says nothing about whether the REVOKE
 * removed anything. Only an assertion taken while the migration is applied can.
 */
function assertPostApply(cluster, fixture) {
  const pa = fixture.postApply;
  if (!pa) {
    return { ok: true, checks: [] };
  }
  const problems = [];

  for (const c of pa.privileges || []) {
    const held = tablePrivileges(cluster, c.table, c.role);
    for (const p of c.absent || []) {
      if (held.includes(p)) {
        problems.push(
          `${c.role} still holds ${p} on ${c.table} after the migration applied ` +
          `(holds: ${held.join(',') || 'none'})`);
      }
    }
    for (const p of c.present || []) {
      if (!held.includes(p)) {
        problems.push(
          `${c.role} lost ${p} on ${c.table}, which the migration was not supposed to remove ` +
          `(holds: ${held.join(',') || 'none'})`);
      }
    }
  }

  // Constraints and indexes are the OTHER way a forward migration matches
  // nothing and still produces a symmetric run. A migration that only ADDs a
  // CHECK or a UNIQUE INDEX declares no removed table and no removed function,
  // so the vacuity guard below (`declaresRemovedObjects`) does not fire on it
  // either — nothing else in the harness would notice that it did nothing.
  for (const c of pa.constraints || []) {
    for (const name of c.present || []) {
      if (!constraintPresent(cluster, c.table, name)) {
        problems.push(`constraint ${name} is ABSENT from ${c.table} after the migration applied`);
      }
    }
    for (const name of c.absent || []) {
      if (constraintPresent(cluster, c.table, name)) {
        problems.push(`constraint ${name} is still present on ${c.table} after the migration applied`);
      }
    }
  }
  for (const name of pa.indexes?.present || []) {
    if (!regclassPresent(cluster, name)) {
      problems.push(`index ${name} is ABSENT after the migration applied`);
    }
  }
  for (const name of pa.indexes?.absent || []) {
    if (regclassPresent(cluster, name)) {
      problems.push(`index ${name} is still present after the migration applied`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function assertPostRollback(cluster, fixture) {
  const pr = fixture.postRollback;
  if (!pr) return { ok: true, checks: [] };
  const problems = [];
  const removed = pr.removed || {};
  const intact = pr.intact || {};

  for (const t of removed.tables || []) if (regclassPresent(cluster, t)) problems.push(`table not removed: ${t}`);
  for (const f of removed.functions || []) if (functionPresent(cluster, f)) problems.push(`function not removed: ${f}`);
  for (const p of removed.policies || []) if (policyPresent(cluster, p)) problems.push(`policy not removed: ${p}`);
  for (const b of removed.buckets || []) if (bucketPresent(cluster, b)) problems.push(`bucket not removed: ${b}`);

  for (const t of intact.tables || []) if (!regclassPresent(cluster, t)) problems.push(`substrate table missing after rollback: ${t}`);
  for (const f of intact.functions || []) if (!functionPresent(cluster, f)) problems.push(`substrate function missing after rollback: ${f}`);
  if (intact.authUsersMinRows != null) {
    if (Number(scalar(cluster, 'SELECT count(*) FROM auth.users')) < intact.authUsersMinRows) {
      problems.push(`auth.users lost rows (< ${intact.authUsersMinRows})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function runRollbackStage(cluster, stage, { optIn } = {}) {
  const sessionSql = optIn ? [`SET ${optIn.setting} = '${optIn.value}'`] : [];
  if (stage.source === 'file') return cluster.runSqlFile(stage.path, { sessionSql });
  return cluster.runInlineSql(stage.label, stage.sql, { sessionSql });
}

function log(verbose, msg) {
  process.stdout.write(msg + '\n');
}

// Run one fixture end-to-end. Returns { code, evidence, artifacts }.
export function runFixture(fixtureId, { verbose = false, keep = false } = {}) {
  const fixture = loadFixture(fixtureId);
  // Precedence: explicit env override > fixture pin > repo default (= prod's major).
  // The override exists so the advisory PG-18 lane can exercise the same fixtures
  // on the next major without editing 38 files; without it, `HARNESS_PG_MAJOR`
  // would be silently ignored, because every fixture carries a pin.
  const pgMajor = PG_MAJOR_OVERRIDE ?? fixture.pgMajor ?? DEFAULT_PG_MAJOR;
  const runId = newRunId(fixture.id);
  const ev = new EvidenceBuilder({ runId, fixtureId: fixture.id, gitSha: gitSha(), pgMajor });
  const cluster = new DisposableCluster({ pgMajor, log: (m) => verbose && log(verbose, `  · ${m}`) });
  const rawLogs = {};
  let code = EXIT.OK;
  let outcome = 'passed';
  const expectFailure = fixture.expectFailure || null;

  const phaseLine = (ok, label, detail = '') =>
    log(verbose, `  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);

  // All work runs inside execute() so teardown can happen AFTER it and still
  // escalate the exit code. A `return` value is snapshotted before a `finally`
  // runs, so teardown residue could never amend it (brief §13 requires teardown
  // failure to fail the run) — execute() + post-hoc teardown fixes that.
  const execute = () => {
    log(verbose, `\n▶ fixture ${fixture.id} (run ${runId})`);

    // Isolation guard for EVERY entry point, not just the CLI: a programmatic
    // caller (e.g. a test) with a poisoned environment is refused before any SQL.
    assertNoRemoteTargets(process.env);

    // ---- Static safety pre-checks (before any SQL touches a cluster) ----
    const applyTexts = fixture.applyStages.map((s) => ({ label: s.label, text: readFileSync(s.path, 'utf8') }));
    const rbTexts = fixture.rollbackStages.map((s) => ({ label: s.label, text: s.sql }));
    const verifyText = fixture.verify?.path ? [{ label: 'VERIFY', text: readFileSync(fixture.verify.path, 'utf8') }] : [];
    const allTexts = [...applyTexts, ...rbTexts, ...verifyText];
    assertNoForceRls(allTexts);
    assertNoUndeclaredSubstrate(fixture, allTexts);
    phaseLine(true, 'static safety (no FORCE RLS, no undeclared substrate)');

    // ---- Cluster up + isolation guards ----
    let conn;
    try {
      conn = cluster.create();
    } catch (err) {
      throw new PhaseError(EXIT.ENV, `environment/cluster: ${err.message}`);
    }
    ev.set('pgVersionActual', cluster.serverVersion);
    assertSocketOnlyConnection(conn, { tmpRoot: process.platform === 'win32' ? undefined : '/tmp' });
    const la = cluster.query('SHOW listen_addresses');
    // Do not let an errored SHOW (empty stdout) pass the no-TCP guard vacuously.
    if (la.status !== 0) throw new PhaseError(EXIT.ENV, `could not read listen_addresses (exit ${la.status}): ${la.stderr || la.stdout}`);
    assertListenAddressesEmpty(la.stdout);
    ev.set('isolation', {
      socketDir: cluster.socketDir,
      listenAddresses: la.stdout.trim(),
      noRemoteTargets: true,
      tcp: false,
    });
    phaseLine(true, 'disposable PG started, runner-isolated, no TCP/remote', `PG ${cluster.serverVersion}`);

    // ---- Bootstrap substrate ----
    try {
      applyBootstrap(cluster);
      assertDeclaredSubstratePresent(cluster, fixture);
    } catch (err) {
      throw new PhaseError(EXIT.ENV, `bootstrap substrate: ${err.message}`);
    }
    phaseLine(true, 'minimal Supabase substrate bootstrapped');

    // ---- Rollback symmetry baseline ----
    // The comparison must be pre-apply vs post-rollback. Snapshotting after
    // apply instead asserts that rollback changes nothing, which passes a
    // rollback that drops nothing and fails a correct one.
    //
    // A fixture applies prerequisites it does NOT undo, so the baseline is the
    // state immediately before the first apply stage that the rollback actually
    // reverses. The rollback stages name their own files, so that set is
    // declared, not guessed: fixture 44 applies 39 then 44 and rolls back only
    // 44 (baseline = after 39), while fixture 36 applies 34 then 36 and rolls
    // back both (baseline = before 34).
    const migrationNumberOf = (file) => Number(/^(\d+)_/.exec(file)?.[1]);
    const rolledBackNumbers = new Set(
      fixture.rollbackStages.map((s) => migrationNumberOf(s.file)).filter(Number.isFinite),
    );
    let baselineIndex = fixture.applyStages.findIndex((s) =>
      rolledBackNumbers.has(migrationNumberOf(s.file)),
    );
    if (baselineIndex < 0) baselineIndex = 0;

    let catalogBaseline = null;

    // ---- Apply forward stages ----
    for (const [stageIndex, st] of fixture.applyStages.entries()) {
      if (stageIndex === baselineIndex) {
        try {
          catalogBaseline = snapshotCatalog(cluster);
        } catch (err) {
          throw new PhaseError(EXIT.ENV, `baseline catalog snapshot failed: ${err.message}`);
        }
      }
      const res = cluster.runSqlFile(st.path);
      rawLogs[`apply-${st.label}.log`] = res.combined;
      const ok = res.status === 0;
      ev.addApplyStage({ label: st.label, file: st.file, status: ok ? 'PASS' : 'FAIL', exitCode: res.status });
      if (!ok) {
        if (expectFailure && expectFailure.phase === 'apply') {
          phaseLine(true, `apply ${st.label} failed AS EXPECTED (negative scenario)`);
          return { code: EXIT.OK, outcome: 'expected-failure' };
        }
        throw new PhaseError(EXIT.APPLY, `apply stage ${st.label} failed:\n${res.stderr || res.stdout}`);
      }
      phaseLine(true, `apply ${st.label}`);
    }
    if (expectFailure && expectFailure.phase === 'apply') {
      throw new PhaseError(EXIT.UNEXPECTED_PASS, `negative fixture ${fixture.id} was expected to fail at apply but passed`);
    }

    // ---- POST-APPLY: did the migration actually DO anything? ----
    // Runs here, while the migration is applied, because this is the only point
    // in the run at which that question can be asked. Symmetry (below) compares
    // pre-apply to post-rollback and is blind to a forward statement that matched
    // nothing. See assertPostApply.
    if (fixture.postApply) {
      const pa = assertPostApply(cluster, fixture);
      ev.set('postApply', { ok: pa.ok, problems: pa.problems || [] });
      if (!pa.ok) {
        if (expectFailure && expectFailure.phase === 'postApply') {
          phaseLine(true, 'post-apply assertion failed AS EXPECTED (negative scenario)', pa.problems.join('\n'));
          return { code: EXIT.OK, outcome: 'expected-failure' };
        }
        throw new PhaseError(EXIT.VERIFY,
          `post-apply assertions failed — the migration did not take effect:\n  - ${pa.problems.join('\n  - ')}`);
      }
      // Count what was actually checked, not just the privileges — a line that
      // says "0 privilege check(s)" next to a tick reads as nothing having been
      // asserted when constraints or indexes were.
      const paCounts = [
        [(fixture.postApply.privileges || []).length, 'privilege'],
        [(fixture.postApply.constraints || []).reduce(
          (n, c) => n + (c.present || []).length + (c.absent || []).length, 0), 'constraint'],
        [(fixture.postApply.indexes?.present || []).length
          + (fixture.postApply.indexes?.absent || []).length, 'index'],
      ].filter(([n]) => n > 0).map(([n, what]) => `${n} ${what} check(s)`);
      phaseLine(true, `post-apply assertions hold (${paCounts.join(', ') || 'nothing declared'})`);
    }
    if (expectFailure && expectFailure.phase === 'postApply') {
      throw new PhaseError(EXIT.UNEXPECTED_PASS,
        `negative fixture ${fixture.id} was expected to fail its post-apply assertions but passed`);
    }

    // ---- VERIFY ----
    if (fixture.verify?.path) {
      if (!Array.isArray(fixture.verify.expectedSections) || fixture.verify.expectedSections.length === 0 ||
          fixture.verify.expectedPassCount == null) {
        throw new PhaseError(EXIT.VERIFY,
          `fixture ${fixture.id} has a VERIFY file but declares no expectedSections/expectedPassCount — ` +
            `a VERIFY that asserts nothing must never pass (brief §8 non-vacuity)`);
      }
      const res = cluster.runSqlFile(fixture.verify.path);
      rawLogs['verify.log'] = res.combined;
      const parsed = parseVerifyOutput(res.combined);
      const evaln = evaluateVerify(parsed, {
        expectedSections: fixture.verify.expectedSections,
        expectedPassCount: fixture.verify.expectedPassCount,
      });
      ev.set('verify', {
        file: fixture.verify.file,
        expectedPassCount: fixture.verify.expectedPassCount,
        passed: parsed.passed,
        failed: parsed.failed,
        sections: evaln.sections,
        ok: evaln.ok && res.status === 0,
      });
      if (res.status !== 0 || !evaln.ok) {
        throw new PhaseError(EXIT.VERIFY, `VERIFY failed: ${evaln.problems.join('; ') || res.stderr}`);
      }
      phaseLine(true, `VERIFY ${parsed.passed.length}/${fixture.verify.expectedPassCount}`, parsed.passed.join(''));
    }

    // ---- Catalog AFTER apply: proves the fixture actually built something ----
    let catalogApplied = null;
    try {
      catalogApplied = snapshotCatalog(cluster);
    } catch (err) {
      throw new PhaseError(EXIT.APPLY, `post-apply catalog snapshot failed: ${err.message}`);
    }
    // Only fixtures that DECLARE they create public-schema objects can be
    // vacuous. 37/38 change storage buckets and storage.objects policies and
    // legitimately add nothing to the public catalog; their postRollback
    // declares no removed tables or functions.
    const declaresRemovedObjects =
      (fixture.postRollback?.removed?.tables?.length ?? 0) > 0 ||
      (fixture.postRollback?.removed?.functions?.length ?? 0) > 0;
    if (declaresRemovedObjects && assertCatalogSymmetry(catalogBaseline, catalogApplied).ok) {
      throw new PhaseError(EXIT.APPLY,
        `fixture ${fixture.id} declares objects to remove at rollback but created no public ` +
          'catalog objects, so the rollback symmetry check would pass vacuously');
    }

    // ---- Destructive guard + rollback ----
    if (fixture.destructiveGuard) {
      const dg = fixture.destructiveGuard;
      // Seed one live request so the guard has audit data to protect.
      const seed = cluster.runInlineSql('guard-seed', dg.seedSql);
      rawLogs['guard-seed.log'] = seed.combined;
      if (seed.status !== 0) throw new PhaseError(EXIT.GUARD, `guard seed failed:\n${seed.stderr}`);
      const liveBefore = countRows(cluster, dg.livenessTable);
      if (liveBefore < 1) throw new PhaseError(EXIT.GUARD, `guard seed produced no live ${dg.livenessTable} row (test would be vacuous)`);

      // (a) REFUSAL branch: run the guarded stage WITHOUT opt-in — must fail closed.
      const refusalStage = fixture.rollbackStages.find((s) => s.label === dg.refusalStage);
      if (!refusalStage) throw new PhaseError(EXIT.GUARD, `refusalStage ${dg.refusalStage} not found`);
      const refusal = runRollbackStage(cluster, refusalStage, { optIn: null });
      rawLogs['guard-refusal.log'] = refusal.combined;
      const refused = refusal.status !== 0 && new RegExp(dg.expectRefusalMatch, 'i').test(refusal.combined);
      const stillThere = regclassPresent(cluster, dg.livenessTable) &&
        countRows(cluster, dg.livenessTable) >= liveBefore;
      ev.set('destructiveGuard', {
        seededRequests: liveBefore,
        refusal: { refused, dataPreserved: stillThere, matched: dg.expectRefusalMatch },
        optIn: { setting: dg.optInSetting, value: dg.optInValue, ok: null },
      });
      if (!refused || !stillThere) {
        throw new PhaseError(EXIT.GUARD, `destructive guard did NOT refuse without opt-in (refused=${refused}, preserved=${stillThere})`);
      }
      phaseLine(true, 'destructive guard refused rollback without opt-in (data preserved)');

      // (b) OPT-IN branch = the real clean rollback, STORAGE -> main, with opt-in.
      for (const st of fixture.rollbackStages) {
        const optIn = st.label === dg.refusalStage ? { setting: dg.optInSetting, value: dg.optInValue } : null;
        const res = runRollbackStage(cluster, st, { optIn });
        rawLogs[`rollback-${st.label}.log`] = res.combined;
        ev.addRollbackStage({ label: st.label, source: st.source, status: res.status === 0 ? 'PASS' : 'FAIL', exitCode: res.status, optIn: !!optIn });
        if (res.status !== 0) throw new PhaseError(EXIT.ROLLBACK, `rollback stage ${st.label} failed:\n${res.stderr}`);
      }
      if (ev.result.destructiveGuard) ev.result.destructiveGuard.optIn.ok = true;
      phaseLine(true, 'destructive guard succeeded WITH opt-in; rollback STORAGE→main complete');
    } else {
      // No guard: plain clean rollback in declared order.
      for (const st of fixture.rollbackStages) {
        const res = runRollbackStage(cluster, st, { optIn: null });
        rawLogs[`rollback-${st.label}.log`] = res.combined;
        ev.addRollbackStage({ label: st.label, source: st.source, status: res.status === 0 ? 'PASS' : 'FAIL', exitCode: res.status });
        if (res.status !== 0) throw new PhaseError(EXIT.ROLLBACK, `rollback stage ${st.label} failed:\n${res.stderr}`);
      }
      if (fixture.rollbackStages.length) phaseLine(true, 'clean rollback complete');
    }

    // ---- Catalog AFTER rollback: must equal the pre-apply BASELINE ----
    let catalogFinal = null;
    try {
      catalogFinal = snapshotCatalog(cluster);
    } catch (err) {
      throw new PhaseError(EXIT.ROLLBACK, `post-rollback catalog snapshot failed: ${err.message}`);
    }
    // A migration that ships NO rollback cannot be asked whether its rollback
    // reversed anything, and comparing a pre-apply baseline to a post-apply
    // catalog would report every object it created as an asymmetry. Those
    // migrations are covered for what CAN be proven — that they apply on the
    // major production runs, and that their postApply assertions hold — and the
    // absence of a rollback is stated on every run rather than inferred from a
    // silence. Eight of the eleven migrations D6 exposed are in this category.
    if (fixture.forwardOnly) {
      ev.set('rollbackSymmetry', {
        baselineObjects: catalogBaseline?.length ?? null,
        appliedObjects: catalogApplied.length,
        finalObjects: null,
        ok: null,
        skipped: 'forwardOnly',
      });
      phaseLine(true,
        'NO ROLLBACK EXISTS for this migration — applied and asserted only; reversibility is NOT proven and cannot be');
      return { code: EXIT.OK, outcome: 'passed' };
    }

    const symmetry = assertCatalogSymmetry(catalogBaseline, catalogFinal);
    // Registered, already-triaged asymmetries are subtracted here. Scoped to an
    // exact object AND its exact before/after definition, so anything the
    // register does not name — including further drift in an object it does —
    // still fails. See lib/known-asymmetries.mjs for why they are not just fixed.
    const known = applyKnownAsymmetries(fixture.id, symmetry);
    ev.set('rollbackSymmetry', {
      baselineObjects: catalogBaseline.length,
      appliedObjects: catalogApplied.length,
      finalObjects: catalogFinal.length,
      ok: symmetry.ok,
      diff: symmetry.ok ? null : symmetry.diff,
      details: symmetry.ok ? null : symmetry.details,
      waived: known.waived,
      remaining: known.remaining,
    });
    if (!symmetry.ok) {
      // A fixture may be registered to PROVE this check still bites. Without
      // that, a symmetry check that quietly stopped detecting anything would
      // look exactly like a corpus of correct rollbacks.
      if (expectFailure && expectFailure.phase === 'rollback') {
        phaseLine(true, 'rollback asymmetry detected AS EXPECTED (negative scenario)', symmetry.diff);
        return { code: EXIT.OK, outcome: 'expected-failure' };
      }
      if (!known.ok) {
        throw new PhaseError(EXIT.ROLLBACK,
          `rollback is NOT symmetric — the database did not return to its pre-apply state:\n${symmetry.diff}`);
      }
    }
    if (expectFailure && expectFailure.phase === 'rollback') {
      throw new PhaseError(EXIT.UNEXPECTED_PASS,
        `negative fixture ${fixture.id} was expected to fail the rollback symmetry check but passed — ` +
          'the check no longer detects a rollback that removes nothing');
    }
    if (symmetry.ok) {
      phaseLine(true,
        `rollback is symmetric (${catalogBaseline.length} → ${catalogApplied.length} → ${catalogFinal.length} objects)`);
    } else {
      // Deliberately NOT folded into the line above. A waived asymmetry is an
      // open defect that this run chose not to fail on, and printing it as
      // "symmetric" would make the register a way of forgetting rather than a way
      // of tracking. Every run restates what is outstanding and why.
      phaseLine(true,
        `rollback symmetric APART FROM ${known.waived.length} KNOWN, ACCEPTED asymmetry(ies) — open, not fixed`,
        known.waived.map((w) => `  ! ${w.key.replace('|', ' ')}\n    raised ${w.raised}: ${w.reason}`).join('\n'));
    }

    // ---- Post-rollback: objects removed, substrate intact ----
    if (fixture.postRollback) {
      const pc = assertPostRollback(cluster, fixture);
      ev.set('postRollback', { ok: pc.ok, problems: pc.problems || [] });
      if (!pc.ok) throw new PhaseError(EXIT.ROLLBACK, `post-rollback assertions failed:\n  - ${pc.problems.join('\n  - ')}`);
      phaseLine(true, 'every migration object removed; bootstrap substrate intact');
    }

    return { code: EXIT.OK, outcome: 'passed' };
  };

  let error = null;
  try {
    const r = execute();
    code = r.code;
    outcome = r.outcome;
  } catch (err) {
    code = err instanceof PhaseError ? err.code : EXIT.ENV;
    outcome = expectFailure ? 'unexpected' : 'failed';
    error = err;
    ev.set('error', String(err.message || err));
    phaseLine(false, `FAILED (exit ${code})`, String(err.message || err).split('\n')[0]);
  }

  // Deterministic teardown ALWAYS — and BEFORE the exit code is finalized, so a
  // failed stop or a leftover run dir escalates a would-be-green run to
  // EXIT.TEARDOWN instead of being masked (brief §13; merge-gate items 12–15).
  if (!keep) {
    const td = cluster.teardown();
    ev.result.teardown = td;
    if (!td.ok && code === EXIT.OK) code = EXIT.TEARDOWN;
  } else {
    ev.result.teardown = { ok: null, kept: true, runRoot: cluster.runRoot };
    log(verbose, `  ! --keep: cluster NOT torn down at ${cluster.runRoot} (never use in CI)`);
  }

  // Finalize evidence ONCE, with the true final exit code (post-teardown).
  ev.finalize({ finalExitCode: code, outcome });
  try {
    const written = ev.write({ rawLogs });
    log(verbose, `  evidence: ${written.resultPath}`);
    ev._artifactPath = written.resultPath;
  } catch (e) {
    log(verbose, `  ! evidence write failed: ${e.message}`);
  }

  return { code, ev, cluster, error };
}

function parseArgs(argv) {
  const opts = { fixtures: [], all: false, verbose: false, keep: false, ci: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--ci') { opts.ci = true; opts.verbose = true; }
    else if (a === '--fixture') opts.fixtures.push(argv[++i]);
    else if (!a.startsWith('-')) opts.fixtures.push(a);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Startup isolation guard — before ANY SQL, before any cluster.
  try {
    assertNoRemoteTargets(process.env);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(EXIT.ENV);
  }

  // Migration-number governance — a collision makes apply ORDER and the runtime
  // register ambiguous, so refuse to certify any migration until it is resolved.
  try {
    assertNoNumberCollisions(REPO_ROOT);
    process.stdout.write('✓ migration numbering: no collisions\n');
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(EXIT.ENV);
  }

  let ids = opts.fixtures;
  if (opts.all || ids.length === 0) {
    const { readdirSync } = await import('node:fs');
    ids = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    if (!opts.all && ids.length) ids = ['24_evidence'].filter((x) => ids.includes(x));
  }
  if (ids.length === 0) {
    process.stderr.write('no fixtures to run\n');
    process.exit(EXIT.ENV);
  }

  process.stdout.write(`Disposable-Postgres migration harness — fixtures: ${ids.join(', ')}\n`);

  // ---- COVERAGE, PRINTED BECAUSE ITS ABSENCE HAS ALREADY MISLED SOMEONE ----
  //
  // This harness enumerates FIXTURES, not migrations. A migration with no
  // fixture is therefore skipped in complete silence, and a green run says
  // nothing whatever about it — while looking exactly like a run that covered
  // everything.
  //
  // Migrations 45 and 46 were merged that way on 2026-08-02, and the passing
  // check was reported twice as evidence that they had been exercised on a real
  // PostgreSQL. It was not. Printing the gap does not close it, but it makes the
  // assumption checkable instead of invisible, which is the difference between a
  // known limit and a false negative.
  //
  // Deliberately NOT a failure: roughly twenty pre-2026 migrations have no
  // fixture, and turning that into a red build would say "this is broken" about
  // a backlog rather than "this run did not cover these", which is the true and
  // more useful statement.
  //
  // ---- WHY THE DENOMINATOR IS NUMBERED MIGRATIONS, NOT *_HARDENING.sql ----
  //
  // It used to be `*_HARDENING.sql`. Every file matching that pattern happened to
  // have a fixture, so the harness printed "32/32" — a ratio that could not have
  // printed anything else, because the set it counted was defined by the same
  // naming convention the covered set follows. A migration escaped the
  // denominator simply by not being called _HARDENING: 3 (`_SEARCH_PATH_AND_GRANTS`),
  // 10/17 (`_MVP`), 23 (bare), 13 (`_DRIFT_CHECK`), 16/18 (`_VERIFY`),
  // 20 (`_ACL_FIX`), 4, 8, 9. Eleven migrations, three of which (10, 17, 23) ship
  // a real ROLLBACK that no fixture has ever executed.
  //
  // "32/32" was therefore not a coverage measurement. It was the statement
  // "every file I chose to count, I counted" — indistinguishable at a glance from
  // full coverage, and read as full coverage in at least one merge commit message.
  //
  // The denominator is now every `<number>_*.sql` in the repo root, which is the
  // set an operator means by "the migrations". The ratio it prints can fall, and
  // that is the entire point: a number that cannot go down measures nothing.
  if (opts.all) {
    const { readdirSync } = await import('node:fs');
    const cov = computeFixtureCoverage(readdirSync(REPO_ROOT), ids);
    process.stdout.write(
      `Fixture coverage: ${cov.coveredCount}/${cov.total} numbered migrations have a fixture.\n`,
    );
    if (cov.uncovered.length) {
      // Naming the migrations, not just counting them, is what makes the gap
      // actionable — "11 uncovered" prompts nobody to go and write fixture 10.
      process.stdout.write(
        `  NO FIXTURE — this run proves nothing about: ${cov.uncovered.join(', ')}\n`,
      );
      if (cov.uncoveredWithRollback.length) {
        process.stdout.write(
          `  OF THOSE, these ship a ROLLBACK that has never been executed: ${cov.uncoveredWithRollback.join(', ')}\n`,
        );
      }
    }
  }
  let worst = EXIT.OK;
  for (const id of ids) {
    const { code, ev } = runFixture(id, { verbose: true, keep: opts.keep });
    process.stdout.write(`  = ${id}: ${ev.result.outcome} (exit ${code})\n`);
    if (code !== EXIT.OK) worst = code;
  }
  process.stdout.write(worst === EXIT.OK ? '\nALL FIXTURES GREEN\n' : `\nHARNESS FAILED (exit ${worst})\n`);
  process.exit(worst);
}

// Only run as CLI when invoked directly.
import { fileURLToPath as _fue } from 'node:url';
if (process.argv[1] && _fue(import.meta.url) === process.argv[1]) {
  main();
}
