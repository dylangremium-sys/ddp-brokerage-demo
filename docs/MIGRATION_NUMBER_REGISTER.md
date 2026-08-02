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

**Last reconciled:** 2026-08-02, against `main` = `48230f0` and every local and remote ref in this
clone — including worktrees belonging to concurrent sessions, which is how the claim on **45** below
was found.

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

## Taken on `main` (36 numbers, 93 files)

3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 34,
35, 36, 37, 38, 39, 40, 41, 42, 43, 44

Never reuse or renumber any of these. Several are applied to production, and the numbers appear in
verification documents, runbooks and the freeze record.

Measured, not transcribed:

```bash
git ls-tree -r --name-only origin/main | grep -E '^[0-9]+_' | sed -E 's/^([0-9]+)_.*/\1/' | sort -n -u
git ls-tree -r --name-only origin/main | grep -cE '^[0-9]+_'
```

**Being on `main` says nothing about being applied.** 24, 28, 39, 40, 41, 42, 43 and 44 are all on
`main` and exist in **no database** — measured against production 2026-08-02, 0 of the 17 tables
those migrations create are present. See `docs/runbooks/EXPORT_HUB_FOUNDATION_APPLY.md`.

---

## Reserved — claimed by work in flight, NOT free

| # | Migration stem | Claimed by | State |
|---|---|---|---|
| 31 | `31_COA_SOURCE_BOUND_REVIEW_*` | PR **#95** `feature/coa-source-bound-watchtower-review` | open, **draft** |
| 32 | `32_COA_REVIEW_INTEGRITY_*` | PR **#95** `feature/coa-source-bound-watchtower-review` | open, **draft** |
| 33 | `33_COA_REVIEW_ATOMICITY_*` | PR **#95** `feature/coa-source-bound-watchtower-review` | open, **draft** |
| 45 | `45_COMMERCIAL_AUDIT_LOG_*` | local branch `fix/commercial-audit-log`, **another session's worktree** | **no commits, unpushed** |

**27 and 28 are no longer reserved — both landed on `main`** (rows struck 2026-08-02). The earlier
note that "28 is on PR #73, not PR #44" was correct at the time and is now history; both numbers are
in the taken list above.

**The 31–33 risk paragraph is discharged.** It previously read that the claiming branch "exists only
in this working clone… no remote branch and no pull request", and advised pushing it. That has since
happened: `origin/feature/coa-source-bound-watchtower-review` exists and PR #95 is open. The claim is
now durable and reviewable. It is still a *draft* PR, so it will not appear in a casual scan of
mergeable work — check drafts before assuming 31–33 are free.

### 45 — claimed, and the reason this reconciliation happened

Migration 45 is reserved for the **Seam 7 correction**: create `commercial_audit_log`, move the
commercial actions out of `compliance_audit_log`'s vocabulary, and re-point the trigger bodies in 39
and 44 that write them. Specified in `docs/OPTION_B_SEAM_CONTRACT.md` (Seam 7).

The claim was found by `git worktree list`, not by any query in this file: a concurrent session has
`fix/commercial-audit-log` checked out in a separate worktree of this same clone, with no commits and
nothing pushed. **CI cannot see that, and neither can GitHub.** `git log --all` can, because
worktrees of one clone share an object store — which is the single argument for sibling worktrees
over separate clones.

Anyone about to write 45: coordinate with that branch first rather than taking the number.

### The check does not catch this class

`npm run verify:migration-numbers` (`scripts/check-migration-numbers.mjs`) detects a collision only
once **both** sides have landed, by which point one of them must be renumbered. The precedent is
recorded above the fold: PR #48 and PR #44 both carried a `25_`, and both were individually green.

The query that would catch it before the fact is the `git log --all` one in "How this was derived",
run as a **pre-commit** check where it can see sibling worktrees. That is not wired up.
`origin/audit-001-migration-number-ci-enforcement` may already contain some of it; it is **not merged
into `main`**. Check there before rebuilding.

---

## Free

**46 and upward.** (Was 45 until 2026-08-02; 45 is now claimed — see above.)

The floor moved from 37 to 45 and then to 46 during 2026-08-02: 37 and 38 (storage privacy) landed,
39–43 were allocated by the export-hub foundation and 44 by the marketplace reservation ledger — all
of which have since merged to `main` — and 45 is reserved for the Seam 7 correction. Quoting a free
floor of 35 would have invited an author to take a number this very document reserves, recreating
exactly the collision the register exists to prevent.

**The floor moved three times in one day.** Re-run the derivation query rather than trusting the
number written here; a register is only as fresh as its last reconciliation, and this one has been
stale before.

The check must therefore exclude the allocated numbers rather than merely look for files on disk: an
allocation is a *claim*, and a claim is made before the file exists. Numbers 27, 28 and 31–33 are
claimed by branches too (see above), so the honest query is "no file exists **and** no row in the
allocations table claims it":

```
$ git log --all --diff-filter=A --name-only --pretty=format: -- '*.sql' | grep -E '^(4[5-9]|[5-9][0-9])_'
(no output)
```

**Take the next number above the highest CLAIMED one — not the highest number on disk.** As of this
reconciliation the highest number *on disk anywhere* is 44, but the highest **claim** is 45
(`fix/commercial-audit-log`, no commits yet), so the next migration is **46**.

That gap between "highest file" and "highest claim" is the whole point of this file. The query above
returns no output for 45 — because no file exists yet — and would tell an author 45 is free. It is
not.

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

## Allocations made by the export-hub foundation (2026-08-02)

Branch `feature/export-hub-foundation`. These five are a dependency chain and must be applied in
order — each one's HARDENING refuses to run if its predecessor is absent.

| # | Migration stem | What it does | Depends on |
|---|---|---|---|
| 39 | `39_COUNTERPARTY_ORGANISATIONS_*` | `organisations` (farm/buyer/laboratory/carrier/broker/internal) + `organisation_memberships`; widens `profiles.role` to admit `buyer`; widens the `compliance_audit_log` action vocabulary | migration 9, 21 |
| 40 | `40_LICENCES_AND_PERMITS_*` | `licences`, `permits`, append-only `permit_drawdowns` with headroom enforced under a row lock; regime as a first-class column (D1); expiry **computed**, never stored (D4); dual-calendar BE/CE asserted in the database (§2) | 39 |
| 41 | `41_EFFECTIVE_DATED_RULESETS_*` | `effective_from`/`effective_to` on `compliance_rules` (backfilled and flagged as estimated), `destination_rulesets`, and the two point-in-time resolvers (D6) | 9, 39, 40 |
| 42 | `42_EXPORT_ELIGIBILITY_GATE_*` | the seven-condition fail-closed export gate, append-only `export_eligibility_evaluations`, `screening_checks`, immutable `export_gate_overrides` and the standing exceptions view (§7.1) | 39, 40, 41 |
| 43 | `43_MFA_FOR_GATE_APPROVAL_*` | `security_settings`, JWT assurance-level readers, and MFA enforcement on gate override — shipped **disabled**, with a missing settings row meaning *required* (§10) | 42 |

---

## Allocation made by the Option B marketplace (2026-08-02)

Branch `feature/marketplace-reservations`, stacked on `feature/export-hub-foundation`.

| # | Migration stem | What it does | Depends on |
|---|---|---|---|
| 44 | `44_RESERVATION_LEDGER_*` | append-only marketplace reservations + releases; availability as a computed `SUM` under a row lock; expiry derived, never stored; double-blind RLS both ways | 39, and the pre-numbering `inventory_batches.quantity_kg` / `client_visible` |

Written to `docs/OPTION_B_SEAM_CONTRACT.md`, which is binding on all marketplace work.

**39–43 and 44 all merged to `main` on 2026-08-02** (`42833ac`, `48230f0`). The two allocation
tables above are kept as the record of what each number bought; the numbers themselves have moved to
the taken list.

**None of these has been applied to any database.** Merging is not applying. All six are verified
only on the disposable PostgreSQL 18 harness (`npm run ci:runtime`), which is a real Postgres but
not staging and not production — re-measured against production on 2026-08-02: 0 of the 17 tables
they create exist. See `docs/runbooks/EXPORT_HUB_FOUNDATION_APPLY.md` before applying any of them.

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
6. **Run `git worktree list` before claiming.** More than one session works in this clone. A
   sibling worktree can hold a branch that claims a number with no commit, no push and no PR —
   invisible to CI, to GitHub, and to the `git log --all` query, which only sees numbers that
   already have a *file*. This is how 45 was found.
7. **Claim before you write, not when you finish.** A row in this file costs nothing and is the only
   artefact a concurrent session can see. The number is reserved by the claim, not by the SQL.
