# DDP Ai Legal — Production Readiness & Strategic Engineering Review

**Status:** Authoritative engineering status report
**Basis:** Continuation of the completed read-only STAGING verification (`szqocdabwkjrggrddocx`). That report is the source of truth unless contradicted by new evidence below.
**Evidence discipline:** every claim is tagged **[VERIFIED]** (observed in repo/DB this session), **[JUDGEMENT]** (reasoned engineering opinion), or **[UNKNOWN]** (requires evidence not yet obtained). No code was modified to produce this report.

---

## New evidence established for this review

1. **[VERIFIED] Migration 17 hard-depends on migration 10.** `17_PROCUREMENT_DECISIONS_MVP.sql:56` — `snapshot_id UUID REFERENCES public.buyer_pack_snapshots(snapshot_id)`. Applying 17 without 10 present fails (`relation does not exist`). **Order is fixed: 10 → 17.**
2. **[VERIFIED] Asymmetric runtime fallback.** `procurementDecisionStore.ts:99-101` feature-detects `42P01` and degrades to local-cache if table 17 is absent. `buyerPackSnapshotSupabaseStore.ts:168` only falls back when Supabase is *unconfigured* — it does **not** detect a missing table/RPC. So in a Supabase-configured prod without migration 10, "Issue Buyer Pack" calls the absent RPC and errors.
3. **[VERIFIED] The error is caught cleanly.** `DDPBuyerPreview.tsx:35-36` — the RPC failure surfaces as `setIssueError(message)`, not a crash. Severity of (2) is therefore "feature unavailable / clean error," not "outage."
4. ~~**[VERIFIED] The remediation-sprint work is uncommitted.**~~ **[CORRECTED — no longer true.]** All Phase-D changes are committed and pushed, then split: the **guard fix, staging-suite hardening and `16_..._VERIFY.sql` merged to `main`** via **PR #3** (`4a77828`, merge commit `677f31f`); the **decision store, snapshot store and migration 17** are in **PR #4** (`9da1ec6`), which is **open and NOT merged**; these reports are **PR #5**. `git status` is clean. Nothing from PR #4 is deployed, and no migration has been applied.

---

## TASK 1 — Classification of remaining issues

| # | Issue | Classification | Why |
|---|---|---|---|
| 1 | Production never verified | **HIGH PRIORITY** | [VERIFIED] All security assurance is staging-only. Production (`iihxjrfxmycjafbtjvvq`) was never contacted. The original self-certification concern was production-specific. Not a *blocker to a staging demo*, but a blocker to any production sign-off. Closeable in ~15 min with the same read-only queries. |
| 2 | Migrations 10 & 17 not applied to staging | **MEDIUM PRIORITY** | [VERIFIED] The app runs without them (decision path degrades to local-cache). They gate the *durable, append-only decision/audit trail* — the compliance value, not app function. Becomes a **BLOCKER specifically for the compliance-audit claim**, not for the app booting. |
| 3 | Farmer UPDATE policy intentionally absent | **NOT AN ISSUE** | [VERIFIED] Q1/Q2 staging: `farms` has only `admin all`, `farmer insert own`, `farmer select own`. Its absence is *why* self-certification is not reproducible. **NO CHANGE REQUIRED** — this is correct-by-absence. |
| 4 | Future regression if farmer UPDATE is added without field protection | **HIGH PRIORITY (preventive)** | [VERIFIED contingency] `trg_protect_farm_admin_fields` is absent (Q1). If `FARM_RESAVE_PERSISTENCE` is ever applied, it introduces `farms: farmer update own` with no column guard → live self-certification. This is a latent trap, not a current defect. Must be fenced before that migration is ever applied anywhere. |
| — | ~~Remediation code uncommitted~~ **[CORRECTED — CLOSED]** | **RESOLVED** | The code is committed and pushed: PR #3 (`4a77828`) merged to `main`; PR #4 (`9da1ec6`) open, not merged; PR #5 open. The stated risk ("one `git checkout` from loss") no longer exists. |

---

## TASK 2 — Should migrations 10 and 17 be applied before production?

### Migration 10 — `10_BUYER_PACK_SNAPSHOTS_MVP.sql` (buyer-pack immutable snapshots)

- **Purpose** [VERIFIED]: creates `buyer_pack_snapshots` / `buyer_pack_audit_log` / `buyer_pack_download_log`, the append-only `issue_buyer_pack_snapshot()` RPC (admin + recorded-progress-decision + named-approver gates), and the `prevent_buyer_pack_mutation()` immutability trigger. It is the durable, tamper-evident record of what a buyer was shown.
- **Dependencies** [VERIFIED]: `is_ddp_admin()` (present in staging), `profiles`, `inventory_batches` (present). Self-contained otherwise. Enables migration 17's FK.
- **Risks** [JUDGEMENT]: low. Additive (new tables/function/trigger); touches no existing object. The known limitation is documented in the file itself: `content_hash` is client-supplied, not recomputed server-side (`10_..._MVP.sql:230-235`) — so it is tamper-*evident*, not yet cryptographically tamper-*proof*.
- **Rollback** [VERIFIED]: `10_BUYER_PACK_SNAPSHOTS_ROLLBACK.sql` exists. Clean drop (additive migration).
- **Production impact** [VERIFIED]: **Required before the buyer-pack-snapshot feature works in prod.** Because the snapshot store does not feature-detect a missing table (finding #2 above), issuing a pack against a Supabase-configured prod without this migration produces a clean error, not a fallback. Without it, the app's read/derive paths still work; only durable snapshot issuance is unavailable.
- **Apply to staging immediately?** **YES.** Additive, reversible, unblocks 17, and lets `10_..._VERIFY.sql` confirm it live. No reason to defer.

### Migration 17 — `17_PROCUREMENT_DECISIONS_MVP.sql` (append-only decision record)

- **Purpose** [VERIFIED]: moves the procurement decision (progress/hold/reject) out of browser localStorage into an append-only server table with a mandatory actor (`decided_by DEFAULT auth.uid()`, RLS-pinned) and mandatory reason. It is the record an auditor/regulator asks for, and the only place a **rejection** can be recorded.
- **Dependencies** [VERIFIED]: **hard FK on migration 10** (`:56 REFERENCES buyer_pack_snapshots`). Also `is_ddp_admin()`, `profiles`. **Must be applied after 10.**
- **Risks** [JUDGEMENT]: low. Additive; append-only enforced by trigger + no UPDATE/DELETE policy. The `security-ci.yml` ACL test already validated its EXECUTE-grant hygiene.
- **Rollback** [VERIFIED]: `17_..._ROLLBACK.sql` exists — but **destructive**: dropping the table destroys the decision audit trail. The file documents exporting first. Prefer rolling back the *app deploy*, leaving the table.
- **Production impact** [VERIFIED]: enables the durable/attributable decision trail. The consumer (`procurementDecisionStore`) degrades gracefully if absent, so applying it is safe before or after the app deploy.
- **Apply to staging immediately?** **YES, immediately after 10.** Then run `17_..._VERIFY.sql`.

**Verdict:** Apply **10 then 17** to staging now; verify both; then apply the identical, verified pair to production as part of the production cutover. They are additive, reversible, and are the difference between "compliance product" and "compliance-shaped UI."

---

## TASK 3 — If production were deployed today, what security risks actually exist?

### VERIFIED (facts, staging)
- **NO CHANGE REQUIRED — genuinely strong:** RLS enabled on all 20 tables; no `service_role` key anywhere; function EXECUTE ACLs correct (no anon-executable SECDEF, trigger-only functions locked); audit-log immutable (2 triggers); role self-elevation blocked (`42501`, role unchanged); self-certification **not reproducible** (no farmer UPDATE policy).
- **Residual (verified):** the procurement decision remains **browser-local and unattributed** until migrations 10/17 are applied — an *auditability* gap, not an access-control breach. The AI draft "citations" are unvalidated free text (`complianceAiSummarisation.ts:164-166`) — a traceability gap, mitigated only by the human-in-the-loop, draft-only boundary.

### LIKELY (reasoned, needs prod confirmation)
- **[JUDGEMENT]** Production likely mirrors staging's RLS/function posture (same migration lineage), so the self-cert protection *probably* holds in prod — but this is **inference, not evidence.**
- **[JUDGEMENT]** No monitoring means a security event in prod would likely be **undetected** (grep confirmed no Sentry/PostHog/logging this session). The `api/compliance/ai-summary.ts` catch swallows errors silently.

### UNKNOWN (require evidence)
- **[UNKNOWN]** Production's actual `farms` policies and triggers — the single most important open question. The original `FARM_ADMIN_ROLE_CHECK_FIX.sql` documented the protect trigger as absent *in production*; whether a farmer UPDATE policy is live *in production* is unverified. **This is the one that must be closed before prod sign-off.**
- **[UNKNOWN]** Whether backups/PITR are enabled and restorable on the production project.
- **[UNKNOWN]** Production Supabase Auth settings (email confirmation, JWT expiry, leaked-password protection).

---

## TASK 4 — Security hardening to implement BEFORE production

Only changes that materially improve security / compliance / auditability / operational resilience. Feature/UI/refactor excluded.

1. **[HIGH] Run the read-only verification query set against production** (`16_PRODUCTION_SAFETY_VERIFY.sql` Q1/Q2/Q4/Q5). Closes the only UNKNOWN that is also a Critical original concern. Zero risk, ~15 min. — *materially improves security assurance.*
2. **[HIGH] Fence the farmer-UPDATE trap.** Before `FARM_RESAVE_PERSISTENCE` is ever applied, merge `trg_protect_farm_admin_fields` into the *same* migration, so a farmer UPDATE path can never exist without the column guard. Prevents finding #4 from ever materialising. — *auditability + security.*
3. **[MEDIUM] Apply migrations 10 → 17 to prod and activate the server-side decision trail.** Converts the compliance record from browser-local to append-only/attributable. — *compliance + auditability.*
4. **[MEDIUM] Minimal error logging + one alert.** Change `api/compliance/ai-summary.ts:97` `catch {}` to log the error server-side, and wire a single error sink (e.g. Sentry). Without it, prod security/incident signals are invisible. — *operational resilience.*
5. **[MEDIUM] Confirm production backups/PITR are enabled and test one restore.** — *operational resilience.*
6. **[LOW] Confirm production Supabase Auth hardening** (email confirmation on, leaked-password protection on, sane JWT expiry). — *security.*

Explicitly **NO CHANGE REQUIRED** for: RLS coverage, function ACLs, audit-log immutability, role-escalation protection, the absent farmer UPDATE policy. These are verified correct.

---

## TASK 5 — AI roadmap review

### Current state [VERIFIED]
- The entire live AI surface is **one stateless prompt→JSON HTTP call** (`api/compliance/ai-summary.ts` → `serverAiSummary.ts` → `serverAiProvider.ts`). No RAG, no retrieval, no vector store, no memory, no tool-calling, no orchestration, no eval harness.
- The model's evidence is the **RSS teaser text**, not the primary legal document (`complianceRssConnector.ts:213`). "Legal change detection" is a SHA-256 of that string.
- Output "citations" (`sourceReferences`) are an unvalidated `string[]` the model invents and are exempt from the safety guard (`complianceAiSummarisation.ts:164-166`).
- The wording guard (`aiComplianceGuard.ts`) was corrected this sprint (negation-scope bypass fixed; 36 tests) and the draft-only, human-in-the-loop boundary is real and held under adversarial probing.

### Answers
- **Is the current architecture suitable?** **For its current scope — a draft-only, human-approved summariser — YES, and NO CHANGE REQUIRED to ship that scope.** The safety comes entirely from the human gate, not from the model. It is **not** suitable to describe as "legal change detection" or "compliance verification"; those claims exceed what the code does.
- **Should anything change before expanding AI?** **Yes — do not expand until three things exist:** (a) retrieval over *primary* legal sources with the fetched document as the evidence body, not the RSS teaser; (b) citations as *validated spans* into that source text, not free strings; (c) an **eval harness with a golden set** and a measured hallucination rate. Expanding autonomy on top of an unevaluated single call is the primary hidden risk.
- **Hidden risks** [VERIFIED/JUDGEMENT]: (i) presenting AI output as authoritative compliance when it is an unverified summary — regulatory-liability exposure; (ii) prompt-injection from ingested external text (the guard runs on output, and — per the prior audit — was mis-applied to *input* in one path); (iii) no persistence of AI drafts, so a misleading draft leaves no trace.
- **How should AI governance evolve?** Draft-only + named-human-approver must remain a **hard, enforced gate** (today it is enforced at the summary intake). Before any autonomy: add per-draft persistence with actor + model + prompt version; add citation validation; add an eval gate in CI; keep a written "AI may not assert compliance; only a human may" policy encoded in the guard.

---

## TASK 6 — Production Readiness Assessment (0–100)

Scored for *production readiness of the current scope*, not aspirational scope. Justifications are evidence-tagged.

| Category | Score | Justification |
|---|---:|---|
| **Architecture** | **62** | [VERIFIED] Coherent small system: 3 runtime deps, pure-core libs, thin serverless adapter, fail-closed. Ceilings: no router, localStorage-as-cache still authoritative until 10/17 applied. Adequate for limited scope. |
| **Security** | **82** | [VERIFIED] RLS on all 20 tables, no service_role key, correct ACLs, immutable audit log, escalation blocked, self-cert not reproducible. Deductions: prod unverified; localStorage decision cache; contingent farmer-UPDATE trap. |
| **Compliance** | **45** | [VERIFIED] The durable/attributable decision trail (10/17) is not yet applied; AI outputs lack validated citations. The controls are *built* but not *active*. |
| **Database** | **58** | [VERIFIED] Solid schema + RLS; but no migration ledger, hand-applied migrations, only-PK indexes on core tables, 10/17 pending with a fixed FK order. |
| **Infrastructure** | **42** | [VERIFIED] Vercel auto-deploy from `main` with no CD gate; no observability; backups/PITR unverified; bus factor 1. |
| **AI** | **48** | [VERIFIED] Safe *for draft-only scope* (human gate real, guard fixed). Not ready to expand: no retrieval/citations/evals. |
| **Operational readiness** | **35** | [VERIFIED] No monitoring, no runbook, no on-call, single maintainer. |
| **Developer workflow** | **58** | [VERIFIED] Strong static CI (**434** tests on `main` today after PR #3 (`4a77828`); 464 when written; **497** measured on PR #4 (`9da1ec6`, open, not merged) — plus tsc, lint, build) + live staging security suite. Weak: no CD, migrations by hand. **[CORRECTED]** "reviewed work uncommitted" no longer applies — see the PR split above. |
| **Testing** | **56** | [VERIFIED] 464 unit tests (pure logic) + live staging security suite. Zero component/E2E tests; zero AI evals. |
| **Deployment** | **44** | [VERIFIED] Auto-deploy works but ungated; no rollback drill; migrations manual with a hard ordering dependency. |
| **Documentation** | **76** | [VERIFIED] Extensive, unusually honest: VERIFY/ROLLBACK pairs, audit reports, this review. |
| **Monitoring** | **15** | [VERIFIED] None. `api/.../ai-summary.ts:97` swallows exceptions. |
| **Incident response** | **20** | [VERIFIED] No documented runbook, alerting, or escalation path. |

**Composite (readiness of current scope):** ~49/100 — *"strong core, unfinished operational and compliance-activation layer."* The security engine is the standout; monitoring, incident response, and compliance-activation are the drags.

---

## TASK 7 — Final Engineering Roadmap (measurable value only)

**Immediate (this week)**
- ~~Commit the verified Phase-D working-tree changes to a branch and open a PR~~ **[CORRECTED — DONE]** committed and split into three PRs: PR #3 (`4a77828`) **merged**, PR #4 (`9da1ec6`) **open**, PR #5 **open**. *Value: the reviewed code becomes reproducible/deployable.*
- Run `16_PRODUCTION_SAFETY_VERIFY.sql` Q1/Q2/Q4/Q5 **read-only against production**. *Value: closes the single Critical UNKNOWN.*
- Apply migrations **10 → 17 to staging**; run `10_/17_..._VERIFY.sql`. *Value: activates the durable decision/audit trail in staging.*

**Before production**
- Merge `trg_protect_farm_admin_fields` into `FARM_RESAVE_PERSISTENCE` so the farmer-UPDATE trap can never open. *Value: eliminates finding #4.*
- Add server-side error logging + one error alert (fix `catch {}` in the AI function). *Value: prod incidents become visible.*
- Confirm prod backups/PITR enabled; perform one test restore. *Value: recoverability.*
- Add a deploy gate so `main` cannot auto-deploy to prod on a red `security-ci`. *Value: prevents shipping a failing build.*

**First production deployment**
- Apply the identical verified migration pair (10 → 17) to prod; re-run the VERIFY scripts against prod. *Value: compliance trail live in prod.*
- Smoke-test issue-buyer-pack end to end (RPC path) in prod. *Value: confirms the snapshot feature works, not just errors gracefully.*

**30 days after launch**
- Add a handful of E2E tests for the farmer submit and buyer-pack-issue flows. *Value: catches regressions unit tests can't.*
- Establish a minimal incident runbook + on-call contact. *Value: operational resilience.*

**90 days after launch**
- Add the missing FK indexes (`inventory_batches(farm_id)`, `documents(farm_id)`, `farm_profiles(farm_id)`, `farms(created_by)`). *Value: query performance as data grows.*
- Stand up a migration ledger (`schema_migrations`) so prod state is knowable. *Value: ends hand-applied drift.*

**6 months**
- Only if AI is to expand: retrieval over primary sources + validated-span citations + a CI eval gate. *Value: the minimum credible basis for any AI autonomy.*

---

## TASK 8 — Independent CTO sign-off (seven-figure investment)

| Decision | Verdict | Required evidence | Remaining risk | Confidence |
|---|---|---|---|---|
| **Staging demonstration** | **YES** | [VERIFIED] staging healthy, build passes, TS clean, security verified on staging | Demo-only; no customer data | **High** |
| **Limited beta** | **YES, conditional** | Commit the code; apply+verify 10/17 on staging; add error logging | Non-critical bugs surface late without monitoring | **Medium** |
| **Pilot customer** | **NO, until conditions met** | Prod self-cert verified (Q1/Q2); migrations 10/17 live+verified in prod; backups tested; one error alert live | Compliance trail must be server-side before real buyers rely on a pack | **Medium** |
| **Production release (general)** | **NO** | All of the above **plus** a deploy gate, an incident runbook, and E2E coverage of the two money paths | No monitoring/incident response; bus factor 1; prod unverified | **High** |

**CTO summary:** The security foundation is genuinely strong and honestly documented — better than most pre-Series-A codebases. I would fund and greenlight a **staging demonstration today** and a **limited beta within a week** once the code is committed and 10/17 are applied+verified on staging. I would **not** authorise a pilot customer until production is verified with the same read-only queries and the durable decision trail is live, and I would **not** authorise general production release until monitoring, incident response, a deploy gate, and the two-path E2E tests exist. None of these gaps are architectural; they are **finishing and operational** items, each closeable with scoped, low-risk work already scaffolded in the repo.

---

## Verified-fact / judgement / unknown ledger

- **Verified:** staging security posture (RLS/ACLs/audit/escalation/self-cert), migration 17→10 FK, snapshot-store non-fallback, graceful error handling, no monitoring, CI-without-CD, tests/tsc/build green (464 when written; **434** on `main` today after PR #3 (`4a77828`); **497** on PR #4 (`9da1ec6`, open, not merged)). **[CORRECTED]** "uncommitted work" removed — the work is committed and split across PR #3 (merged), PR #4 (open) and PR #5.
- **Judgement:** production probably mirrors staging; readiness scores; AI-expansion prerequisites.
- **Unknown (must close before prod):** production `farms` policies/triggers; production backups/PITR; production Auth settings.

**Bottom line:** This is a fundable, demonstrable system with a strong, verified security core and a short, concrete, low-risk path to production. It is **not yet production-ready** for general release — the gaps are operational activation (migrations, monitoring, incident response, a deploy gate) and one production verification, not engineering rework.
