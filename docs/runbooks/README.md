# Owner-actioned runbooks

Five actions that this remediation **prepared but did not perform**. Each requires
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
| P2 | Apply migration 30 — durable override store | DB write credential + break-glass | [P2](P2_APPLY_MIGRATION_30_OVERRIDES.md) |
| P3 | Apply migration 29 — server-side contaminant gate | P2 first + break-glass | [P3](P3_APPLY_MIGRATION_29_CONTAMINANT_GATE.md) |
| P4 | Apply migration 22's storage overlay | DB write credential + break-glass | [P4](P4_APPLY_MIGRATION_22_STORAGE_OVERLAY.md) |
| P5 | Turn OFF Supabase self-signup | Supabase dashboard access | [P5](P5_DISABLE_SUPABASE_SELF_SIGNUP.md) |

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
and nothing more. **`ddp_ro` cannot perform any statement in P2, P3 or P4** — those
need a write credential the owner must supply. As of 2026-07-28 no such credential
is known to exist in this environment.
