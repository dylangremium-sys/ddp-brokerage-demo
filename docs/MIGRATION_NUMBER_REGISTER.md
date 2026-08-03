# Migration number register

**Purpose:** say which migration numbers are *taken*, which are *reserved by work in flight*, and
which are *genuinely free* — so the next author picks a number without creating a collision.

**Why this file exists.** `npm run verify:migration-numbers` detects **collisions**, not **gaps**.
Reading `main` alone, numbers 31–33 look free; all three are claimed on a branch that has not merged
(27 and 28 were in this sentence until they landed on 2026-08-02). A reader of `main` cannot tell a reserved number from an unused one, and the
guard only fires once both sides land — by which point one of them has to be renumbered. This is not
hypothetical: PR #48 landed `25_WATCHTOWER_INGESTION_PROVENANCE_*` on `main` while PR #44 carried
`25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_*`; both branches were individually green
(`scripts/disposable-pg/lib/migration-numbering.mjs:14-16`).

**Scope:** this register tracks **number claims only**. It says nothing about whether a migration has
been applied to any database. For deployment state see
`docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md` §4 and the runbooks under `docs/runbooks/`.

**Last reconciled:** 2026-08-02, against `main` = `48230f0` and every local and remote ref in this
clone — including worktrees belonging to concurrent sessions, which is how the short-lived claim on
**45** below was found, and then seen released.

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
| ~~45~~ | ~~`45_COMMERCIAL_AUDIT_LOG_*`~~ | ~~local branch `fix/commercial-audit-log`~~ | **claim released — see below** |
| ~~45~~ | `45_SEAM7_ORGANISATION_EVENT_SPLIT_*` | PR **#120** | **MERGED to `main` 2026-08-02** — now in the taken list |
| 46 | `46_SEAM5_VERIFIED_BUYER_READ_PREDICATE_*` | branch `feature/seam5-verified-read-predicate` | pushed, claimed 2026-08-02 |

**46 closes Seam 5's outstanding half.** `has_organisation_membership()` tests membership and
nothing else, so migration 44's buyer SELECT policies admitted a member of an organisation in any
verification state — suspension changed a column and changed no access. 46 adds
`has_verified_organisation_membership()` and re-points those two policies at it. Measured on
staging before writing it: a suspended buyer really did still read their own reservation.

**45 was re-claimed the same day it was released.** The released claim was for the *reservation* half
of Seam 7, which #115 delivered by amending 44 in place. The re-claim is for the half #115 left
behind: moving `organisation_created` / `organisation_updated` /
`organisation_membership_granted` / `organisation_membership_revoked` out of `compliance_audit_log`
and **narrowing** its vocabulary from 30 values to 26. `organisation_verification_changed` stays.

**Why a new number rather than another in-place amendment of 39/42.** The licence #115 relied on —
"nothing is applied to any database, so there is no history to preserve" — **expired on 2026-08-02**,
when migrations 39–44 were applied to staging `szqo…`. `docs/OPTION_B_SEAM_CONTRACT.md` states that
expiry explicitly. An applied migration is history, not a draft.

**27 and 28 are no longer reserved — both landed on `main`** (rows struck 2026-08-02). The earlier
note that "28 is on PR #73, not PR #44" was correct at the time and is now history; both numbers are
in the taken list above.

**The 31–33 risk paragraph is discharged.** It previously read that the claiming branch "exists only
in this working clone… no remote branch and no pull request", and advised pushing it. That has since
happened: `origin/feature/coa-source-bound-watchtower-review` exists and PR #95 is open. The claim is
now durable and reviewable. It is still a *draft* PR, so it will not appear in a casual scan of
mergeable work — check drafts before assuming 31–33 are free.

### 45 — claimed, then released within the hour. Both halves are worth recording.

**The claim.** `git worktree list` showed a concurrent session holding `fix/commercial-audit-log` in
a sibling worktree of this clone, with no commits and nothing pushed — about to become the **Seam 7
correction** (create `commercial_audit_log`, move the commercial actions out of
`compliance_audit_log`'s vocabulary, re-point the trigger bodies in 39 and 44). **CI could not see
that, GitHub could not see it, and this file's own `git log --all` query could not see it** — that
query finds numbers which already have a file. Only `git worktree list` did.

**The release.** That session committed `bfcdf4f` and did **not** take 45. It amended
`44_RESERVATION_LEDGER_*` in place instead — the migration is already on `main`, but applied to no
database, so editing it yields a clean final schema with no add-then-move churn. That work has since
merged as PR **#115** (`ae057bb`). **45 is therefore free**, and the floor returns to 45.

**Resolved, same day.** That work merged as PR **#115** (`ae057bb`): `commercial_audit_log` is
created inside migration 44 and carries `reservation_created` / `reservation_released`. Seam 7 in
`docs/OPTION_B_SEAM_CONTRACT.md` had specified the opposite — correct forward in 45, do not edit
merged files — and has been amended to record what actually landed and why it was the better call
here: nothing is applied to any database, so there was no history to preserve, and #115 re-ran the
fixtures rather than inheriting them. **That licence ends the moment anything is applied.**

Five events specified as moving are still in `compliance_audit_log` on `main`
(`organisation_created`, `organisation_updated`, `organisation_verification_changed`,
`organisation_membership_granted`, `organisation_membership_revoked`), so the split is partial —
tracked in Seam 7, not here. **No migration number is reserved for it**; whoever finishes it decides
whether it fits in another in-place amendment or needs 45.

**The lesson survives the release.** A claim held for an hour by a branch with no commits was
invisible to every automated check in this repository. Rules 6 and 7 below exist because of it, not
because of the number.

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

**47 and upward.** 45 merged as PR #120 and 46 is claimed by
`feature/seam5-verified-read-predicate` — both on 2026-08-02. See the Reserved table above.

The floor moved from 37 to 45, briefly to 46, back to 45, and then to 46 during 2026-08-02: 37 and 38 (storage
privacy) landed, 39–43 were allocated by the export-hub foundation and 44 by the marketplace
reservation ledger — all of which have since merged to `main` — and the Seam 7 correction claimed 45
and then released it by amending 44 instead. Quoting a free floor of 35 would have invited an author to take a number this very document reserves, recreating
exactly the collision the register exists to prevent.

**The floor moved four times in one day.** Re-run the derivation query rather than trusting the
number written here; a register is only as fresh as its last reconciliation, and this one has been
stale before.

The check must therefore exclude the allocated numbers rather than merely look for files on disk: an
allocation is a *claim*, and a claim is made before the file exists. Numbers 31–33 are claimed by a
branch too (see above), so the honest query is "no file exists **and** no row in the
allocations table claims it":

```
$ git log --all --diff-filter=A --name-only --pretty=format: -- '*.sql' | grep -E '^(4[5-9]|[5-9][0-9])_'
(no output)
```

**Take the next number above the highest CLAIMED one — not the highest number on disk.** As of this
reconciliation the highest number on disk anywhere is 44 and there is no live claim above it, so the
next migration is **45**.

That gap between "highest file" and "highest claim" is the whole point of this file, and it was real
for about an hour today: 45 was claimed by a branch with no commits, which the query above cannot
see, because the query finds numbers that already have a *file*. Re-derive both before claiming.

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
   **Enforced from number 24 up** by `npm run verify:migration-numbers`. Until 2026-08-03 this
   rule was written here and checked nowhere: the gate only ever asked whether two stems shared a
   number, so five HARDENING-only migrations (47–51, written 2026-08-02) passed CI green with no
   VERIFY to show they did what they claim and no ROLLBACK to undo them. Numbers below 24 predate
   the convention and are grandfathered — renaming an applied migration would break the runbooks
   and freeze record that cite it by name.
6. **Run `git worktree list` before claiming.** More than one session works in this clone. A
   sibling worktree can hold a branch that claims a number with no commit, no push and no PR —
   invisible to CI, to GitHub, and to the `git log --all` query, which only sees numbers that
   already have a *file*. This is how 45 was found.
7. **Claim before you write, not when you finish.** A row in this file costs nothing and is the only
   artefact a concurrent session can see. The number is reserved by the claim, not by the SQL.
