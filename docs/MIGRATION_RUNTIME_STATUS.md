# Migration Runtime Status — Authoritative Register

Last updated: 2026-07-25

This register is environment-specific. No migration is described as applied
without naming the environment and evidence source.

## Evidence policy

- Repository evidence is read from `origin/main` via git tree inspection.
- Local branch evidence is read from the current working branch file set.
- Runtime evidence (staging/production) is only accepted from direct database
  queries or recorded execution logs.
- Where access is missing, status is `UNKNOWN` and the missing evidence is
  listed explicitly.

## Current repository and branch context

- `origin/main` SHA: `3c51627b58fc0b3890e06b33d74a43a86b3be091`
- Current local branch during this update: `feature/admin-operations-desk-readonly`

## Migration register (10, 17, 19-27)

Legend:

- `PRESENT`: file exists in that code context.
- `ABSENT`: file does not exist in that code context.
- `APPLIED+VERIFIED`: direct runtime evidence exists.
- `UNKNOWN`: no direct runtime evidence available.

| Migration | `origin/main` files | Current local branch files | Staging runtime state | Production runtime state | Evidence source |
|---|---|---|---|---|---|
| 10 | PRESENT | PRESENT | APPLIED+VERIFIED (2026-07-14) | NOT APPLIED (at last verified checkpoint) | `docs/MIGRATION_RUNTIME_STATUS.md` historical entries |
| 17 | PRESENT | PRESENT | APPLIED+VERIFIED (2026-07-14) | NOT APPLIED (at last verified checkpoint) | `docs/MIGRATION_RUNTIME_STATUS.md` historical entries |
| 19 | PRESENT | PRESENT | UNKNOWN | UNKNOWN | No direct staging/production query evidence in this update |
| 20 | PRESENT | PRESENT | UNKNOWN | UNKNOWN | No direct staging/production query evidence in this update |
| 21 | PRESENT | ABSENT | UNKNOWN | UNKNOWN | Present on `origin/main` tree, absent on local branch file set |
| 22 | PRESENT | ABSENT | UNKNOWN | UNKNOWN | Present on `origin/main` tree, absent on local branch file set |
| 23 | PRESENT | PRESENT | UNKNOWN | UNKNOWN | No direct staging/production query evidence in this update |
| 24 | PRESENT | ABSENT | UNKNOWN | UNKNOWN | Present on `origin/main` tree, absent on local branch file set |
| 25 | PRESENT | ABSENT | UNKNOWN | UNKNOWN | `origin/main` uses Watchtower 25; no direct runtime query in this update |
| 26 | PRESENT | ABSENT | UNKNOWN | UNKNOWN | `origin/main` uses Watchtower 26; no direct runtime query in this update |
| 27 | ABSENT | ABSENT | UNKNOWN | UNKNOWN | No migration 27 file on `origin/main` or current local branch |

## Verified technical constraints

1. Migration ordering: 10 must be present before 17 due to the FK from 17 to
   `buyer_pack_snapshots`.
2. Migration numbering collision risk remains active for unmerged PRs that still
   attempt to add a different migration using ordinal `25`.
3. Current local branch does not contain all migration files present on
   `origin/main` (notably 21, 22, 24, 25, 26).

## What is missing before launch sign-off

Direct runtime evidence is missing for staging and production on migrations 19,
20, 21, 22, 23, 24, 25, 26, and candidate 27. This prevents a truthful
environment parity claim.

Required evidence must include, per environment:

1. migration history rows,
2. object presence checks (tables/functions/triggers/policies),
3. verification script outcomes,
4. timestamped execution logs.

See `docs/PRODUCTION_READ_ONLY_VERIFICATION_BUNDLE.md` for the exact query set
and execution protocol.
