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
 * Sort the elements of every `ARRAY[...]` literal in a definition string.
 *
 * `role = ANY (ARRAY['pending','farmer','ddp_admin'])` and
 * `role = ANY (ARRAY['ddp_admin','farmer','pending'])` are the SAME constraint.
 * PostgreSQL renders the elements in whatever order the DDL wrote them, so a
 * rollback that re-creates a CHECK with its values listed differently reports as
 * a redefinition when nothing about the admissible set changed. Migration 39's
 * rollback does exactly this to profiles_role_check.
 *
 * That false positive matters more than it looks. A gate that cries wolf on a
 * correct rollback is a gate someone eventually switches off, taking the true
 * positives with it — so the noise is a threat to the real findings, not just an
 * annoyance.
 *
 * Sorting is deliberately the ONLY normalisation. Set membership is the one place
 * where element order is provably not semantic; anywhere else — a CASE, an
 * ordered comparison, a function's argument list — order carries meaning and
 * canonicalising it would hide real changes. Nested brackets inside an element
 * (a subscript, a nested ARRAY) are left alone rather than mis-split: the
 * matcher only handles flat literals, which is what enum-style CHECKs are.
 *
 * Exported for test.
 */
export function normaliseArrayLiterals(detail) {
  if (!detail || !detail.includes('ARRAY[')) return detail;

  let out = '';
  let i = 0;
  while (i < detail.length) {
    const start = detail.indexOf('ARRAY[', i);
    if (start < 0) { out += detail.slice(i); break; }
    out += detail.slice(i, start + 'ARRAY['.length);

    // Walk to the matching close bracket, tracking single-quoted strings so a
    // literal containing '[' or ']' cannot end the scan early.
    let depth = 1, j = start + 'ARRAY['.length, inStr = false;
    while (j < detail.length && depth > 0) {
      const ch = detail[j];
      if (inStr) {
        // '' is an escaped quote inside a string, not a terminator.
        if (ch === "'" && detail[j + 1] === "'") j++;
        else if (ch === "'") inStr = false;
      } else if (ch === "'") inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
      j++;
    }
    if (depth !== 0) { out += detail.slice(start + 'ARRAY['.length); break; }

    const body = detail.slice(start + 'ARRAY['.length, j - 1);
    // Split on top-level commas only.
    const parts = [];
    let cur = '', d = 0, s = false;
    for (let k = 0; k < body.length; k++) {
      const ch = body[k];
      if (s) {
        if (ch === "'" && body[k + 1] === "'") { cur += "''"; k++; continue; }
        if (ch === "'") s = false;
      } else if (ch === "'") s = true;
      else if (ch === '[' || ch === '(') d++;
      else if (ch === ']' || ch === ')') d--;
      else if (ch === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);

    out += parts.map((p) => p.trim()).sort().join(', ') + ']';
    i = j;
  }
  return out;
}

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

    -- ========================================================================
    -- BELOW: object classes added 2026-08-04 (defect D7).
    --
    -- Everything above tracks objects that live in their own catalog row and
    -- have a name. That covered functions, tables, policies, triggers, RLS and
    -- privileges — and nothing else. A migration that added a CHECK constraint,
    -- an index, a NOT NULL, a column, or a column default produced a catalog
    -- snapshot IDENTICAL to the one before it ran, so its rollback could remove
    -- none of them and the symmetry check would still report success.
    --
    -- That is the difference between "the rollback did not leave a stray table"
    -- and "the rollback reversed the migration". Only the first was ever proven.
    -- ========================================================================

    -- Columns, with type, nullability and default. atttypid::regtype rather
    -- than format_type() so a domain reads as the domain, not its base type —
    -- a rollback that swaps a constrained domain for its underlying type is
    -- exactly the kind of near-miss this is here to catch. Dropped columns
    -- (attisdropped) are excluded: PostgreSQL keeps the tombstone forever, so
    -- including them would make every DROP COLUMN rollback look asymmetric.
    UNION ALL SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname,
           a.atttypid::regtype::text
             || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
             || coalesce(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname IN ('public', 'storage') AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND ${notExtensionOwned.replace('%OID%', 'c.oid').replace('%CATALOG%', 'pg_class')}

    -- Constraints: CHECK, UNIQUE, PRIMARY KEY, FOREIGN KEY and EXCLUDE alike.
    -- pg_get_constraintdef is the whole definition, so a CHECK whose predicate
    -- is weakened on rollback (>= 0 restored as > -1) is caught, not just one
    -- that disappears. Constraint NAMES are unstable for system-generated ones,
    -- so the key is table+name and the detail is the definition.
    UNION ALL SELECT 'constraint',
           n.nspname || '.' || c.relname || ': ' || con.conname,
           -- contype is "char", for which || has no unambiguous resolution;
           -- casting explicitly rather than relying on an implicit one.
           con.contype::text || ' ' || pg_get_constraintdef(con.oid)
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'storage')
        AND ${notExtensionOwned.replace('%OID%', 'c.oid').replace('%CATALOG%', 'pg_class')}

    -- Indexes. pg_get_indexdef covers uniqueness, method, columns, ordering,
    -- INCLUDE and the WHERE of a partial index. An index backing a constraint
    -- is intentionally still listed: dropping the constraint but leaving the
    -- index (or the reverse) is a real asymmetry, and the constraint branch
    -- above would not see it.
    UNION ALL SELECT 'index', n.nspname || '.' || ic.relname,
           pg_get_indexdef(i.indexrelid)
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_class tc ON tc.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace
      WHERE n.nspname IN ('public', 'storage')
        AND ${notExtensionOwned.replace('%OID%', 'tc.oid').replace('%CATALOG%', 'pg_class')}

    -- Views and materialised views. The 'table' branch above matches relkind
    -- r/p only, so a migration creating a view was invisible to it — and views
    -- are how this repo exposes filtered reads (procurement_decisions_current),
    -- which makes a leftover one a privilege leak, not a tidiness problem.
    UNION ALL SELECT 'view', n.nspname || '.' || c.relname,
           ${definitionDigest('pg_get_viewdef(c.oid)')}
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'storage') AND c.relkind IN ('v', 'm')
        AND ${notExtensionOwned.replace('%OID%', 'c.oid').replace('%CATALOG%', 'pg_class')}

    -- Sequences, including the identity/serial ones a CREATE TABLE makes
    -- implicitly. A rollback that drops a table but not its sequence leaves the
    -- next apply to fail on a name clash — reported today as a mystery.
    UNION ALL SELECT 'sequence', n.nspname || '.' || c.relname,
           s.seqtypid::regtype::text || ' inc ' || s.seqincrement || ' min ' || s.seqmin
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_sequence s ON s.seqrelid = c.oid
      WHERE n.nspname IN ('public', 'storage') AND c.relkind = 'S'
        AND ${notExtensionOwned.replace('%OID%', 'c.oid').replace('%CATALOG%', 'pg_class')}

    -- Enum types and their VALUES. Postgres cannot remove an enum label, so a
    -- migration that adds one is effectively irreversible — which is a fact the
    -- author should confront at review time rather than discover in production.
    -- Listing labels in sort order makes the addition visible as an asymmetry.
    UNION ALL SELECT 'type', n.nspname || '.' || t.typname,
           coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                       FROM pg_enum e WHERE e.enumtypid = t.oid), t.typtype::text)
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname IN ('public', 'storage')
        AND t.typtype IN ('e', 'd')
        AND ${notExtensionOwned.replace('%OID%', 't.oid').replace('%CATALOG%', 'pg_type')}
    ORDER BY 1, 2, 3
  `;

  const result = cluster.query(query);
  if (result.status !== 0) {
    throw new Error(`catalog snapshot failed: ${result.stderr || result.stdout}`);
  }

  // See normaliseArrayLiterals — applied to every detail, because a CHECK is not
  // the only definition PostgreSQL may render with a reordered ARRAY literal.

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
      detail: normaliseArrayLiterals(line.slice(second + 1).trim()),
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

  // The before/after definition of every reported key, so a caller can decide
  // whether a specific asymmetry is the one it already knows about. Without this
  // an allowlist could only match on object NAME, which would waive any future
  // change to that object as well — far too blunt for a check whose value is
  // that it notices small differences.
  const details = {};
  for (const k of [...leaked, ...destroyed, ...redefined]) {
    details[k] = { was: beforeMap.get(k) ?? null, now: afterMap.get(k) ?? null };
  }

  return { ok: false, diff: lines.join('\n'), leaked, destroyed, redefined, details };
}
