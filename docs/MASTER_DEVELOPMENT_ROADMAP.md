# DDP Brokerage — Master Development Roadmap

**Status of this document:** Documentation only. No application code, SQL, environment files, or infrastructure were changed to produce this document. Nothing here was deployed, migrated, or pushed as part of writing it.

**Method:** Every claim below was checked directly against the files in this repository (`/Users/mac/ddp-inventory-demo`), against `git log`, and — where noted — against prior validation documents already in the repo. Claims that could not be confirmed from the repository are explicitly labeled **Unable to verify**. No feature is described as complete, certified, or compliant unless the code itself demonstrates it.

**Status legend used throughout this document:**

| Label | Meaning |
|---|---|
| **Implemented** | Working code exists, was read directly, and does what is described. |
| **Partially implemented** | Some real code exists, but with a material gap, a hardcoded stub, or a piece that is unwired/unreachable from the actual product surface. |
| **Planned** | An interface, type, comment, or roadmap entry describes the intent, but no functioning implementation exists yet. |
| **Unable to verify** | The claim depends on live infrastructure state (e.g. production Supabase), or on files/behavior outside what could be directly confirmed from this repository. |

---

## 1. Executive Summary

DDP Brokerage is a React/TypeScript web application built around a cannabis-industry agricultural supply-chain compliance workflow between farmers and a broker ("DDP"), with a simulated view of what a prospective buyer would see. (Domain confirmed directly in code — `strainName`, `thcPct`/`cbdPct`, and a `'Thai cannabis control'` document-requirement type in `src/types.ts`; the project's own `README.md` frames this more generally as "agricultural commodities.") It runs in one of two modes: a **demo mode** backed entirely by browser `localStorage`, and a **live mode** backed by Supabase (Postgres, Auth, Storage), selected automatically based on whether Supabase environment variables are configured.

The system currently implements: farmer registration and a 9-step onboarding wizard, farmer inventory/COA submission with real PDF upload to Supabase Storage, an admin review workflow (farm review, inventory review, master inventory), a document-completeness matrix, a mechanical risk-flagging register, a Compliance Watchtower for tracking regulatory updates through a human-approval pipeline, and an admin-only "Buyer Pack" preview. Database access control is designed to be enforced by Postgres Row-Level Security (RLS), with a detailed manual test log documenting live verification of many — but not all — of those policies (Section 19).

The system does **not** currently have: a real buyer account/role, a working AI model integration anywhere (despite AI-shaped naming and interfaces), a real chain-of-custody ledger, working file uploads for most licence/certification fields, or any automated CI pipeline. Several pieces of infrastructure exist as tested library code but are not wired into the product a user actually sees (most notably the "immutable buyer pack" snapshot system). One live SQL trigger was found with a likely logic defect that has not been confirmed against production behavior.

This document exists to separate what is genuinely built from what is aspirational, and to lay out what remains before the platform could reasonably be described — by an external auditor, regulator, or enterprise buyer, not by this document — as meeting professional, security, compliance, or audit-readiness standards.

---

## 2. Product Vision

DDP Brokerage is designed for a workflow where:

- Farmers register, complete a profile, and submit inventory batches with supporting documentation (including lab Certificates of Analysis).
- DDP staff (the sole "admin" role) review farm profiles and inventory submissions, track missing documentation, flag risk, and monitor regulatory/compliance developments.
- A prospective buyer is intended to eventually see a curated, evidence-backed "Buyer Pack" for an approved batch, with DDP acting as the reviewing intermediary rather than the buyer having direct platform access.

The product vision, as expressed in the codebase's own comments and prior roadmap documents, is explicitly **not** to claim that the platform itself certifies legal compliance, export readiness, or pharmaceutical-grade quality. It is designed to organize, evidence, and route documentation and decisions to qualified humans — DDP staff, and ultimately legal/regulatory professionals — for real judgment calls.

---

## 3. Core Compliance Principle

The intended governing principle for any compliance-relevant automation in this system, confirmed against actual code and comments (`src/lib/aiComplianceProvider.ts`, `src/lib/complianceRules.ts`, `src/pages/admin/DDPComplianceWatchtower.tsx`):

1. **AI detects** — an automated process identifies a candidate regulatory/legal change or data gap.
2. **AI summarises** — an automated process produces a plain-language summary and classification of the finding.
3. **Human reviews** — a DDP staff member reads the finding and makes a judgment call.
4. **Approved rule** — the human's judgment is codified as an explicitly approved/active rule, not left as an inference.
5. **System enforces** — only rules that reached the "approved/active" state are used to flag real data going forward.

**Current implementation status of each stage:**

| Stage | Status | Evidence |
|---|---|---|
| AI detects | **Planned** | No regulatory-source monitoring or detection job exists. Intake of legal/regulatory updates is a 100%-manual paste form (`DDPComplianceWatchtower.tsx`, "Manual Legal / Regulatory Update Intake"). |
| AI summarises | **Planned** | `src/lib/aiComplianceProvider.ts` defines a `ComplianceAIProvider` interface and an `AIComplianceConfidenceScore` type, but its own header comment states plainly: "No implementation exists yet in this codebase — no AI API is called, no network request is made." The only concrete class implementing the interface is a test-only stub (`aiComplianceProvider.test.ts`) that returns canned strings. |
| Human reviews | **Implemented** | A Review Queue tab lets a DDP admin classify each intake as informational / create-rule / approve-rule / send-to-legal / reject / archive, with real state transitions persisted (Supabase when configured, else `localStorage`). |
| Approved rule | **Implemented** | Rules only take effect once a human sets their status to `approved` or `active` via the Rules tab (`isEnforcedRuleStatus`, `src/lib/complianceRules.ts`). Rules are seeded as `suggested` (non-enforced) by default. |
| System enforces | **Implemented, alert-level only** | `deriveRuleBasedComplianceAlerts` (`src/lib/complianceAlerts.ts`) checks only enforced rules against current farm/inventory data and raises alerts. There is no automated downstream action (e.g. no automatic hold on a batch) — enforcement means "an alert is shown," not "a workflow is blocked."

**Important distinction verified in code:** there is one deterministic, non-AI safety mechanism that *is* wired in today — `src/lib/aiComplianceGuard.ts`, a plain regex/keyword scanner that blocks unqualified claim-words ("compliant," "certified," "verified," "guaranteed," "export-ready," etc.) from being submitted in the manual legal-update intake form unless properly qualified. This is a genuine, working control, but it is a wording linter, not an AI system, and it should not be described as "AI compliance detection."

---

## 4. What Has Been Built So Far

High-level, verified inventory (details in later sections):

- Farmer registration, a 9-step onboarding wizard with autosave, an advanced/extended profile form, inventory/COA submission with real PDF upload, a "My Stock" management view, a request/response inbox, and a status/activity timeline.
- Admin dashboards: overview, inventory dashboard, per-batch inventory review with approve/reject/request-info actions, master inventory table, farm profile registry, per-farm review with a scoring sidebar and decision actions.
- A "Supply Ledger" navigation grouping (Inventory Review, Master Inventory, Missing Documents, COA Intelligence, Risk Register, Buyer Preview) — a UI label, not a distinct data ledger (see Section 10).
- A Missing Documents Matrix computing document-completeness status per farm against a fixed set of 12 document types.
- A COA Intelligence dashboard summarizing lab-value fields already entered by the farmer, with a rule-based red-flag scan.
- A Risk Register that emits risk entries from a small, fixed if/else rule cascade over COA red flags and farm status.
- A Compliance Watchtower: manual legal-update intake, human review queue, rule approval workflow, and rule-based alerting, with real Supabase persistence (RLS-protected, 7 tables) including a database-enforced append-only audit log trigger.
- A Buyer Pack preview (admin-only) showing a curated summary of an approved batch, with copy-to-clipboard and browser-print export.
- A fully built, unit-tested "immutable buyer pack snapshot" library (SHA-256 hashing, object-freezing, append-only versioned store, audit trail, download-history log) — **not currently wired into any page**.
- An extensive, staged Row-Level Security rollout across many SQL migration files, with a rollback file, and a substantial manual live-testing log (`docs/SECURITY_TEST_LOG.md`) documenting real tests against a production Supabase project.
- A Thai/English bilingual translation layer (~700 key-value pairs) with two rounds of native-speaker/legal review documented.
- 103 passing automated unit tests (Vitest) covering business logic in `src/lib/` — compliance rules, buyer-pack logic, and the AI-guard wording filter. No UI/component or end-to-end tests exist.
- A prior professionalization audit and roadmap (`docs/PROFESSIONALIZATION_ROADMAP.md`) covering a 7-agent read-only review plus an implemented "Wave 1" of copy/CSS fixes, and a separately closed-out "Compliance Rules Operationalization v1" workstream, verified live in production on 2026-07-08.

---

## 5. Current Architecture

**Implemented, verified against `package.json`, `vite.config.ts`, `tsconfig*.json`, `src/lib/supabase.ts`, `src/lib/db.ts`, `src/App.tsx`:**

- **Frontend:** React 19, TypeScript 6 (project references, `strict`-adjacent flags including `noUnusedLocals`/`noUnusedParameters`), Vite 8 for build/dev, ESLint 10 + typescript-eslint for linting.
- **No dedicated backend server.** There is no Express/Fastify/Nest process, and no `/api` directory. The browser talks directly to Supabase using the public anon key (`src/lib/supabase.ts`).
- **No routing library.** Navigation is a hand-rolled `Page` string-union type held in component state (`goTo(page)` in `App.tsx`), not React Router or any URL-based routing. There are no deep-linkable URLs for individual farms/batches.
- **No state-management library.** All state is local `useState`/`useEffect`, persisted to `localStorage` in demo mode (`src/data.ts`) or read/written directly against Supabase in live mode (`src/lib/db.ts`, ~980 lines, the sole data-access layer).
- **Authorization boundary:** the real access-control boundary is intended to be Postgres Row-Level Security, not the React code. Frontend role checks (`isAdminRole`/`isFarmerRole` derived inline in `App.tsx`) exist only to avoid rendering UI a user shouldn't see or issuing requests doomed to be rejected by RLS — they are not a substitute for RLS and are trivially bypassable by any direct API call.
- **Dual operating mode:** if Supabase environment variables are absent, the entire app runs against `localStorage` with all pages/roles unlocked for demo purposes (`isSupabaseConfigured` flag). This is clearly useful for demos but means "the app works" is not, by itself, evidence that the live/Supabase-backed security model works.

---

## 6. User Roles

**Implemented:** Exactly two backend-enforced roles exist: `ddp_admin` and `farmer` (`UserRole` type, `src/services/auth.ts`). Role is stored on a `profiles` table row and read on login/session-change.

**Not implemented as a role:** There is no buyer role, buyer login, or buyer-scoped table anywhere in the schema or auth code. The "Buyer Preview" page is reachable only by an already-authenticated `ddp_admin` — it is DDP staff previewing what a buyer would be shown, not a buyer's own account.

**Cosmetic-only, not an auth role:** A farmer "sub-role" (`Farmer` / `Farm Manager` / `Broker`) exists purely as a display label typed during registration; it has no effect on authorization.

**Unable to verify:** How `ddp_admin` profile rows are actually provisioned in production (no self-service admin signup path exists in the code, so admin accounts are presumably created directly against the database — this was not observed in the repository).

---

## 7. Farmer Workflow

**Implemented:**
- Registration (local draft only, not yet a backend account).
- A 9-step onboarding wizard with per-step autosave, completion-percentage tracking, and a final review/submit step producing a `FarmProfile` with status `Submitted to DDP`.
- Inventory/batch submission (`FarmerSubmitInventory.tsx`) with real client-side MIME/extension validation and a genuine PDF upload to Supabase Storage (bucket `farmer-documents`, path scoped to the uploading user).
- "My Stock" list/filter view, including a working "replace COA" action using the same real upload path.
- A requests inbox reflecting admin-created review requests, with resolve/edit actions.
- A status/activity timeline merging farm and inventory state.
- An "Advanced Profile" second-tier form covering business, licensing, facility, production, genetics, compliance, and export/partnership fields.

**Partially implemented / stub:**
- Licence and certification fields throughout the onboarding wizard and the Advanced Profile (e.g. processing licence, export licence, organic certification, ISO certifications) are **plain text inputs**, not file uploads — a farmer types a filename or reference string; no file is attached or stored. This contrasts with the genuinely working COA/photo-related upload path used elsewhere.
- Product/facility photo fields in onboarding accept a pasted **external URL** (e.g. a Google Photos or LINE link), not an uploaded file.
- Inventory submission photos are read client-side as `data:` URLs and kept only in application state — they are **not** uploaded to Supabase Storage.
- The farmer-side carbon-programme "exclude/withdraw" action is explicitly a no-op against live Supabase: the UI displays a warning that production persistence requires an approved migration, and the action only updates local React state.

---

## 8. Buyer Workflow

**Implemented:**
- An admin-only "Buyer Pack Preview" (`DDPBuyerPreview.tsx`) shown to DDP staff for an approved batch: product/farm identity, allocatable quantity, price, lab values (explicitly captioned "as documented by the farm from its COA — DDP review required before commercial reliance"), a COA link generated via a real, time-limited (1-hour) Supabase signed URL, a document-completeness matrix, a risk-register summary, and a recommended-decision control.
- "Copy Summary" (clipboard text) and "Print / Save PDF" (`window.print()`) export mechanisms. There is no server-side PDF generation pipeline.
- A human-approval gate (`buyerApprovalGate.ts`, unit tested) that only allows a batch to be labeled approved-for-buyer-discussion when there are no blocking issues **and** a DDP staffer has recorded an explicit "progress" decision — a status field alone is not sufficient.

**Partially implemented (built, but not reachable by users):**
- A fully designed and unit-tested "immutable buyer pack snapshot" system exists (`buyerPackSnapshot.ts`, `buyerPackSnapshotRepository.ts`, `buyerPackSnapshotStore.ts`, `buyerPackAudit.ts`, `buyerPackDownloads.ts`): SHA-256 content hashing over a canonically ordered, deep-frozen copy of the pack's evidence; an append-only version store that rejects overwrites; an audit-event log (generated/viewed/superseded/archived); and a separate download-history log. **This code is not imported or called anywhere in `DDPBuyerPreview.tsx` or any other page** — confirmed by a repository-wide search for its exported functions. The Buyer Pack a user actually sees today is recomputed live on every render and is not hashed, versioned, or snapshotted in practice.
- Persistence for this snapshot/audit system, where it is used at all (its own tests), is `localStorage` only — there is no Supabase table backing it. It is not durable across devices or browsers, and nothing prevents a user from clearing browser storage to erase the "immutable" record.

**Not implemented:** A real buyer account, buyer login, buyer-initiated access request, or buyer-visible audit trail of who viewed which pack and when.

---

## 9. Admin Workflow

**Implemented:**
- Overview dashboard (farm/inventory counts, action-required list, top batches/farms).
- Inventory dashboard and per-batch inventory review with real approve/reject/request-missing-document actions, an internal note field, a buyer-visibility toggle, a "send request to farmer" action (feeding the farmer requests inbox), and COA viewing via signed URL.
- Master Inventory: filterable/sortable table of approved batches, with a route into the Buyer Pack for a given batch.
- Farm Profiles registry with simple, transparent (non-black-box) heuristics for risk level and export readiness.
- Farm Review: a full read-only detail view plus a scoring sidebar (9 named sub-scores) and real decision actions (Approve / Request Additional Information / Watchlist / Strategic Partner / Reject), persisted via `updateFarmProfileStatus`.

**Partially implemented / caveat:**
- The admin-side carbon-programme status control is explicitly disabled against live Supabase with an on-screen warning that changes will not be saved, mirroring the farmer-side limitation in Section 7.
- **Unable to verify:** where the 9 Farm Review compliance sub-scores are actually computed. They default to zero in the onboarding wizard, and no admin UI reviewed writes to them directly — it is possible they are only ever seeded by demo fixtures rather than computed from real farm data. This needs direct confirmation against `src/lib/complianceScoring.ts` and `src/lib/testFixtures.ts` before being described in any product materials as a working scoring engine.

---

## 10. Supply Ledger

**Partially implemented — a navigation label, not a ledger mechanism.** "Supply Ledger" is the name of a tab group (`SupplyLedgerTabs.tsx`) spanning six existing admin pages (Inventory Review, Master Inventory, Missing Documents, COA Intelligence, Risk Register, Buyer Preview). There is no dedicated ledger data type, no per-batch history/versioning, and no append-only or hash-chained record of state changes to a batch.

`chain_of_custody` is a recognized document-requirement type in the type system, but its status is **hardcoded to `missing`** in two independent places (`src/lib/procurementControl.ts`, `src/lib/complianceScoring.ts`), each with an explicit source comment stating that chain-of-custody evidence is not captured in the current MVP. No blockchain, hash-chaining, or other tamper-evidence mechanism exists for inventory/farm data — it is stored as ordinary mutable rows (Postgres in live mode, `localStorage` in demo mode).

---

## 11. COA Intelligence

**Implemented, as a manual-data summary and file viewer — not document extraction.** `DDPCoaIntelligence.tsx` displays lab fields (THC/CBD/terpenes, moisture, heavy metals/pesticides/mycotoxins/microbial pass-fail, lab name, report number) that were **typed directly into a form by the farmer** during inventory submission, together with a small rule-based scan that flags missing/expired/failed results. The actual COA document is a PDF stored in Supabase Storage and opened via a signed URL for a human to read.

There is **no OCR, PDF parsing, or AI-based extraction anywhere in the codebase.** The page itself carries an on-screen disclaimer that the displayed values are as typed by the farm and are not independently verified — this document preserves that same caution and does not describe this feature as AI-powered extraction.

---

## 12. Missing Documents Matrix

**Implemented, as a static, hardcoded rule engine.** A fixed list of 12 document-requirement types is evaluated per farm/batch by deterministic, hand-written boolean logic (`deriveFarmDocumentRequirements`, `src/lib/procurementControl.ts`). DDP staff can manually override any computed status, and overrides persist to `localStorage`. This is not a dynamic or externally configurable requirements schema — the requirement types and derivation rules are fixed in source code, and changing them requires a code change, not a data change.

---

## 13. Risk Register

**Implemented, as a mechanical gap-scan — not a weighted or learned risk model.** `deriveAutoRisks` (`src/lib/procurementControl.ts`) emits risk entries from a small fixed if/else cascade: batches with COA red flags produce `blocker`/`high`/`medium` entries depending on the nature of the flag; farms flagged "More Information Required" produce a fixed medium-severity entry. Severity is not numerically weighted or model-derived, and `owner` defaults to "Unassigned" pending manual assignment. DDP staff can manually override status.

A related but distinct feature, "Export Readiness" (`src/lib/complianceScoring.ts`), computes a 16-item pass/fail checklist per batch; four of those items (buyer licence, import permit, export permit, chain-of-custody, human review) are **hardcoded to fail**, each annotated in source as "not active in this MVP." No AI or machine-learning involvement exists in either the Risk Register or Export Readiness logic — confirmed by tracing all call paths and finding no import of the AI-related modules from either feature.

---

## 14. Buyer Pack / Immutable Evidence Packs

See Section 8 for the user-facing workflow. Summarized status:

- **Implemented (as a tested, standalone library):** SHA-256 content hashing over a deep-frozen, canonically serialized snapshot; an append-only version store that rejects overwrites of an existing `(packId, version)`; an audit-event log; a download-history log.
- **Not implemented (as a shipped, reachable feature):** none of this library is called from the Buyer Pack page or any other page in the application. It is unit-tested, dead code from the product's point of view.
- **Not implemented:** server-side (Supabase) persistence for any of this — all of it, where used at all (its own tests), is `localStorage`-backed only, meaning it is neither durable nor genuinely tamper-resistant in a real deployment (a user can edit or clear their own browser storage).
- **Recommendation embedded in this audit:** do not describe the Buyer Pack as having immutable evidence, hashing, or an audit trail in any external-facing material until this library is actually wired into the live page and backed by durable, server-side storage.

---

## 15. Compliance Watchtower

**Implemented, as a human-gated, rule-based alerting system with real database persistence.**

- Alerts are computed synchronously on render (`useMemo` over current farm/inventory/rule data) — there is no polling, realtime subscription, or scheduled job. The system reflects whatever data happens to be loaded at the time.
- 14 baseline compliance rules are hardcoded in source, seeded with status `suggested` (i.e., **not enforced by default**). A rule only affects alerting once a human admin explicitly sets it to `approved` or `active` via the Rules tab. New rules can also be created dynamically from a reviewed legal update.
- When Supabase is configured, all Watchtower data (legal updates, reviews, rules, alerts, entity status, audit log) is persisted to seven RLS-protected, admin-only Postgres tables. The audit log table has a **database-level trigger that raises an exception on any UPDATE or DELETE**, making it a genuinely enforced append-only log when Supabase is configured — not merely an application-level convention.
- In demo mode (no Supabase configured), the same data model falls back to `localStorage`, which carries none of the same server-enforced guarantees; the UI explicitly labels this as local/demo-only data.
- A full end-to-end proof of the intended pipeline (legal update → human review → approved rule → generated alert → visible rule-impact badge on a Supply Ledger page) was executed and verified live against production Supabase on 2026-07-08, using a clearly labeled demo entity, and was subsequently cleaned up with the audit trail confirmed intact (`docs/PROFESSIONALIZATION_ROADMAP.md`). This is real evidence the mechanism works end-to-end in production, for the one entity and rule tested.

**Unable to verify:** whether the underlying SQL migration (`9_COMPLIANCE_WATCHTOWER_MVP.sql`) is applied in every environment this system might be deployed to, beyond the specific production project referenced in the above proof.

---

## 16. Security and RLS Work Completed

**Implemented — a staged, chronological Row-Level Security rollout:**

RLS is enabled with per-role policies on: `farms`, `farm_profiles`, `farm_memberships`, `inventory_batches`, `ddp_scores`, `risk_flags`, `status_history`, `documents`, `profiles`, `farmer_review_requests`, `market_price_benchmarks`, `farmer_documents`, `farmer_photos`, and the seven Compliance Watchtower tables. The general pattern is: `ddp_admin` gets full access via an `is_ddp_admin()` helper; farmers get access scoped to their own farm membership or `created_by = auth.uid()`; no table grants unauthenticated (`anon`) access.

The migration history shows deliberate staging and correction discipline: an initial schema draft, a staged enablement file, two documented hotfix patches for drift discovered after initial rollout (`INVENTORY_BATCHES_RLS_PATCH.sql`, `INVENTORY_BATCHES_INSERT_GUARDRAIL_FIX.sql`), a dedicated search-path/grants hardening pass for five database functions (revoking `PUBLIC`/`anon` execute rights), and a full rollback script (`RLS_ROLLBACK.sql`).

**Defect found during this audit — requires live verification before relying on it:**

`FARM_RESAVE_PERSISTENCE_MIGRATION.sql` defines a trigger function, `fn_protect_farm_admin_fields()`, that checks `profiles.role = 'admin'`. Every other admin-gating function in this codebase checks `role = 'ddp_admin'` — the only value the `profiles.role` check constraint actually permits alongside `farmer`. As written, this trigger's admin check can never be true, which means it would unconditionally revert several fields (including `status`, `reviewed_by`, `compliance_status`, `risk_level`) back to their prior value on every update to the `farms` table — including legitimate admin approve/reject actions. Prior validation documentation (`PHASE_3E_2_FARM_RESAVE_PERSISTENCE_VALIDATION.md`) records that this migration was manually applied to production, but its own verification only confirmed that the trigger and function *exist*, not that admin status changes actually persist afterward.

**This is flagged as the single highest-priority item in this document's Immediate roadmap (Section 24).** It should be confirmed directly against production before this document, or anyone reading it, assumes admin farm-approval actions are being saved correctly.

**Storage security — implemented, with one unused planned bucket:**

The `farmer-documents` Supabase Storage bucket is private, restricted to `application/pdf`, capped at 10MB (dashboard-configured), and has three RLS policies (admin: all; farmer: upload own path-prefixed content; farmer: read own content). A second bucket, `farmer-photos`, is defined only in a commented-out SQL block that was never applied — photo data is instead stored as base64/JSONB directly on the inventory row, which is a materially different (less scalable, less access-controlled) storage pattern than the COA path.

**Unused schema found:** the `farmer_documents` and `farmer_photos` database tables are RLS-protected and were confirmed present in the live policy sweep, but have zero references anywhere in the application code — the real upload path uses Supabase Storage directly. These tables appear to be vestigial.

---

## 17. Authentication and Authorization

**Implemented:** Supabase Auth, email + password only (`signInWithPassword`, `signUp`). Session state is handled via Supabase's own client-side session management, with a subscription (`onAuthStateChange`) that re-fetches the user's profile row on every auth event.

**Not implemented:** multi-factor authentication, single sign-on/OAuth, and magic-link sign-in — confirmed absent by direct search of the authentication code; none of these are wired into the UI or the auth service.

**Authorization:** enforced primarily by Postgres RLS (Section 16), not by application code. Frontend role checks exist only to shape the UI (hiding admin pages from farmers, showing an "Access Denied" screen for out-of-scope pages) and are not a security boundary on their own. Two small helper functions (`isAdmin()`/`isFarmer()`) exist in the auth service but are not actually called anywhere else in the app — role checks are re-derived inline elsewhere instead. This is a minor code-hygiene issue, not a security gap, since the inline checks are functionally equivalent.

---

## 18. Storage Security

Covered in detail in Section 16. Summary: real, path-scoped, MIME-restricted, size-capped, RLS-protected private storage exists for COA PDFs. It does not yet exist for photos (base64/JSONB instead) or for any of the free-text licence/certification "upload" fields described in Section 7, which do not actually store a file at all.

---

## 19. Testing and Verification Completed

**Automated tests — implemented, but narrow in scope.** `vitest run` currently passes 103 of 103 tests across 11 test files, all located under `src/lib/`. These tests cover business logic — compliance rule status transitions, buyer-pack approval gating, the AI-guard wording filter, and related domain logic — and were confirmed (by direct reading) to contain substantive assertions and real branch coverage, not placeholder tests. **There are no automated UI/component tests, no automated RLS/integration tests, and no end-to-end tests.**

**Manual RLS verification — implemented, and extensive relative to the size of the codebase, but explicitly self-declared as partial.** `docs/SECURITY_TEST_LOG.md` documents real, live functional tests run against the production Supabase project using the anon key and dedicated test identities (two farmer accounts, one admin fixture), citing actual HTTP and Postgres error codes as evidence. It records: a genuine access-control drift that was found and fixed; a full `pg_policies` parity sweep across all 28 public/storage tables; passing cross-farmer data-isolation tests; passing storage-isolation tests using real uploaded files; and a real gap it found — no farmer-level `DELETE` policy exists on any table, so farmer delete requests silently succeed with zero rows affected rather than being explicitly denied. The log explicitly states it is **not** a full security audit or penetration test, and lists specific untested combinations (admin `DELETE`, `farms`/`farm_memberships` `DELETE`, more storage-isolation scenarios, and — naturally — anything buyer-role-related, since no buyer role exists).

Live policy snapshots (`tmp/live_pg_policies_snapshot*.csv`, `tmp/parsed_*.json`) in the repository are genuine exports queried from the production database, corroborating the security log's claims rather than being fabricated evidence.

---

## 20. Thai/English Language Review

**Implemented, with a known internal inconsistency that should be resolved.** The translation layer (`src/translations.ts`) contains roughly 700 bilingual key-value pairs. Two review documents exist: `docs/THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md`, which marks a specific set of "buyer discussion" phrases as **Status: Pending**, and `docs/THAI_NATIVE_SPEAKER_REVIEW.md`, which later states the same phrases were reviewed and approved, citing specific commit hashes. **These two documents directly contradict each other** — one of them is stale and should be corrected or reconciled. Separately, two "needs native speaker review" comments remain live in `src/translations.ts` for strings that the native-speaker review document marks as already resolved — the documented cleanup step (removing those comments once confirmed) does not appear to have been carried out.

---

## 21. Documentation Already Created

The repository root contains 29 markdown files and `docs/` contains 4, almost all of which are dated, point-in-time validation or phase-completion logs rather than living architectural reference documentation:

- `docs/PROFESSIONALIZATION_ROADMAP.md` — a prior 7-agent read-only audit plus an implemented "Wave 1" copy/CSS patch, and a separately closed-out "Compliance Rules Operationalization v1" workstream verified live in production. This is the most substantive prior planning document and this roadmap builds on it rather than duplicating it.
- `docs/SECURITY_TEST_LOG.md` — covered in Section 19.
- `docs/THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md` and `docs/THAI_NATIVE_SPEAKER_REVIEW.md` — covered in Section 20.
- `README.md` — general project overview.
- 20 `PHASE_*_VALIDATION.md` files and several similarly named root-level validation documents — each records a specific, narrow refactor or feature validation at a specific commit.

**A prior audit (`docs/PROFESSIONALIZATION_ROADMAP.md`) already flagged that a number of these root-level validation documents are stale or contradictory — some claim different branches/commits as "currently deployed" — and recommended archiving them into `docs/archive/`. That recommendation has not yet been executed** and is carried forward into this roadmap (Section 24).

---

## 22. Known Limitations

Consolidated from all sections above, without repeating evidence already cited:

- No real buyer role, account, or login exists; the Buyer Pack is an admin-only simulation.
- The immutable buyer-pack snapshot/audit system is fully built and tested but not wired into the product and not backed by durable server-side storage.
- Chain-of-custody tracking is explicitly not implemented; the field is hardcoded to "missing."
- Most licence/certification "upload" fields across farmer onboarding are plain text inputs, not real file uploads; product/facility photos are similarly not stored as real files in most flows.
- Carbon-programme status changes do not persist against live Supabase on either the farmer or admin side.
- A likely-defective SQL trigger (`fn_protect_farm_admin_fields()`, wrong role literal) may be silently reverting admin farm-status changes in production — unconfirmed, high priority to verify.
- No farmer-level `DELETE` RLS policy exists on any table (requests silently no-op rather than being denied) — a real gap noted in the project's own security test log.
- The `farmer-photos` storage bucket was never actually created; the `farmer_documents`/`farmer_photos` database tables appear unused.
- Two Thai-review documents contradict each other on the review status of the same set of phrases.
- No AI/LLM model is called anywhere in the codebase, despite AI-shaped naming (`aiComplianceProvider`, "COA Intelligence") — these are currently rule-based/manual, not AI-driven.
- No CI/CD pipeline exists to gate lint, typecheck, or tests before deploy; no error/observability monitoring exists.
- Automated test coverage is limited to business logic in `src/lib/`; there are no automated UI, integration, RLS, or end-to-end tests.
- Manual RLS testing, while extensive, is explicitly self-declared as non-exhaustive by its own author.
- A number of root-level documentation files are stale/contradictory and have not yet been archived, despite a prior audit recommending it.

---

## 23. Remaining Work

The remaining work spans: fixing the specific defects above, wiring already-built-but-unreachable code into the product, replacing stubbed/placeholder data-entry patterns with real ones, closing testing gaps, and — only after all of that — considering any claims about compliance, security certification, or audit readiness. The prioritized breakdown is in Section 24.

---

## 24. Roadmap to World-Class Standard

### Immediate (days)
1. Confirm live, in the Supabase SQL editor, whether `fn_protect_farm_admin_fields()`'s role check is actually reverting admin farm-status updates in production (Section 16). This affects whether core admin approve/reject actions are working at all.
2. Directly query live `pg_tables`/`pg_policies` in production and diff against what the on-disk SQL files claim, closing the loop `docs/PROFESSIONALIZATION_ROADMAP.md` already identified as open.
3. Reconcile the two contradictory Thai-review documents (Section 20) and remove the two stale "needs review" comments in `translations.ts` once genuinely confirmed.
4. Decide on and execute the previously recommended archiving of stale/contradictory root-level validation documents into `docs/archive/`.

### Short term (weeks)
1. Either wire the existing buyer-pack snapshot/audit/download library into `DDPBuyerPreview.tsx` with real Supabase persistence, or remove/clearly label it as unused until that work happens — do not leave tested-but-unreachable code that could be mistaken for a shipped feature.
2. Add an explicit farmer-level `DELETE` policy decision (deny with a clear error, or permit with scoping) for every table currently missing one, closing the gap noted in `docs/SECURITY_TEST_LOG.md`.
3. Correct the "upload document" copy on licence/certification fields that are actually plain text inputs, or implement real file upload for them, backed by Supabase Storage with the same RLS pattern used for COAs.
4. Stand up CI (e.g. GitHub Actions) to run lint, typecheck, and `vitest run` on every change before merge.
5. Implement the Buyer Pack print/reference-number/legend improvements already scoped in `docs/PROFESSIONALIZATION_ROADMAP.md` Phase C.

### Medium term (months)
1. Make an explicit product decision on whether a real buyer role/account is in scope; if yes, design its auth, RLS scoping, and audit logging before building any buyer-facing UI beyond the current admin preview.
2. Design and implement a real chain-of-custody data model (farm → DDP → buyer transfer events) to replace the current hardcoded placeholder.
3. Implement real file storage (not base64/JSONB, not free text) for product photos and all licence/certification documents, with RLS matching the COA pattern.
4. If regulatory-source monitoring and AI summarization are still desired, implement a concrete `ComplianceAIProvider` behind the existing interface — with the human-review and approved-rule gates in Section 3 preserved exactly as designed, not weakened.
5. Expand automated testing to include UI/component tests and a scripted (not purely manual) RLS/integration test suite that formalizes the checks already documented by hand in `docs/SECURITY_TEST_LOG.md`.
6. Add error/observability monitoring (e.g. Sentry or equivalent) for both the frontend and any server-side logic introduced later.

### Long term (quarters and beyond)
1. Commission a formal, independent security review or penetration test — current testing, while substantive, is self-declared partial and performed by the same people building the system.
2. If pursuing pharmaceutical-, GACP-, GMP-, or GDP-adjacent claims, engage qualified regulatory/legal counsel to define the actual applicable requirements for the specific target jurisdictions and product categories before building toward them — this system does not currently implement, and should not claim, any such certification.
3. Evaluate whether stronger, infrastructure-level tamper-evidence (true content-addressed storage, WORM-compliant object storage, or a dedicated audit-log service) is needed for buyer-facing evidence, beyond the current database-level trigger protecting the Compliance Watchtower audit log.
4. Establish formal data retention, backup/disaster-recovery, and incident-response policies.
5. Plan for scale (multi-region/high-availability infrastructure) only once real usage patterns justify it.

---

## 25. Enterprise Security Roadmap

Enterprise-grade security readiness, given the current state, requires (in addition to items already listed in Section 24): resolving the live-vs-documented RLS confirmation gap; closing the missing farmer-DELETE-policy gap; independently verifying the farm-admin-fields trigger defect; introducing MFA and session-management hardening for admin accounts specifically (given they hold broad `FOR ALL` RLS access); introducing structured audit logging for all admin actions (not just Compliance Watchtower actions); and a documented secrets-management and environment-variable handling policy (out of scope for this document to audit, since env files were explicitly not to be read or changed).

**This system does not currently implement, and this document does not claim, SOC 2, ISO 27001, or any other formal security certification.** Achieving any of those would require a dedicated compliance program (policies, formal risk assessments, third-party audits) well beyond application code changes.

---

## 26. Pharmaceutical/GxP Readiness Roadmap

The codebase's own comments already correctly disclaim pharmaceutical, GACP, GMP, and GDP readiness — several fields in the Export Readiness checklist (Section 13) are explicitly hardcoded as not-yet-implemented for exactly this reason. Any future work toward such standards should be **led by qualified regulatory/quality professionals defining the actual requirements**, with engineering work following from that definition — not the reverse. Until that happens, this document deliberately does not propose a technical roadmap toward GxP readiness, because the requirements are not yet defined by anyone qualified to define them.

---

## 27. AI Compliance Agent Roadmap

Building on Section 3's stage-by-stage status:

1. Define, with human compliance stakeholders, what "AI detects" should actually monitor (specific regulatory sources, jurisdictions, update cadence) before writing any detection code.
2. Implement a concrete `ComplianceAIProvider` (the interface already exists in `src/lib/aiComplianceProvider.ts`) that calls a real model for summarization/classification, with every output explicitly marked as requiring human review — the `requiresHumanReview: true` provenance field already designed into the type system should remain non-negotiable.
3. Preserve the existing human-review → approved-rule → system-enforces pipeline exactly as built; do not allow an AI-generated summary or classification to auto-approve a rule or auto-generate an enforced alert.
4. Retain and extend the existing wording-safety guard (`aiComplianceGuard.ts`) to cover any new AI-generated text surfaces.
5. Only after a real provider exists and has been tested, update this document (and any external materials) to describe "AI-assisted" (not "AI-certified" or "AI-verified") compliance monitoring.

---

## 28. Audit and Regulator Readiness

**Unable to verify** whether this system has ever been reviewed by an external auditor or regulator — no such review is referenced anywhere in the repository. What currently exists that would be useful evidence in a future audit: the staged RLS migration history with a rollback plan, the manual security test log with live production evidence, the Compliance Watchtower's database-enforced append-only audit trigger, and this document's own explicit separation of implemented-vs-planned claims. What is currently missing that a real audit would ask for: independent verification of the items in Section 24 (Immediate), a resolved chain-of-custody model, automated (not purely manual) security testing, and a documented incident-response process. This document does not claim the system is audit-ready; it documents what evidence currently exists toward that goal.

---

## 29. Investor/Partner Due Diligence Readiness

For due-diligence purposes, this document itself — and the verified state it describes — is the most accurate current answer to "what has actually been built." Reviewers should be pointed to: this document, `docs/SECURITY_TEST_LOG.md`, and `docs/PROFESSIONALIZATION_ROADMAP.md`. Reviewers should **not** be given any of the individual `PHASE_*_VALIDATION.md` files as a primary reference, since several are known to be stale or to contradict each other about what is "currently deployed" (Section 21) — this is exactly the kind of documentation-hygiene issue that damages credibility in due diligence and should be fixed per Section 24 (Immediate) before any external review.

---

## 30. Final Highest-Standard Checklist

This checklist reflects verified current state, not aspiration. An item is checked only if directly confirmed in this repository.

- [x] Role-based data model with two enforced roles (`ddp_admin`, `farmer`)
- [x] Database-level (RLS) access control, staged and largely tested manually
- [x] Real, path-scoped, RLS-protected file storage for COA documents
- [x] Human-approval gate for buyer-facing evidence (code-level, tested)
- [x] Database-enforced append-only audit log (Compliance Watchtower)
- [x] Automated unit tests for core business logic (103 passing)
- [x] Bilingual (Thai/English) UI with a documented native-speaker review process (two review documents currently contradict each other on status — see Section 20 — and should be reconciled before this is relied on as complete)
- [ ] Independently confirmed, current-as-of-today live RLS state matching on-disk SQL
- [ ] Confirmed-correct admin farm-status persistence (pending trigger-defect verification)
- [ ] Real buyer role/account with its own scoped access and audit trail
- [ ] Chain-of-custody data model
- [ ] Real file storage for all licence/certification/photo fields
- [ ] Wired, server-persisted immutable buyer-pack evidence system
- [ ] CI pipeline gating lint/typecheck/tests before deploy
- [ ] Automated UI/integration/end-to-end test coverage
- [ ] A real AI compliance provider implementation, gated by the existing human-review pipeline
- [ ] Independent (external) security review or penetration test
- [ ] Formal data retention, backup/DR, and incident-response policies
- [ ] Consolidated, non-contradictory documentation set (stale validation docs archived)

## Definition of Highest Standard

For this platform, "highest standard" means: every claim made to a farmer, buyer, investor, auditor, or regulator is directly traceable to working code or a verified live test — never to a comment, an interface name, or a document written before the feature it describes actually existed. It means the security boundary that matters (database-level access control) is independently confirmed against live infrastructure, not assumed from source files. It means automation that touches compliance or legal judgment is designed so a human always makes the final call, and the system can prove that a human did. It means documentation is consolidated and internally consistent, not a trail of dated validation notes that contradict each other about what is actually deployed. And it means the platform never asserts a certification, legal compliance status, or regulatory approval that has not been granted by the qualified party actually authorized to grant it. Reaching that standard is a continuous process, evidenced by verification, not a one-time declaration — this document is one step in that process, not its conclusion.
