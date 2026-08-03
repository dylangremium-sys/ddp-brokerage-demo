// Rollback symmetry verification — behavioral proof that migrations are reversible.
//
// Migrations must be symmetric: applying a HARDENING and then rolling it back
// must leave the database in exactly the state it started. A broken rollback
// that does not remove what it created — including edge cases like wrong
// function signatures — is only caught by comparing catalogs before and after.
//
// Usage: call snapshotCatalog(cluster) before HARDENING, and after ROLLBACK,
// then call assertCatalogSymmetry(before, after) to verify they match.
// The snapshot includes functions WITH their signatures, not just names.

/**
 * Snapshot the public schema catalog in a form suitable for before/after comparison.
 * Returns a sorted array of { kind, obj } tuples.
 * Functions include full signatures from pg_get_function_identity_arguments().
 * This catches both wrong names and wrong signatures.
 */
export function snapshotCatalog(cluster) {
  const query = `
    SELECT 'function' kind, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' obj
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    UNION ALL SELECT 'table', tablename FROM pg_tables WHERE schemaname = 'public'
    UNION ALL SELECT 'policy', policyname FROM pg_policies WHERE schemaname = 'public'
    UNION ALL SELECT 'trigger', t.tgname FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY 1, 2
  `;

  const result = cluster.query(query);
  if (result.status !== 0) {
    throw new Error(`catalog snapshot failed: ${result.stderr || result.stdout}`);
  }

  // Parse psql output into array of objects
  const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
  const objects = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\w+)\s*\|\s*(.+?)\s*$/);
    if (match) {
      objects.push({ kind: match[1], obj: match[2] });
    }
  }

  return objects;
}

/**
 * Assert that two snapshots are identical.
 * Returns { ok: true } on match, or { ok: false, diff: string } with details.
 */
export function assertCatalogSymmetry(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return { ok: false, diff: 'invalid snapshot format' };
  }

  // Check length first
  if (before.length !== after.length) {
    return {
      ok: false,
      diff: `length mismatch: before ${before.length}, after ${after.length}`,
    };
  }

  // Check each entry
  const diffs = [];
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    if (b.kind !== a.kind || b.obj !== a.obj) {
      diffs.push(`[${i}] before: ${b.kind} | ${b.obj}`);
      diffs.push(`    after:  ${a.kind} | ${a.obj}`);
    }
  }

  if (diffs.length > 0) {
    return { ok: false, diff: diffs.join('\n') };
  }

  return { ok: true };
}
