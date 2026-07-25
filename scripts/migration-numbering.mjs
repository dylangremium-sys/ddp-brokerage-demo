// Migration numbering integrity — pure predicates (no filesystem, no process).
//
// WHY THIS EXISTS
// ---------------
// Root migration files are ordered by a leading integer. Two independent
// branches can each claim the same next number, and neither branch's CI notices
// because each is internally consistent — the clash only exists in the union.
// That is exactly what happened with migration 25: `main` carried
// 25_WATCHTOWER_INGESTION_PROVENANCE_* while an open PR carried
// 25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_*. Merging would have produced two
// unrelated migrations sharing an ordinal, so "apply migrations in order" would
// no longer name a single well-defined sequence.
//
// These predicates are extracted from the gate script so they can be NEGATIVELY
// tested: a check that only ever runs against a passing corpus proves nothing
// about whether it would catch a real clash.

/**
 * Role suffixes a migration's companion files may carry. Order matters only in
 * that the LONGEST match must win (ACL_FIX before FIX, DRIFT_CHECK before CHECK),
 * so callers must not reorder this casually.
 *
 * Exactly ONE trailing role suffix is stripped. Stripping more than one would
 * collapse 8_COA_UPLOAD_STORAGE_MIGRATION past its real stem
 * (COA_UPLOAD_STORAGE) into COA_UPLOAD.
 */
export const ROLE_SUFFIXES = Object.freeze([
  'DRIFT_CHECK',
  'ACL_FIX',
  'HARDENING',
  'ROLLBACK',
  'MIGRATION',
  'STORAGE',
  'VERIFY',
  'MVP',
])

const NUMBERED_SQL_RE = /^(\d+)_(.+)\.sql$/i

/**
 * Split a root migration filename into its ordinal and its migration stem.
 *
 * The stem is the migration's identity: every companion of one migration must
 * reduce to the same stem, and two different migrations must not.
 *
 * @param {string} filename e.g. '24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql'
 * @returns {{number: number, prefix: string, stem: string, file: string} | null}
 *          null when the filename is not a numbered root migration.
 */
export function parseMigrationFilename(filename) {
  const matched = NUMBERED_SQL_RE.exec(filename)
  if (matched === null) return null

  const prefix = matched[1]
  const body = matched[2].toUpperCase()

  let stem = body
  for (const suffix of ROLE_SUFFIXES) {
    const tail = `_${suffix}`
    if (body.length > tail.length && body.endsWith(tail)) {
      stem = body.slice(0, -tail.length)
      break
    }
  }

  return { number: Number(prefix), prefix, stem, file: filename }
}

/** @param {string[]} filenames */
function parseAll(filenames) {
  return filenames.map(parseMigrationFilename).filter((entry) => entry !== null)
}

/** Group parsed entries by a key selector into a Map<key, entry[]>. */
function groupBy(entries, selectKey) {
  const grouped = new Map()
  for (const entry of entries) {
    const key = selectKey(entry)
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [entry])
    else bucket.push(entry)
  }
  return grouped
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

/**
 * COLLISION — one ordinal claimed by two or more distinct migrations.
 *
 * This is the hard failure the gate exists for. Companions of a single
 * migration (HARDENING / VERIFY / ROLLBACK / ...) share an ordinal legitimately
 * and are NOT a collision, because they reduce to one stem.
 *
 * @param {string[]} filenames root-directory filenames
 * @returns {Array<{number: number, stems: string[], files: string[]}>}
 */
export function findNumberCollisions(filenames) {
  const collisions = []
  for (const [number, entries] of groupBy(parseAll(filenames), (e) => e.number)) {
    const stems = sortedUnique(entries.map((e) => e.stem))
    if (stems.length > 1) {
      collisions.push({ number, stems, files: sortedUnique(entries.map((e) => e.file)) })
    }
  }
  return collisions.sort((a, b) => a.number - b.number)
}

/**
 * SPLIT — one migration's companions spread across two ordinals.
 *
 * This is the signature of a half-finished renumbering: HARDENING moved to 27
 * but VERIFY left behind at 25. It is a distinct defect from a collision and is
 * not implied by it.
 *
 * Some stem reuse across ordinals is deliberate — a later corrective migration
 * that fixes an earlier one keeps the earlier name on purpose (19
 * FARM_ADMIN_FIELD_GUARD and its 20 ACL_FIX; 12 PUBLIC_FUNCTION_EXECUTE and its
 * 13 DRIFT_CHECK). Those pairs must be declared in `allowedSplits`; adding an
 * entry is a deliberate act, not a way to silence the gate.
 *
 * @param {string[]} filenames
 * @param {{allowedSplits?: Record<string, number[]>}} [options]
 * @returns {Array<{stem: string, numbers: number[], files: string[]}>}
 */
export function findMigrationSplits(filenames, { allowedSplits = {} } = {}) {
  const splits = []
  for (const [stem, entries] of groupBy(parseAll(filenames), (e) => e.stem)) {
    const numbers = [...new Set(entries.map((e) => e.number))].sort((a, b) => a - b)
    if (numbers.length < 2) continue

    const allowed = allowedSplits[stem]
    if (Array.isArray(allowed) && numbers.every((n) => allowed.includes(n))) continue

    splits.push({ stem, numbers, files: sortedUnique(entries.map((e) => e.file)) })
  }
  return splits.sort((a, b) => (a.stem < b.stem ? -1 : 1))
}

/**
 * PADDING DRIFT — one ordinal written two ways (`7_` and `07_`).
 *
 * Both sort to the same number numerically but to different places
 * lexicographically, so "apply in filename order" and "apply in numeric order"
 * stop agreeing. Cheap to detect, silent and confusing if missed.
 *
 * @param {string[]} filenames
 * @returns {Array<{number: number, prefixes: string[]}>}
 */
export function findPaddingInconsistencies(filenames) {
  const drifted = []
  for (const [number, entries] of groupBy(parseAll(filenames), (e) => e.number)) {
    const prefixes = sortedUnique(entries.map((e) => e.prefix))
    if (prefixes.length > 1) drifted.push({ number, prefixes })
  }
  return drifted.sort((a, b) => a.number - b.number)
}

/**
 * The next free ordinal — what a new migration should claim.
 * @param {string[]} filenames
 * @returns {number}
 */
export function nextAvailableNumber(filenames) {
  const numbers = parseAll(filenames).map((entry) => entry.number)
  if (numbers.length === 0) return 1
  return Math.max(...numbers) + 1
}
