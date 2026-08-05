#!/usr/bin/env node
// restore.mjs — put the bytes back, and prove they are the right bytes.
//
// "The acceptance test for D4 is a restore, not a backup. A backup that has
// never been restored is not a backup." — the remediation plan, and the reason
// this file is not an afterthought.
//
// Three modes, deliberately separate:
//
//   --verify            decrypt and check every object against the manifest.
//                       Touches no Supabase project. This is what CI runs, and
//                       what you run at 3am before trusting an archive.
//
//   --extract <dir>     write the objects to a local directory. For inspecting
//                       or hand-restoring a single lost file, which is the
//                       common case — one deleted certificate, not a lost bucket.
//
//   --upload            upload into a Supabase project. Requires --i-understand
//                       because this writes to a live system.
//
// Usage:
//   node scripts/storage-backup/restore.mjs <archive> --verify
//   node scripts/storage-backup/restore.mjs <archive> --extract ./restored
//   node scripts/storage-backup/restore.mjs <archive> --upload --i-understand [--overwrite]
// Environment: BACKUP_PASSPHRASE (always); SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for --upload
//
// Exit codes: 0 ok · 2 usage/env · 3 failure · 5 verification mismatch

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decrypt, unpack } from './lib/archive.mjs';
import { verifyRestore } from './lib/manifest.mjs';
import { makeClient, uploadObject, downloadAll } from './lib/storage.mjs';

const EXIT = { OK: 0, USAGE: 2, FAILURE: 3, MISMATCH: 5 };
const flag = (n) => process.argv.includes(`--${n}`);
function arg(n, fallback = null) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const log = (m) => process.stdout.write(`${m}\n`);

async function main() {
  const archivePath = process.argv[2];
  if (!archivePath || archivePath.startsWith('--')) {
    process.stderr.write('usage: restore.mjs <archive> (--verify | --extract <dir> | --upload --i-understand)\n');
    process.exit(EXIT.USAGE);
  }
  if (!process.env.BACKUP_PASSPHRASE) {
    process.stderr.write('missing BACKUP_PASSPHRASE\n');
    process.exit(EXIT.USAGE);
  }

  let manifest, objects;
  try {
    ({ manifest, objects } = unpack(decrypt(readFileSync(archivePath), process.env.BACKUP_PASSPHRASE)));
  } catch (err) {
    process.stderr.write(`could not open archive: ${err.message}\n`);
    process.exit(EXIT.FAILURE);
  }

  log(`Archive taken ${manifest.takenAt}`);
  log(`  ${manifest.objectCount} object(s), ${manifest.totalBytes} bytes, buckets: ${manifest.buckets.join(', ')}`);

  // ALWAYS verify what came out of the archive, whatever mode we are in. An
  // extract or upload of unverified bytes is how a corrupted backup becomes a
  // corrupted production.
  const check = verifyRestore(manifest, objects);
  if (!check.ok) {
    process.stderr.write(`ARCHIVE CONTENTS DO NOT MATCH ITS MANIFEST:\n${check.diff}\n`);
    process.exit(EXIT.MISMATCH);
  }
  log('  ✓ every object matches the manifest by SHA-256');

  if (flag('verify')) {
    log('VERIFIED — this archive can be restored.');
    process.exit(EXIT.OK);
  }

  const extractDir = arg('extract');
  if (extractDir) {
    for (const o of objects) {
      const dest = join(extractDir, o.bucket, o.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, o.bytes);
    }
    writeFileSync(join(extractDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
    log(`EXTRACTED ${objects.length} object(s) to ${extractDir}`);
    process.exit(EXIT.OK);
  }

  if (flag('upload')) {
    if (!flag('i-understand')) {
      process.stderr.write(
        '--upload writes into a live Supabase project. Re-run with --i-understand once you are sure\n' +
        'the target is the one you mean. Restoring into the wrong project, or over files newer than\n' +
        'the archive, turns a recovery into a second incident.\n',
      );
      process.exit(EXIT.USAGE);
    }
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      process.stderr.write('--upload needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY\n');
      process.exit(EXIT.USAGE);
    }

    const client = makeClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const overwrite = flag('overwrite');
    log(`Uploading to ${SUPABASE_URL} (overwrite: ${overwrite})`);

    let written = 0;
    const skipped = [];
    for (const o of objects) {
      try {
        await uploadObject(client, o.bucket, o.path, o.bytes, { upsert: overwrite });
        written++;
      } catch (err) {
        // Without --overwrite an existing object is an expected skip, not a
        // failure: the common restore is "put back the ones that are gone".
        if (!overwrite && /exists/i.test(err.message)) skipped.push(`${o.bucket}/${o.path}`);
        else throw err;
      }
    }
    log(`  uploaded ${written}, skipped ${skipped.length} already present`);

    // Read it all back and verify against the manifest. Upload success is the
    // API saying "accepted"; this is the only thing that says "and it is there,
    // and it is the same".
    log('  reading back to verify...');
    const after = await downloadAll(client, manifest.buckets, () => undefined);
    const relevant = after.filter((o) => manifest.entries.some((e) => e.bucket === o.bucket && e.path === o.path));
    const post = verifyRestore(manifest, relevant);
    if (!post.ok) {
      process.stderr.write(`RESTORE VERIFICATION FAILED:\n${post.diff}\n`);
      process.exit(EXIT.MISMATCH);
    }
    log('RESTORED AND VERIFIED — every object in the manifest is present with matching bytes.');
    process.exit(EXIT.OK);
  }

  process.stderr.write('pick one of --verify, --extract <dir>, --upload\n');
  process.exit(EXIT.USAGE);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(EXIT.FAILURE);
});
