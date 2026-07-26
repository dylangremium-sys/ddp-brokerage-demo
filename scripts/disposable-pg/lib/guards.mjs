// guards.mjs — structural isolation guards (brief §5, §16, §18).
//
// The harness may ONLY ever talk to a per-run Unix socket under an OS temp dir on
// a cluster it just created and will destroy. These guards refuse EVERYTHING
// remote — the inverse of run-staging-security-tests.mjs, which is pinned to
// staging. They are pure functions so they can be unit-tested without Postgres.

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

// Known DDP project refs that must never be reachable from this harness.
export const FORBIDDEN_PROJECT_REFS = Object.freeze([
  'szqocdabwkjrggrddocx', // canonical staging
  'iihxjrfxmycjafbtjvvq', // production
]);

// Env vars that, if set to a non-empty value, indicate a remote/hosted target.
export const FORBIDDEN_ENV_KEYS = Object.freeze([
  'STAGING_DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_DB_URL',
  'DATABASE_URL',
  'PGHOST',
  'PGHOSTADDR',
  'PGSERVICE',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
]);

// Does a string look like a TCP/remote Postgres target (as opposed to a local
// Unix-socket path)? A socket "host" is an absolute directory path (starts "/").
export function isTcpTarget(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (s === '') return false;
  // A Unix-socket host is an absolute path; anything else that names a host is TCP.
  if (s.startsWith('/')) return false;
  if (/^postgres(ql)?:\/\//i.test(s)) {
    // A libpq URL with an empty/absolute host component is socket-based; else TCP.
    const m = s.match(/^postgres(?:ql)?:\/\/(?:[^@/]*@)?([^/?:]*)/i);
    const host = m ? decodeURIComponent(m[1] || '') : '';
    return !(host === '' || host.startsWith('/') || host.startsWith('%2F') || host.startsWith('%2f'));
  }
  if (/(?:^|[?&\s;])host=/.test(s) && !/host=\//.test(s)) return true;
  if (/(?:^|[?&\s;])hostaddr=/.test(s)) return true;
  if (/\.supabase\.(co|net|in)/i.test(s)) return true;
  // A bare "hostname:port" or "hostname" that is not a path.
  if (/^[a-z0-9.-]+:\d+$/i.test(s)) return true;
  return false;
}

// Scan an env object for anything indicating a remote/hosted DB target.
// Returns an array of human-readable reasons (empty => clean).
export function detectRemoteTargets(env) {
  const reasons = [];
  for (const key of FORBIDDEN_ENV_KEYS) {
    const val = env[key];
    if (val != null && String(val).trim() !== '') {
      if (key === 'PGHOST' || key === 'PGHOSTADDR') {
        // A socket "host" is an absolute directory path; anything else is a TCP host.
        if (!String(val).trim().startsWith('/')) reasons.push(`${key} names a non-socket (TCP) host: ${val}`);
      } else {
        reasons.push(`${key} is set (${key.includes('KEY') ? '<redacted>' : val})`);
      }
    }
  }
  // Any env value referencing a forbidden project ref.
  for (const [key, val] of Object.entries(env)) {
    if (val == null) continue;
    const s = String(val);
    for (const ref of FORBIDDEN_PROJECT_REFS) {
      if (s.includes(ref)) reasons.push(`${key} references forbidden project ref ${ref}`);
    }
  }
  return reasons;
}

// Startup guard: abort before ANY SQL if the environment points anywhere remote.
export function assertNoRemoteTargets(env = process.env) {
  const reasons = detectRemoteTargets(env);
  if (reasons.length > 0) {
    throw new GuardError(
      'refusing to run: a remote/hosted database target is present in the environment. ' +
        'This harness only ever talks to its own disposable socket-only cluster. ' +
        'Offending signals:\n  - ' + reasons.join('\n  - '),
    );
  }
}

// The resolved connection must be a Unix socket under an OS temp dir.
export function assertSocketOnlyConnection(conn, { tmpRoot } = {}) {
  if (!conn || typeof conn !== 'object') {
    throw new GuardError('connection descriptor missing');
  }
  const { host } = conn;
  if (!host || typeof host !== 'string' || !host.startsWith('/')) {
    throw new GuardError(`connection host must be an absolute socket directory, got: ${host}`);
  }
  if (isTcpTarget(host)) {
    throw new GuardError(`connection host looks like a TCP target: ${host}`);
  }
  if (tmpRoot && !host.startsWith(tmpRoot)) {
    throw new GuardError(
      `socket directory ${host} is not under the expected temp root ${tmpRoot}`,
    );
  }
  if (conn.tcp === true || conn.port === undefined) {
    // port is still used to name the socket file; a `tcp:true` marker is illegal.
    if (conn.tcp === true) throw new GuardError('connection is marked TCP; refused');
  }
  return true;
}

// After start, assert the running server has no TCP listener.
export function assertListenAddressesEmpty(showListenAddressesValue) {
  const v = (showListenAddressesValue ?? '').toString().trim();
  if (v !== '') {
    throw new GuardError(
      `postmaster is listening on TCP (listen_addresses='${v}'); expected '' (socket-only)`,
    );
  }
  return true;
}
