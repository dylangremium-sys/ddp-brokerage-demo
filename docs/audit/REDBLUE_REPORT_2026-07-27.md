# DDP brokerage — Red vs Blue, all 11 open PRs

Date: 2026-07-27 · Repo `/Users/mac/DDP AUDIT/ddp-brokerage-demo` · `origin/main` @ `55afcc6`
Production live on `55afcc6` (`curl https://www.ddpbrokerage.com/version.json`)

**Nothing was merged. Nothing was pushed to `main`. No PR was closed. No auto-merge enabled.**

---

## §A. VERDICT — coverage 11 of 11, plus W0

| PR | branch | verdict | one-line reason |
|---|---|---|---|
| **#76** | `chore/gitignore-backups` | **MERGE-READY** | W0, created this session. `.gitignore` only, falsified, zero runtime surface |
| **#73** | `feature/evidence-digest-dedup-provenance` | **OWNER-BLOCKED** | Migration 28 is well-built, but its stated GAP 2 is not closed and it carries an undisclosed 57-line auth rewrite |
| **#72** | `remediation/p0-mutations` | **CLOSE** | 100% absorbed — all 185 added lines already on `main`, both lib files byte-identical |
| **#70** | `audit-017-role-system-security` | **CLOSE** | Security doc quoting three pieces of source that occur **zero** times in the repo |
| **#69** | `audit-016-full-mutation-audit` | **CLOSE** | 3 of 4 headline P0s already fixed on `main`; four confirmed factual errors |
| **#61** | `feat/public-self-signup` | **OWNER-BLOCKED** | Public self-signup is the owner's call; also has no compiling single-side merge resolution |
| **#58** | `docs/release-hardening-2026-07-25` | **CLOSE** | "AUTHORITATIVE" register omits migrations 29/30 and contradicts `main`'s own register |
| **#44** | `security/ddp-audit-remediation` | **OWNER-BLOCKED** | Substantially sound, but rollback-10 still drops migration 29's issuance gate; author says do-not-merge |
| **#43** | `infra/disposable-postgres-migration-harness` | **CLOSE** | Already merged as PR #64. Merging it would *revert* two CI hardening changes |
| **#33** | `fix/demo-admin-entry-routing` | **CLOSE** | DRAFT; the defect it describes no longer exists on `main` |
| **#26** | `fix/buyer-pack-print-gate` | **CLOSE** | Purpose absorbed by PR #32; rebase would silently delete a fail-closed gate |
| **#20** | `chore/staging-smoke-test` | **OWNER-BLOCKED** | Direct opposite of #61; 6 of 7 files already absorbed |

**1 MERGE-READY · 6 CLOSE · 4 OWNER-BLOCKED.** The backlog collapses to **four owner decisions
plus one trivially mergeable PR**.

---

## §B. FINDINGS — most severe first

Findings **F1–F4 are live in production on `main` right now** and are independent of every PR.

### F1 — non-atomic status write tells the operator an approval FAILED that the database ACCEPTED
`src/lib/db.ts:300-308` (farms) and `src/lib/db.ts:402-410` (inventory)

```
300:   await sbUpdate('farms', farmUpdate, 'id', farmId)
302:   await sbInsert('status_history', { entity_type: 'farm', ... })
402:   await sbUpdate('inventory_batches', batchUpdate, 'id', itemId)
404:   await sbInsert('status_history', { entity_type: 'inventory_batch', ... })
```

Two writes, no transaction. `sbInsert` throws unconditionally on any error (`db.ts:28-34`), and
`commitMutation` runs `onCommitted` only if the *whole* promise resolves. When the entity UPDATE
lands and the `status_history` INSERT is refused (RLS/grant), the row is **approved in the
database** while the operator sees an error banner, no list update and no navigation.

**Blast radius:** every farm approval and every inventory approval. This is the exact
inverse-truthfulness failure the AUDIT-015/016/017 programme exists to prevent, and the DB-first
remediation **does not fix it** — both writes are inside the single awaited call. Worse, the
DB-first rewrite is what turned it *into* a lie: before it, the optimistic UI update had already
run, so the UI matched the database.

Raised by a review bot on PR #72 (thread at `App.tsx:816`), never addressed, and the code merged
to `main` unchanged via `a0b0bce`. **Fix status: unfixed. Needs a transactional RPC or
post-failure reconciliation.**

### F2 — rollback of migration 10 destroys migration 29's contaminant-blocker gate
`10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql:78-79` (on `main` **and** on PR #44's head)

```
78: DROP FUNCTION IF EXISTS public.issue_buyer_pack_snapshot(
79:   TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID);
```

Migration 10 explicitly disclaims ownership of that function —
`10_BUYER_PACK_SNAPSHOTS_MVP.sql:256` reads `-- issue_buyer_pack_snapshot() IS NOT DEFINED HERE.`
and points at 23. It is defined by `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql:80` and
redefined by `29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_HARDENING.sql:119`.

The file's own header still claims *"rollback simply removes exactly what
10_BUYER_PACK_SNAPSHOTS_MVP.sql created… It does not touch any pre-existing object."*

PR #44 rewrote this very file for rollback safety and **left the cross-migration DROP in place**.
Its new destructive guard counts rows only in `buyer_pack_snapshots` / `buyer_pack_audit_log` /
`buyer_pack_download_log`, so on any database where those are empty (a fresh staging) the guard
does not fire, the DROP executes, and **both the contaminant-blocker gate and the
server-authoritative issuance gate disappear silently.** PR #44's own new checker reports the
file as `PASS — Rollback safety`.

This is a **disaster-recovery break**, and it is the measured form of the work order's §9.6
inference. **Fix status: unfixed in `main` and in #44.**

### F3 — carbon programme status persists nothing in Supabase mode
`src/App.tsx:861-873` — **two** handlers, not one

```
861: function handleFarmerCarbonExclude(farmId, newStatus) {
862:   setFarms(prev => ...)                        ← UI updated
864:   console.warn('Carbon exclusion: Production persistence requires approved SQL/RLS migration. Local state updated only.')
868: function handleAdminCarbonAction(farmId, newStatus) {   ← identical twin
```

Operator changes carbon programme status, the UI confirms, nothing is written, the change vanishes
on reload. A deliberate placeholder pending an approved migration — so this is an **owner
decision** (persist it, or disable the control), not a bug to silently patch. PR #69 documents
only one of the two handlers.

### F4 — the supplier-signup button is a dead end in production
`src/App.tsx:994` (LandingPage) and `:1015` (LoginPage) both render
`onSupplierSignup={() => goTo('farmer-register')}`, but `src/App.tsx:86` is
`const PUBLIC_PAGES: Page[] = ['landing', 'login']` — `farmer-register` is **not** public — so
`src/App.tsx:584` bounces an unauthenticated Supabase-mode visitor straight back to `login`.

Confirmed exactly as the work order described it. **Leaving it as-is is the one option that is
actively wrong** — see §E owner decision 1.

### F5 — `git merge-tree` conflict markers systematically understate the damage
Demonstrated on #61's merged tree `72a8fb0c`:

```
merged src/App.tsx:  conflict markers at 629, 1027 only
                     but  30: import { T } from './translations'
                          50: import { T } from './translations'     ← duplicate, unmarked
merged LoginPage.tsx: markers at 9/14/20 (Props block only)
                     but 108: onClick={onSupplierSignup}   (main's side)
                         117: onClick={onSignUp}           (#61's side)   ← both survive, unmarked
```

Neither "take main" nor "take the PR" compiles, and a reviewer who resolves every visible marker
still ships a broken file. **The auto-merged regions are where the breakage hides.** This is worse
than §4.1 of the work order anticipated and it applies to every conflicting PR here.

### F6 — the buyer-pack timestamp gate can be deleted by a one-keystroke conflict resolution
`main` has a fourth issuance condition that PR #26 predates:

```
$ git grep -c isRealApprovalTimestamp origin/main -- src
origin/main:src/lib/buyerPackSnapshot.ts:3
origin/main:src/lib/buyerPackSnapshotSupabaseStore.ts:2
$ git grep -c isRealApprovalTimestamp refs/prq/26 -- src
(none)
$ git grep -ln "isRealApprovalTimestamp|no valid approval timestamp" origin/main -- '*test*'
(no test references it)
```

The 3-way merge puts that check inside #26's single `buyerPackSnapshot.ts` conflict hunk, because
#26 moved the surrounding lines into a new predicate. Taking the PR's side yields `tsc` 0, lint 0,
`npm test` green — **and the gate is gone, with no test anywhere able to notice.** Severity:
critical, if #26 is ever rebased.

### F7 — the harness's green CI check does not verify `main`'s migration set
I ran it on `main` (PG 18.4):

```
✓ migration numbering: no collisions
▶ fixture 24_evidence           → VERIFY 18/18 A–R, rollback OK   = passed
▶ fixture negative_broken_apply → apply BROKEN failed AS EXPECTED = expected-failure
ALL FIXTURES GREEN (exit 0)
```

There are exactly **two fixtures**. The real one applies **migration 24 alone** onto a synthetic
`bootstrap/00_supabase_substrate.sql`. It never applies `main`'s set in numeric order, and no
fixture exists for 29 or 30 — so 22 of `main`'s 23 migration numbers have zero runtime coverage.
Nothing gates "every migration has a fixture": PR #44 adds migration 27 with no fixture and would
still show green.

The required gate does not cover it either — `scripts/check-migration-numbers.mjs` tests
**collisions only**. Run on `main` it prints the gap inside its own success message:

```
PASS — 54 numbered migration files across 23 numbers (3, 4, 8, …, 25, 26, 29, 30); no number
claimed by two migrations.
```

**The negative fixture does genuinely fail when it should** — that potential kill is refuted (see
§B.2). The finding is one of *scope*, and it belongs against `main`, not against #43.

### F8 — PR #43 is fully absorbed, and merging it would revert CI hardening
24 of its 25 files are byte-identical blobs on `main`. On the 25th, `main` is strictly ahead:

```
$ git diff --numstat origin/main refs/prq/43 -- .github/workflows/security-ci.yml
0	18	.github/workflows/security-ci.yml
```

Zero insertions. `main` has `fetch-depth: 0` (whose own comment says the collision check "would
pass without having verified anything" without it) and the entire AUDIT-001 step; #43 lacks both.
It landed as PR #64 (`9873e1f`) and was never closed as #43.

### F9 — two security-audit documents assert code that does not exist
PR #70's document quotes `onAuthStateChanged(...)` (a Firebase API) and `applyFarmerScope(...)` as
current `App.tsx` source, and locates the definition of `isSupabaseConfigured` in `App.tsx`.
Measured across every file on `main`:

```
onAuthStateChanged         occurrences=0
applyFarmerScope           occurrences=0
subscribeToAuthChanges     occurrences=4   ← the real handler
src/lib/supabase.ts:10  export const isSupabaseConfigured: boolean = !!(url && key)
```

The threat model is also wrong in consequence: it models only a missing `VITE_SUPABASE_URL`, but a
build with the URL present and the anon key absent *also* enters demo mode. Two of its six findings
were already closed before it was written — the fail-closed prebuild guard shipped 2026-07-19
(`package.json` `prebuild` → `scripts/validate-hosted-supabase-config.mjs`, which requires **both**
vars), and the role-transition race was closed at the PR's own merge base.

This is the same fabrication failure mode that cost a full session before. **A false security
document is worse than none, because it gets cited as authority.**

### F10 — PR #58's "AUTHORITATIVE" register is wrong on the questions it exists to answer
Its §4 production-parity delta has no row for migrations **29 or 30**, both of which are on `main`
and are server-authoritative security gates. Its §3 numbering statement lists `3…26` plus a 27 that
is not on `main`, and omits 29/30 entirely. It records migrations 19–23 as `unknown` while `main`'s
own `docs/MIGRATION_RUNTIME_STATUS.md` closed them on 2026-07-26 and found a real production gap
(migration 22's storage overlay absent). Both files self-declare authority and neither supersedes
the other.

**It is therefore not fit for the leverage role §9.5 hoped for** — landing it early would entrench
the error it was wanted to resolve.

---

## §B.2 REFUTED — Red claims that did not survive

1. **"29 or 30 depends on an object created by 27 or 28, so a from-scratch apply of `main` breaks."**
   (§9.12, the work order's highest-value inference.) **REFUTED.** Migration 27 creates 2 objects,
   28 creates 15; cross-referencing all 17 names against all six `29_*`/`30_*` files on `main`:
   `total references from 29/30 to objects created by 27/28: 0`. The numbering gap is real; the
   predicted disaster-recovery break is not. Independently reached by the #44 and #73 agents.

2. **"The disposable-PG harness green-lights a broken migration."** (§9.7's primary target.)
   **REFUTED by execution.** `negative_broken_apply` fixture → `apply BROKEN failed AS EXPECTED`,
   and the harness has an explicit `EXIT.UNEXPECTED_PASS` (41) branch for the case where a negative
   fixture succeeds. The real finding is narrower (F7: scope, and a dead `exitCode` field).

3. **"#73's migration 28 depends on the absent migration 27."** **REFUTED.** 28 depends on
   migration 24, migration 3/`AUTH_RLS_SCHEMA`, and `FARMER_MVP_MIGRATION` — all on `main`. 27 is
   `27_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_*`, a disjoint surface. #73 can land before or
   after #44.

4. **"#73's VERIFY passes regardless / the prior session's 13/13 claim is inherited."**
   **REFUTED on re-derivation.** VERIFY A enumerates every object and RAISEs on absence, so it
   cannot pass on an unmigrated database; sections C–M each RAISE if their fixture is unbuildable.
   The claim holds *for what it covers* — the residual finding is that it passes over four things
   it implies it covers.

5. **"#44's 24 outdated threads are concerns that aged out unaddressed."** **REFUTED.** All 24 are
   `deepsource-io` style nits, and all 24 were genuinely fixed by commit `64dd896`; `DeepSource:
   JavaScript` is SUCCESS on that head while it FAILS on `main`. Zero human review comments exist
   on #44.

6. **"#20's guard test is a well-built regression lock that can simply be cherry-picked."**
   **PARTIALLY REFUTED.** Assertion `LoginPage.test.ts:33` (`not.toMatch(/signup/i)`) **fails
   against `main`**, which has `onSupplierSignup` at LoginPage lines 9, 12, 100 and the literal
   `'Supplier signup'` at 102. The test must be narrowed before any part of #20 is reused.

7. **"The case-only filename collision is an index-level corruption risk."** **DOWNGRADED.** Git's
   tree merge is case-sensitive and `main` has neither file, so #20's delete is a both-sides-deleted
   no-op. `core.ignorecase=true` is confirmed, so the risk is real but **working-tree-only**, and
   only if one PR is rebased onto the other in a shared macOS checkout. Also: the work order's
   filename was wrong — the tracked path is `SignupPage.tsx`, not `Signuppage.tsx`.

8. **My own thread counts were wrong.** My first GraphQL script passed the literal string `"null"`
   as the `after` cursor, silently dropping one node per page and producing a systematic −1 on every
   PR. Caught by cross-checking #70 against `totalCount`. Corrected numbers are in §C.

---

## §C. VERIFICATION MATRIX

| # | Claim | Command | Result | Verdict |
|---|---|---|---|---|
| 1 | `main` @ 55afcc6, 11 open PRs | `git log --oneline -1 origin/main` / `gh pr list` | identical to work order | CONFIRMED |
| 2 | Production live on 55afcc6 | `curl .../version.json` | `commitShaShort 55afcc6`, builtAt 2026-07-26T20:10:53Z | CONFIRMED |
| 3 | Baseline gates green | `npm test`, `tsc -b`, `lint`, `build`, collision check | 2091 passed / 6 skipped / 99 files; all exit 0 | CONFIRMED |
| 4 | Branch protection | `gh api .../branches/main/protection` | `enforce_admins:true, required_reviews:null, strict:true, contexts:["Static security & build checks"]` | CONFIRMED |
| 5 | Only one required check | `gh pr checks 73` | DeepSource JS **fail**, SQL/Secrets pass, `Static security & build checks` pass, Vercel + disposable-PG advisory | CONFIRMED |
| 6 | Migrations on `main` | `git ls-tree -r origin/main \| grep .sql` | `3,4,8..26,29,30` — no 27, no 28 | CONFIRMED |
| 7 | NUL-byte files | `python3` byte count | DDPBuyerPreview 63532 B / 2 NUL; procurementControl 19468 B / 1 NUL | CONFIRMED |
| 8 | `grep` returns a false zero | `grep -c localStorage src/lib/procurementControl.ts` | no output, exit 1 (true count 6) | CONFIRMED |
| 9 | ahead/behind/files/conflicts, all 11 | `git merge-tree --write-tree --name-only` per PR | identical to work order for all 11 | CONFIRMED |
| 10 | Review threads | corrected GraphQL pagination | **250 unresolved / 206 live** (doc: 160/121) | **DRIFT** |
| 11 | #43 thread count + authorship | full pagination + author tally | 190 total, 175 live, **190/190 `deepsource-io`**, zero humans | CONFIRMED |
| 12 | W0 changes behaviour | `git ls-files --others --exclude-from=<main .gitignore>` | before: 2 dumps listed; after: none | CONFIRMED |
| 13 | #43 fully absorbed | blob-SHA compare of all 25 files | 24 IDENTICAL; 25th: `main` +18 lines | CONFIRMED |
| 14 | #72 fully absorbed | 185 added App.tsx lines vs `main` | 0 not present on `main`; 11 vs 11 `commitMutation` sites | CONFIRMED |
| 15 | 29/30 ⇸ 27/28 dependency | name cross-reference of 17 objects | 0 references | CONFIRMED (refutes §9.12) |
| 16 | Harness scope | `run-migration-harness.mjs --all --ci` + fixture read | 2 fixtures; real one applies migration 24 only | CONFIRMED |
| 17 | Gap detection absent | `grep -niE "gap\|contiguous\|sequence" lib/migration-numbering.mjs` | no output | CONFIRMED |
| 18 | F1 non-atomic write | `git show origin/main:src/lib/db.ts` lines 294-312, 396-412, 26-36 | verbatim as quoted | CONFIRMED |
| 19 | F2 rollback-10 overreach | `git show refs/prq/44:10_*_ROLLBACK.sql` + `git grep CREATE...issue_buyer_pack_snapshot` | DROP at :78-79; owned by 23:80 and 29:119 | CONFIRMED |
| 20 | F3 carbon handlers | `git show origin/main:src/App.tsx` 855-880 | both handlers, no persistence | CONFIRMED |
| 21 | F4 dead-end signup | `grep -n` on App.tsx / types.ts / `ls src/pages/public/` | every cited line matches | CONFIRMED |
| 22 | F5 unmarked merge damage | `git merge-tree` tree `72a8fb0c`, then `git show` | duplicate import at 30/50; both props at 108/117 | CONFIRMED |
| 23 | F6 timestamp gate | `git grep isRealApprovalTimestamp` main vs #26 vs tests | main 5 refs / #26 none / **0 tests** | CONFIRMED |
| 24 | F9 fabricated quotes | repo-wide Python scan on `main` | `onAuthStateChanged` 0, `applyFarmerScope` 0 | CONFIRMED |
| 25 | Prebuild fail-closed guard exists | `package.json` prebuild + validator source | requires **both** vars; hosted-only | CONFIRMED |
| 26 | Signup filenames | `git diff --name-status` both PRs | #20 deletes `SignupPage.tsx`; #61 adds `SignUpPage.tsx` | CONFIRMED (work order said `Signuppage.tsx`) |

---

## §D. WHAT I COULD NOT CHECK

1. **Live database state — anywhere.** There are no production or staging credentials on this
   machine. Every statement above about applied migrations is quoted from a repository document
   with attribution, never asserted as measured fact. F1 and F2 are confirmed as **code paths**;
   the RLS/grant configuration that triggers F1, and the row-emptiness that disarms F2's guard, are
   unverified against any live database.
2. **The DeepSource issue list.** Not exposed by the GitHub API; it lives in the DeepSource
   dashboard. `DeepSource: JavaScript` fails on `main` and is advisory. I did not "fix" any `void`
   floating-promise idiom.
3. **A true from-scratch apply of `main`'s migration set.** F7 establishes that nothing in CI does
   this and no fixture exists for it. My refutation of §9.12 (item §B.2.1) is **name-based static
   analysis of HARDENING files**, not a live apply. A real from-scratch run would be stronger, and
   is the single most valuable experiment left.
4. **Browser-rendered behaviour.** F4's dead-end, #26's print cascade, and #33's demo-admin
   reachability are all confirmed by reading the render tree, not by driving a browser.
5. **Vercel production env vars.** Whether `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are set in
   the Production environment is not knowable from here. It matters: if they are unset, demo mode
   grants `isAdminRole` unconditionally. `vercel env ls production` settles it.
6. **Post-merge CI on any PR.** `strict: true` means every PR must be brought up to date before
   merging, so all existing green checks are stale. No PR's gates were re-run on an updated tree.
7. **The 175 live threads on #43 were not read individually** — 10 were read in full, the rest
   classified mechanically by severity, title, path and line. All 190 are bot-authored.

---

## §E. NEXT ACTIONS

### E0 — merge W0 first
**PR #76** (`chore/gitignore-backups`). `.gitignore` only, four added lines, no runtime surface,
independent of everything else. **One production deploy.** Until it lands, any `git add -A` in this
repo stages 856 KB of real staging rows.

### E1 — close six PRs (zero deploys, clears 96% of the review backlog)
Recommended CLOSE, with the re-filing each one requires:

| PR | close because | must re-file first |
|---|---|---|
| **#43** | merged as #64; merging would revert CI hardening | nothing — all 190 threads are bot style nits that DeepSource re-raises against `main` automatically |
| **#72** | 100% absorbed | **two review threads**: the `handleFarmSubmit` late-commit-after-auth-scope-change race, and F1 |
| **#26** | purpose absorbed by #32; rebase risks F6 | the fail-closed CSS posture, `beforeprint` provenance and print ink — ~40 lines written fresh on `main` |
| **#33** | DRAFT; defect no longer exists | nothing |
| **#69** | 3 of 4 P0s already fixed; four factual errors | **F3** (carbon persistence) as an issue |
| **#70** | quotes non-existent source; 2 findings pre-closed | the migration-22 production storage-overlay gap — already recorded accurately in `main`'s `MIGRATION_RUNTIME_STATUS.md` |
| **#58** | register wrong on arrival | its one unique claim (production has 25/26, staging does not) folded into `MIGRATION_RUNTIME_STATUS.md` |

Closing these clears **~198 of the 206 live threads** and costs **zero production deploys**.
I have not closed any of them — that is your action.

### E2 — four owner decisions
1. **Public self-signup: #61 or #20?** Given F4, the real question is *make the existing dead-end
   button work, or remove the button*. **Leaving it as-is is the one option that is actively
   wrong.** Note #61 additionally reverses a control migration 21 documents as its own companion
   ("disable *Allow new users to sign up*"), and #61's server-side safety actually rests on
   migration 22 — which its body never cites. Neither team picked a side.
2. **Carbon programme status (F3)** — persist it behind a migration, or disable the control. It
   currently lies to the operator.
3. **#73's data model** — should the COA path write `public.farmer_documents` rows (nothing in 193
   `src/`+`api/` files does today), and should a >8 s profiles query silently de-authenticate a live
   session? Both are product calls inside an otherwise well-built migration.
4. **#44 merge timing** — its author states "do not merge yet; migration 27 has not been applied to
   any database". Merging ahead of a verified staging apply is your call. **F2 should be fixed
   first regardless.**

### E3 — fix the two live production defects
**F1** (non-atomic status write) and **F2** (rollback-10 overreach) are the highest-value work on
the board and neither belongs to any open PR. F1 needs a transactional RPC or post-failure
reconciliation; F2 needs the `DROP FUNCTION` removed from migration 10's rollback and the guard
widened.

### E4 — the structural fix (the actual cause of the pile-up)
`strict: true` + deploy-on-merge makes merging both serialized and expensive, so PRs accumulate
faster than they drain. Fixing them one at a time loses the same race again. Two options:

- **A GitHub merge queue** — keeps `strict` semantics without forcing a manual rebase per PR.
- **Decouple deploy from merge** — trigger `deploy-production` on a tag or `workflow_dispatch`
  rather than `push: main`. This is the higher-value change: it removes the coupling that makes
  every merge a production event, and it would let the docs-only PRs land in a batch.

Also worth adding, given F7: a CI gate requiring every numbered migration to register a harness
fixture, and gap (not just collision) detection in `check-migration-numbers.mjs`.

### E5 — recommended order and deploy count
```
1. #76  (W0)                                    → 1 deploy
2. close #43, #72, #26, #33, #69, #70, #58      → 0 deploys
3. owner decisions E2.1–E2.4                    → 0 deploys
4. F2 fix, then F1 fix                          → 2 deploys
5. #44 and #73 after their owner decisions      → 2 deploys
6. #61 xor #20 after decision E2.1              → 1 deploy
```
**Seven deploys total, versus eleven for the naive path** — and the first is a one-line `.gitignore`
change rather than a migration.

---

## Local state I created (for cleanup)

- **Branch `chore/gitignore-backups`** @ `c38d58b` — pushed to origin, opened as **PR #76**. The
  only remote object I created.
- **`refs/prq/1..11`** — 11 local refs holding each PR head, used for read-only merge-tree analysis.
  Delete with `git for-each-ref --format='%(refname)' refs/prq/ | xargs -n1 git update-ref -d`.
- **Scratchpad** `/private/tmp/claude-501/-Users-mac/76a81e48-.../scratchpad/` — brief, findings,
  baseline output. Outside your project.
- `scripts/disposable-pg/.artifacts/` was created by my harness run and **has been deleted**.
- Working tree is clean apart from the untracked `backups/` (which PR #76 addresses).

**Not touched, as instructed:** `wip/override-undecided-parked` @ `449d1d9`, `stash@{0}`, and the
second clone at `/Users/mac/ddp-inventory-demo`.

**Pre-existing loose state you may want to clear** (not mine): four stale worktrees from earlier
sessions still hold branches checked out — `wt-p0`, `wt43`, `wt44`, `wtdocs`, `wtunion` under two
old session scratchpad directories (`git worktree list`). Plus the prior-session branches
`*-rebased`, `integration/pr43-plus-pr44`, `audit-001-merge-pr43-rebased`.
