# Owner-actioned runbooks

Actions that this remediation **prepared but did not perform**. Each requires
production access or owner authority that an engineering agent does not have and
should not have.

A **production change freeze is ACTIVE**
(`docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md`). Every runbook here that touches
the database is a **break-glass event** under §3: authorisation must be recorded in
§5 of the freeze document **before** execution, not after. Migration 34 was applied
without that record, which is finding R2 — the record now exists, retrospectively
and labelled as such. Do not add a second one.

| # | Action | Blocked on | Runbook |
|---|---|---|---|
| P1 | Set `SUPABASE_SERVICE_ROLE_KEY` in Vercel Production | owner holds the key | [P1](P1_SET_SUPABASE_SERVICE_ROLE_KEY.md) |
| P2 | Apply migration 30 — durable override store | break-glass (see the correction below) | [P2](P2_APPLY_MIGRATION_30_OVERRIDES.md) |
| P3 | Apply migration 29 — server-side contaminant gate | P2 first + break-glass | [P3](P3_APPLY_MIGRATION_29_CONTAMINANT_GATE.md) |
| P4 | Apply migration 22's storage overlay | break-glass (see the correction below) | [P4](P4_APPLY_MIGRATION_22_STORAGE_OVERLAY.md) |
| P5 | Turn OFF Supabase self-signup | Supabase dashboard access | [P5](P5_DISABLE_SUPABASE_SELF_SIGNUP.md) |
| P6 | Apply migration 37 — assert bucket privacy | break-glass | [P6](P6_APPLY_MIGRATION_37_BUCKET_PRIVACY.md) |

## Correction, 2026-07-30 — "DB write credential" was the wrong blocker

P2 and P4 were recorded above as blocked on a **DB write credential**, and since
2026-07-27 the working assumption has been that none exists: `~/.pgpass` fails
authentication and no `PROD_RO_DATABASE_URL` is present on the engineering machine.
Both facts are still true, and both are facts about a **psql connection string** —
not about whether the database can be changed.

The Supabase **SQL Editor** in the project dashboard executes SQL as a privileged
role. Demonstrated 2026-07-30: the owner ran `select id, public, file_size_limit from
storage.buckets` there and it returned a row. **`ddp_ro` cannot do that** (no USAGE on
schema `storage`), so the editor is strictly more capable than the read-only
credential this repository has been treating as the only available access.

**Consequence:** these runbooks are gated on **break-glass authorisation**, which is
the owner's decision to make, and not on obtaining a credential that may never
arrive. Do not carry "blocked on a credential" forward without testing it.

**Test it, do not assume it — in either direction.** [P6](P6_APPLY_MIGRATION_37_BUCKET_PRIVACY.md)
Step 0 is a read-only capability probe that reports, per object, whether the current
role can perform the change. Reuse that pattern before declaring any of these blocked.
Storage-schema changes (P4, P6) are the doubtful case, because they need membership in
`supabase_storage_admin`; ordinary `public`-schema DDL (P2, P3) is far more likely to
succeed and has never been tested.

**One trap that makes the editor look broken:** it does **not** display
`RAISE NOTICE` output. Every migration here reports success through notices, so a
successful run shows "Success. No rows returned" and confirms nothing. Failures do
surface, as errors — so the editor is safe, but blind on success. Verify with queries
that **return rows**; P6 Step 3 is written that way for this reason.

## Priority

**P1 first, and it is not close.** Until the service-role key is set, no supplier
can be onboarded end to end on any production surface — the site collects
enquiries it is structurally incapable of fulfilling. P1 needs no break-glass and
no SQL; it is a dashboard change and a redeploy.

P2 → P3 in that order (P3 depends on P2's ordering decision). P4 and P5 are
independent.

## What every runbook contains

Exact statements to run · a read-only pre-state query with its expected output ·
the rollback · post-state verification · an operator field to complete.

## Two standing rules

**1. `10_BUYER_PACK_SNAPSHOTS_MVP.sql` must NEVER run against production.** It
re-creates `public.issue_buyer_pack_snapshot` and silently reverts migration 23's
server-authoritative issuance to the client-trusting definition. There is no
numeric-ordering runner in this repo, and `ls *.sql | sort` orders `10` before
`3, 4, 8, 9` — so any glob-and-run triggers it. Apply named files, one at a time.

**2. Measure grants with `pg_class.relacl` + `aclexplode()`, never
`information_schema.role_table_grants`.** As `ddp_ro` the latter returns **0 rows**
regardless of reality, because it only shows grants involving roles the querying
role belongs to. It has already produced one false "PASS" in this project.

## Read-only production access

```bash
set -a; . ~/.ddp_prod.env; set +a      # PROD_RO_DATABASE_URL, role ddp_ro, SELECT-only
psql "$PROD_RO_DATABASE_URL"
```

Wrap every query in `BEGIN READ ONLY; … COMMIT;`. Freeze §2 permits exactly this
and nothing more. **`ddp_ro` cannot perform any statement in P2, P3, P4 or P6** — it
is SELECT-only by design.

Re-measured 2026-07-30 — the snippet above **works**:

```
$ set -a; . ~/.ddp_prod.env; set +a
$ psql "$PROD_RO_DATABASE_URL" -tAc "select current_user, current_database()"
ddp_ro|postgres
```

- **Read-only production access is live and working.** `~/.ddp_prod.env` exists and
  `PROD_RO_DATABASE_URL` authenticates as `ddp_ro`. Any claim that "no database
  credential exists" is about a **write** credential; do not let it grow into a claim
  that production cannot be read. It can, today, and freeze §2 permits it.
- The `~/.pgpass` `postgres` entry is separately **broken** (`FATAL: password
  authentication failed`). That is the credential that does not work — not this one.
- **`ddp_ro` still cannot read `storage.buckets`:** `ERROR: permission denied for
  schema storage`. It *can* read `pg_policies` for schema `storage`, because that is a
  catalog view. So storage POLICIES are measurable from here and bucket PRIVACY is
  not — which is why bucket privacy had to be settled from the SQL Editor, and why P6
  Step 1 belongs there rather than here.
- **No write credential exists**, but see the correction above: the SQL Editor is a
  privileged write path needing no connection string, so P2/P3/P4/P6 are gated on
  break-glass authorisation rather than on obtaining a URL. Probe with P6 Step 0
  instead of inferring capability from the absence of one.

### Measured production state, 2026-07-30 (read-only, `ddp_ro`)

`storage.objects` carries exactly **three** policies, all scoped to
`farmer-documents`. Migration 22's overlay: **absent** (0 rows). Migration 37's
`farmer-photos` policies: **absent** (0 rows, expected — not applied).

Confirmed **NOT applied** to production by direct object probe: migrations **24, 28,
30, 31, 35, 36** (`evidence_requests`, `document_field_extractions`,
`requirement_overrides`, `risk_overrides`, `coa_documents`, `public_intake_attempts`
and `record_status_transition` are all absent). This supersedes any earlier
"last recorded" status for those.
