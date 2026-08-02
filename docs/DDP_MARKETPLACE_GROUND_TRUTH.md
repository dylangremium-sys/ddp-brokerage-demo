# DDP Supply Exchange — Repository Ground Truth

**Audit date:** 2026-08-01
**Method:** direct inspection of files, migrations and tests in this repository, plus one read-only query session against the live production database. No file outside `docs/` was modified. Nothing was committed, pushed or deployed.

---

## 0. Repository identification — the briefing's path is wrong

The briefing instructed work in `/Users/mac/ddp-inventory-demo`. **That path does not exist.**

| Candidate | Verdict | Evidence |
| --- | --- | --- |
| `/Users/mac/ddp-inventory-demo` | Does not exist | `ls` → `No such file or directory` |
| `/Users/mac/ddp-inventory-demo 2` | **Not a repository.** A June-22 snapshot of the original prototype. `git rev-parse --show-toplevel` resolves to `/Users/mac` (the home directory repo), i.e. it has no `.git` of its own. 14 top-level files, 21 source files, no Supabase, no migrations, no tests, no CI. | `find src -type f` → 21 files; no `.sql`, no `*.test.ts` |
| `/Users/mac/DDP AUDIT/ddp-brokerage-demo` | **This is the DDP platform.** `package.json` declares `"name": "ddp-inventory-demo"` — the briefing's name refers to *this* codebase; only the directory path was stale. | `git remote -v` → `github.com/dylangremium-sys/ddp-brokerage-demo.git`; 223 TypeScript files; 38 numbered SQL migrations; 129 test files |

**All findings below are measured against `/Users/mac/DDP AUDIT/ddp-brokerage-demo`.** The prototype directory is an ancestor, not an alternative — it contains earlier versions of the same page names (`DDPMasterInventory`, `DDPBuyerPreview`, `DDPFarmProfiles`) with none of the backend.

---

## 1. Exact state inspected

| Fact | Value |
| --- | --- |
| Path | `/Users/mac/DDP AUDIT/ddp-brokerage-demo` |
| Branch **at time of audit** | `feature/ai-summary-hardening` |
| HEAD **at time of audit** | `55c2808146a05b65b4589c18f98bc431aff71c9e` |
| Working tree | **Clean** — `git status --porcelain` returned 0 lines |
| `origin/main` at that moment | `75255d7139bea4ab74ac6fddd2c3ec20339ce62f` |
| HEAD vs main | 12 commits ahead, 0 behind |

### Mid-session branch change — disclosed, and re-verified

**Partway through this audit the repository was switched to `main` and fast-forwarded by a `git pull` outside this session** (PR #102, *"security: close the compliance AI permission-gate bypass"*, merged). Reflog confirms: `checkout: moving from feature/ai-summary-hardening to main`, then `pull --ff-only origin main: Fast-forward` to `0e65608f5e3753206fc424830ec4d81de2b48492`.

I re-verified rather than assuming the findings survived:

- `git diff --name-only 55c2808 0e65608` returns **exactly one file: `.deepsource.toml`** (a static-analysis config).
- No `.sql`, no `src/services/auth.ts`, no `src/types.ts`, no `src/App.tsx`, no `vercel.json` differs.
- `npm test` re-run on `0e65608`: **exit 0, 124 files passed / 5 skipped, 2600 tests passed / 34 skipped** — identical counts.

**Every finding in this document holds unchanged on the current `main` @ `0e65608`.** Working tree at close of session contains only the four untracked planning documents.

The 12 previously-unmerged commits were the compliance AI-summariser workstream (`serverAiProvider`, `aiSourceReferenceGuard`, `aiEval*`, `DDPComplianceWatchtower.tsx`) and are now on `main`. None of them touch a marketplace-relevant surface.

### Stack (from `package.json`, read in full)

React 19.2 + Vite 8 + TypeScript 6 + `@supabase/supabase-js` 2.108, tested with Vitest 4. Four Vercel serverless functions in `api/`. There is **no framework router** — see §3.

---

## 2. Commands run, exit codes, results

| Command | Exit | Result |
| --- | --- | --- |
| `git status --porcelain` | 0 | 0 lines (clean) |
| `npm test` (`vitest run`) | **0** | **124 test files passed, 5 skipped (129). 2600 tests passed, 34 skipped (2634). Duration 23.49s.** |
| `psql "$PROD_RO_DATABASE_URL" -c "select current_user, current_database()"` | 0 | `ddp_ro | postgres` — live production, read-only role |
| `psql … pg_tables where schemaname='public'` | 0 | 27 tables (listed in §5) |
| `psql … pg_class/pg_policy` | 0 | 27/27 tables have `relrowsecurity = t`, all with ≥1 policy |
| `psql … pg_proc where nspname='public'` | 0 | 18 functions (listed in §5) |
| `psql … select count(*) from public.profiles …` | **1** | **FAILED — `ERROR: permission denied for function is_ddp_admin`.** See §9. |

**What the passing suite proves:** 2600 assertions over the domain/service layer hold. **What it does not prove:** it is a Vitest unit/integration suite executing against in-process fakes and a jsdom environment. It does not exercise the production database, does not exercise RLS, and does not exercise any browser workflow end to end. A separate real-PostgreSQL harness exists (`npm run ci:runtime`, `scripts/disposable-pg/`) and is wired into `.github/workflows/runtime-verify.yml`; it was **not** run in this session.

---

## 3. Application architecture (measured)

**Single-page state machine, not a router.** `src/App.tsx` is 1515 lines holding ~25 `useState` hooks. Navigation is `const [page, setPage] = useState<Page>(...)` at `src/App.tsx:113`. `Page` is a 26-member string union at `src/types.ts:393`:

```
landing, login, set-password, forgot-password, farmer-register,
farmer-dashboard, farmer-onboarding, farmer-advanced-profile, farmer-my-stock,
farmer-stock-form, farmer-requests, farmer-status,
ddp-overview, ddp-farms, ddp-farm-review, ddp-inventory, ddp-inventory-review,
ddp-master, ddp-buyer, ddp-missing-documents, ddp-coa-intelligence,
ddp-risk-register, ddp-compliance-watchtower, ddp-operations-desk,
ddp-access-requests
```

**Consequence for this programme:** every marketplace surface (buyer catalogue, RFQ list, deal room, pipeline) becomes another member of this union and another branch in a 1515-line component, unless a router is introduced. Deep links, per-deal-room URLs, and browser back/forward are all impossible today. This is a Release 0 decision, not a cosmetic one.

`vercel.json` **does** contain an SPA rewrite (`/((?!api/).*)` → `/index.html`), so arbitrary paths serve the app shell — but the shell ignores `location.pathname`, so the path carries no state. `vercel.json` is byte-identical on `main`.

### Pages on disk (26 files, `find src/pages -type f`)

- `src/pages/admin/` — 13 pages + 1 contract test
- `src/pages/farmer/` — 8 pages
- `src/pages/public/` — 4 pages (Landing, Login, ForgotPassword, SetPassword)

**`DDPBuyerPreview.tsx` lives under `src/pages/admin/`.** It is an admin-facing preview of what a buyer would be shown. It is not a buyer-accessible surface.

---

## 4. Roles and authentication — the decisive finding

`src/services/auth.ts` (read in full, lines 1–120):

```ts
export type UserRole = 'ddp_admin' | 'farmer' | 'pending'
```

Reinforced at the database layer in three separate migrations:

- `AUTH_RLS_SCHEMA.sql:21` — `CHECK (role IN ('ddp_admin', 'farmer'))`
- `21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql:44` — `CHECK (role IN ('ddp_admin', 'farmer', 'pending'))`
- `27_…_ACTOR_AUTHORITATIVE_HARDENING.sql:473` — `CHECK (actor_role IN ('ddp_admin','farmer'))`

> **There is no buyer role, no buyer account, no buyer session and no buyer-facing authenticated surface anywhere in this codebase.**

Public self-registration was deliberately removed (`src/services/auth.ts`, closing comment: *"public self-registration has been removed. There is deliberately no client wrapper around the Supabase Auth public sign-up endpoint"*). Farmer accounts are created only by an admin via `api/admin/provision-farmer.ts`. Migration 34's header states the design intent explicitly: *"An access request is an ENQUIRY — a queue an administrator works from — never an account and never a role."*

`src/App.tsx:466-467` derives authority as `isAdminRole = isDemo || role === 'ddp_admin'` and `isFarmerRole = !isDemo && role === 'farmer'`. **Note `isDemo` grants admin authority in the client.** Demo mode's boundary is a live-vs-demo concern that must be re-examined before any external buyer touches the system.

### Absence proof for marketplace primitives

`grep -ril "enquiry|deal_room|dealroom|commission|rfq|requirement_document|buyer_organisation"` across `src/` and all `*.sql` returned **only** `src/App.css` and the ten `accessRequest*` files (which match the word "enquiry" in prose comments). **Zero** structural hits. No enquiry, deal room, RFQ, commission or buyer-organisation concept exists in code or schema.

---

## 5. Database — repository SQL vs live production

Migrations are numbered `*.sql` files at the repository **root** (not `supabase/migrations/`; that directory does not exist). Numbers present: `3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 34, 35, 36, 37, 38` plus seven unnumbered legacy files (`AUTH_RLS_SCHEMA.sql`, `SUPABASE_SCHEMA.sql`, `FARMER_MVP_MIGRATION.sql`, etc.). Most numbers ship a matching `_VERIFY.sql` and `_ROLLBACK.sql`.

**Note:** number 24 is used twice — `24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql` and `24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql`. Numbers 31, 32, 33 are absent from this branch. A migration-collision CI check exists (`scripts/audit-001-check-migration-collisions.mjs`).

### 5.1 The 27 tables that exist in production (measured, `pg_tables`)

`buyer_pack_audit_log`, `buyer_pack_download_log`, `buyer_pack_snapshots`, `compliance_alerts`, `compliance_audit_log`, `compliance_entity_status`, `compliance_reviews`, `compliance_rules`, `ddp_scores`, `documents`, `farm_memberships`, `farm_profiles`, `farmer_access_requests`, `farmer_documents`, `farmer_photos`, `farmer_review_requests`, `farms`, `inventory_batches`, `legal_updates`, `market_price_benchmarks`, `procurement_decisions`, `profiles`, `regulatory_sources`, `risk_flags`, `status_history`, `watchtower_ingestion_items`, `watchtower_ingestion_runs`

**All 27 have row-level security enabled (`relrowsecurity = t`) and at least one policy.** Policy counts: `farm_profiles` 5, `farms` 5, `inventory_batches` 5, `farm_memberships` 4, `farmer_documents` 4, `farmer_photos` 4, `farmer_review_requests` 4, `ddp_scores` 3, `documents` 3, `farmer_access_requests` 3, `market_price_benchmarks` 3, `profiles` 3, `risk_flags` 3, `status_history` 3, `watchtower_ingestion_runs` 3, remainder 1–2. **This is a genuinely strong isolation baseline and the single biggest asset this programme inherits.**

### 5.2 Tables defined in repository SQL but **absent from production** (8)

`document_field_extractions`, `evidence_request_attachments`, `evidence_request_history`, `evidence_request_responses`, `evidence_requests`, `public_intake_attempts`, `requirement_overrides`, `risk_overrides`

This is measured drift, not inference: the repository contains `CREATE TABLE` statements for 35 tables; production has 27. The evidence-request workflow (migration 24), the override tables (migration 30) and the intake throttle (migration 36) exist as reviewed code that **has never been applied to any production database.**

### 5.3 Production functions (18, measured `pg_proc`)

`fn_protect_farm_admin_fields`, `fn_protect_owner_notes`, `fn_protect_review_request_fields`, `guard_rule_source_authority`, `guard_watchtower_ingestion_item_insert`, `guard_watchtower_ingestion_run_update`, `handle_new_user`, `has_farm_membership`, `has_operational_farmer_access`, `is_ddp_admin`, `issue_buyer_pack_snapshot`, `prevent_buyer_pack_mutation`, `prevent_compliance_audit_log_mutation`, `prevent_procurement_decision_mutation`, `prevent_watchtower_ingestion_item_mutation`, `regulatory_source_tier`, `source_can_act_as_authority`, `stamp_farmer_access_request_review`

Absent: any evidence-request RPC (migration 24), any atomic status-transition RPC (migration 35), the throttled intake RPC (migration 36). Consistent with §5.2.

---

## 6. Capability-by-capability findings

Classification: **Built and proven** / **Partially built** / **Present but unsafe or incomplete** / **Not found** / **Cannot verify**.

### 6.1 Controlled farm onboarding — **Partially built**

- **Evidence:** `api/admin/provision-farmer.ts`, `src/lib/serverFarmerProvisioning.ts` (caller role checked at line 76 via `getProfileRole`), `21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql`, `34_FARMER_ACCESS_REQUESTS_HARDENING.sql`, `36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql`, `src/pages/admin/DDPAccessRequests.tsx`, `src/pages/farmer/FarmerRegister.tsx`. Tests: `serverFarmerProvisioning.test.ts`, `accessRequest.integration.test.ts`, `accessRequestProvisioning.test.ts`, `accessRequestAdmin.test.ts`, `farmerProvisioning.test.ts`.
- **Proves:** admin-only account creation is enforced server-side; a public intake queue exists that anon can insert into but not read back; approve/reject review is stamped by `stamp_farmer_access_request_review`.
- **Does not prove:** migration 36 (the throttled intake RPC) is **not in production** — `public_intake_attempts` is absent and the RPC is absent from `pg_proc`. Intake is therefore **unthrottled in production**. No licence-expiry tracking exists on the account (see 6.4).

### 6.2 Controlled buyer onboarding — **Not found**

No buyer role (§4), no buyer table, no buyer invitation path, no destination-country field, no import-authorisation evidence type. `DocumentRequirementType` (`src/types.ts:47`) enumerates only farm/batch document kinds.

### 6.3 Farm and supply profiles — **Built and proven (farm side), partially built (supply side)**

- **Evidence:** tables `farms`, `farm_profiles`, `farm_memberships`, `inventory_batches`, `farmer_photos`, `farmer_documents` — all present in production with 4–5 policies each. Pages `DDPFarmProfiles.tsx`, `DDPFarmReview.tsx`, `FarmerAdvancedProfile.tsx`, `FarmerSubmitInventory.tsx`, `FarmerMyStock.tsx`. Photo storage: `src/lib/batchPhotoStorage.ts` + tests; `38_FARMER_PHOTOS_OBJECT_POLICIES_HARDENING.sql`.
- **`StockStatus`** (`src/types.ts`) is a real lifecycle: `draft, submitted, needs_changes, approved_internal, client_visible, reserved, sold, archived`.
- **Does not prove:** `reserved`/`sold` have no counterpart transaction record — nothing in the schema explains *who* reserved or bought. Harvest-date/upcoming-harvest and sample-availability fields were not found.

### 6.4 Evidence review — **Present but incomplete**

- **Built:** `EvidenceStatus` at `src/types.ts:28` is `claimed | documented | reviewed | verified | missing | rejected | expired`. `ComplianceVerificationTier` at `src/types.ts:17` is `CULTIVATOR_CLAIMED | DDP_DOCUMENTED | ADVANCED_DOCUMENTATION_REVIEW`. Derivation lives in `src/lib/procurementControl.ts` with an explicit in-code prohibition on implying "verified" without support. `src/lib/buyerApprovalGate.ts` (read in full) is exactly the anti-auto-verification control this programme requires: it refuses to let "no blockers found" read as approval, and labels the outcome *"DDP Reviewed — Human Approved for Buyer Discussion"* rather than a bare "Approved". Tests: `buyerPackOutputGate.test.ts`, `buyerPackGateOverrides.test.ts`, `complianceRepository.test.ts`.
- **Gap vs the brief:** the brief's `under review` and `buyer-ready for discussion` states are not members of `EvidenceStatus` (the latter is derived at render time by `deriveBuyerApprovalGate`, not stored).
- **Unsafe/incomplete:** the entire evidence-**request** workflow (migration 24 — `evidence_requests`, `evidence_request_responses`, `evidence_request_history`, `evidence_request_attachments`, plus the `evidence-request-files` storage bucket) is **absent from production**. Farms cannot be asked for evidence through the live system.

### 6.5 Buyer catalogue — **Present but not a buyer surface**

`DDPBuyerPreview.tsx` is admin-only (§3). `src/lib/buyerPreviewApprovedList.ts` + test govern what reaches the approved list. There is no buyer login, no search, no filter set matching the brief (cultivar / cannabinoid range / quantity / harvest date / certification / cultivation method), no comparison view, no request-access action. **Classify: Partially built as an internal preview; Not found as a buyer catalogue.**

### 6.6 Buyer requirements and RFQs — **Not found.** No table, no type, no page.

### 6.7 Matching — **Not found.** No `matches` table, no matching workspace. `DDPOperationsDesk.tsx` + `operationsDeskPriority.ts`/`operationsDeskFilters.ts`/`operationsDeskActions.ts` are an internal work queue, not supply↔demand matching.

### 6.8 Enquiries — **Not found** as a buyer↔farm channel. `farmer_review_requests` (`FarmerRequests.tsx`, `reviewRequestScope.test.ts`, `reviewRequestsLoader.test.ts`) is an admin↔farm channel and is a reusable pattern, not a substitute.

### 6.9 Private deal rooms — **Not found.** Nothing in schema or code.

### 6.10 Progressive identity disclosure — **Not found.** No masking, no introduction record, no disclosure snapshot. `fn_protect_owner_notes` protects internal notes from farmer edits, which is an internal/external separation primitive but not disclosure control.

### 6.11 Buyer Packs — **Built and proven, with three stated limitations**

- **Evidence:** `10_BUYER_PACK_SNAPSHOTS_MVP.sql` (read in detail), `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql`, `29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_HARDENING.sql`; `src/lib/buyerPackSnapshot.ts`, `buyerPackSnapshotRepository.ts`, `buyerPackSnapshotSupabaseStore.ts`, `buyerPackOutputGate.ts`, `buyerPackAudit.ts`, `buyerPackDownloads.ts`. Tests: `buyerPackSnapshot.test.ts`, `buyerPackSnapshotDurability.test.ts`, `buyerPackSnapshotSupabaseStore.test.ts`, `buyerPackOutputGate.test.ts`, `pages/admin/buyerPackOutputGate.contract.test.ts`.
- **Confirmed live:** `buyer_pack_snapshots`, `buyer_pack_audit_log`, `buyer_pack_download_log` **all exist in production with RLS on**. `issue_buyer_pack_snapshot` and `prevent_buyer_pack_mutation` are **present in `pg_proc`**. Append-only is enforced twice over — no UPDATE/DELETE policy at all, plus a trigger that raises even for elevated roles.
- **Schema proves:** `UNIQUE (pack_id, version)` version guard; `content_hash CHAR(64) CHECK (~ '^[0-9a-f]{64}$')`; `procurement_decision TEXT NOT NULL CHECK (procurement_decision = 'progress')` — the human-approval gate is a database constraint, not a UI convention; `issued_by UUID` captured server-side from `auth.uid()`.
- **Three limitations stated by the migration itself (lines 40–58), which I confirm by reading the DDL:**
  1. `content_hash` is **client-supplied and not recomputed server-side** — there is a hash-parity TODO in the RPC. Tamper-*evident* only if you trust the client that computed it.
  2. `approved_by` is **client metadata, not verified identity**. Only `issued_by` is authoritative.
  3. "Immutable" means immutable to `anon`/`authenticated`. A service-role or direct-Postgres actor can still alter rows. Not WORM, not legally immutable.
- **Not found:** watermarking, recipient binding, expiring access, revocation. `buyer_pack_download_log` has the columns (`buyer_organisation`, `browser`, `ip_address`, `device`, `reason`) but the DDL comments state they are **not captured by default** and enabling capture is a separate privacy-reviewed step.

### 6.12 Opportunity pipeline — **Not found.** `procurement_decisions` records per-batch decisions (`progress, hold, reject, request_documents, request_fresh_coa, request_inventory_proof, escalate_review`, each requiring a non-empty `reason`, with `decided_by` defaulting to `auth.uid()` and a `prevent_procurement_decision_mutation` trigger). That is an append-only decision log, not an opportunity state machine — there is no opportunity entity to hold state.

### 6.13 Commission tracking — **Not found.** No table, type or page. Zero grep hits.

### 6.14 Marketplace protections — **Partially built, and the strongest area**

Present and measured: RLS on 27/27 production tables; private storage buckets (`farmer-documents`, `farmer-photos`, `evidence-request-files` referenced; **20 storage policies** across migrations; `37_STORAGE_BUCKET_PRIVACY_HARDENING.sql`, `38_FARMER_PHOTOS_OBJECT_POLICIES_HARDENING.sql`); append-only audit tables with anti-TRUNCATE triggers (`11_…TRUNCATE_HARDENING.sql`); function EXECUTE ACL hardening (12, 13); default-privilege hardening (14); field-level guards (`fn_protect_farm_admin_fields`, `fn_protect_owner_notes`); evidence digest dedup (migration 28 — **not in production**); a strict CSP + `X-Frame-Options: DENY` + `Permissions-Policy` in `vercel.json`; `npm audit --audit-level=high` in CI.

Not found: malware scanning, metadata stripping, contact-detail detection, rate limiting (migration 36 unapplied), watermarking, expiring links, documented retention/deletion policy, documented incident response, tested backup/restore.

### 6.15 Notifications — **Partially built / deliberately narrowed.** Email exists only for account invitations (`api/admin/resend-invitation.ts`, `serverInvitationResend.ts`, `inviteRedirect.test.ts`). Commit `234b4ac` on the adjacent home-directory repo replaced SMTP with an in-app activity log. `compliance_alerts` + `complianceLocalAlerts.ts` cover compliance alerting only. No notification table, no preferences, no digest.

### 6.16 Administration and reporting — **Partially built.** Thirteen admin pages exist covering farm/inventory review, missing documents, COA intelligence, risk register, watchtower, operations desk and access requests. Absent: buyer management, listing moderation as a distinct concept, requirement management, matching workspace, deal oversight, commission ledger, and a searchable audit-log UI.

### 6.17 Revenue model support — **Not found.** No membership, fee, subscription or billing concept anywhere.

### 6.18 Audit logging — **Present but scoped to compliance, not commerce**

`compliance_audit_log` (`9_COMPLIANCE_WATCHTOWER_MVP.sql:102-129`, read in full) has `actor_type CHECK IN ('admin','ai_assistant','system','legal_reviewer')`, `before_state`/`after_state` JSONB, mandatory `entity_type`, and — critically — a **closed 15-value `action` CHECK constraint**: `legal_update_created, legal_update_reviewed, rule_suggested, rule_approved, rule_paused, rule_retired, alert_created, alert_resolved, readiness_status_changed, document_status_changed, sent_to_legal_review, reviewer_note_added, rule_rejected, legal_update_archived, alert_dismissed`.

**Every one of those 15 actions is a regulatory-watchtower event. Not one is a commercial event.** Migration 27 made the actor authoritative. This is exactly the "generic compliance audit logging vs commercial deal audit logging" distinction the brief asks for: the commercial audit trail does not exist, and the existing table **cannot** absorb it without a constraint change. This is a Release 0 decision.

---

## 7. Tests and CI

- 129 test files, 2634 tests. `npm test` exit 0 (§2).
- **`.github/workflows/security-ci.yml`** — `npm audit --omit=dev --audit-level=high`, `verify:migration-numbers`, `security:sql`, `audit-001-check-migration-collisions.mjs`, `npm test`, `tsc -b`, `lint`, `build`; then a gated Vercel production deploy job.
- **`.github/workflows/runtime-verify.yml`** — spins a disposable PostgreSQL and runs `npm run ci:runtime` plus five harness tests including `migration-35-precondition` and `migration-36-throttle-concurrency`. **A real-PostgreSQL migration gate exists and is genuinely good.** It was not executed in this session.
- `vercel.json` sets `git.deploymentEnabled.main = false` — production deploys are CI-driven, not push-driven.

---

## 8. Existing documentation

`docs/` holds 40+ files including `MASTER_DEVELOPMENT_ROADMAP.md`, `PRODUCTION_MIGRATION_PLAN.md`, `MIGRATION_RUNTIME_STATUS.md`, `LAUNCH_GO_NO_GO_2026-07-25.md`, `PRODUCTION_CHANGE_FREEZE_2026-07-25.md`, `BUYER_PACK_PHASE_B_DESIGN.md`, `THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md`, plus `docs/audits/`, `docs/runbooks/`, `docs/releases/`. **Per the brief's integrity rules these were not treated as proof of current state** — every claim above is from source, schema or a live query. A change freeze is documented; whether it is still in force is a decision for the owner and is not evidenced by the repository.

---

## 9. What could not be verified

1. **Production row counts and data content.** The `ddp_ro` role can read catalogue metadata but **cannot read table rows** — every `select count(*)` failed with `ERROR: permission denied for function is_ddp_admin` (and `has_operational_farmer_access`), because the RLS policies call those functions and `ddp_ro` lacks EXECUTE. *This is itself a positive finding about RLS, and a hard limit on this audit.* How many farms, batches or buyer packs exist in production is **unverified**.
2. **Whether the disposable-PG runtime harness currently passes.** Not run.
3. **Storage bucket configuration in production** (private flag, object counts). Requires the Supabase management API, not the read-only Postgres role.
4. **Which migrations have been applied**, as a positive record. There is no migration-tracking table. §5.2 infers non-application from the *absence* of tables and functions, which is sound for those eight tables but does not establish the applied status of migrations that only alter privileges (11–16, 19, 20, 37).
5. **Deployment status** — no Vercel API call was made. Whether `origin/main` is what is live is unverified.
6. **The supplied photographs and COA PDFs.** No such assets were located in this repository. Their existence, count and provenance are unverified; the ingestion design in the implementation plan is written against the requirement, not against inspected files.
7. **Demo mode's production boundary.** `isDemo` grants admin authority at `src/App.tsx:466`. Whether `isDemo` can ever be true in a production build was not traced to a conclusion.

---

## 10. Honest completion assessment

Counted **after** the matrix in `DDP_MARKETPLACE_IMPLEMENTATION_PLAN.md`, not before.

Of the 17 required marketplace capabilities: **0 fully built and proven end-to-end for a marketplace**, **7 partially built** (farm onboarding, farm/supply profiles, evidence review, buyer catalogue-as-internal-preview, marketplace protections, notifications, administration), **1 built and proven within its own scope but not marketplace-wired** (Buyer Packs), **9 not found** (buyer onboarding, RFQs, matching, enquiries, deal rooms, identity disclosure, opportunity pipeline, commission tracking, revenue model).

Weighting by the effort estimates in the implementation plan rather than by capability count: **the existing platform supplies roughly 30–35% of the marketplace build**, and the part it supplies — tenant isolation, RLS, evidence semantics, human-approval gating, immutable pack issuance, real-PostgreSQL CI — is the part that is normally hardest to retrofit. The missing 65–70% is almost entirely the two-sided commercial layer, which does not exist in any form.
