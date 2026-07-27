# DDP brokerage — remediate what the Red/Blue exercise found

You are Fable, operating on a live repository whose `main` branch **auto-deploys to production**.
Read §1 before you form any intention to merge anything.

The audit is done. This is the **fix** order. A prior session ran a full Red/Blue exercise across
all 11 open PRs and produced verdicts; your job is not to re-audit the board, it is to land the
work that exercise identified and could not itself land.

**Provenance:** everything below was measured in a terminal on 2026-07-27, `origin/main` @
`55afcc6`. **FACT** = measured, command given. **INFERENCE** = reasoned, never run — testing it is
your job. **Where your measurement disagrees with this document, the measurement wins, and say so
in your report.** The prior session found four factual errors in *its* own briefing document by
doing exactly that.

Full prior report: `~/Desktop/DDP_REDBLUE_REPORT_2026-07-27.md`. Read it before Phase 0 — but
treat it as evidence, not authority.

---

## 0. Mission

Five deliverables, in priority order:

1. **Fix F2** — a disaster-recovery break: rolling back migration 10 destroys migration 29's
   contaminant-blocker gate. Concrete, bounded, and nobody's product decision.
2. **Fix F1** — approvals that succeed in the database report failure to the operator. Live in
   production. Needs a design call from you, then implementation.
3. **Close the CI blind spots (F7)** that let both of the above stay invisible.
4. **Re-file, then recommend closing, six obsolete PRs** — the re-filing is the load-bearing part;
   closing without it silently discards real findings.
5. **Escalate four owner decisions** with a crisp comparison, and decide none of them.

**The single non-negotiable: you do not merge.** See §1.

---

## 1. THE PRODUCTION HAZARD — read before anything

**FACT** (`.github/workflows/security-ci.yml`, job `deploy-production`): every push to `main` is a
production deployment.

```
$ curl -s https://www.ddpbrokerage.com/version.json
{"version":"0.0.0","builtAt":"2026-07-26T20:10:53.172Z",
 "commitSha":"55afcc60d73d2ace6b249ae4bcb5e332bb4adc5b","commitShaShort":"55afcc6"}
```

Production is live on exactly `main`'s HEAD. Verify this again yourself — if it has drifted,
something deployed outside CI and that is your first finding.

### Rules of engagement — violations invalidate the whole exercise

1. **DO NOT MERGE ANY PR.** Not `gh pr merge`, not `--auto`, not by pushing to `main`.
2. **DO NOT PUSH TO `main`.** Ever, for any reason.
3. **DO NOT enable auto-merge** on anything.
4. **DO NOT close any PR.** Recommend CLOSE with evidence; the owner closes.
5. **DO NOT force-push an existing PR branch** without first stating exactly which commits the
   force-push would discard and getting explicit go-ahead.
6. **DO NOT `git add -A` or `git add .`** — see §6. Stage explicit paths only.
7. **Opening issues and opening PRs from new branches is authorised** and is most of the job.

Your deliverable is **pushed branches, opened PRs, filed issues, and a recommended order** — not
merges.

---

## 2. Ground truth

**FACT:**

```
repo    /Users/mac/DDP AUDIT/ddp-brokerage-demo
origin  https://github.com/dylangremium-sys/ddp-brokerage-demo.git
main    55afcc6
```

**FACT — a second clone of the same origin exists at `/Users/mac/ddp-inventory-demo`** (@ `ac753d4`).
Both have `package.json` name `ddp-inventory-demo`. Confirm `git remote -v` **and** `pwd` before
touching anything.

**FACT — baseline on `main` @ 55afcc6, each gate run separately:**

```
npm test        →  2091 passed | 6 skipped | 0 failed   (99 files passed, 2 skipped)
npx tsc -b      →  exit 0
npm run lint    →  exit 0
npm run build   →  exit 0
node scripts/audit-001-check-migration-collisions.mjs  →  no collisions (41 refs)
```

Nothing you do may reduce this.

**FACT — branch protection:**

```json
{"enforce_admins": true, "required_approving_reviews": null,
 "strict": true, "contexts": ["Static security & build checks"]}
```

No human approval is required. **Exactly one status check gates a merge.** DeepSource, Vercel and
the disposable-Postgres job are advisory. `DeepSource: JavaScript` currently FAILS on `main`,
pre-existing. **A `void` prefix on floating promises is house idiom here, not a defect — never
"fix" those.**

**FACT — migrations on `main`: `3, 4, 8..26, 29, 30`. No 27, no 28.** (27 lives in PR #44, 28 in
PR #73.)

**FACT — the disposable-PG harness runs locally.** It needs real Postgres *server* binaries, not
Docker:

```
PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.4/bin \
  node scripts/disposable-pg/run-migration-harness.mjs --all --ci
```

Verified green on `main` this session (`ALL FIXTURES GREEN`, exit 0). It writes evidence into
`scripts/disposable-pg/.artifacts/` — gitignored; delete it when you are done.

**FACT — there are NO production or staging database credentials on this machine.** Assert nothing
about live database state. Quote repository documents with attribution instead.

---

## 3. W1 — fix F2: rollback of migration 10 destroys migration 29's gate

**Highest priority. Bounded, decision-free, and a genuine disaster-recovery break.**

**FACT:**

```
$ git show origin/main:10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql | grep -n -A1 "DROP FUNCTION IF EXISTS public.issue_buyer_pack_snapshot"
78:DROP FUNCTION IF EXISTS public.issue_buyer_pack_snapshot(
79-  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID);

$ git show origin/main:10_BUYER_PACK_SNAPSHOTS_MVP.sql | sed -n '255,260p'
-- issue_buyer_pack_snapshot() IS NOT DEFINED HERE.
-- The authoritative, server-authoritative definition lives in
--   23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql  (CREATE at :80, ACLs at :192-196)

$ git grep -n "CREATE OR REPLACE FUNCTION public.issue_buyer_pack_snapshot" origin/main -- '*.sql'
23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql:80
23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_ROLLBACK.sql:23
29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_HARDENING.sql:119
29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_ROLLBACK.sql:40
```

Migration 10's rollback drops a function migration 10 explicitly says it does not own. The live
definition is migration 29's — the contaminant-blocker gate. The rollback file's own header still
claims *"It does not touch any pre-existing object."*

**FACT — PR #44 rewrote this exact file for rollback safety and left the DROP in place.** Its new
destructive guard counts rows only in `buyer_pack_snapshots`, `buyer_pack_audit_log` and
`buyer_pack_download_log`, so on any database where those are empty the guard does not fire. Its
own new checker reports the file as `PASS — Rollback safety`.

**Your job:**

1. Remove the cross-migration `DROP FUNCTION` from `10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql`, or scope
   it so it cannot execute when 23/29 own the object. Decide which and justify it.
2. Correct the file header's false claim.
3. **Add a check to `scripts/check-security-migrations.mjs` that would have caught this** — a
   rollback must not DROP an object it does not create. This is the part that matters: the existing
   gate blessed the file.
4. **Falsify it.** Re-introduce the DROP, watch your new check fail, restore it, watch it pass.
   State both outcomes with output. A check that is green on both sides of the change tests nothing.
5. Prove it end-to-end on real Postgres:
   ```
   PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.4/bin node scripts/disposable-pg/run-migration-harness.mjs --all --ci
   ```
   then apply the migration corpus, run rollback 10, and confirm
   `SELECT to_regprocedure('public.issue_buyer_pack_snapshot(text,text,text,timestamptz,text,text,text,jsonb,uuid)');`
   is **not** NULL afterwards. Paste the output.

Branch `fix/rollback-10-cross-migration-drop`. Its own PR. Do not bundle it.

**Coordination note:** PR #44 also modifies this file. Say explicitly in your PR body how your
change interacts with #44 — whether #44 should be rebased onto yours, or yours folded into #44.

---

## 4. W2 — fix F1: approvals that succeed are reported as failures

**Live in production. This is the defect the entire AUDIT-015/016/017 programme exists to prevent,
and the DB-first remediation did not fix it.**

**FACT** — `src/lib/db.ts`:

```
298:  const farmUpdate = { status: newStatus, updated_at: ... }
300:  await sbUpdate('farms', farmUpdate, 'id', farmId)
302:  await sbInsert('status_history', { entity_type: 'farm', ... })
...
402:  await sbUpdate('inventory_batches', batchUpdate, 'id', itemId)
404:  await sbInsert('status_history', { entity_type: 'inventory_batch', ... })
```

```
28: async function sbInsert(table, data): Promise<void> {
29:   const { error } = await supabase!.from(table).insert(data)
30:   if (error) { console.error(...); throw new Error(error.message) }
```

Two writes, no transaction. `commitMutation` (`src/lib/mutationCommit.ts`) runs `onCommitted` only
if the whole promise resolves. So when the entity UPDATE lands and the `status_history` INSERT is
refused, **the row is approved in the database while the operator sees an error banner, no list
update and no navigation.**

**FACT — a review bot raised this on PR #72 (thread anchored at `App.tsx:816`), it was never
addressed, and the code merged to `main` unchanged via `a0b0bce`.**

**INFERENCE, worth stating plainly in your report:** the DB-first rewrite is what turned this into
a lie in the operator's direction. Before it, the optimistic `setFarms` had already run, so the UI
matched the database. Test that reading against the merge-base if you want to assert it.

**Your job — the design call is yours, but justify it:**

- **Option A: a transactional RPC.** Move the status change + history insert into one
  `SECURITY DEFINER` function so they commit or fail together. Cleanest, but it is a new migration
  (number **31**, since `main` ends at 30 — confirm before choosing a number) and migrations on this
  repo are not applied anywhere without an owner decision.
- **Option B: reconciliation.** Keep two writes; on history-insert failure, report the *status
  change* as succeeded and the audit-trail write as degraded, distinctly. No migration; weaker
  guarantee; honest to the operator.
- **Option C:** something better. Say why.

**Constraint:** whatever you pick, a test must fail if the fix is reverted. `src/lib/db.ts` has no
direct test coverage of this path today — check before you claim otherwise.

**FACT — this repo's house disease is tests that pass over the defect they claim to cover.** It has
happened at least four times (`buyerPreviewApprovedList.test.ts:223`, migration 29's VERIFY B9, a
Codex P1, the approved-list gate). **Assume it is present in whatever you write.** For every test
you add, state: *would this fail if I reverted the fix?* — and prove it.

Branch `fix/status-history-atomicity`. If you choose Option A, the migration goes in the same PR as
the code, and the PR body must say plainly that the migration is **unapplied to any database**.

---

## 5. W3 — close the CI blind spots (F7)

**FACT — the required gate checks migration-number COLLISIONS only, never gaps.** Run on `main` it
prints the gap inside its own success message:

```
$ node scripts/check-migration-numbers.mjs
PASS — 54 numbered migration files across 23 numbers (3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
18, 19, 20, 21, 22, 23, 24, 25, 26, 29, 30); no number claimed by two migrations.
exit=0
```

```
$ grep -niE "gap|contiguous|sequence|missing|skip" scripts/disposable-pg/lib/migration-numbering.mjs
(no output)
```

**FACT — the disposable-PG harness has exactly two fixtures**, and the real one applies **migration
24 alone** onto a synthetic `bootstrap/00_supabase_substrate.sql`:

```
$ ls scripts/disposable-pg/fixtures/
24_evidence.json    negative_broken_apply.json    sql/
```

So 22 of `main`'s 23 migration numbers have zero runtime coverage, and the CI check named
**"Disposable PostgreSQL migration verification"** shows green having verified none of them. PR #44
adds migration 27 with no fixture and would still be green.

**FACT — the negative fixture genuinely works.** `apply BROKEN failed AS EXPECTED`, and the harness
has an explicit `EXIT.UNEXPECTED_PASS` (41) branch. Do not "fix" that; it is correct.

**Your job:**

1. Add **gap detection** to the migration-number check — warn or fail on a non-contiguous sequence,
   with an allowlist mechanism for deliberate reservations (27/28 are currently reserved by open
   PRs #44 and #73, so a hard failure today would red every PR).
2. Add a gate requiring **every numbered migration to register a harness fixture**, or an explicit
   recorded exemption. Land the gate; do not try to write 22 fixtures.
3. **INFERENCE to test:** `negative_broken_apply.json` declares `"expectFailure": {"phase":"apply",
   "exitCode":10}`, and the prior session reports that `.exitCode` is never read — so any non-zero
   exit counts as the expected failure. Verify by reading
   `scripts/disposable-pg/run-migration-harness.mjs` around lines 121/183/191/291. If true, assert
   on the failure *message*, as the destructive guard already does with `expectRefusalMatch`.
4. Falsify each gate as in §3.4.

Branch `ci/migration-sequence-and-fixture-gates`. Separate PR from W1 and W2.

---

## 6. Traps — each has already cost a session

**FACT — `grep` and `ripgrep` silently lie about two files on `main`:**

```
src/pages/admin/DDPBuyerPreview.tsx   2 NUL bytes  (63532 bytes)
src/lib/procurementControl.ts         1 NUL byte   (19468 bytes)
```

```
$ grep -c localStorage src/lib/procurementControl.ts
(no output)   exit=1        ← true count is 6
```

`git diff`, `git show` and `git merge-tree` are unaffected. Search those files with Python:

```python
import subprocess, re
text = subprocess.run(['git','show','origin/main:src/lib/procurementControl.ts'],
                      capture_output=True).stdout.decode('utf-8','replace')
for i, line in enumerate(text.splitlines(), 1):
    if re.search(PATTERN, line): print(f'{i}: {line}')
```

**FACT — `git merge-tree` conflict markers systematically understate the damage.** Demonstrated on
PR #61's merged tree `72a8fb0c`: markers appear at `App.tsx` 629 and 1027, while a duplicate
`import { T } from './translations'` lands at lines **30 and 50** with no marker, and in
`LoginPage.tsx` both `onClick={onSupplierSignup}` (108) and `onClick={onSignUp}` (117) survive
below the marked Props block. **A reviewer who resolves every visible marker still ships a file
that does not compile.** If you resolve any conflict, diff the *merged result* against both parents
— never trust the markers alone.

**FACT — `vitest` does not typecheck.** A green `npm test` says nothing about `npx tsc -b`.

**FACT — `tsc` errors mask each other.** Never report a type error fixed after one clean edit;
re-run to exit 0 and paste it.

**FACT — untracked production-shaped data is in the working tree:**

```
backups/staging_pre_reset_20260724_220215.dump       428257 bytes
backups/staging_pre_userdelete_20260724_231605.dump  428257 bytes
```

Real staging rows. **PR #76 (already open, `chore/gitignore-backups`) adds the ignore rule.** Until
the owner merges it, `git add -A` stages 856 KB of real data. Never use it.

**FACT — fabrication has happened on this repo, twice.** A prior handover cited invented file
hashes; PR #70's security document quotes `onAuthStateChanged` and `applyFarmerScope`, which occur
**zero** times anywhere in the repo. **Any claim in your report without a command and its literal
output will be treated as fabricated.**

---

## 7. W4 — re-file, then recommend closing, six PRs

**The re-filing is the load-bearing part.** Closing first discards real findings silently.

**FACT — verdicts from the prior exercise, each independently re-derived at blob level:**

| PR | close because | **re-file this first** |
|---|---|---|
| **#43** | 24 of 25 files byte-identical to `main`; landed as PR #64 (`9873e1f`). On the 25th, `main` is **18 lines ahead** — merging would revert `fetch-depth: 0` and the AUDIT-001 step | nothing — all 190 threads are `deepsource-io` style nits, zero humans |
| **#72** | all 185 lines it adds to `App.tsx` already on `main`; both lib files byte-identical; 11 vs 11 `commitMutation` sites | **two threads**: the `handleFarmSubmit` late-commit-after-auth-scope-change race, and F1 |
| **#26** | purpose absorbed by PR #32 | the fail-closed CSS posture, `beforeprint` provenance, print ink — ~40 lines written fresh on `main` |
| **#33** | DRAFT; the defect it describes no longer exists | nothing |
| **#69** | 3 of 4 headline P0s already fixed on `main`; four confirmed factual errors | **F3** (carbon persistence) |
| **#70** | quotes source that does not exist; 2 of 6 findings pre-closed | migration 22's absent production storage overlay |
| **#58** | "AUTHORITATIVE" register omits migrations 29/30 from its parity delta | its one unique claim (production has 25/26, staging does not) folded into `docs/MIGRATION_RUNTIME_STATUS.md` |

**Verify each obsolescence claim yourself before filing anything.** The cheap decisive test:

```bash
BASE=$(git merge-base origin/main refs/prq/NN)   # or origin/pull/NN/head
git diff --name-only $BASE refs/prq/NN | while read f; do
  a=$(git rev-parse refs/prq/NN:"$f" 2>/dev/null); b=$(git rev-parse origin/main:"$f" 2>/dev/null)
  [ "$a" = "$b" ] && echo "IDENTICAL $f" || echo "DIFFERS   $f"
done
```

**Do not close any PR.** File the issues, then post one comment per PR stating the evidence and
recommending closure, and list them in your report for the owner.

**F3 detail, for the issue you file** — `src/App.tsx:861-873`, **two** handlers, not one:

```
861: function handleFarmerCarbonExclude(farmId, newStatus) { setFarms(...); console.warn('... Local state updated only.') }
868: function handleAdminCarbonAction(farmId, newStatus)   { setFarms(...); console.warn('... Local state updated only.') }
```

Operator changes carbon status, UI confirms, nothing persists, change vanishes on reload. It is a
deliberate placeholder pending an approved migration — so it is an **owner decision** (§8), not a
bug for you to quietly fix.

---

## 8. Owner-fenced — analyse fully, decide nothing

**Four decisions. Produce the comparison, escalate, and sequence everything else so it proceeds
while they are pending.**

1. **Public self-signup: PR #61 or PR #20?** They are direct opposites.
   **FACT** — the live state on `main` is the one option that is actively wrong:
   `src/App.tsx:994` and `:1015` both render `onSupplierSignup={() => goTo('farmer-register')}`,
   but `src/App.tsx:86` is `PUBLIC_PAGES = ['landing','login']` and `:584` bounces any non-public
   page to `login` when `!isDemo && !isSignedIn`. **The button is live in production and dead-ends
   for exactly the users it targets.** So the real question is: make the existing button work, or
   remove the button.
   Two facts the owner needs and neither PR body states: #61's server-side safety actually rests on
   migration **22**, which its body never cites; and #61 requires enabling a Supabase toggle that
   `21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql:21-24` documents as a companion control of
   migration 21's own hardening.
2. **Carbon programme persistence (F3)** — persist behind a migration, or disable the control.
3. **PR #73's data model** — should the COA path write `public.farmer_documents` rows? **FACT:
   nothing in 193 `src/`+`api/` files does today**, which is why #73's stated GAP 2 is not closed
   and its VERIFY M only passes by inserting that row itself. Also: should a >8 s profiles query
   silently de-authenticate a live operator session (#73's undisclosed `auth.ts` change)?
4. **PR #44 merge timing** — its author states "do not merge yet; migration 27 has not been applied
   to any database." **Fix F2 first regardless** (§3).

**Do not pick a side on any of these.** Produce what each option does, what breaks under the other,
and which PRs become obsolete under each.

---

## 9. The structural recommendation

**FACT:** `strict: true` + deploy-on-merge makes merging both serialized and expensive, so PRs
accumulate faster than they drain. **One merge invalidates every other open PR.** A remedy that
fixes them one at a time loses the same race again.

Include a recommendation in your report. The prior session's view, which you should test rather
than inherit: **decoupling deploy from merge** (tag or `workflow_dispatch` instead of `push: main`)
is worth more than a merge queue here, because it removes the coupling that makes every merge a
production event and would let docs-only PRs land as a batch. Argue for or against it with evidence.

---

## 10. Method

**Phase 0 — Recon (no fan-out).** Re-measure §2. `main` may have moved; PR #76 may have merged.
State every drift from this document before continuing. Do not start on stale facts.

**Phase 1 — W1 (F2).** Serial. Fix → falsify → all five gates green → real-Postgres proof → push
branch → open PR → report. Then stop.

**Phase 2 — W3 (CI gates).** Same discipline. Independent of W1; may be parallelised only with
`isolation: "worktree"`, and prefer serial.

**Phase 3 — W2 (F1).** The design call first, stated and justified, *then* implementation. This is
the one place where getting it wrong is worse than not doing it — if you cannot make a test that
fails on revert, say so and stop rather than shipping a fix nobody can verify.

**Phase 4 — W4 (re-file + close recommendations).** Verify each obsolescence claim independently
before filing.

**Phase 5 — Report.** §11 format.

**Rules throughout:**

1. **No claim without a command and its output.**
2. **Falsify every fix** — re-introduce the defect, watch the new test fail, restore, watch it
   pass. State both outcomes.
3. **Cite `file:line`.** Never invent hashes, line numbers or counts.
4. **Never reduce the baseline** (§2).
5. **Nothing merges. Nothing is pushed to `main`. No PR is closed.**
6. **No silent scope reduction.** If you land 2 of 4 work items, your §A says "2 of 4" and names
   what you dropped and why.

If your session carries a workflow-size guideline, respect it by **narrowing the work set and
saying which items you dropped**, never by thinning verification. A verified fix for F2 alone beats
four unverified ones.

---

## 11. Report format

- **§A. WHAT LANDED** — one line per work item: branch, PR number, state. Coverage ("4 of 4" or
  "2 of 4 — dropped W2/W3 because …") stated here, not buried.
- **§B. FINDINGS** — anything new you found, most severe first: what is wrong, `file:line`,
  reproduction, blast radius, fix status.
- **§B.2 REFUTED** — every claim in *this document* that your measurement contradicted. **This
  section is mandatory.** A remediation pass that refutes nothing in its own briefing did not check
  it.
- **§C. VERIFICATION MATRIX** — one row per assertion: claim │ command │ result │
  CONFIRMED/PLAUSIBLE. Every fix you made and every FACT you relied on.
- **§D. WHAT I COULD NOT CHECK** — explicitly, with the reason. Live database state and the
  DeepSource issue list belong here unless the owner supplied access.
- **§E. NEXT ACTIONS** — dependency-ordered sequence with its production-deploy count; the four
  owner decisions (§8); close recommendations with the issues you filed for each; the §9
  structural recommendation.

Then, separately: **local state you created** — branches, worktrees, refs, issues, PRs — so the
owner can clean up.

---

## 12. Loose state you will trip over

**FACT:**

- **PR #76** (`chore/gitignore-backups`, `c38d58b`) is open and merge-ready — the `backups/` ignore
  rule. Not yours to merge.
- `wip/override-undecided-parked` @ `449d1d9` — **local-only, never pushed.** Holds two undecided
  product calls and 225 lines of test code. Do not delete, merge or push.
- `stash@{0}` — *"On fix/test-path-resolution: procurementDecisionStore fail-closed edits"*.
  Unexamined. Leave it.
- `refs/prq/*` — 11 PR heads fetched by the prior session for merge-tree analysis. Reuse them;
  they save a fetch. Harmless.
- **Five stale worktrees from earlier sessions still hold branches checked out** — `wt-p0`, `wt43`,
  `wt44`, `wtdocs`, `wtunion` under two old scratchpad directories. `git worktree list`. They are
  why `git branch` shows `+` markers. Not yours; report them, do not silently prune.
- Prior-session branches `*-rebased`, `integration/pr43-plus-pr44`, `audit-001-merge-pr43-rebased`.

---

**Final instruction.** This document is evidence, not authority. Where it says FACT, a command is
given — run it. Where it says INFERENCE, someone reasoned it and never tested it; testing it is the
job. Where your measurement disagrees, **the measurement wins**, and reporting that disagreement is
among the most valuable things you can do here.

Be ruthless about evidence. Do not be ruthless about certainty.
