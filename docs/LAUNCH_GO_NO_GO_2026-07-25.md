# DDP Release Hardening — Go / No-Go Report

Date: **2026-07-25**
Repository: `dylangremium-sys/ddp-brokerage-demo`
`main` at audit: **`3c51627b58fc0b3890e06b33d74a43a86b3be091`** (verified, not assumed)

Companions:
[`MIGRATION_RUNTIME_REGISTER.md`](./MIGRATION_RUNTIME_REGISTER.md) ·
[`PRODUCTION_MIGRATION_PLAN.md`](./PRODUCTION_MIGRATION_PLAN.md) ·
[`PILOT_LAUNCH_REHEARSAL.md`](./PILOT_LAUNCH_REHEARSAL.md)

---

## 1. Findings

### 1.1 Verified findings (direct evidence)

| # | Starting finding | Verdict | Evidence |
|---|---|---|---|
| 1 | main is `3c51627…` | **CONFIRMED** | `git rev-parse origin/main` |
| 2 | main health good (DeepSource JS/SQL/Secrets pass) | **CONFIRMED** | commit status API on `3c51627` — all three `success` |
| 3 | Main blocker is release integrity | **CONFIRMED, and worse than stated** | see 1.2 #A |
| 5 | PR #48 merged, added migrations 25 + 26 | **CONFIRMED** | merge commit `22008ba`, 2026-07-24T11:14:23Z |
| 6 | PRs #53, #55, #56 extended starter sources / SUKL | **CONFIRMED** | merged `68c1503`, `bf003f4`, `3c51627` |
| 7 | PR #44 migration collides with main's 25 | **CONFIRMED** | both claimed `25_` |
| 8 | PR #43 is a reusable disposable-PG harness worth keeping | **CONFIRMED** | harness runs green locally, deterministic |
| 9 | No admin provisioning UI wired | **CONFIRMED** | README:116, 258 |
| 10 | Fulfilment / chain-of-custody not built | **CONFIRMED** | README:30 |

### 1.2 Corrected findings

**A. Finding 4 is wrong in its most important respect.**
The claim was "10 and 17 verified in staging but not production". Measured:

- **Production has migrations 25 and 26 applied. Staging does not.**
- Production **also** has 10 and 17 (tables and all columns present).
- Migration 24 is absent from **both**.

Production is **ahead** of staging on Watchtower. Any plan built on "staging is
a superset of production" is unsafe. This is the single most consequential
correction in this report.

**B. Migration 23's VERIFY was unpassable — a launch-critical defect not in the
starting findings.**

`23_..._VERIFY.sql` Section A scanned the function body with the case-sensitive
`~` and a lowercase pattern, while the body its own migration installs writes
`IF v_decided_by IS NULL`. Measured against staging:

| scan | result |
|---|---|
| `body ~  'v_decided_by\s+IS\s+NULL'` | `true` |
| `body ~  'v_decided_by\s+is\s+null'` | **`false`** ← the check as written |
| `body ~* 'v_decided_by\s+is\s+null'` | `true` |

The Buyer Pack server-authoritative issuance gate — the control that prevents a
pack being issued without a current `progress` decision — had **no working
verification in any environment**. Fixed in PR #57; the gate is now proven.

**C. The DeepSource JavaScript failures on #43/#44 were not security issues.**
All were hygiene-class. DeepSource itself graded PR #44 **A** for Security,
Reliability and Complexity while still failing the check.

### 1.3 Still unknown

- Production state of migrations **19, 20, 21, 22, 23, 27** — invisible through
  PostgREST. No production DB URL or service-role key was available.
- Production backup **restore** readiness — never drilled, as far as this audit
  can evidence.
- DeepSource threshold configuration (no `.deepsource.toml` in-repo).

---

## 2. What was fixed

| Item | Branch | Head SHA | CI |
|---|---|---|---|
| **PR #44** — rebased onto main; migration renumbered **25 → 27**; all references updated; DeepSource JS cleared | `security/ddp-audit-remediation` | **`64dd896`** | **CLEAN** — all checks pass |
| **PR #43** — rebased onto main; **migration-number collision guard** added; harness re-proven | `infra/disposable-postgres-migration-harness` | **`b5fa998`** | Functional gates pass; DeepSource JS still fails (§4) |
| **PR #57** (new) — migration-23 VERIFY case-sensitivity fix | `fix/migration-23-verify-case-sensitivity` | **`8badffa`** | **CLEAN** |

### 2.1 PR #44 detail

- Rebase `0aa4b26` → `2276e2d` (clean, no conflicts).
- Renumber commit `7978234`; hygiene commit `64dd896`.
- Files changed: 3 SQL renamed `25_… → 27_…` + internal headers;
  `scripts/check-security-migrations.mjs` (Check 14, label, `mig25*`→`mig27*`
  import aliases); `scripts/security-migrations/auditLogActorMigration{,.test}.mjs`;
  `src/lib/complianceRepository.ts`; plus 6 files in the hygiene pass.
- Watchtower's own "migration 25" references in `src/` deliberately left alone.
- Verification: **1797/1797** tests · `security:sql` **PASS** · `tsc -b` clean ·
  `eslint` clean · DeepSource JavaScript **pass**.

One correctness note: the DeepSource "initialize on declaration" fix was applied
as `for (let match = RE.exec(s); match !== null; match = RE.exec(s))`, **not** by
hoisting the assignment above a `while`. `definerSearchPath.mjs` has two
`continue`s inside that loop; hoisting would have stopped advancing the regex
and spun forever.

### 2.2 PR #43 detail

- Rebase `a727bcb` → `1432384` (clean, 3 commits replayed); guard commit `b5fa998`.
- **New:** `scripts/disposable-pg/lib/migration-numbering.mjs`,
  `scripts/check-migration-numbers.mjs`, 12 tests, `npm run verify:migration-numbers`.
- Wired into **Security CI on every PR** (ahead of the SQL checks) **and** as a
  harness preflight, so `ci:runtime` refuses to certify while a collision exists.
- **Proven, not asserted:**
  - guard on clean tree → `PASS — 48 numbered migration files across 21 numbers`
  - reintroducing the real 25/25 collision → guard **FAILS** and names both migrations
  - harness **refuses to start** while the collision is present
  - legitimate shapes not flagged: multi-stage sets, 24's four stages, 23's
    unsuffixed forward file, `MVP` forward files, one stem reused at 19 + 20
- **Determinism proven:** two independent full runs produced byte-identical
  stage output (`VERIFY 18/18 — ABCDEFGHIJKLMNOPQR`, destructive-guard refusal
  then opt-in success, full object teardown; negative fixture failed as expected).

---

## 3. Readiness

### 3.1 Controlled procurement-MVP pilot

**Codebase:** ready. **Hosted production state:** not evidenced.

| Dimension | State |
|---|---|
| Repository / CI health | **Green** — main passes all three DeepSource analyzers |
| Migration governance | **Fixed** — collision resolved, guard added and proven |
| Buyer Pack issuance gate | **Proven in staging** (B1–B17), incl. every bypass attempt |
| Tenant isolation / RLS | **Proven in staging** — 24/24 tables RLS on, 63 policies, pending-user denial verified live |
| Production migration state | **Partially unknown** (19–23, 27) |
| Production ↔ staging parity | **Divergent, in both directions** |
| Evidence workflow (M24) | **Not applied anywhere** — D3/D4 of the rehearsal are blocked |
| Executable end-to-end rehearsal | **Blocked** — staging test credentials do not exist |
| Backup / restore drill | **Not done** |

### 3.2 Full commercial brokerage launch

Not close, and not because of defects. Fulfilment, chain-of-custody, and the
deeper commercial brokerage layer are **not built** (README:30). There is also
no admin provisioning UI — provisioning today means calling the endpoint
directly (README:116). Only the procurement MVP is in scope at all.

---

## 4. Residual risks

Named explicitly, in order of severity.

1. **Production schema state for 19–23 is unknown.** These are the tenant
   isolation, provisioning, and Buyer Pack authorization controls. If any is
   missing or drifted in production, a pilot exposes real data. *This is the
   single blocking risk.*
2. **Production and staging have diverged in opposite directions.** Staging
   evidence does **not** transfer to production, and production carries
   Watchtower objects that were never exercised in staging.
3. **No restore drill.** A backup that has never been restored is not a rollback
   plan. Migration 24's rollback is destructive.
4. **Forged-`actor_id` attack test is uncovered.** Migration 27 is unapplied
   everywhere. Until then, `compliance_audit_log.actor_id` is client-supplied and
   a DDP admin can attribute an entry to another user. The append-only triggers
   are present, so entries cannot be edited — but they can be *mis-attributed*.
5. **Migration 24 unapplied in both environments** while application code for the
   evidence workflow is on `main`. Any UI path reaching those RPCs fails at runtime.
6. **PR #43 DeepSource JavaScript still fails.** Cause identified:
   `runFixture` has cyclomatic complexity **51** ("critical"), plus ~24 hygiene
   items. Not a security finding — DeepSource graded Security **A**. The
   functional gate (`Disposable PostgreSQL migration verification`) passes.
7. **Staging test credentials are drifted**, so the standing executable security
   suite has not run recently. Its coverage is not currently a live signal.
8. **Loose unnumbered root `.sql` files** remain applyable by hand. The new guard
   covers numbered collisions only; it does not stop someone running
   `AUTH_RLS_SCHEMA.sql` against production.

---

## 5. Exact next actions

**Blocking, in order:**

1. **Provide production DB access** (read-only URL or service-role key) and run
   `MIGRATION_RUNTIME_REGISTER.md` §5.3. → closes risks 1 and 2.
2. **Merge PR #57** (CLEAN) — restores the Buyer Pack verification gate.
3. **Merge PR #43** (functional gates green) — prevents the next collision.
   Decide separately on the complexity refactor.
4. **Merge PR #44** (CLEAN) — lands migration 27 and closes risk 4.
5. **Backup + restore drill** into a scratch project; record measured RTO.
6. **Apply the delta** per `PRODUCTION_MIGRATION_PLAN.md` — Stage 1 → 6. Almost
   certainly migration 24, plus whatever Stage 1 reveals for 19–23. **Not** 25/26.

**Then:**

7. Repair staging test credentials, re-run `npm run security:staging`.
8. Apply 25/26 to **staging** to close the reverse gap, so Watchtower is
   rehearsable somewhere other than production.
9. Execute Part B of `PILOT_LAUNCH_REHEARSAL.md` end to end.
10. Run the two uncovered attack probes (#7 unauthenticated provisioning, #8
    missing hosted config) against a preview deployment.

---

## 6. Recommendation

### Controlled procurement-MVP pilot — **NO-GO (conditional)**

The blocker is **evidence, not code**. The codebase is in good shape: CI is
green, migration governance is now enforced, and every Buyer Pack bypass attempt
and tenant-isolation attack tested against staging **failed to get through**.

What is missing is proof that production carries those same controls. Migrations
19–23 — tenant isolation, controlled provisioning, and Buyer Pack authorization —
are unmeasured in production, and the two environments are known to have
diverged. Running a pilot on that basis means exposing real farmer data to a
schema nobody has inspected.

This converts to **GO** on completing next actions 1–6. Nothing there requires
new development; item 1 alone would resolve most of the uncertainty, and it
needs a credential, not an engineer.

### Full commercial brokerage launch — **NO-GO**

Not a defect judgment. Fulfilment, chain-of-custody, and the commercial
brokerage layer are not built, and there is no admin provisioning UI. This is a
roadmap gap of months, not a hardening gap. Re-assess only after those ship.

---

## 7. Evidence boundary

Stated plainly, so nothing here is over-read:

- Everything claimed about **staging** was executed against `szqocdab…` as
  `postgres` and is reproducible from the commands in the register.
- Everything claimed about **production** rests on **PostgREST object probes
  with an anon key and an admin JWT** — GET requests only. No writes, no RPC
  invocation, no DDL.
- **No production migration state was inferred from source files.** Where
  production could not be measured, the register says `unknown`.
- Section B of every VERIFY executed during this audit ran inside a single
  `BEGIN … ROLLBACK`; migration 23's Section B asserted zero residue across all
  five counters afterwards.
