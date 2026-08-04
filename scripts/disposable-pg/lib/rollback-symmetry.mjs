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

  // A grantee of 0 is the pseudo-role PUBLIC, which `::regrole` renders as '-'.
  // Spelling it out matters: "PUBLIC still holds EXECUTE" is the finding these
  // migrations exist to prevent, and '-' reads like an absence.
  const granteeName = (col) => `CASE WHEN ${col} = 0 THEN 'PUBLIC' ELSE ${col}::regrole::text END`;

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

    -- Row-level security is a per-table BOOLEAN, not an object, so nothing above
    -- can see it. Migration 51 consists almost entirely of
    -- "ALTER TABLE ... ENABLE ROW LEVEL SECURITY" and creates no catalog object
    -- at all: without this branch its fixture would compare an unchanged catalog
    -- to itself and pass having proved nothing.
    UNION ALL SELECT 'rls', n.nspname || '.' || c.relname,
           CASE WHEN c.relrowsecurity THEN 'enabled' ELSE 'disabled' END
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'storage') AND c.relkind IN ('r', 'p')
        AND ${notExtensionOwned.replace('%OID%', 'c.oid').replace('%CATALOG%', 'pg_class')}

    -- Privileges. Migrations 12, 14 and 15 REVOKE and GRANT and create no object
    -- whatsoever, so to an object-only snapshot their rollbacks are invisible and
    -- a fixture for them would pass vacuously. A rollback that restores the
    -- structure but leaves EXECUTE granted to PUBLIC has not reversed anything
    -- that mattered.
    --
    -- Every ACL is normalised through coalesce(acl, acldefault(...)) because a
    -- NULL acl does not mean "no privileges" — it means "the built-in defaults",
    -- which for a function include EXECUTE to PUBLIC. Comparing the stored
    -- representation instead of the effective grants reports a rollback that
    -- restored the right permissions as broken: migration 11 REVOKEs EXECUTE
    -- from PUBLIC on a trigger-only guard (turning NULL into an explicit acl) and
    -- its rollback GRANTs it back, ending at an explicit acl that is
    -- byte-different from NULL and privilege-identical to it. Without the
    -- normalisation that correct rollback failed with two phantom leaked grants.
    UNION ALL SELECT 'grant',
           'table ' || n.nspname || '.' || c.relname || ' -> ' || ${granteeName('a.grantee')},
           string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
           LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname IN ('public', 'storage') AND c.relkind IN ('r', 'p', 'v')
        AND ${notExtensionOwned.replace('%OID%', 'c.oid').replace('%CATALOG%', 'pg_class')}
      GROUP BY 1, 2
    UNION ALL SELECT 'grant',
           'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> '
             || ${granteeName('a.grantee')},
           string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
           LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
        AND ${notExtensionOwned.replace('%OID%', 'p.oid').replace('%CATALOG%', 'pg_proc')}
      GROUP BY 1, 2
    UNION ALL SELECT 'grant',
           'schema ' || n.nspname || ' -> ' || ${granteeName('a.grantee')},
           string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type)
      FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE n.nspname IN ('public', 'storage', 'auth', 'extensions')
      GROUP BY 1, 2

    -- Default privileges are what migration 14 hardens: they govern objects that
    -- do not exist yet, so they leave no trace on any present object. Dropping a
    -- pg_default_acl entry silently re-opens every table created afterwards.
    UNION ALL SELECT 'default_acl',
           coalesce(dn.nspname, '-') || ':' || d.defaclrole::regrole::text || ':'
             || d.defaclobjtype::text || ' -> ' || ${granteeName('a.grantee')},
           string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type)
      FROM pg_default_acl d
      LEFT JOIN pg_namespace dn ON dn.oid = d.defaclnamespace,
           LATERAL aclexplode(d.defaclacl) a
      GROUP BY 1, 2
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
