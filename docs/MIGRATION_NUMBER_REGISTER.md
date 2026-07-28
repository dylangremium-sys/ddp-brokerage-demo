# Migration number register

**Purpose:** say which migration numbers are *taken*, which are *reserved by work in flight*, and
which are *genuinely free* — so the next author picks a number without creating a collision.

**Why this file exists.** `npm run verify:migration-numbers` detects **collisions**, not **gaps**.
Reading `main` alone, numbers 27, 28 and 31–33 look free; every one of them is claimed on a branch
that has not merged. A reader of `main` cannot tell a reserved number from an unused one, and the
guard only fires once both sides land — by which point one of them has to be renumbered. This is not
hypothetical: PR #48 landed `25_WATCHTOWER_INGESTION_PROVENANCE_*` on `main` while PR #44 carried
`25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_*`; both branches were individually green
(`scripts/disposable-pg/lib/migration-numbering.mjs:14-16`).

**Scope:** this register tracks **number claims only**. It says nothing about whether a migration has
been applied to any database. For deployment state see
`docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md` §4 and the runbooks under `docs/runbooks/`.

**Last reconciled:** 2026-07-28, against `main` = `507d8386f5d5ec624cda52e60be2c0ada330747c` and every
local and remote ref in this clone.

---

## How this was derived (re-run before trusting it)

```bash
# Numbers present on main
ls | grep -E '^[0-9]+_' | sed -E 's/^([0-9]+)_.*/\1/' | sort -n -u

# Numbers claimed ANYWHERE — including unmerged and unpushed branches.
# This is the query that matters; the one above is the one that misleads.
git log --all --diff-filter=A --name-only --pretty=format: -- '*.sql' \
  | grep -E '^[0-9]+_' | sort -u

# Which ref claims a given number
git log --all --diff-filter=A --name-only --pretty=format: -- '31_*.sql'
```

---

## Taken on `main` (24 numbers, 57 files)

3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29, 30, 34

Never reuse or renumber any of these. Several are applied to production, and the numbers appear in
verification documents, runbooks and the freeze record.

---

## Reserved — claimed by work in flight, NOT free

| # | Migration stem | Claimed by | State |
|---|---|---|---|
| 27 | `27_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_*` | PR **#44** `security/ddp-audit-remediation` | open, mergeable |
| 28 | `28_EVIDENCE_DIGEST_DEDUP_*` | PR **#73** `feature/evidence-digest-dedup-provenance` | open, mergeable |
| 31 | `31_COA_SOURCE_BOUND_REVIEW_*` | local branch `feature/coa-source-bound-watchtower-review` | **unpushed, no PR** |
| 32 | `32_COA_REVIEW_INTEGRITY_*` | local branch `feature/coa-source-bound-watchtower-review` | **unpushed, no PR** |
| 33 | `33_COA_REVIEW_ATOMICITY_*` | local branch `feature/coa-source-bound-watchtower-review` | **unpushed, no PR** |

Two corrections to the 2026-07-28 red/blue audit (finding R12), which recorded that "27/28 live on
unmerged PR #44" and that 31–33 were unclaimed:

1. **28 is on PR #73, not PR #44.** PR #44 carries only 27.
2. **31, 32 and 33 are all claimed** — by `feature/coa-source-bound-watchtower-review`, which exists
   only in this working clone. It has no remote branch and no pull request, so nothing on GitHub
   reveals the claim. Taking 31–33 for new work would have created a three-way collision recoverable
   only by renumbering.

`27_EVIDENCE_DIGEST_DEDUP_*` also appears in history on the local integration branches
`integration/pr43-plus-pr44` and `security/ddp-audit-remediation-rebased`. That is a **resolved**
collision — the digest-dedup work was moved to 28 — and 27 belongs to PR #44.

### Risk carried by 31–33

An unpushed branch is invisible to every collision check that runs in CI, because CI only sees what
is pushed. The claim above is real but fragile: if that clone is lost, the reservation is lost with
it. Either push the branch (so the claim is durable and reviewable) or release the numbers
explicitly by deleting the branch and striking these rows.

---

## Free

**35 and upward.** No `.sql` file numbered 35 or higher has ever existed on any ref in this
repository:

```
$ git log --all --diff-filter=A --name-only --pretty=format: -- '*.sql' | grep -E '^(3[5-9]|[4-9][0-9])_'
(no output)
```

**1, 2, 5, 6, 7 are NOT free.** They were never used by a numbered file, but the pre-numbering
migrations (`AUTH_RLS_SCHEMA.sql`, `SUPABASE_SCHEMA.sql`, `FARMER_MVP_MIGRATION.sql`,
`INVENTORY_BATCHES_RLS_PATCH.sql`, and the other unnumbered root `.sql` files) occupy that era of the
schema's history. Numbering new work below the existing floor would imply it runs *before* migrations
that are already applied to production, which is false and dangerous. **Always take the next number
above the highest claimed one.**

---

## Allocations made by this remediation (2026-07-28)

| # | Migration stem | PR | What it does |
|---|---|---|---|
| 35 | `35_STATUS_TRANSITION_ATOMIC_*` | atomic status transition | `SECURITY DEFINER` RPC performing the entity `UPDATE` and the `status_history` `INSERT` in one transaction (audit R7) |
| 36 | `36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING_*` | public intake throttle | revokes `INSERT` on `farmer_access_requests` from `anon`, narrowing the write path to the rate-limited server function (audit R5) |

---

## Rules

1. Before claiming a number, run the `git log --all` query above. `ls` on `main` is not sufficient
   and has already produced one wrong answer.
2. Claim the number in this file **in the same PR** that adds the migration.
3. Never renumber a migration that exists on `main` — its number is referenced by verification
   documents, runbooks and the freeze record.
4. If you abandon a branch, delete its row here so the number returns to the free pool.
5. A number is a set: `NN_STEM_HARDENING.sql` + `NN_STEM_VERIFY.sql` + `NN_STEM_ROLLBACK.sql`. Two
   different stems at one number is a collision even if the files do not overlap.
