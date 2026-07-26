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
import { DisposableCluster, DEFAULT_PG_MAJOR } from './lib/cluster.mjs';
import {
  applyBootstrap,
  assertDeclaredSubstratePresent,
  assertNoForceRls,
  assertNoUndeclaredSubstrate,
} from './lib/supabase-shim.mjs';
import { parseVerifyOutput, evaluateVerify } from './lib/verify-parser.mjs';
import { EvidenceBuilder, newRunId } from './lib/evidence.mjs';

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
  const pgMajor = fixture.pgMajor || DEFAULT_PG_MAJOR;
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

    // ---- Apply forward stages ----
    for (const st of fixture.applyStages) {
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
