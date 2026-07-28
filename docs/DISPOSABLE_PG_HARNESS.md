# Disposable-PostgreSQL Migration Verification Harness

A committed, reviewable, CI-enforced tool that proves a migration's **runtime
behaviour** — triggers, CHECK constraints, immutability, SECURITY DEFINER RPCs, the
grant/REVOKE ACL posture, VERIFY, rollback and the destructive-rollback guard — by
executing it against an **isolated, ephemeral, socket-only PostgreSQL 18** cluster
it creates and destroys. It is the behavioural counterpart to the repo's *static*
SQL-text suites: a trigger can exist in text and still not fire; this harness makes
it fire.

> **Scope of the RLS claim — read this.** The harness runs the migration's own
> `*_VERIFY.sql` as the cluster **owner/superuser**, and that VERIFY does no
> `SET ROLE`. PostgreSQL **bypasses row-level security for the owner/superuser**, so
> the harness proves that RLS is *enabled*, that the policies *apply and roll back*,
> and that the *trigger / CHECK / SECURITY DEFINER / grant-ACL* authorization logic
> behaves — it does **not** prove that an RLS policy actually filters or denies rows
> for a live non-privileged (`authenticated`/`anon`) caller. Row-level RLS
> *enforcement* is not exercised here and remains the job of the live-staging
> harness. (A future enhancement could add a `SET ROLE`-based enforcement probe; see
> "Recommended follow-ups" below.)

Migration 24 (Evidence Request & Resolution) is the first reference fixture. The
harness is **general** over the repo's `NN_NAME_{...}.sql` convention — new
migrations add a fixture descriptor, not harness code.

> **Not a Supabase emulator, and no parity claim.** A green disposable run proves
> the migration's SQL/RLS/guard *logic* on vanilla Postgres 18 plus a minimal
> shim. It does **not** assert equivalence with hosted Supabase (token issuance,
> Storage HTTP layer, signed URLs, server-side size limits). Those remain the job
> of the live-staging harness (`scripts/run-staging-security-tests.mjs`). Both
> gates are required; neither substitutes for the other.

## Usage

```bash
# One fixture, full apply -> VERIFY -> rollback -> destructive-guard cycle:
npm run verify:migration -- --fixture 24_evidence --verbose

# Every registered fixture (CI gate; includes the negative scenario):
npm run ci:runtime

# Dev-only: keep the cluster for inspection (prints a warning; never used in CI):
npm run verify:migration -- --fixture 24_evidence --keep
```

**Prerequisite:** a full PostgreSQL 18 **server** toolset (`initdb`, `postgres`,
`pg_ctl`, `psql`, `createdb`) discoverable via `PG_BIN` or `PATH`. A client-only
install (e.g. Homebrew `libpq`) is rejected with an actionable message.

- macOS: `brew install postgresql@18`, then
  `PG_BIN=/opt/homebrew/opt/postgresql@18/bin npm run verify:migration -- --fixture 24_evidence`
- Debian/Ubuntu: PGDG `postgresql-18`, then `PG_BIN=/usr/lib/postgresql/18/bin …`

The supported major is `18` (matching the proven 18.4 reference run) and is read
from `HARNESS_PG_MAJOR` (default `18`). The harness records the **actual**
`server_version` it ran into `result.json`, and **fails fast** if the available
binary is a different major — a different major could mask or invent behaviour.

## Safety model (why it cannot touch staging or Production)

Structural, defence-in-depth, asserted **before any SQL** (`lib/guards.mjs`):

1. **No remote target.** Startup aborts if the environment carries any remote
   signal — `STAGING_DATABASE_URL`, `SUPABASE_URL`, `DATABASE_URL`, a TCP `PGHOST`,
   or any value referencing the known staging/production project refs.
2. **Socket-only.** The cluster runs with `listen_addresses = ''` (no TCP listener
   at all) and a Unix socket inside a per-run temp dir. The connection target is
   computed internally and never taken from env/args; a guard asserts the resolved
   host is that socket dir, and that `SHOW listen_addresses` is empty.
3. **No client, no secrets.** No `@supabase/supabase-js`, no HTTP client, no
   `.env`/DSN/key reads — the harness builds its own database and holds no secrets.
   Evidence is scrubbed and asserted secret-free before it is written.
4. **Ephemeral.** Each run `initdb`s a fresh cluster in a temp dir and destroys it
   (`pg_ctl stop -m immediate` + recursive delete) in a `finally` and on
   `SIGINT`/`SIGTERM`, then asserts zero residue (no dir, no process, no socket).

## Evidence

Each run writes `scripts/disposable-pg/.artifacts/<runId>/result.json`
(**gitignored**; CI uploads it as an artifact). It captures: fixture id · git SHA ·
actual PG version · timestamps · each apply stage + result · VERIFY sections +
per-section results · rollback stages + result · destructive-guard scenario results
· teardown result · final exit code. Exit codes: `0` ok · `10` apply · `20` verify
· `30` rollback/postcondition · `40` destructive guard · `41` unexpected-pass
· `50` environment · `60` teardown residue.

## Fixture format

A fixture (`fixtures/<id>.json`) is **data**; the runner iterates whatever it
declares. Key fields:

- `applyStages` — ordered `{label, file}` forward stages. `HARDENING`+`STORAGE` are
  migration-24-specific names, **not** universal; a fixture declares its own.
- `verify` — `{file, expectedSections, expectedPassCount}`. The parser asserts every
  expected section is present and PASSED, the count matches (non-vacuity), and no
  undeclared section drifted in.
- `rollback.stages` — ordered stages. A stage may be a `file`, or
  `source: "storage-companion-comment"`, which **extracts** the storage rollback
  from the `-- ROLLBACK (storage companion)` block inside `*_STORAGE.sql` (single
  source of truth — the DDL is never duplicated in the fixture).
- `declaredSubstrate` — roles/schemas/symbols the migration depends on. If a
  migration references an `auth.*`/`storage.*` symbol not declared here (and not
  created by the migration itself), the harness **fails loudly** (fail-on-undeclared
  substrate) rather than silently succeeding on an approximation.
- `destructiveGuard` — `{livenessTable, seedSql, optInSetting, optInValue,
  refusalStage, expectRefusalMatch}`: seed live data into `livenessTable` (the
  fully-qualified table whose rows the guard protects — not hardcoded to any
  migration), prove the guarded stage **refuses** without the opt-in, then
  **succeeds** with it.
- `postRollback` — `removed`/`intact` object lists asserted after rollback, proving
  the rollback is real (objects gone) and safe (substrate intact).

### Adding a new migration fixture

1. Copy `fixtures/24_evidence.json`, set `id`, `applyStages`, `verify` (list the
   actual sections your VERIFY emits and their count), and `rollback.stages`.
2. Declare every `auth.*`/`storage.*`/role/extension symbol the migration depends
   on in `declaredSubstrate`. Run the harness; if it reports an **undeclared
   substrate** symbol, either add it to the bootstrap + declaration, or route that
   property to live-staging verification and document why.
3. Fill `destructiveGuard` (seed SQL that creates the data the guard protects) and
   `postRollback` (objects the migration adds → `removed`; earlier-migration objects
   → `intact`).
4. `npm run verify:migration -- --fixture <id> --verbose` until green; the CI
   `runtime-verify` job then runs it on every PR head automatically.

## VERIFY section count — A–R (18), not A–M (13)

The original PR-0 brief referenced migration 24 as "VERIFY A–M, 13/13". The
**merged** migration 24 (PR #37, head `fd57135`) carries **18 sections A–R**: the
final PR #37 fixes added N (CoA document-type link), O/P (tombstone lifecycle),
Q (internal-helper ACLs) and R (bucket `file_size_limit`) after the brief was
written. The fixture is data-driven off the actual file and expects **18/18 A–R**;
the harness would fail a run that produced only 13. This is a deliberate,
documented divergence from the brief in favour of the live repository (the brief's
own source-of-truth rule).

## Shim boundary records (minimum-substrate principle)

`bootstrap/00_supabase_substrate.sql` provides **only** the minimum substrate a
migration needs — not an oversized fake Supabase. For every shimmed object: why it
exists · what real Supabase object it represents · what it approximates · what it
does **not** reproduce.

| Shim | Why it exists | Represents | Approximates | Does NOT reproduce |
|------|---------------|------------|--------------|--------------------|
| `auth.uid()` | RLS policies/helpers resolve a caller id | GoTrue JWT-derived `sub` | reads the `request.jwt.claim.sub` session GUC; NULL when unset (fail-closed) | token issuance, signature checks, expiry, refresh |
| `auth.users` | VERIFY/seed pick real actor ids (two, for handoff sections) | GoTrue user table | two fixed UUID rows | the full GoTrue schema, auth flows |
| `storage.buckets` | migration creates the private evidence bucket + asserts its size limit | Supabase Storage bucket catalog | a table with `id/name/public/file_size_limit` | the Storage HTTP API and server-side size enforcement |
| `storage.objects` | storage RLS policies read object rows; STORAGE precondition needs an owner | Supabase Storage object catalog | a table owned by the bootstrap superuser (so `current_user` owns it) | real object bytes, signed URLs, the Storage service |
| roles `anon`/`authenticated`/`service_role`/`supabase_storage_admin` | migrations `GRANT`/`REVOKE` against them; RLS evaluates per-role | Supabase's baseline roles | `NOLOGIN` roles with the platform's baseline grants | the full hosted role hierarchy and JWT→role mapping |
| `public.is_ddp_admin()` / `has_operational_farmer_access()` / `has_farm_membership()` | migration 24 policies/RPCs call them | earlier-migration authorization helpers | `SECURITY DEFINER` predicates over `profiles`/`farm_memberships` keyed on `auth.uid()` | any additional business rules those helpers carry in production |
| `public.profiles/farms/farm_profiles/inventory_batches/farm_memberships/farmer_documents/documents` | FK targets and scope checks the migration/VERIFY touch | earlier-migration tables | the subset of columns actually referenced | full column sets, their own RLS, and unrelated constraints |
| `public.status_history` | migration 35's RPC writes the audit half of a status transition into it | the pre-numbering compliance artefact (`SUPABASE_SCHEMA.sql`) | `id/entity_type/entity_id/old_status/new_status/note/created_at`, all nullable except `id`/`created_at`, with **no** FK on `entity_id` (it addresses two different tables) — shapes copied from production, measured read-only 2026-07-28 | its RLS policy set, and therefore the fact that in production only `is_ddp_admin()` satisfies a permissive INSERT policy |
| `farms.status` / `inventory_batches.status` / `.reviewed_by` / `.updated_at` | the columns an admin review action writes and migration 35's RPC transitions | earlier-migration columns | `status text NULL`, `reviewed_by uuid NULL`, `updated_at timestamptz NOT NULL DEFAULT now()` | nothing further — production carries **no** CHECK constraint on `status` (the vocabulary is enforced in TypeScript), which the shim reproduces exactly |

Anything the shim cannot faithfully model stays a documented limitation and is
covered by the live-staging harness instead.

**The RLS limitation matters for migration 35.** VERIFY runs as the cluster owner,
who bypasses RLS, so sections C–J prove the RPC's *own* authorisation checks —
which are the access control that matters, because `SECURITY DEFINER` bypasses RLS
in production too. What the harness does **not** prove is the surrounding policy
set: that `status_history` has no permissive INSERT policy for any role but
`ddp_admin`. That was established by direct read-only measurement of production
(`pg_policies`, 2026-07-28) and is recorded in the migration header.

## K-10(e): FORCE ROW LEVEL SECURITY stays OFF

The harness statically asserts that no in-scope migration (or the bootstrap)
enables `FORCE ROW LEVEL SECURITY`, and exercises SECURITY DEFINER helper/projection
behaviour under the shim — the drift-protection anchor for owner decision K-10(e).
It never introduces FORCE RLS.

## Migration-number collision guard

Root migrations are ordered by a leading integer (`NN_STEM_STAGE.sql`). A
migration is the SET of files sharing one number and one stem.

The failure this guards against is a **number collision**: two unrelated
migrations independently claiming the same number on different branches. Each
branch is internally consistent and individually green, so nothing surfaces
until both land — at which point apply ordering is undefined and the runtime
register becomes ambiguous ("is 25 applied?" has two answers).

This is not hypothetical. PR #48 landed `25_WATCHTOWER_INGESTION_PROVENANCE_*`
on `main` while PR #44 carried `25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_*`.
Both passed every check. Nothing noticed.

Two enforcement points:

```bash
# Standalone gate — no PostgreSQL needed, runs on EVERY pull request in
# Security CI ("Static security & build checks"), before the SQL checks.
npm run verify:migration-numbers
```

and a **harness preflight**: `npm run ci:runtime` refuses to certify any
migration while a collision exists, exiting with the environment code before a
cluster is started.

Rule (`scripts/disposable-pg/lib/migration-numbering.mjs`): group numbered root
`.sql` files by number; within a group, strip one recognised trailing stage
token (`HARDENING`, `ROLLBACK`, `VERIFY`, `STORAGE`, `MVP`) to obtain the stem.
More than one distinct stem at a number is a collision. Files alone at a number
never collide, so the stage list only has to cover numbers carrying several
files. Unnumbered schema files (`AUTH_RLS_SCHEMA.sql`, `SUPABASE_SCHEMA.sql`,
`FARMER_MVP_MIGRATION.sql`) sit outside the ordering contract and are ignored.

Negative coverage in `scripts/disposable-pg/migration-numbering.test.mjs`
reconstructs the real 25/25 collision and asserts it is caught, and asserts the
legitimate shapes are NOT flagged: multi-stage sets (26), a four-stage set (24),
an unsuffixed forward file (23), `MVP`-suffixed forward files (10, 17), and one
stem legitimately reused at two numbers (19 guard, 20 ACL fix).

## Recommended follow-ups (known coverage boundaries)

These are deliberate boundaries of the current harness, not defects — recorded so
they are chosen, not forgotten:

1. **RLS enforcement probe.** Add an optional fixture step that, after apply, runs a
   short probe as a non-privileged role (`SET ROLE authenticated` / `anon` with a
   `request.jwt.claim.sub` GUC) and asserts a representative storage/table policy
   actually *allows* the authorized caller and *denies* the unauthorized one. This
   would upgrade RLS coverage from "enabled + applies" to true row-level
   enforcement. Until then, RLS enforcement stays a live-staging responsibility.
2. **Negative-scenario breadth (brief §17).** Real-Postgres negative coverage
   currently exercises the apply-failure path. Rollback-failure, a raising VERIFY,
   and a guard that wrongly succeeds are covered only at the unit level (parser /
   guard logic), not as end-to-end integration negatives. Adding expect-failure
   fixtures for the `rollback`/`verify`/`guard` phases would close this.
3. **Required-check enforcement.** That `runtime-verify` is a *required* status check
   is a GitHub branch-protection setting, not expressible in-repo; confirm it in the
   repository settings.
