# Migration Runtime Status — by Environment

**Last verified: 2026-07-14.** This file records where each migration actually is,
per environment. A migration is never described as "applied" without naming the
environment it was applied to.

Contains no credentials, project URLs, or connection strings.

## Status table

| | Migration 10 — Buyer Pack snapshots | Migration 17 — Procurement decisions |
|---|---|---|
| **Repository** | Committed on `main`. Executable SQL unchanged since it was applied to staging. | Committed on `main`. Executable SQL unchanged since it was applied to staging. |
| **Staging** | **APPLIED + VERIFIED** (2026-07-14) | **APPLIED + VERIFIED** (2026-07-14) |
| **Production** | **NOT applied.** Not run, not deployed. | **NOT applied.** Not run, not deployed. |
| **Runtime verification — staging** | V1–V6 executed and matched expectations. Behavioural checks run inside a **rolled-back** transaction. | `17_..._VERIFY.sql` returned `ok` for all 8 checks. Behavioural checks run inside a **rolled-back** transaction. |
| **Runtime verification — production** | **None. Never executed.** | **None. Never executed.** |
| **VERIFY script** | `10_..._VERIFY.sql` — V1–V6 are **active, read-only, and directly runnable**. V7 writes and is commented out, outside the default path. | `17_..._VERIFY.sql` — read-only, directly runnable, safe against any environment. |
| **Rollback** | `10_..._ROLLBACK.sql` present. | `17_..._ROLLBACK.sql` present — **destructive**: dropping the table destroys the decision audit trail. Export first; prefer rolling back the app deploy. |
| **Remaining blockers (production)** | Backup + explicit approval. Revisit the `ACL-TEST-EXEMPT` marker once these functions exist in production. | Depends on migration 10. No TRUNCATE guard of its own (covered in staging by migration 14's default privileges). |

## What is true right now

- **Staging has both migrations**, and staging verification **passed**.
- **Production has neither migration.**
- **Production therefore still uses the application's localStorage fallback.** The
  server-side decision trail and server-side snapshot persistence exist in the
  deployed code but are **not active in production**, because the schema is absent
  and the app feature-detects that and degrades.
- **No production SQL verification has occurred.** Not for migration 10, not for
  migration 17, and not for `16_PRODUCTION_SAFETY_VERIFY.sql`.

## Ordering — not optional

**Migration 10 MUST be applied before migration 17.** Migration 17 holds a hard FK
to `public.buyer_pack_snapshots(snapshot_id)`. Applying 17 first fails outright with
`relation "public.buyer_pack_snapshots" does not exist`.

The coupling between 17 and 10 remains an **open review item** for production
planning. It is not settled by this document.

## Before any production cutover

1. Take a **pre-application backup** of production and confirm it restores.
2. Obtain **explicit sign-off**. Application to staging does **not** imply production
   readiness and must not be read as approval.
3. Run **`16_PRODUCTION_SAFETY_VERIFY.sql`** (read-only) against production — it is
   **still outstanding** and has never been executed.
4. Apply **10 → 17**, in that order.
5. Run **`10_..._VERIFY.sql`** and **`17_..._VERIFY.sql`** against production and
   confirm every check. In particular, `17` V6 must report that `authenticated` holds
   neither UPDATE nor DELETE.
6. Do **not** run `10_..._VERIFY.sql` section **V7** as part of any pipeline. It
   writes, and is safe only when run manually inside a transaction ending in
   `rollback;`.
