// Fail-closed detection of SECURITY DEFINER functions with a MUTABLE search_path
// (DDP audit F1).
//
// A SECURITY DEFINER function runs with the privileges of its owner. If its
// search_path is not pinned, a caller can create an object (e.g. in a temp schema)
// that shadows an unqualified name used inside the function body, and have that
// object executed as the function owner — a classic privilege-escalation vector.
//
// The audit found such functions in the unnumbered baseline files
// (AUTH_RLS_SCHEMA.sql, FARMER_MVP_SECURITY_PATCH.sql). Their live definitions are
// superseded by 3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql, so the applied
// end-state is safe — but replaying a baseline file after migration 3 would
// silently strip the pinned search_path and re-open the vector. This check makes
// any such definition fail CI.
//
// Excluded: *_VERIFY.sql (throwaway BEGIN/ROLLBACK test scaffolding) and files
// carrying the draft exemption token (already quarantined by the token checks).

/** Strip block and line comments so prose is never read as code. */
export function stripSqlComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

// A function's OPTION list (LANGUAGE / SECURITY / SET / volatility) always precedes
// the `AS <body>` clause, so the header is everything from CREATE FUNCTION up to the
// first `AS`. Matching lazily keeps each function's header separate.
const FUNCTION_HEADER_RE = /create\s+(?:or\s+replace\s+)?function\s+([\s\S]*?)\bas\b/gi

/**
 * @param {Array<{name: string, body: string}>} files
 * @param {{ exemptionToken?: string }} [opts]
 * @returns {Array<{file: string, fn: string}>} definer functions lacking a pinned search_path
 */
export function findMutableSearchPathDefiners(files, { exemptionToken } = {}) {
  const offenders = []
  for (const { name, body } of files) {
    if (/VERIFY\.sql$/i.test(name)) continue
    if (exemptionToken && body.includes(exemptionToken)) continue
    const sql = stripSqlComments(body)
    FUNCTION_HEADER_RE.lastIndex = 0
    // `for` (not `while`) so the two `continue`s below still advance the regex.
    for (let match = FUNCTION_HEADER_RE.exec(sql); match !== null; match = FUNCTION_HEADER_RE.exec(sql)) {
      const header = match[1]
      if (!/security\s+definer/i.test(header)) continue
      if (/set\s+search_path/i.test(header)) continue
      const fn = (header.match(/^\s*(?:public\.)?([a-z0-9_]+)\s*\(/i) || [])[1] || '<unnamed>'
      offenders.push({ file: name, fn })
    }
  }
  return offenders
}
