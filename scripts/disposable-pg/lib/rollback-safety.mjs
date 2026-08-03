// Static check for rollback create/drop symmetry.
//
// For each migration number at or above TRIPLET_FLOOR, verifies that every
// function and table created by the HARDENING file is mentioned in the ROLLBACK file.
// This catches Defect A (dropped wrong names) but not Defect B (wrong signatures);
// use the behavioral snapshot check (rollback-symmetry.mjs) for full coverage.

import { readFileSync } from 'node:fs';

/** Extract all identifiers that look like function or table names from SQL text.
 *  Returns a Set of names created by CREATE FUNCTION, CREATE TABLE, etc.
 *  Heuristic: look for CREATE (OR REPLACE)? (FUNCTION|TABLE) followed by identifier. */
function extractCreatedObjects(sqlText) {
  const objects = new Set();
  
  // Match: CREATE [OR REPLACE] FUNCTION <name> or CREATE [IF NOT EXISTS] TABLE <name>
  const patterns = [
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi,
    /CREATE\s+(?:IF\s+NOT\s+EXISTS\s+)?TABLE\s+(?:public\.)?(\w+)/gi,
  ];
  
  for (const pattern of patterns) {
    let match;
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
  
  // Match: DROP FUNCTION [IF EXISTS] <name> or DROP TABLE [IF EXISTS] <name>
  const patterns = [
    /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(\w+)\s*[\(;]/gi,
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)/gi,
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(sqlText)) !== null) {
      objects.add(match[1].toLowerCase());
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
    
    const created = extractCreatedObjects(hardening);
    const dropped = extractDroppedObjects(rollback);
    
    const check = checkSymmetryByName(created, dropped);
    if (!check.ok) {
      return {
        ok: false,
        reason: `functions/tables created but not dropped: ${check.missing.join(', ')}`,
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
