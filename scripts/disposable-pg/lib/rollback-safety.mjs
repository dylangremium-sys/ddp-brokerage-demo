// Static check for rollback create/drop symmetry.
//
// For each migration number at or above TRIPLET_FLOOR, verifies that every
// function and table created by the HARDENING file is mentioned in the ROLLBACK file.
// This catches Defect A (dropped wrong names) but not Defect B (wrong signatures);
// use the behavioral snapshot check (rollback-symmetry.mjs) for full coverage.

import { readFileSync } from 'node:fs';

/** Remove `--` line comments and block comments before pattern matching.
 *  Without this, prose that mentions a statement is matched as one: migration 49
 *  carries the comment "`DROP FUNCTION IF EXISTS` must match the signature", and
 *  a scanner that reads it as a statement swallows the real DROP that follows
 *  and reports the function as never dropped.
 *
 *  Heuristic, and deliberately so: a `--` inside a string literal or a
 *  dollar-quoted function body is stripped too. That can only cause this check
 *  to see FEWER statements, never to invent one, so it cannot manufacture a pass. */
function stripSqlComments(sqlText) {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Extract all identifiers that look like function or table names from SQL text.
 *  Returns a Set of names created by CREATE FUNCTION, CREATE TABLE, etc.
 *  Heuristic: look for CREATE (OR REPLACE)? (FUNCTION|TABLE) followed by identifier. */
function extractCreatedObjects(sqlText) {
  const objects = new Set();
  
  // PostgreSQL puts IF NOT EXISTS AFTER the object keyword — `CREATE TABLE IF
  // NOT EXISTS foo`, never `CREATE IF NOT EXISTS TABLE foo`. Matching it before
  // the keyword captures the literal word "if" as the object name, which then
  // fails every migration for the same phantom object.
  const patterns = [
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\s*\.\s*)?"?(\w+)"?\s*\(/gi,
    /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\s*\.\s*)?"?(\w+)"?/gi,
  ];
  
  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(sqlText)) !== null) {
      objects.add(match[1].toLowerCase());
    }
  }
  
  return objects;
}

/** Extract all identifiers mentioned in DROP statements.
 *  Returns a Set of names dropped by DROP FUNCTION, DROP TABLE, etc. */
function extractDroppedObjects(sqlText) {
  const objects = new Set();
  
  // A ROLLBACK may drop several objects in one statement
  // (`DROP TABLE IF EXISTS a, b, c CASCADE;`), so capture the whole target list
  // and split it, rather than only the first name.
  const patterns = [
    /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([^;]+);/gi,
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+);/gi,
  ];

  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(sqlText)) !== null) {
      // Strip argument lists BEFORE splitting on commas — otherwise the commas
      // inside `ai_create_audit_event(TEXT, TEXT, UUID, ...)` split one function
      // into fragments and the name is never recorded as dropped.
      const targets = match[1].replace(/\([^)]*\)/g, ' ');
      for (const target of targets.split(',')) {
        const name = target
          .replace(/\b(CASCADE|RESTRICT)\b/gi, ' ')
          .replace(/^\s*(?:public\s*\.\s*)?/, '')
          .replace(/"/g, '')
          .trim();
        if (/^\w+$/.test(name)) objects.add(name.toLowerCase());
      }
    }
  }

  return objects;
}


/**
 * Check that every created object appears in the drop list (static name check).
 * Returns { ok: true } or { ok: false, missing: [names] }
 */
function checkSymmetryByName(created, dropped) {
  const missing = [];
  for (const obj of created) {
    if (!dropped.has(obj)) {
      missing.push(obj);
    }
  }
  
  if (missing.length === 0) {
    return { ok: true };
  }
  return { ok: false, missing: missing.sort() };
}

/**
 * For a migration number, read HARDENING and ROLLBACK files and check symmetry.
 * Returns { ok: true } or { ok: false, reason: string }
 */
export function checkMigrationSymmetry(migrationNumber, hardeningPath, rollbackPath) {
  try {
    const hardening = readFileSync(hardeningPath, 'utf8');
    const rollback = readFileSync(rollbackPath, 'utf8');
    
    const rollbackText = stripSqlComments(rollback);

    const created = extractCreatedObjects(stripSqlComments(hardening));
    const dropped = extractDroppedObjects(rollbackText);
    // When a migration REPLACES a function that already existed, the correct
    // rollback restores the previous definition with CREATE OR REPLACE rather
    // than dropping it — dropping would delete an object the migration never
    // created. Migrations 21, 29 and 45 all do this. Treat a restored object as
    // reversed: the catalog returns to its pre-apply state either way.
    const restored = extractCreatedObjects(rollbackText);
    const reversed = new Set([...dropped, ...restored]);

    const check = checkSymmetryByName(created, reversed);
    if (!check.ok) {
      return {
        ok: false,
        reason: `functions/tables created but neither dropped nor restored: ${check.missing.join(', ')}`,
      };
    }
    
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `error reading files: ${err.message}` };
  }
}

/**
 * Format results for reporting.
 */
export function formatRollbackSafetyReport(results) {
  const lines = [];
  const failures = results.filter((r) => !r.ok);
  
  if (failures.length === 0) {
    lines.push('✓ All migrations have symmetric create/drop names');
    return lines.join('\n');
  }
  
  lines.push(`✗ ${failures.length} migration(s) have missing drops:`);
  for (const fail of failures) {
    lines.push(`  migration ${fail.number}: ${fail.reason}`);
  }
  
  lines.push(
    '\nNOTE: This is a static NAME check only. A correct name with wrong signature',
    'will still pass this check but fail the behavioral snapshot test.'
  );
  
  return lines.join('\n');
}
