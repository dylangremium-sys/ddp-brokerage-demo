// cluster.mjs — deterministic create -> use -> destroy of an isolated, ephemeral,
// socket-only PostgreSQL cluster (brief §4, §5, §12).
//
// No TCP listener, no reuse, no shared global cluster, zero residue after teardown.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

export class ClusterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClusterError';
  }
}

// 17, because production runs 17.6 (`select version()`, measured read-only
// 2026-08-04). It was 18, which meant every migration in this repo was proven
// reversible on a major version the live database does not run — a guarantee
// about a database that does not exist. Between "newest" and "the one prod
// actually runs", the harness owes its answer to the second.
//
// The DEFAULT tracks production and should be changed when production upgrades,
// not before.
export const DEFAULT_PG_MAJOR = 17;

/**
 * An explicit operator override, or null when unset.
 *
 * Kept SEPARATE from DEFAULT_PG_MAJOR because the two are resolved at different
 * precedences. Every fixture carries its own `pgMajor`, and the harness used to
 * resolve `fixture.pgMajor || DEFAULT_PG_MAJOR` — under which the fixture pin
 * always wins, since every fixture sets one. Folding HARNESS_PG_MAJOR into the
 * default would therefore have made the env var silently inert: a CI lane that
 * installs 18 and sets HARNESS_PG_MAJOR=18 would still request a 17 cluster and
 * die on a major mismatch, which reads as a broken lane rather than an ignored
 * setting. An explicitly-set env var must beat a file-level default.
 */
export const PG_MAJOR_OVERRIDE =
  process.env.HARNESS_PG_MAJOR && process.env.HARNESS_PG_MAJOR.trim() !== ''
    ? Number(process.env.HARNESS_PG_MAJOR)
    : null;
const SOCKET_PORT = 5432;
// Socket paths have a hard ~100-char limit (sockaddr_un). Keep the run dir short.
const SOCKET_BASE = process.platform === 'win32' ? os.tmpdir() : '/tmp';

function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    ...opts,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error || null,
    signal: res.signal || null,
  };
}

function which(bin) {
  const res = run(process.platform === 'win32' ? 'where' : 'which', [bin]);
  const line = (res.stdout || '').split(/\r?\n/).find(Boolean);
  return res.status === 0 && line ? line.trim() : null;
}

// Resolve a directory holding initdb/pg_ctl/psql/createdb of the pinned major.
// Priority: PG_BIN env dir -> binaries on PATH. Fail fast on absence/mismatch.
export function resolvePgBin({ env = process.env, pgMajor = DEFAULT_PG_MAJOR } = {}) {
  const required = ['initdb', 'pg_ctl', 'psql', 'createdb', 'postgres'];
  let binDir = null;

  if (env.PG_BIN && env.PG_BIN.trim() !== '') {
    binDir = env.PG_BIN.trim();
    for (const b of required) {
      if (!existsSync(join(binDir, b))) {
        throw new ClusterError(`PG_BIN=${binDir} is missing required binary "${b}"`);
      }
    }
  } else {
    const pgCtl = which('pg_ctl');
    if (!pgCtl) {
      throw new ClusterError(
        `no PostgreSQL ${pgMajor} binaries found. Set PG_BIN to a Postgres ${pgMajor} bin dir ` +
          `(e.g. Homebrew postgresql@${pgMajor} or /usr/lib/postgresql/${pgMajor}/bin), or add it to PATH.`,
      );
    }
    binDir = pgCtl.replace(/\/pg_ctl$/, '');
    // Require the FULL server toolset co-located (a client-only install such as
    // Homebrew libpq has pg_ctl/psql but no initdb/postgres — it cannot host a
    // disposable cluster). Fail fast rather than dying mid-initdb.
    for (const b of required) {
      if (!existsSync(join(binDir, b))) {
        throw new ClusterError(
          `PostgreSQL bin dir ${binDir} (from PATH) lacks "${b}" — this looks like a client-only ` +
            `install. Set PG_BIN to a full Postgres ${pgMajor} server bin dir.`,
        );
      }
    }
  }

  // Enforce the pinned major — never silently run on a different major.
  const ver = run(join(binDir, 'pg_ctl'), ['--version']);
  const m = (ver.stdout || '').match(/(\d+)(?:\.\d+)?/);
  const foundMajor = m ? Number(m[1]) : null;
  if (foundMajor !== pgMajor) {
    throw new ClusterError(
      `PostgreSQL major mismatch: harness requires ${pgMajor}, found ${ver.stdout.trim()} at ${binDir}. ` +
        `A different major could mask or invent behaviour; refusing.`,
    );
  }
  return { binDir, versionString: ver.stdout.trim() };
}

export class DisposableCluster {
  // The default honours an explicit HARNESS_PG_MAJOR, so "this run uses major X"
  // means the same thing to every caller. Defaulting to DEFAULT_PG_MAJOR alone
  // put the override only where runFixture applied it by hand: a direct
  // `new DisposableCluster({})` on the PG-18 lane asked for 17, found 18, and
  // refused on a major mismatch that the operator had explicitly asked for.
  constructor({
    pgMajor = PG_MAJOR_OVERRIDE ?? DEFAULT_PG_MAJOR,
    superuser = 'postgres',
    log = () => {},
  } = {}) {
    this.pgMajor = pgMajor;
    this.superuser = superuser;
    this.log = log;
    this.runRoot = null;
    this.pgData = null;
    this.socketDir = null;
    this.database = 'harness';
    this.binDir = null;
    this.versionString = null;
    this.serverVersion = null;
    this.postmasterPid = null;
    this._started = false;
    this._tornDown = false;
    this._signalHandler = null;
  }

  bin(name) {
    return join(this.binDir, name);
  }

  connection() {
    return { host: this.socketDir, port: SOCKET_PORT, database: this.database, user: this.superuser };
  }

  create() {
    const { binDir, versionString } = resolvePgBin({ pgMajor: this.pgMajor });
    this.binDir = binDir;
    this.versionString = versionString;

    this.runRoot = mkdtempSync(join(SOCKET_BASE, 'dpg-'));
    this.pgData = join(this.runRoot, 'pgdata');
    this.socketDir = this.runRoot; // short path -> safe socket length
    this._installSignalHandlers();

    // 1. initdb — UTF8 / C locale / trust on the local socket only.
    const initdb = run(this.bin('initdb'), [
      '-D', this.pgData,
      '-U', this.superuser,
      '--encoding=UTF8',
      '--locale=C',
      '--auth=trust',
      '--no-sync',
    ]);
    if (initdb.status !== 0) {
      throw new ClusterError(`initdb failed:\n${initdb.stderr || initdb.stdout || initdb.error}`);
    }

    // 2. Harden config: no TCP, socket-only, fast (ephemeral).
    appendFileSync(
      join(this.pgData, 'postgresql.conf'),
      [
        "listen_addresses = ''",
        `unix_socket_directories = '${this.socketDir}'`,
        `port = ${SOCKET_PORT}`,
        'fsync = off',
        'synchronous_commit = off',
        'full_page_writes = off',
        '',
      ].join('\n'),
    );
    // Local socket connections only — no host/hostssl lines at all.
    writeFileSync(
      join(this.pgData, 'pg_hba.conf'),
      'local all all trust\n',
    );

    // 3. Start, bounded wait.
    const logFile = join(this.runRoot, 'postmaster.log');
    const start = run(this.bin('pg_ctl'), [
      '-D', this.pgData,
      '-l', logFile,
      '-w', '-t', '30',
      '-o', `-c listen_addresses='' -c unix_socket_directories='${this.socketDir}' -c port=${SOCKET_PORT}`,
      'start',
    ]);
    if (start.status !== 0) {
      const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
      throw new ClusterError(`pg_ctl start failed:\n${start.stderr || start.stdout}\n${tail}`);
    }
    this._started = true;
    const pidFile = join(this.pgData, 'postmaster.pid');
    if (existsSync(pidFile)) {
      this.postmasterPid = Number(readFileSync(pidFile, 'utf8').split(/\r?\n/)[0]);
    }

    // 4. Throwaway database.
    const createdb = run(this.bin('createdb'), [
      '-h', this.socketDir, '-p', String(SOCKET_PORT), '-U', this.superuser, this.database,
    ]);
    if (createdb.status !== 0) {
      throw new ClusterError(`createdb failed:\n${createdb.stderr || createdb.stdout}`);
    }

    // Record the ACTUAL server version (self-describing evidence).
    const sv = this.query('SHOW server_version');
    this.serverVersion = (sv.stdout || '').trim();

    this.log(`cluster up: PG ${this.serverVersion} socket=${this.socketDir}`);
    return this.connection();
  }

  // Run inline SQL via -c; returns {status, stdout, stderr}. Does not throw.
  query(sql) {
    return run(this.bin('psql'), [
      '-h', this.socketDir, '-p', String(SOCKET_PORT), '-U', this.superuser, '-d', this.database,
      '-tA', '-c', sql,
    ]);
  }

  // Run a .sql file (or written stage SQL) with ON_ERROR_STOP. `sessionSql` (array)
  // is executed via -c BEFORE the file, in the same session (used for the rollback
  // opt-in GUC). Returns {status, stdout, stderr, combined}.
  runSqlFile(filePath, { sessionSql = [] } = {}) {
    const args = [
      '-h', this.socketDir, '-p', String(SOCKET_PORT), '-U', this.superuser, '-d', this.database,
      '-v', 'ON_ERROR_STOP=1',
    ];
    for (const s of sessionSql) args.push('-c', s);
    args.push('-f', filePath);
    const res = run(this.bin('psql'), args);
    return { ...res, combined: `${res.stdout}\n${res.stderr}` };
  }

  // Persist inline SQL as a stage file inside the run dir, then execute it.
  runInlineSql(label, sql, opts = {}) {
    const p = join(this.runRoot, `stage-${label.replace(/[^a-z0-9_-]/gi, '_')}.sql`);
    writeFileSync(p, sql);
    return this.runSqlFile(p, opts);
  }

  teardown() {
    if (this._tornDown) return { ok: true, residue: false, alreadyDone: true };
    this._tornDown = true;
    let stopErr = null;
    if (this._started && this.binDir && this.pgData) {
      const stop = run(this.bin('pg_ctl'), ['-D', this.pgData, '-m', 'immediate', '-w', '-t', '20', 'stop']);
      if (stop.status !== 0) stopErr = stop.stderr || stop.stdout;
    }
    if (this.runRoot && existsSync(this.runRoot)) {
      rmSync(this.runRoot, { recursive: true, force: true });
    }
    const residue = this.runRoot ? existsSync(this.runRoot) : false;
    let processAlive = false;
    if (this.postmasterPid) {
      try {
        process.kill(this.postmasterPid, 0);
        processAlive = true; // still alive => residue
      } catch {
        processAlive = false;
      }
    }
    this._removeSignalHandlers();
    const ok = !residue && !processAlive;
    if (!ok) {
      this.log(`TEARDOWN RESIDUE: dir=${residue} process=${processAlive} stopErr=${stopErr || 'none'}`);
    }
    return { ok, residue, processAlive, stopErr };
  }

  _installSignalHandlers() {
    if (this._signalHandler) return;
    this._signalHandler = () => {
      try {
        this.teardown();
      } finally {
        process.exit(130);
      }
    };
    process.on('SIGINT', this._signalHandler);
    process.on('SIGTERM', this._signalHandler);
  }

  _removeSignalHandlers() {
    if (!this._signalHandler) return;
    process.removeListener('SIGINT', this._signalHandler);
    process.removeListener('SIGTERM', this._signalHandler);
    this._signalHandler = null;
  }
}
