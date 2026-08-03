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
  // Objects owned by an extension (pgcrypto lands ~37 functions in public via
  // `CREATE EXTENSION IF NOT EXISTS`) are excluded. A ROLLBACK must NOT drop
  // them — the extension is shared, and other migrations depend on it — so
  // counting them makes a correct rollback look asymmetric.
  const notExtensionOwned = `
    NOT EXISTS (SELECT 1 FROM pg_depend d
                WHERE d.objid = %OID% AND d.classid = '%CATALOG%'::regclass AND d.deptype = 'e')`;

  const query = `
    SELECT 'function' kind, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' obj
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND ${notExtensionOwned.replace('%OID%', 'p.oid').replace('%CATALOG%', 'pg_proc')}
    UNION ALL SELECT 'table', c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND ${notExtensionOwned.replace('%OID%', 'c.oid').replace('%CATALOG%', 'pg_class')}
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

  // Compare as sets, not by position. A positional walk reports only "length
  // mismatch" the moment one object is added or removed, which names nothing an
  // operator can act on — and the whole point of this check is to say WHICH
  // object the rollback left behind or destroyed.
  const key = (e) => `${e.kind}|${e.obj}`;
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));

  // Present after rollback but not before it ran: the rollback failed to remove these.
  const leaked = [...afterKeys].filter((k) => !beforeKeys.has(k)).sort();
  // Present before but gone after: the rollback destroyed something it never created.
  const destroyed = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort();

  if (leaked.length === 0 && destroyed.length === 0) return { ok: true };

  const lines = [];
  if (leaked.length > 0) {
    lines.push(`${leaked.length} object(s) the ROLLBACK failed to remove:`);
    for (const k of leaked) lines.push(`  + ${k.replace('|', ' ')}`);
  }
  if (destroyed.length > 0) {
    lines.push(`${destroyed.length} pre-existing object(s) the ROLLBACK destroyed (over-reach):`);
    for (const k of destroyed) lines.push(`  - ${k.replace('|', ' ')}`);
  }

  return { ok: false, diff: lines.join('\n'), leaked, destroyed };
}
