# DDP Ai Legal — Production Readiness Master Report

**Type:** Engineering execution plan (not an audit). Authoritative status + the exact path from validated staging to production.
**Source of truth:** this repository. Evidence tags: **[VERIFIED]** (observed this session), **[JUDGEMENT]** (reasoned), **[UNKNOWN]** (needs evidence).
**Nothing was executed or modified to produce this report.**

## Ground truth captured for this phase (verified now)

- **[VERIFIED] The commit gate is green.** `npm run ci:verify` → **exit 0** (security:sql + `tsc -b` + eslint + production build all pass).
  - **[CORRECTED]** The test count read **464** when this report was written. It is now **497** (`npm run ci:verify`, 35 files) after the defect-1 regression tests were added in `febe95a`.
- **[VERIFIED] Branch = `chore/staging-smoke-test`**. `main` is separate; per `README.md:105` a push to `main` auto-deploys to production.
  - **[CORRECTED]** This report originally recorded HEAD as `f5c8cbb`. That was the HEAD *before* this initiative was committed. The Phase-D work is now committed: `94c5c42` (implementation) and `9ccffab` (these reports), plus the post-audit defect fixes.
- **[CORRECTED] Working tree contents → now committed.** This section originally described an uncommitted working tree. `git status` is clean; every file listed below is tracked in `94c5c42` / `9ccffab`.
  - *Remediation (this initiative):* `src/lib/aiComplianceGuard.ts` + test, `src/lib/procurementControl.ts`, `src/pages/admin/DDPBuyerPreview.tsx`, `src/lib/procurementDecisionStore.ts` + test, `src/lib/buyerPackSnapshotSupabaseStore.ts` + test, `scripts/run-staging-security-tests.mjs` + test, `16_PRODUCTION_SAFETY_VERIFY.sql`, `17_PROCUREMENT_DECISIONS_{MVP,VERIFY,ROLLBACK}.sql`, `docs/*`, **and `vite.config.ts`** — see the correction below.
  - **[CORRECTED]** This report originally listed *"Pre-existing, NOT part of this initiative: `vite.config.ts` (vendor-chunking), `scripts/staging-smoke-test.mjs`"*. Both halves are wrong:
    - `vite.config.ts` **is** part of this initiative. The change on this branch is `include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs']` — the test glob that makes this initiative's own `scripts/run-staging-security-tests.test.mjs` run. It is **not** vendor chunking. (Vendor chunking is a separate change, committed on branch `chore/vite-vendor-chunking` at `6464ed8`, which this branch does not contain.)
    - `scripts/staging-smoke-test.mjs` **is not in this worktree**. It was committed to branch `chore/staging-smoke-automation` (`4d9f1ac`), with its npm script in `64a1e9b`.
- **[VERIFIED] Migration 10 is already committed** (tracked; `10_BUYER_PACK_SNAPSHOTS_*.sql` in history). Neither 10 nor 17 is applied to any database.
  - **[CORRECTED]** Migration 17 was described as *"new/untracked"*. `17_PROCUREMENT_DECISIONS_{MVP,VERIFY,ROLLBACK}.sql` are tracked, committed in `94c5c42`.
- **[VERIFIED] Migration order is fixed: 10 → 17** (`17_..._MVP.sql:56` FK → `buyer_pack_snapshots`).

---

## WORK PACKAGE 1 — Remaining blockers

### B1 — Production environment not independently verified
- **Verified:** [VERIFIED] all assurance is staging-only; production (`iihxjrfxmycjafbtjvvq`) never contacted.
- **Severity:** HIGH. **Business impact:** cannot truthfully claim production is secure to any buyer/partner. **Technical impact:** the original self-certification question is open for prod. **Risk if ignored:** shipping on the *assumption* prod mirrors staging.
- **Required action:** run `16_PRODUCTION_SAFETY_VERIFY.sql` (read-only) against prod. **Effort:** ~15 min. **Dependencies:** prod DB read credentials. **Rollback:** n/a (read-only).

### B2 — Farmer-UPDATE regression trap
- **Verified:** [VERIFIED] `trg_protect_farm_admin_fields` absent (staging Q1); if `FARM_RESAVE_PERSISTENCE` is applied it adds `farms: farmer update own` with no column guard.
- **Severity:** HIGH (latent). **Business impact:** would let a farmer self-certify export compliance. **Technical impact:** RLS row-access without column protection. **Risk if ignored:** a future migration silently opens the exact vulnerability this program closed.
- **Required action:** merge `trg_protect_farm_admin_fields` into `FARM_RESAVE_PERSISTENCE` so the policy can never exist without the guard; never apply the policy alone. **Effort:** ~1–2 h. **Dependencies:** none. **Rollback:** the combined migration ships with its own guard, so rollback is the existing pattern.

### B3 — Migration 10 not applied
- **Verified:** [VERIFIED] staging Q6 — `buyer_pack_snapshots`/RPC absent.
- **Severity:** MEDIUM. **Business impact:** no durable, tamper-evident buyer-pack record. **Technical impact:** `buyerPackSnapshotSupabaseStore` does **not** feature-detect a missing table (`:168` falls back only when Supabase is unconfigured) — so "Issue Buyer Pack" errors (caught cleanly, `DDPBuyerPreview.tsx:35`). **Risk if ignored:** the snapshot feature appears live but errors in prod.
- **Required action:** apply `10_..._MVP.sql`; run `10_..._VERIFY.sql`. **Effort:** ~30 min. **Dependencies:** `is_ddp_admin()` (present). **Rollback:** `10_..._ROLLBACK.sql` (clean drop; additive).

### B4 — Migration 17 not applied
- **Verified:** [VERIFIED] staging Q6 — `procurement_decisions` absent.
- **Severity:** MEDIUM. **Business impact:** the compliance decision (incl. rejections) stays browser-local and unattributed. **Technical impact:** consumer degrades gracefully (`procurementDecisionStore.ts:99-101`, `42P01` → local-cache), so no runtime break. **Risk if ignored:** no server-side audit trail of who approved a pack.
- **Required action:** apply after 10; run `17_..._VERIFY.sql`. **Effort:** ~30 min. **Dependencies:** **migration 10 (FK).** **Rollback:** `17_..._ROLLBACK.sql` — **destructive** (drops the trail; export first); prefer rolling back the app deploy.

### B5 — Implementation exists only in the working tree — **[CLOSED]**
- **[CORRECTED] This blocker is closed.** It stated *"HEAD `f5c8cbb`; all Phase-D work uncommitted"*. The work is committed: `94c5c42` (implementation) and `9ccffab` (reports); `git status` is clean. The stated risk — *"one `git checkout` from loss"* — no longer exists.
- *Original entry, retained for the record:* Severity MEDIUM; reviewed, gate-passing code not reproducible or deployable. **Required action:** commit to the feature branch, open a PR. **Rollback:** git revert.

---

## WORK PACKAGE 2 — Migration plan (10 & 17)

### Exact execution order
**10 (MVP → VERIFY) → 17 (MVP → VERIFY).** Non-negotiable: 17's FK requires 10's table.

### Pre-flight checklist (per environment)
1. `[ ]` Confirm target ref (staging `szqocdabwkjrggrddocx` / prod `iihxjrfxmycjafbtjvvq`) and that it is the intended one.
2. `[ ]` **Take a fresh backup / confirm PITR window** before prod application.
3. `[ ]` Confirm `is_ddp_admin()` exists (dependency).
4. `[ ]` Confirm `buyer_pack_snapshots` **absent** before 10, **present** before 17.
5. `[ ]` Apply in a transaction where the tool allows; keep the ROLLBACK script open.

### Expected database changes
- **10:** 3 tables (`buyer_pack_snapshots`, `buyer_pack_audit_log`, `buyer_pack_download_log`) + indexes; `issue_buyer_pack_snapshot()` (SECURITY DEFINER, gated); `prevent_buyer_pack_mutation()` trigger; explicit GRANT/REVOKE.
- **17:** `procurement_decisions` (append-only) + 2 indexes; `prevent_procurement_decision_mutation()` trigger; RLS (admin select/insert, no update/delete); `procurement_decisions_current` view; explicit GRANT/REVOKE.

### Expected application changes
- **None deploy-coupled.** Both consumers already ship in the remediation code and feature-detect/behave safely whether or not the migrations are present. After 10+17: "Issue Buyer Pack" persists durably; decisions record server-side with actor + reason; rejections become recordable.

### Verification checklist
- `[ ]` `10_..._VERIFY.sql` → all PASS (tables, RPC gates, immutability trigger, ACLs).
- `[ ]` `17_..._VERIFY.sql` → all PASS (V1–V8: shape, reject/hold allowed, reason mandatory, RLS append-only, trigger, privileges, trigger-fn locked, current view).
- `[ ]` Re-run `run-staging-security-tests.mjs` (staging) — group F + suite green.
- `[ ]` Smoke: issue a buyer pack end-to-end; confirm a `buyer_pack_snapshots` row and a `procurement_decisions` row appear.

### Rollback strategy
- Staging: either ROLLBACK script is safe (test data).
- Prod: **17 first, then 10** (reverse of apply, respecting the FK). Prefer rolling back the *app* over dropping `procurement_decisions` — export the trail first. Both are additive, so revert risk is low.

### Risk analysis
- [JUDGEMENT] **Low.** Additive, reversible, VERIFY/ROLLBACK-paired, ACL-tested in CI. Primary risk is *ordering* (mitigated by the explicit 10→17 rule) and *forgetting the pre-application backup* (mitigated by the checklist).

---

## WORK PACKAGE 3 — Production verification plan (read-only; do NOT execute)

Run entirely read-only against prod. Tooling already exists: `16_PRODUCTION_SAFETY_VERIFY.sql` + the four Group-F `*_VERIFY.sql`.

| Domain | Check | Method |
|---|---|---|
| Environment | Confirm ref = prod, not staging; API-ref === DB-ref | parse `DATABASE_URL` + `SUPABASE_URL` |
| Authentication | Email confirmation on; JWT expiry sane; leaked-password protection on | Supabase Auth settings (console/API) |
| Authorization / RLS | RLS enabled on all 20 tables; policy counts | `16_` Q3 |
| Farms policies | Enumerate `farms` policies; confirm no farmer UPDATE (or, if present, guard exists) | `16_` Q1/Q2 |
| Triggers | `trg_protect_*`, audit-log immutability, `on_auth_user_created` present | `16_` (trigger enumeration) |
| RPC permissions | No anon-executable SECDEF; trigger-only fns locked | `16_` Q5 + `12_..._VERIFY.sql` |
| Audit logging | `compliance_audit_log` immutability triggers live | `11_..._VERIFY.sql` |
| Backups | Automated backups enabled; last snapshot timestamp | Supabase console (Database → Backups) |
| PITR | PITR enabled; recovery window | Supabase console |
| Storage | `farmer-documents` bucket private; per-user prefix RLS | Group G behavioural probe (read-only list) |
| Supabase Auth config | Providers, redirect allow-list, rate limits | Auth settings |
| Service-role separation | Confirm no `service_role` key in client bundle or env with `VITE_` prefix | `grep` bundle + env inventory |
| Environment validation | Prod env vars present, server-only keys unprefixed | Vercel env inventory |
| Deployment validation | Prod build = intended commit; health check responds | Vercel deployment inspect |

**Exit criterion:** every `16_`/Group-F check returns PASS (or a documented benign exception like the 14-script superseded assertion), backups+PITR confirmed enabled, and the farms/self-cert posture matches staging.

---

## WORK PACKAGE 4 — Operational readiness (gaps, prioritised)

| Capability | State | Why it matters | Priority |
|---|---|---|---|
| Logging | [VERIFIED] none server-side; `api/.../ai-summary.ts:97` `catch {}` swallows errors | Prod failures are invisible; no forensic trail | **P0 (before prod)** |
| Monitoring / observability | [VERIFIED] none (no Sentry/PostHog/OTel) | No visibility into errors, latency, usage | **P0** |
| Alerting | [VERIFIED] none | Incidents discovered by users, not the team | **P1** |
| Incident response / runbook | [VERIFIED] none documented | No defined response; bus factor 1 | **P1** |
| Backup verification | [UNKNOWN] not confirmed on prod | Data-loss recoverability unproven | **P0** |
| Restore testing | [UNKNOWN] never drilled | "Backups exist" ≠ "restore works" | **P1** |
| Deployment gates | [VERIFIED] `main` auto-deploys with no CI gate | A red build can reach prod | **P0** |
| Health checks | [JUDGEMENT] none beyond Vercel default | No app-level liveness signal | **P2** |

**Minimum operational bar before production:** P0 items — one error sink + fix the swallowed catch, a deploy gate on `security-ci`, and confirmed+tested backups. The P1/P2 items follow in the first 30 days.

---

## WORK PACKAGE 5 — AI readiness (three projects)

1. **DDP Brokerage** — [VERIFIED] AI is confined to a draft-summary side feature; the transactional/compliance core does not depend on AI. Separation of concerns is clean. **NO CHANGE REQUIRED** to ship the brokerage without expanding AI.
2. **Compliance Watchtower** — [VERIFIED] one stateless prompt→JSON call; evidence is the RSS *teaser* (`complianceRssConnector.ts:213`), not the primary document; "change detection" is a checksum; citations are unvalidated strings. Safe **only** because output is draft-only and human-approved (guard fixed this sprint, 36 tests).
3. **New AI Agent** — [VERIFIED] `feature/evidence-intelligence-phase-a`, unmerged, synthetic fixtures only; no live LLM wiring.

**Evaluation:** architecture/separation/security-boundary — adequate for *draft-only* scope. Prompt security — output guard is correct; input-side injection remains a risk (external text into the model). Retrieval — none. Hallucination controls — human gate only. Auditability — AI drafts are not persisted. Cost/latency — a single Opus call per action; acceptable at current volume. Scalability — not built for autonomy.

**Should the architecture change before more AI is built? YES — three prerequisites, none retroactive to current scope:** (a) retrieve and store the *primary* source as the evidence body; (b) citations as validated spans into that text; (c) an eval harness + golden set gating changes in CI. Until these exist, keep AI draft-only and do not wire the Agent into the product.

---

## WORK PACKAGE 6 — Commercial readiness (investor lens)

- **Inspires confidence:** [VERIFIED] a verified, defensible security core (RLS on 20 tables, no service_role key, immutable audit log, escalation blocked, self-cert not reproducible); unusually honest documentation with VERIFY/ROLLBACK-paired migrations and a live staging security suite; a real human-in-the-loop compliance gate.
- **Reduces confidence:** [VERIFIED] production never independently verified; no monitoring/incident response; the compliance decision trail is browser-local until 10/17 land; the "AI compliance" story is currently a draft summariser, not verification; bus factor 1.
- **What would stop a sale:** a government/compliance buyer asking "show me the immutable, attributed record of who approved this pack in production" — today, in prod, that record does not yet exist server-side. And "show your production security verification" — not yet done.
- **What accelerates adoption:** apply 10/17 + verify prod (turns the compliance claim from *built* to *live*); add monitoring + an incident runbook (institutional buyers require it); a one-page control narrative mapped to the verified RLS/audit evidence.

---

## WORK PACKAGE 7 — Master roadmap (every task appears once)

**COMPLETE (verified done)**
- Security remediation: guard negation-scope fix (`aiComplianceGuard.ts:99`); escalation-test correction (`run-staging-security-tests.mjs:337,366` — now probes `ddp_admin`); staging suite hardened + regression-tested.
- **[CORRECTED] "localStorage-write guardrails" was listed here as complete. It is not implemented.** No such guardrail exists on this branch: `src/data.ts` is not modified at all (`saveInventory` at `:631-633` and `saveFarms` at `:644-646` are still unguarded `localStorage.setItem`), and `src/services/auth.ts:80` `signOut()` still does not clear. The only change to `procurementControl.ts` in this branch is adding the `export` keyword to `interface StoredDecision`. This item remains **OPEN** — it is audit finding C-4, which the audit in this same commit rates as inexcusable and ~1 hour of work.
- Staging security verification (RLS, ACLs, audit immutability, escalation, self-cert, Group F).
- Migration artifacts authored + paired (10 already committed; 16, 17 authored).

**NO CHANGE REQUIRED**
- RLS implementation · function EXECUTE permissions · audit-log immutability · role-escalation protection · absence of a farmer UPDATE policy · AI draft-only human gate.

**READY FOR COMMIT** (gate green now) — **[DONE / CORRECTED]**
- The remediation set is committed to `chore/staging-smoke-test` (`94c5c42`, `9ccffab`). A PR is still to be opened.
- **[CORRECTED]** The original condition — *"split the pre-existing `vite.config.ts`/`staging-smoke-test.mjs` into their own commit"* — was incorrect and must not be followed. `vite.config.ts` on this branch is this initiative's own test-glob change and must **not** be split out; `scripts/staging-smoke-test.mjs` is not in this worktree (it is on `chore/staging-smoke-automation`, `4d9f1ac`). Vendor chunking, the change that bullet meant, is on `chore/vite-vendor-chunking` (`6464ed8`).

**READY FOR STAGING**
- Apply migration 10 → VERIFY. Apply migration 17 → VERIFY. Re-run staging security suite.

**READY FOR PRODUCTION** (after staging + verification pass)
- Run `16_` + Group-F verification against prod (read-only).
- Add P0 operational items: error logging (fix the swallowed catch) + one error sink; deploy gate on `security-ci`; confirm + test backups/PITR.
- Apply 10 → 17 to prod during a controlled cutover (backup first); re-verify.

**BLOCKED**
- Pilot-customer onboarding — blocked on prod verification + P0 operational items + server-side decision trail live in prod.

**FUTURE ENHANCEMENT**
- Fence the farmer-UPDATE trap inside `FARM_RESAVE_PERSISTENCE` (do before that migration is ever applied).
- FK indexes on core tables; `schema_migrations` ledger.
- E2E tests for farmer-submit and buyer-pack-issue.
- AI expansion prerequisites: retrieval over primary sources, validated-span citations, CI eval gate — before any Agent productionisation.

---

## WORK PACKAGE 8 — Final CTO decision

| # | Question | Decision | Evidence |
|---|---|---|---|
| 1 | Commit current work? | **DONE** | [VERIFIED] `ci:verify` exit 0; committed as `94c5c42` + `9ccffab`. **[CORRECTED]** The original condition ("split the pre-existing `vite.config.ts`/`staging-smoke-test.mjs` from the remediation commit") was wrong and was not followed: `vite.config.ts` is this initiative's own test-glob change, and `staging-smoke-test.mjs` is not in this worktree (it is on `chore/staging-smoke-automation`, `4d9f1ac`). |
| 2 | Merge to main? | **YES WITH CONDITIONS** | `main` auto-deploys to prod (`README.md:105`). Condition: PR review + green branch, **and** either apply migration 10 to prod first or accept the buyer-pack-issue feature errors gracefully until it is. |
| 3 | Apply migrations 10 & 17? | **YES WITH CONDITIONS** | [VERIFIED] additive, reversible, VERIFY-paired. Condition: **staging immediately (order 10→17)**; prod only with a pre-application backup during a controlled cutover. |
| 4 | Verify production? | **YES** | [VERIFIED] read-only, zero risk; `16_`/Group-F tooling ready. Do this next. |
| 5 | Onboard a pilot customer? | **NO** | [VERIFIED] prod unverified; no monitoring/incident response; decision trail not yet server-side in prod. |
| 6 | Demonstrate to investors? | **YES WITH CONDITIONS** | [VERIFIED] staging verified + healthy. Condition: demo on staging; do not represent prod as verified until WP3 is done. |
| 7 | Continue building Compliance Watchtower? | **YES WITH CONDITIONS** | [VERIFIED] contained, draft-only. Condition: keep it draft-only; don't claim "verification"; add evals before any autonomy. |
| 8 | Continue building the new AI Agent? | **YES WITH CONDITIONS** | [VERIFIED] isolated on an unmerged branch. Condition: R&D only, not wired to prod; build retrieval + citations + evals before productionising. |
| 9 | Begin Phase E? | **YES** | Phase E = this execution plan; its immediate steps (commit, verify prod, apply staging migrations) are safe now, gate-green, and evidence-backed. |

---

## The path, in order (execution, not discovery)

1. **Now:** commit the remediation (gate is green) → PR.
2. **Now:** run `16_` + Group-F **read-only against production** → close B1.
3. **This week:** apply **10 → 17 to staging**, run both VERIFY scripts + the security suite.
4. **Before prod:** P0 ops (logging + error sink, deploy gate, backup/PITR confirmed & test-restored); fence the farmer-UPDATE trap.
5. **Cutover:** backup → apply 10 → 17 to prod → re-verify → smoke-test issue-pack.
6. **Then:** pilot customer; investor demo can proceed on staging in parallel from step 1.

**Bottom line:** the uncertainty is eliminated. The security core is verified and the remaining work is a short, ordered, low-risk sequence of *activation and operational* steps — every one of them already scaffolded in this repository, none requiring rework.
