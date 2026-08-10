#!/usr/bin/env node
// Deploy preflight: does the TARGET database already contain everything the code
// about to ship will ask for?
//
//   PREFLIGHT_DATABASE_URL=... node scripts/deploy-preflight/check-schema-contract.mjs
//
// Exit 0  every relation the app references exists.
// Exit 75 at least one is missing — deploying would ship code the database
//         cannot serve. Apply the migration that creates it FIRST.
// Exit 50 environment problem (no URL, no psql, unreadable source tree).
//
// Read-only. It issues one SELECT against the catalog and writes nothing, so it
// is safe to point at production — and pointing it at production is the entire
// use case.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanRequiredTables, missingTables } from './schema-contract.mjs';

const EXIT = Object.freeze({ OK: 0, ENV: 50, MISSING: 75 });
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SOURCE_DIRS = ['src', 'api'];

// Tests describe databases that do not exist and are never deployed; including
// them would make the preflight fail on fixtures rather than on the product.
const SKIP = /\.(test|spec)\.(ts|tsx|js|mjs)$/;

function collectSourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules') walk(full);
      } else if (/\.(ts|tsx)$/.test(entry) && !SKIP.test(entry)) {
        out.push({ path: relative(REPO_ROOT, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

function main() {
  const url = process.env.PREFLIGHT_DATABASE_URL;
  if (!url) {
    process.stderr.write(
      'PREFLIGHT_DATABASE_URL is not set. Point it at the database you are about to deploy\n'
      + 'against — production for a production deploy. A read-only role is sufficient.\n',
    );
    process.exit(EXIT.ENV);
  }

  const files = SOURCE_DIRS
    .map((d) => join(REPO_ROOT, d))
    .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
    .flatMap(collectSourceFiles);

  if (files.length === 0) {
    process.stderr.write(`No source files found under ${SOURCE_DIRS.join(', ')}.\n`);
    process.exit(EXIT.ENV);
  }

  const required = scanRequiredTables(files);
  process.stdout.write(
    `Deploy preflight: ${files.length} source file(s) reference ${required.length} relation(s).\n`,
  );

  // pg_class rather than information_schema: information_schema.tables shows only
  // relations the connecting role holds a privilege on, so a read-only role would
  // report a table as ABSENT when it is merely not granted — the preflight would
  // then block a deploy that was fine. The catalog is visible to everyone.
  const psql = process.env.PSQL_BIN || 'psql';
  const q = "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
          + "WHERE n.nspname='public' AND c.relkind IN ('r','v','m','f','p');";
  const res = spawnSync(psql, [url, '-tAc', q], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    process.stderr.write(`Could not query the target database: ${res.error?.message || res.stderr}\n`);
    process.exit(EXIT.ENV);
  }
  const present = new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean));

  const missing = missingTables(required, present);
  if (missing.length === 0) {
    process.stdout.write(
      `All ${required.length} relation(s) exist in the target database. Safe to deploy.\n`,
    );
    process.exit(EXIT.OK);
  }

  process.stdout.write(
    `\nDEPLOY WOULD BREAK: ${missing.length} relation(s) the code requires do NOT exist in the\n`
    + 'target database. Apply the migration that creates them BEFORE deploying.\n\n',
  );
  for (const m of missing) {
    process.stdout.write(`  MISSING  ${m.table}\n`);
    for (const site of m.sites) process.stdout.write(`             referenced by ${site}\n`);
  }
  process.stdout.write('\n');
  process.exit(EXIT.MISSING);
}

main();
