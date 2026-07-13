# DDP Platform — Multi-Agent Technical & Commercial Due Diligence

**Date:** 2026-07-13
**Repo:** `ddp-inventory-demo` @ `f5c8cbb` (branch `chore/staging-smoke-test`)
**Method:** 15 independent expert agents (12 blind domain reviews → Red Team → Blue Team → Investment Committee), 1.4M tokens, 319 tool calls against the live source. Every claim below is cited to `file:line`.

> **Confidential.** Contains unpatched security findings. Do not circulate outside the company.

---

## Executive Summary

**The engineering is far better than the product, and the product is far better than the business.**

You have built a genuinely disciplined codebase — 3 runtime dependencies, no `service_role` key anywhere, a fail-closed AI adapter, pure-functional compliance core, ~30 unit tests, paired VERIFY/ROLLBACK migrations. That discipline is real and rare, and several agents said so unprompted.

But it is discipline applied to the wrong surface. **The system of record for every commercial and compliance decision DDP makes is browser localStorage.** The immutable Postgres tables built to hold that evidence are dead code: `grep -rn '\.rpc(' src/` returns **zero** — `issue_buyer_pack_snapshot()` has never been called. Migrations 11 and 15 harden `compliance_audit_log` against TRUNCATE while the batch-approval decision they exist to protect sits in a browser cache, editable from devtools by the very operator it is meant to hold accountable.

**Current maturity:** Advanced prototype attached to a services business.
**Overall confidence:** High on facts (all verified in source), low on production DB state (unknowable — see C-1).
**Overall risk:** High and concentrated in three places: an unverified RLS escalation, an unrecorded approval decision, and a commercial thesis with no revenue mechanism.
**Overall opportunity:** Real. Thai cannabis export documentation is a genuine, painful, brokerable problem, and the domain knowledge on display (GACP, PIC/S, water activity, CAPA, 77 provinces) is not something a generalist invents.

---

## Maturity Scores (0–10)

| Dimension | Score | One-line justification |
|---|---|---|
| **Commercial Readiness** | **1** | Zero billing/payment/invoice/deal code. The revenue event does not exist as data. |
| **Architecture** | **3** | Good taste in the small; the system of record is a browser cache. No router, no service boundary. |
| **Data Architecture** | **3** | No index beyond PKs on any core table; 5 tables have zero writers; no migration ledger. |
| **AI Readiness** | **3** | No RAG, no retrieval, no corpus, no evals. The AI summarises an RSS *teaser*, never the law. |
| **Deployment** | **3** | `main` auto-deploys to production with **no CI gate**; zero observability; no evidenced backups. |
| **Compliance Readiness** | **3** | The export-readiness engine can **never pass a batch**. No document is ever verified. |
| **Product** | **4** | A coherent internal supply-side ops tool mistaken by its own roadmap for a platform. |
| **Technical Direction** | **4** | 49 commits in 4 days; **zero** touched the farmer flow or the revenue path. |
| **UX** | **4** | No router (no deep links, back button ejects). No language toggle for farmers in live mode. |
| **Code Quality** | **5** | Excellent pure core; a 1,945-line god component and an 830-line hand-rolled router. |
| **Security** | **6** | Strong primitives (no service_role, RLS-scoped, fails closed) — undermined by a **vacuous** escalation test. |
| **AI Safety** | **6** | Draft-only boundary is real and held. Its enforcing guard failed **9 of 9** adversarial probes. |
| **Testing** | **4** | ~30 tests, all pure-logic with mocked providers. Zero component, zero E2E, zero evals. |
| **Documentation** | **6** | Voluminous and unusually honest — but ~30 PHASE_*_VALIDATION docs contradict live production. |
| **Enterprise Readiness** | **2** | Bus factor 1. No tenancy model, no SSO, no audit export, no SLA, no DR. |
| **Maintainability** | **5** | The pure core is a pleasure. The god component and localStorage coupling are the tax. |
| **Investment Readiness** | **2** | Investment Committee verdict: **pass-for-now**. |
| **OVERALL PROJECT HEALTH** | **3.5** | A 7/10 engineering asset inside a 2/10 commercial vehicle. |

---

## Critical Risk Register

### C-1 — Farmer may be able to self-certify export compliance *(UNRESOLVED — answer today)*
**Likelihood: Unknown (that is the finding). Impact: Catastrophic.**

- `FARM_RESAVE_PERSISTENCE_MIGRATION.sql:104-126` creates policy `"farms: farmer update own"`. Its `USING` and `WITH CHECK` assert **only farm membership — no column restriction.** A farmer may update *any column* on their own farm row.
- The sole guard is trigger `trg_protect_farm_admin_fields`.
- `FARM_ADMIN_ROLE_CHECK_FIX.sql:10-25` records a **live production check**: that trigger and its function **return 0 rows in production — they do not exist.**
- Therefore a farmer may be able to `PATCH` their own farm row setting `status='Approved'`, `compliance_status`, `risk_level`, `partner_tier` — **self-certifying the export compliance that this platform exists to independently verify.**
- The staging suite never tests this. `scripts/run-staging-security-tests.mjs:186-213` only tests *cross-tenant* updates (farmer A vs farmer B), never a farmer writing a privileged column on their **own** farm.

**Nobody in the company can currently answer whether this is live.** That is a 15-minute read-only query:
```sql
select policyname, cmd, qual, with_check from pg_policies
  where schemaname='public' and tablename='farms';
select tgname from pg_trigger
  where tgrelid='public.farms'::regclass and not tgisinternal;
```
**Fix:** column-level `GRANT`s (a privilege layer beats RLS logic), not another trigger. **4 hours.** **Owner: you, today.**

### C-2 — The privilege-escalation test is vacuous and always passes
`scripts/run-staging-security-tests.mjs:192,213` probes `profiles.update({ role: 'admin' })`. But `AUTH_RLS_SCHEMA.sql:21` is `CHECK (role IN ('ddp_admin','farmer'))` — Postgres **rejects `'admin'` on the CHECK constraint before RLS is ever consulted.** The test goes green **even if RLS on `profiles` were entirely disabled.** Your escalation coverage is an illusion.
**Fix:** probe `role: 'ddp_admin'`. **10 minutes.** Then re-run and see what it actually says.

### C-3 — The approval decision — the one record an auditor demands — is in a browser
`procurementControl.ts:340,344-359` stores `{decision, notes?, decidedAt}` in `localStorage`. **No `decided_by`. No mandatory reason. No server row.** Same for `RISK_OVERRIDE_KEY:304` and `REQUIREMENT_OVERRIDE_KEY:141`. `buyerPackAudit.ts:23` and `buyerPackSnapshotStore.ts:11` likewise.
Meanwhile `10_BUYER_PACK_SNAPSHOTS_MVP.sql:236` defines the immutable `issue_buyer_pack_snapshot()` RPC — and **`grep -rn '\.rpc(' src/` returns ZERO.** It has never been called. The schema can only record a **YES**: `10_BUYER_PACK_SNAPSHOTS_MVP.sql:59` is `CHECK (procurement_decision = 'progress')` — **you cannot record a rejection.**
**Fix:** append-only `procurement_decisions` / `risk_overrides` / `requirement_overrides` tables with actor FK + mandatory reason; call the RPC you already wrote. **1–2 weeks.**

### C-4 — The app copies the entire database into the admin's browser and never clears it
Reads are correctly guarded (`data.ts:622-623,636-637` return `[]` when `sbConfigured`). **Writes are not.** `data.ts:631-633` `saveInventory` and `:644-646` `saveFarms` are bare `localStorage.setItem`, called unconditionally from `App.tsx:117-118` on every state change. Every farm's **GPS coordinates, licence numbers, owner names, contacts, prices** are serialised in plaintext into that browser — **never read back in Supabase mode** (pure liability, zero function) — and `auth.ts:80-83` `signOut()` never clears it. It also crashes the admin portal at ~5MB (`QuotaExceededError` in an unguarded `useEffect`, no error boundary anywhere in `src/`).
**Fix:** `if (sbConfigured) return` in both functions; clear `ddp_*` on signOut. **1 hour.** There is no excuse for this one.

### C-5 — The compliance engine can never pass a batch
`complianceScoring.ts:116-144` hardcodes five checklist items to `passed: false` ("Buyer evidence model not active in this MVP"). Because they can never pass, `missingRequirements` is never empty and **`buyer_ready_for_discussion` is unreachable dead code.** Every batch that ships does so via a human override that has no server-side record (see C-3).
**Fix:** split IN-SCOPE checks (which gate) from DECLARED-OUT-OF-SCOPE (which display as *not assessed*, not *failed*). **2 days.**

### C-6 — "COA Intelligence" never reads the COA
`procurementControl.ts:183-229` `deriveCoaIntelligence()` re-displays the **farmer's own dropdown selections** (`FarmerSubmitInventory.tsx:36-37,62`). No PDF parser exists in the dependency tree. The code only checks `coaStoragePath` is non-empty — **a blank PDF passes.** Worse, `complianceRules.ts:169-180` grades missing heavy-metals testing as **`isBlocking: false`** — on a Thai-soil product whose top EU rejection cause is **cadmium**.
**Fix now (1 hour):** flip heavy metals to blocking, and put this sentence on every pack until you actually read COAs: *"Lab results as declared by the producer; COA not independently reviewed by DDP."* That sentence is free, it is true today, and it is the entire distance between a **disclosure** and a **misrepresentation**.

### C-7 — Production deploys with no gate, no observability, no backups
`README.md:105`: pushing to `main` auto-deploys to production. The Vercel API confirms every `main` commit is `target: 'production'`. **`security-ci.yml` does not gate it.** Greps for `sentry|datadog|otel|posthog|pino|winston` return **zero**. `api/compliance/ai-summary.ts:97` is a bare `} catch {` — it swallows every exception with no log. No evidenced DB backup/PITR.
**Fix:** Vercel Ignored Build Step querying the commit status; `console.error` in the catch; Sentry. **3 days.**

### C-8 — The Watchtower cannot watch, and suppresses the notices that matter
- `browserRssFetch.ts:19-21` — **in your own words** — "cross-origin regulatory feeds will typically be blocked by CORS in a real browser." The flagship feature's Check button **cannot succeed in production.** A buyer's engineer with devtools open finds this in ten minutes, and it retroactively reclassifies every honest claim you have made as marketing.
- `complianceSourceMonitoring.ts:270` runs the **AI-output wording guard over raw government text**. Blue Team reproduced it: *"Thailand approved licence classes for certified operators"* → **BLOCKED, no legal_update created.** A regulator saying "these operators are certified" is a **fact to ingest**, not an AI claim to censor.

**Fix:** disable the dead button **today** (0.5 day); server-side proxy + cron + allowlist (3–5 days); stop running the output guard over input (2–4 hours).

---

## Where Red Team Overreached (Blue Team's corrections — these matter)

Intellectual honesty cuts both ways. Four Red Team claims are **false**:

1. **The seal does not say "verified."** `logos.tsx:112-175` renders `DDP REVIEWED SUPPLY` / `HUMAN REVIEWED · TRACEABLE`. A comment at `:99-102` states it *deliberately* avoids "verified." You already made the right call here.
2. **`compliance_audit_log` is not empty.** `complianceRepository.ts:621` `insertAuditLog()` is called from `DDPComplianceWatchtower.tsx:361` with `actor_id`. Migrations 11/15 are protecting a table that is genuinely written.
3. **The Watchtower is not *architecturally* incapable.** The connector takes an injected `RssFetchImpl`; `browserRssFetch.ts:20-23` notes a server-side proxy swap "requires no change to the connector." It is a 3–5 day fix, not a rewrite.
4. **The guard's suppression is not silent.** `DDPComplianceWatchtower.tsx:822` surfaces the block to the admin. Wrong behaviour, but visible and attributable.

**And what neither team should lose:** no `service_role` key exists anywhere. The AI function uses the anon key **plus the caller's own JWT so RLS still applies**, and fails **closed** when unconfigured. `docs/SECURITY_TEST_LOG.md` explicitly disclaims its own completeness. That posture is better than most Series A companies.

---

## The AI Verdict

**There is no AI system here.** There is one stateless prompt→JSON HTTP call, wrapped in ~2,400 lines of genuinely disciplined guard code that makes the *absence* of retrieval, grounding, versioning, and evaluation **look like architecture**.

- **The AI never sees the law.** `complianceRssConnector.ts:213` — the LLM's entire evidence is the RSS **teaser blurb**, never the linked instrument.
- **"Legal change detection" is a SHA-256 of an RSS string** (`complianceSourceMonitoring.ts:62-78`). It cannot distinguish a typo fix from a new delegated act.
- **Citations are unvalidated free text the model invents** — `sourceReferences` is a bare `string[]` (`complianceAiSummarisation.ts:164-166`), explicitly **exempted from the safety guard**, never checked against source. **No conclusion can be traced to a legislative clause, so the output is unusable as compliance evidence.**
- **Zero evaluation.** All ~30 tests inject a fake provider. `EVIDENCE_INTELLIGENCE_TEST_MATRIX.md:123-127` says so plainly.
- **The safety guard failed 9 of 9 adversarial probes** (verified by execution, not inspection). `aiComplianceGuard.ts:34-98` `isNegatedContext()` returns true if *any* negation marker appears within 40 preceding characters — so *"There is **no** doubt this batch is compliant"* passes as **SAFE**. The inversion fix is **1 hour**.
- **No AI draft is ever persisted.** If a reviewer is misled, there is no trace it happened.

The draft-only, human-in-the-loop boundary **is real and Blue Team could not break it.** That is the thing worth keeping.

---

## The Brutal Truth

**What you are overestimating:** the SQL hardening. Migrations 11–15 harden function ACLs and TRUNCATE guards on a database with a near-zero real user count, while `farms` — where the actual escalation risk lives — went untouched.

**What you are underestimating:** that `grep -rn '\.rpc(' src/` returns zero. You designed, migrated, VERIFY-scripted and ROLLBACK-scripted an immutable snapshot RPC, and then never called it. **You built the vault, tested the vault, documented the vault — and kept the money in your browser.**

**The biggest mistake being made right now:** 49 commits in 4 days, **zero** on the farmer flow or the batch-review path. 40 of 49 touched SQL hardening, markdown, or AI scaffolding. That is not a knowledge gap — `DDPBuyerPreview.tsx:28-30` says *in your own words* the snapshots are "tamper-evident via content hashing, not durably tamper-proof." **You wrote the diagnosis and then went and did something else.**

**Why:** SQL migrations produce green VERIFY scripts. Buyers produce silence. Synthetic fixtures cannot fail in a way that hurts — you wrote them, so they pass. A farmer abandoning your 9-step wizard at step 6 *would* hurt, which is exactly why you have no telemetry to tell you that they did. You have built a rigorous apparatus of assurance for an organisation that does not exist, staffed by one person, certifying controls that are not wired to anything.

**And the part that should sting:** your honesty is your single most distinctive asset and the reason this audit could find anything at all — but in a diligence room, a founder who documents his own gaps better than most Series A companies **and then does not close them** is not read as honest. He is read as someone who knew exactly what was wrong and chose not to fix it. That is a worse story than incompetence, and it is the one your git log currently tells.

**Highest-leverage improvement:** get one real buyer to open one real pack. If nobody wants the pack, none of the rest matters — and you will have found that out for the price of a week instead of a company.

**Stop immediately:** all SQL hardening, all PHASE_*_VALIDATION docs, all AI work. Not deprioritise — **freeze**, as a written rule: *no commit merges unless it moves a real farmer or a real buyer through a real transaction.*

---

## Roadmap

**This week (the price of continuing, not a milestone):**
1. Run the `pg_policies` / `pg_trigger` query. Answer C-1. *(15 min)*
2. Fix the vacuous escalation test — probe `'ddp_admin'`, not `'admin'`. *(10 min)*
3. Guard the two localStorage writes; clear on signOut; add an ErrorBoundary. *(1 hour)*
4. Flip heavy metals to blocking; add the COA disclosure line. *(1 hour)*
5. Disable the Watchtower Check button. *(30 min)*
6. Fix the guard inversion. *(1 hour)*
7. Create a `schema_migrations` ledger. *(2 hours)*

**Next 2 weeks:** the approval decision becomes a server row — append-only, with actor and reason. Call `issue_buyer_pack_snapshot()`. Print the snapshot ID on the pack. Fix the unreachable readiness ladder — but **only after** the decision record exists (making the ladder passable without a server record makes things strictly worse).

**Next month:** a `deals` table (`batch_id, buyer_name, qty, price_agreed, commission_pct, stage, closed_at`) + admin CRUD. Replace `window.print()` with a **signed, expiring, tokenised buyer-pack URL** so you can *see* that a buyer opened it. **Do not build a buyer portal. Do not build Stripe.** A link and a deal row buy you the entire demand dataset for four days of work.

**Next quarter:** Sentry + ~12 PostHog events (`onboarding_step_completed`, `batch_submitted`, `buyer_pack_OPENED`). Then go and sell. Structured COA analytes vs. EU 2023/915 limits. Server-side Watchtower proxy + cron.

**Next 6–12 months:** three closed, invoiced commissions **recorded in the platform**. A second engineer. Only then: retrieval, a versioned legal corpus, citations as validated spans, and an eval harness.

---

## Final Verdict — Investment Committee

**PASS FOR NOW.** *(Not a hard pass — a "come back with a buyer.")*

> "This is one exceptionally disciplined developer with a well-organised prototype and an AI story — **not a company.** There is no buyer, no deal object, no revenue rail, no server-side record of the one decision the product exists to make, and no second human. £20m has nothing to buy here yet."

**Valuation view:** a **prototype attached to a services business — and the services business is the real one.** The moat, if it exists, is exclusive supply relationships with licensed Thai farms and buyer trust — and that lives entirely **outside this repository**, in contracts no code audit can value. Which is precisely why you should stop presenting the code as the asset. At £20m you would be paying a software multiple for a filing cabinet with excellent SQL hygiene. A seed cheque in the low seven figures against the milestones above is the honest number.

**Would I continue?** Yes — but **refactor the priorities, not the code.** The code is not the problem. The code is the place you have been hiding.

---

*Generated by a 15-agent adversarial audit. Every finding above was verified against source at `f5c8cbb`. Findings marked UNRESOLVED require a live database query that only you can run.*
