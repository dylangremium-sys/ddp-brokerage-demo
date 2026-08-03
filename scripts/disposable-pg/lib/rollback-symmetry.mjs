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

  // A third column carries a DEFINITION digest, so "the object still exists"
  // is not mistaken for "the object was restored". Migration 45 replaces
  // fn_audit_organisation_change() and its rollback re-creates the previous
  // body under the SAME signature: without the digest that fixture measured
  // 53 → 53 → 53 objects and the symmetry check proved nothing at all.
  //
  // Policies are swept in `storage` as well as `public`. Migration 38 creates
  // its policies on storage.objects; scoped to public, that fixture measured
  // 15 → 15 → 15 and a rollback removing none of them would still pass.
  // The digest normalises comments and whitespace away, so it tracks BEHAVIOUR
  // rather than prose. Migration 45's rollback restores fn_audit_organisation_change
  // with the same executable body as migration 39 but without the explanatory
  // comments; hashing the raw text would fail a correct rollback over a comment.
  // (Narrow, accepted limitation: a `--` inside a string literal is stripped too.)
  const definitionDigest = (expr) =>
    `substr(md5(regexp_replace(regexp_replace(${expr}, '--[^\\n]*', '', 'g'), '\\s+', ' ', 'g')), 1, 12)`;

  const query = `
    SELECT 'function' kind,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' obj,
           ${definitionDigest('pg_get_functiondef(p.oid)')} detail
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
        AND ${notExtensionOwned.replace('%OID%', 'p.oid').replace('%CATALOG%', 'pg_proc')}
    UNION ALL SELECT 'table', c.relname, '' FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND ${notExtensionOwned.replace('%OID%', 'c.oid').replace('%CATALOG%', 'pg_class')}
    UNION ALL SELECT 'policy', schemaname || '.' || tablename || ': ' || policyname,
           coalesce(qual, '') || ' | ' || coalesce(with_check, '') || ' | ' || array_to_string(roles, ',')
      FROM pg_policies WHERE schemaname IN ('public', 'storage')
    UNION ALL SELECT 'trigger', n.nspname || '.' || c.relname || ': ' || t.tgname,
           substr(md5(pg_get_triggerdef(t.oid)), 1, 12)
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'storage') AND NOT t.tgisinternal
    ORDER BY 1, 2, 3
  `;

  const result = cluster.query(query);
  if (result.status !== 0) {
    throw new Error(`catalog snapshot failed: ${result.stderr || result.stdout}`);
  }

  // psql runs with -tA, so rows are unaligned and pipe-separated. A policy's
  // qual can itself contain pipes, so split only on the FIRST two.
  const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
  const objects = [];
  for (const line of lines) {
    const first = line.indexOf('|');
    if (first < 0) continue;
    const second = line.indexOf('|', first + 1);
    if (second < 0) continue;
    objects.push({
      kind: line.slice(0, first).trim(),
      obj: line.slice(first + 1, second).trim(),
      detail: line.slice(second + 1).trim(),
    });
  }

  if (objects.length === 0) {
    throw new Error('catalog snapshot returned no rows — the substrate is never empty, so this is a query or parse failure, not a clean database');
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
  const beforeMap = new Map(before.map((e) => [key(e), e.detail ?? '']));
  const afterMap = new Map(after.map((e) => [key(e), e.detail ?? '']));

  // Present after rollback but not before it ran: the rollback failed to remove these.
  const leaked = [...afterMap.keys()].filter((k) => !beforeMap.has(k)).sort();
  // Present before but gone after: the rollback destroyed something it never created.
  const destroyed = [...beforeMap.keys()].filter((k) => !afterMap.has(k)).sort();
  // Present in both but DEFINED differently: the object was never removed, so a
  // name-and-signature comparison sees nothing, yet the rollback restored the
  // wrong implementation. This is the restore-in-place failure (migration 45).
  const redefined = [...beforeMap.keys()]
    .filter((k) => afterMap.has(k) && beforeMap.get(k) !== afterMap.get(k))
    .sort();

  if (leaked.length === 0 && destroyed.length === 0 && redefined.length === 0) return { ok: true };

  const lines = [];
  if (leaked.length > 0) {
    lines.push(`${leaked.length} object(s) the ROLLBACK failed to remove:`);
    for (const k of leaked) lines.push(`  + ${k.replace('|', ' ')}`);
  }
  if (destroyed.length > 0) {
    lines.push(`${destroyed.length} pre-existing object(s) the ROLLBACK destroyed (over-reach):`);
    for (const k of destroyed) lines.push(`  - ${k.replace('|', ' ')}`);
  }
  if (redefined.length > 0) {
    lines.push(`${redefined.length} object(s) still present but NOT restored to their prior definition:`);
    for (const k of redefined) {
      lines.push(`  ~ ${k.replace('|', ' ')} (was ${beforeMap.get(k) || '<none>'}, now ${afterMap.get(k) || '<none>'})`);
    }
  }

  return { ok: false, diff: lines.join('\n'), leaked, destroyed, redefined };
}
