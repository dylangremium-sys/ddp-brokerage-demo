// supabase-shim.mjs — load the minimal Supabase substrate and enforce the
// substrate-declaration, drift, and FORCE-RLS invariants (brief §6, §16, §17).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BOOTSTRAP_PATH = resolve(__dirname, '..', 'bootstrap', '00_supabase_substrate.sql');

export class ShimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShimError';
  }
}

// Apply the bootstrap substrate to a live disposable cluster.
export function applyBootstrap(cluster) {
  const res = cluster.runSqlFile(BOOTSTRAP_PATH);
  if (res.status !== 0) {
    throw new ShimError(`bootstrap substrate failed to apply:\n${res.stderr || res.stdout}`);
  }
  return res;
}

// Strip SQL comments (-- line and /* */ block) without cutting inside single-quoted
// string literals, so scans see only executable SQL. Quote-aware for `--`.
export function stripSqlComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "'") {
        if (n === "'") { out += n; i++; } // escaped quote
        else inString = false;
      }
      continue;
    }
    if (c === "'") { inString = true; out += c; continue; }
    if (c === '-' && n === '-') { inLine = true; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

// Scan SQL text for FORCE ROW LEVEL SECURITY — owner decision K-10(e): it stays OFF.
export function scanForceRls(sqlTexts) {
  const hits = [];
  for (const { label, text } of sqlTexts) {
    if (/FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(stripSqlComments(text))) hits.push(label);
  }
  return hits;
}

export function assertNoForceRls(sqlTexts) {
  const hits = scanForceRls(sqlTexts);
  if (hits.length > 0) {
    throw new ShimError(
      `FORCE ROW LEVEL SECURITY found in: ${hits.join(', ')} — forbidden by owner decision K-10(e)`,
    );
  }
}

// Static "fail on undeclared substrate" scan (brief §6): every auth.* / storage.*
// symbol a migration references must either be declared by the fixture's
// substrate OR be created by the migration itself. Anything else is an unmodelled
// dependency and must be surfaced, not silently approximated.
export function scanUndeclaredSubstrate(fixture, sqlTexts) {
  const declared = new Set((fixture.declaredSubstrate?.symbols || []).map((s) => s.toLowerCase()));
  const REF_RE = /\b((?:auth|storage)\.[a-z_][a-z0-9_]*)/gi;
  const CREATE_RE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|VIEW|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:auth|storage)\.[a-z_][a-z0-9_]*)/gi;

  const created = new Set();
  const referenced = new Set();
  for (const { text } of sqlTexts) {
    const code = stripSqlComments(text);
    let m;
    CREATE_RE.lastIndex = 0;
    while ((m = CREATE_RE.exec(code)) !== null) created.add(m[1].toLowerCase());
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(code)) !== null) referenced.add(m[1].toLowerCase());
  }
  const undeclared = [];
  for (const sym of referenced) {
    if (declared.has(sym)) continue;
    if (created.has(sym)) continue;
    undeclared.push(sym);
  }
  return undeclared.sort();
}

export function assertNoUndeclaredSubstrate(fixture, sqlTexts) {
  const undeclared = scanUndeclaredSubstrate(fixture, sqlTexts);
  if (undeclared.length > 0) {
    throw new ShimError(
      `migration references auth.*/storage.* symbols the fixture did not declare: ` +
        `${undeclared.join(', ')}. Declare + shim them, or route that property to live-staging verification.`,
    );
  }
}

// Post-bootstrap: assert the shim actually exposes the roles/schemas/symbols the
// fixture declares (drift test — brief §17 supabase-shim.test).
export function assertDeclaredSubstratePresent(cluster, fixture) {
  const problems = [];
  const sub = fixture.declaredSubstrate || {};

  for (const role of sub.roles || []) {
    const r = cluster.query(`SELECT 1 FROM pg_roles WHERE rolname = '${role}'`);
    if (r.stdout.trim() !== '1') problems.push(`role missing: ${role}`);
  }
  for (const schema of sub.schemas || []) {
    const r = cluster.query(`SELECT 1 FROM pg_namespace WHERE nspname = '${schema}'`);
    if (r.stdout.trim() !== '1') problems.push(`schema missing: ${schema}`);
  }
  for (const sym of sub.symbols || []) {
    const [schema, name] = sym.split('.');
    // Try relation first, then function.
    const rel = cluster.query(`SELECT to_regclass('${schema}.${name}') IS NOT NULL`);
    const isRel = rel.stdout.trim() === 't';
    const fn = cluster.query(
      `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ` +
        `WHERE n.nspname = '${schema}' AND p.proname = '${name}'`,
    );
    const isFn = Number(fn.stdout.trim() || '0') > 0;
    if (!isRel && !isFn) problems.push(`declared substrate symbol missing: ${sym}`);
  }
  if (problems.length > 0) {
    throw new ShimError(`declared substrate not fully present after bootstrap:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

export function readBootstrapSql() {
  return readFileSync(BOOTSTRAP_PATH, 'utf8');
}
