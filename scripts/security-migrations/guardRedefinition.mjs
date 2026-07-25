// Fail-closed detection of a farm admin-field guard DOWNGRADE (DDP audit A1/F2).
//
// public.fn_protect_farm_admin_fields() is the trigger function that stops a
// farmer self-certifying admin-controlled columns (status, compliance_status,
// risk_level, partner_tier, reviewed_by) or spoofing created_by, on INSERT and
// UPDATE. Its ONE canonical definition is 19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql
// (validated field-by-field elsewhere in the gate).
//
// The DDP audit found that a *second* file could `CREATE OR REPLACE` the same
// function with a weaker body (e.g. the invalid `role = 'admin'` literal that is
// always false, or a BEFORE UPDATE-only trigger that drops INSERT coverage) and
// the static gate would NOT catch it — it only validated the canonical file's
// body and scanned for EXECUTE re-grants, never for a divergent redefinition.
//
// This module closes that hole: any root *.sql that redefines the guard, other
// than the canonical file, must be an explicitly-quarantined draft carrying the
// exemption token (already confined to the known drafts by the token check). A
// redefinition anywhere else — a new migration, or a draft that lost its token —
// is a downgrade hazard and fails the gate.

/** Strip block and line comments so guard prose is never read as code. */
export function stripSqlComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

// Matches a real CREATE [OR REPLACE] FUNCTION of the guard (optional `public.`
// qualifier), not a REVOKE/DROP/GRANT/trigger reference to it.
const CREATE_GUARD_RE =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?fn_protect_farm_admin_fields\s*\(/i

/** True iff the SQL text DEFINES (creates) the guard function. */
export function definesFarmGuard(sqlBody) {
  return CREATE_GUARD_RE.test(stripSqlComments(sqlBody))
}

/**
 * Given the SQL corpus, return the names of files that redefine the guard but
 * are NOT the canonical file and do NOT carry the exemption token. A non-empty
 * result is a downgrade hazard the gate must reject.
 *
 * @param {Array<{name: string, body: string}>} files
 * @param {{ canonicalFile: string, exemptionToken: string }} opts
 * @returns {string[]} offending file names
 */
// ─── handle_new_user replay downgrade (DDP audit A2) ────────────────────────
//
// Migration 21 changed handle_new_user() to mint the NON-OPERATIONAL 'pending'
// role, closing anonymous self-provisioning (an anon signup previously became a
// working 'farmer'). Two older files still define it with the 'farmer' default;
// re-running either AFTER migration 21 silently reverts the hardened definition.
// Ordering rests only on filename numbering, with nothing recording applied
// state — so each such definition must carry an executable guard that refuses
// when the hardened version is installed. Migration 21's OWN rollback is exempt:
// restoring 'farmer' is its documented purpose, and it carries its own ordering
// and pending-row guards.

const CREATE_HANDLE_NEW_USER_RE =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?handle_new_user\s*\(/i

// The role a definition MINTS must be read from the function body only. Reading
// the whole file would false-positive on migration 21's hardening, whose CHECK
// constraint legitimately lists 'farmer' while handle_new_user mints 'pending'.
const HANDLE_NEW_USER_BODY_RE =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?handle_new_user[\s\S]*?\$\$[\s\S]*?\$\$\s*;/i

export function extractHandleNewUserBody(sqlCode) {
  const bodyMatch = sqlCode.match(HANDLE_NEW_USER_BODY_RE)
  return bodyMatch ? bodyMatch[0] : null
}

/** True iff the SQL executably refuses a downgrade (detects the hardened fn and RAISEs). */
export function hasHandleNewUserDowngradeGuard(sql) {
  const code = stripSqlComments(sql)
  return /proname\s*=\s*'handle_new_user'/i.test(code) &&
    /'%''pending''%'|pending/i.test(code) &&
    /raise\s+exception/i.test(code)
}

/**
 * Files that define handle_new_user minting the weaker 'farmer' default without a
 * downgrade guard.
 * @param {Array<{name: string, body: string}>} files
 * @param {{ allowedRollbackFile?: string }} [opts]
 * @returns {string[]} offending file names
 */
export function findUnguardedHandleNewUserDowngrades(files, { allowedRollbackFile } = {}) {
  const offenders = []
  for (const { name, body } of files) {
    if (name === allowedRollbackFile) continue
    const code = stripSqlComments(body)
    if (!CREATE_HANDLE_NEW_USER_RE.test(code)) continue
    // Only definitions whose FUNCTION BODY mints the operational 'farmer' role
    // are a downgrade — scoped to the body, not the whole file.
    const fnBody = extractHandleNewUserBody(code)
    if (!fnBody || !/'farmer'/i.test(fnBody)) continue
    if (hasHandleNewUserDowngradeGuard(body)) continue
    offenders.push(name)
  }
  return offenders
}

export function findUnexpectedGuardRedefinitions(files, { canonicalFile, exemptionToken }) {
  const offenders = []
  for (const { name, body } of files) {
    if (name === canonicalFile) continue
    if (!definesFarmGuard(body)) continue
    if (typeof exemptionToken === 'string' && exemptionToken && body.includes(exemptionToken)) continue
    offenders.push(name)
  }
  return offenders
}
