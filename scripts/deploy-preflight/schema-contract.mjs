// What the shipped application requires the database to already contain.
//
// WHY THIS EXISTS
// PR #143 merged, together, a migration creating `batch_internal_notes` and the
// application code that reads it. The code reached `main`; the migration reached
// no database. Production still has neither the table nor any check that would
// have noticed — and `loadInventoryFromDB` throws rather than degrading, so the
// first deploy after that merge takes the inventory page down.
//
// Nothing in CI can catch this. CI has the migration, so CI is always consistent
// with itself. The disagreement is between the code being deployed and the
// database it is being deployed AGAINST, and that only exists at deploy time.
//
// So this is a preflight, not a test: point it at the target database, and it
// answers one question — does this database already contain everything the code
// I am about to ship will ask for?

// PostgREST reaches related rows by embedding them inside a select string:
//   .select('*, farms(farm_name), batch_internal_notes(note)')
// Each embedded name is a relation the request touches, exactly like .from().
// Missing one is not a missing FIELD — PostgREST rejects the whole query, so the
// caller gets nothing rather than a partial row.
const FROM_CALL = /\.from\(\s*'([a-z_][a-z0-9_]*)'\s*\)/g;
const SELECT_CALL = /\.select\(\s*'([^']*)'/g;
const EMBEDDED = /(?:^|[,\s(])([a-z_][a-z0-9_]*)\s*\(/g;

// Names that appear in embedded position but are PostgREST syntax or aggregate
// helpers rather than relations. Kept explicit: a silent skip list is how a real
// missing table would hide.
const NOT_RELATIONS = new Set(['count', 'sum', 'avg', 'min', 'max', 'and', 'or', 'not']);

/**
 * @param {{path: string, text: string}[]} files
 * @returns {{table: string, sites: string[]}[]} sorted by table name
 */
export function scanRequiredTables(files) {
  /** @type {Map<string, Set<string>>} */
  const found = new Map();
  const record = (table, path) => {
    if (NOT_RELATIONS.has(table)) return;
    if (!found.has(table)) found.set(table, new Set());
    found.get(table).add(path);
  };

  for (const { path, text } of files) {
    for (const m of text.matchAll(FROM_CALL)) record(m[1], path);
    for (const sel of text.matchAll(SELECT_CALL)) {
      for (const emb of sel[1].matchAll(EMBEDDED)) record(emb[1], path);
    }
  }

  return [...found.entries()]
    .map(([table, sites]) => ({ table, sites: [...sites].sort() }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * @param {{table: string, sites: string[]}[]} required
 * @param {Set<string>} present  relations that exist in the target database
 */
export function missingTables(required, present) {
  return required.filter((r) => !present.has(r.table));
}
