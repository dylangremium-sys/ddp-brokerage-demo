# Storage backup

Supabase backs up the **database** daily. It does **not** back up Storage. Its own
Backups page says so:

> Storage objects are not included. Database backups do not include objects stored via
> the Storage API… Restoring an old backup does not restore objects that have been
> deleted since then.

So the lab certificates, cultivation licences and farm photos had no safety net at all.
This is that safety net (defect **D4**).

## What runs, and when

`.github/workflows/storage-backup.yml`, daily at 03:17 UTC, and on demand via
**Actions → Storage Backup → Run workflow**.

Each run:

1. Lists every object in `farmer-documents`, `farmer-photos`, `evidence-request-files`
   — recursing into folders, and paging past the 100-object listing cap.
2. Downloads every object and records its path, size and SHA-256 in a manifest.
3. **Refuses** to record the run if it looks implausible — zero objects, a drop of more
   than half against yesterday, or a previously-populated bucket that now returns none.
4. Packs, gzips and encrypts with AES-256-GCM (scrypt-derived key).
5. **Decrypts the archive it just made and verifies every object against the manifest.**
   Then does it again through the restore CLI, from disk.
6. Uploads the encrypted archive (90-day retention) and the manifest as the next
   baseline.

Every backup is therefore also a restore test, daily, on the real bytes.

## Restoring

```sh
export BACKUP_PASSPHRASE='…'   # from your password manager

# Is this archive good? Touches no Supabase project.
node scripts/storage-backup/restore.mjs storage-20260805.ddpbak --verify

# Get the files out — the common case is one deleted certificate.
node scripts/storage-backup/restore.mjs storage-20260805.ddpbak --extract ./restored

# Put them back into a project. Writes to a live system, hence the flag.
node scripts/storage-backup/restore.mjs storage-20260805.ddpbak --upload --i-understand
# add --overwrite to replace objects that already exist (it will not by default)
```

`--upload` re-downloads everything afterwards and verifies it against the manifest.
"The API accepted it" is not the same as "it is there and it is the same".

## Required secrets

| Secret | What it is |
|---|---|
| `SUPABASE_URL` | Production project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Needed because migration 37 made all three buckets private — the anon key cannot read them |
| `BACKUP_PASSPHRASE` | The only thing protecting farmer identity documents at rest |

**Keep `BACKUP_PASSPHRASE` in your password manager.** If it exists only as a GitHub
secret, then losing the GitHub account loses every archive with it — GitHub cannot
show you a secret's value back.

## Archive format

Deliberately simple, so a recovery does not depend on this repository being available:

```
magic    8 bytes  "DDPBAK01"
salt    16 bytes  scrypt salt
iv      12 bytes  AES-GCM nonce
tag     16 bytes  AES-GCM auth tag
body     n bytes  ciphertext of a gzipped stream of
                  [4-byte BE name len][name][8-byte BE body len][body] …
                  the first entry always being MANIFEST.json
```

## What this is not

**Not off-site in the strong sense.** The archive lives in GitHub Actions artifacts.
That survives losing the Supabase project, which is the point — but artifacts expire
after 90 days and GitHub is a single provider. Once there is a material number of
objects, send the archive to a third provider (S3, R2, B2) as well: it is a change to
the final step of the workflow, and the archive is already encrypted, so the
destination does not need to be trusted.

**Not a replacement for the database backup.** These files are meaningless without the
rows that reference them. A real recovery restores both, and `storage.objects` metadata
comes from the database side.
