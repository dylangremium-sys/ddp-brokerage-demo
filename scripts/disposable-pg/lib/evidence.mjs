// evidence.mjs — structured, gitignored evidence capture (brief §11).
//
// result.json is the machine-readable proof a migration reached VERIFIED (not
// merely APPLIED_NOT_VERIFIED). It holds NO credentials — the harness has none —
// and that absence is asserted before the bundle is written.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS_DIR = resolve(__dirname, '..', '.artifacts');

export class EvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvidenceError';
  }
}

// Patterns that must never appear in an evidence bundle.
const SECRET_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /service_role["'\s:=]+[A-Za-z0-9._-]{20,}/i,
  /postgres(?:ql)?:\/\/[^/\s:@]+:[^/\s@]+@/i, // credentials in a DSN
  /szqocdabwkjrggrddocx/, // staging ref
  /iihxjrfxmycjafbtjvvq/, // production ref
  /\.supabase\.(co|net|in)/i,
];

export function findSecrets(text) {
  const s = String(text);
  const hits = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(s)) hits.push(re.toString());
  }
  return hits;
}

export function assertNoSecrets(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const hits = findSecrets(text);
  if (hits.length > 0) {
    throw new EvidenceError(`evidence contains forbidden secret-shaped content: ${hits.join(', ')}`);
  }
}

export class EvidenceBuilder {
  constructor({ runId, fixtureId, gitSha, pgMajor }) {
    this.result = {
      schema: 'disposable-pg-harness/result@1',
      runId,
      fixture: fixtureId,
      gitSha: gitSha || null,
      pgMajorSupported: pgMajor,
      pgVersionActual: null,
      isolation: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      applyStages: [],
      verify: null,
      rollbackStages: [],
      postRollback: null,
      destructiveGuard: null,
      teardown: null,
      finalExitCode: null,
      outcome: 'incomplete',
    };
    this._t0 = Date.now();
  }

  set(key, value) {
    this.result[key] = value;
    return this;
  }

  addApplyStage(stage) {
    this.result.applyStages.push(stage);
    return this;
  }

  addRollbackStage(stage) {
    this.result.rollbackStages.push(stage);
    return this;
  }

  finalize({ finalExitCode, outcome }) {
    this.result.endedAt = new Date().toISOString();
    this.result.durationMs = Date.now() - this._t0;
    this.result.finalExitCode = finalExitCode;
    this.result.outcome = outcome;
    return this.result;
  }

  // Write result.json (+ optional raw logs) under .artifacts/<runId>/. Returns path.
  write({ rawLogs = {} } = {}) {
    assertNoSecrets(this.result);
    const dir = resolve(ARTIFACTS_DIR, this.result.runId);
    mkdirSync(dir, { recursive: true });
    const resultPath = resolve(dir, 'result.json');
    writeFileSync(resultPath, JSON.stringify(this.result, null, 2) + '\n');
    for (const [name, content] of Object.entries(rawLogs)) {
      assertNoSecrets(content);
      writeFileSync(resolve(dir, name), content);
    }
    return { dir, resultPath };
  }
}

export function newRunId(fixtureId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${fixtureId}-${stamp}-${rand}`;
}
