#!/usr/bin/env node
// backup.mjs — take an encrypted, verifiable snapshot of every storage bucket.
//
// WHY THIS EXISTS
// ---------------
// Supabase's own Backups page states it plainly: "Storage objects are not
// included. Restoring an old backup does not restore objects that have been
// deleted since then." The database is backed up daily; the lab certificates,
// cultivation licences and farm photos are not backed up at all. For a platform
// whose product is "here is the evidence this batch was tested", those files are
// the product. This closes defect D4.
//
// The database cannot schedule this — the project has no pg_cron — so the clock
// lives in GitHub Actions (.github/workflows/storage-backup.yml).
//
// Usage:
//   node scripts/storage-backup/backup.mjs --out backup.ddpbak [--allow-empty]
//                                          [--previous prev-manifest.json]
// Environment:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKUP_PASSPHRASE
//
// Exit codes: 0 ok · 2 bad usage/env · 3 transfer failure · 4 implausible result

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { buildManifest, assertPlausible, verifyRestore } from './lib/manifest.mjs';
import { pack, encrypt, decrypt, unpack } from './lib/archive.mjs';
import { makeClient, downloadAll, DEFAULT_BUCKETS } from './lib/storage.mjs';

const EXIT = { OK: 0, USAGE: 2, TRANSFER: 3, IMPLAUSIBLE: 4 };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);
const log = (m) => process.stdout.write(`${m}\n`);

async function main() {
  const out = arg('out');
  if (!out) {
    process.stderr.write('usage: backup.mjs --out <file> [--allow-empty] [--previous <manifest.json>]\n');
    process.exit(EXIT.USAGE);
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKUP_PASSPHRASE } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BACKUP_PASSPHRASE) {
    process.stderr.write(
      'missing environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and BACKUP_PASSPHRASE are all required.\n' +
      'The service-role key is needed because these buckets are private (migration 37) and the anon key\n' +
      'cannot read them; the passphrase is what keeps the archive from being a plaintext copy of farmer\n' +
      'identity documents.\n',
    );
    process.exit(EXIT.USAGE);
  }

  const buckets = (arg('buckets') || DEFAULT_BUCKETS.join(',')).split(',').map((b) => b.trim()).filter(Boolean);
  const takenAt = new Date().toISOString();

  log(`Storage backup — ${buckets.length} bucket(s), ${takenAt}`);

  let objects;
  try {
    objects = await downloadAll(makeClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), buckets, log);
  } catch (err) {
    process.stderr.write(`TRANSFER FAILED: ${err.message}\n`);
    process.exit(EXIT.TRANSFER);
  }

  const manifest = buildManifest(objects, { takenAt, buckets });
  log(`  total: ${manifest.objectCount} object(s), ${manifest.totalBytes} bytes`);

  // Compare against the previous run before declaring success. A backup that
  // captured nothing, or half of what it captured yesterday, is the failure this
  // whole exercise exists to prevent — and it is the one that looks like success.
  const previousPath = arg('previous');
  const previous = previousPath && existsSync(previousPath)
    ? JSON.parse(readFileSync(previousPath, 'utf8'))
    : null;
  if (previousPath && !previous) log(`  (no previous manifest at ${previousPath} — first run)`);

  const plausible = assertPlausible(manifest, previous, { allowEmpty: flag('allow-empty') });
  if (!plausible.ok) {
    process.stderr.write(`REFUSING TO RECORD THIS AS A BACKUP:\n  - ${plausible.problems.join('\n  - ')}\n`);
    process.exit(EXIT.IMPLAUSIBLE);
  }

  const container = encrypt(pack(objects, manifest), BACKUP_PASSPHRASE);

  // Read the archive back and verify it against the manifest BEFORE writing it
  // out as the day's backup. Every backup is therefore also a restore test, on
  // the real bytes, every single day — rather than an operation nobody exercises
  // until the day it matters. It costs a decrypt and some hashing.
  const roundTrip = verifyRestore(manifest, unpack(decrypt(container, BACKUP_PASSPHRASE)).objects);
  if (!roundTrip.ok) {
    process.stderr.write(`ARCHIVE FAILED ITS OWN RESTORE CHECK — not writing it:\n${roundTrip.diff}\n`);
    process.exit(EXIT.TRANSFER);
  }
  log('  ✓ archive decrypts and every object verifies against the manifest');

  writeFileSync(out, container);
  writeFileSync(`${out}.manifest.json`, JSON.stringify(manifest, null, 2));
  log(`  wrote ${out} (${container.length} bytes) and ${out}.manifest.json`);
  process.exit(EXIT.OK);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(EXIT.TRANSFER);
});
