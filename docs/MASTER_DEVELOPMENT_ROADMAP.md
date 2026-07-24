# DDP Brokerage — Master Development Roadmap

**Single source of truth for the full DDP Brokerage product *plan*.** For **runtime application status** the authority is `docs/MIGRATION_RUNTIME_STATUS.md`; for **Evidence Request & Resolution behaviour** the authority is `docs/EVIDENCE_REQUEST_RESOLUTION_CONTRACT.md` (current binding contract, v1.5). These are complementary, not competing.

**Status of this document:** Documentation only. No application code, SQL, migration, test, environment file, branch, commit, deployment, or external setting was created or changed to produce it. Nothing here was applied, migrated, pushed, or deployed.

**Audited baseline:** `origin/main` @ **`afbe59e1ba19cf2c2799f83c90add134ae0923d0`** — *"Add DDP-controlled farmer provisioning (#22)"*, merged 2026-07-20. Reconciliation performed 2026-07-21.

> **Local-checkout warning at time of audit.** The local `main` branch was at `e4175c7` — **16 commits behind `origin/main`**. Every statement in this document was verified against an exact extract of `origin/main` @ `afbe59e`, not against the stale local branch. Anyone re-running this audit should `git fetch` and verify against `origin/main` first.

**Method:** Every substantive statement below is grounded in at least one of: a source file, a migration file, a test, a `package.json` script, a CI workflow, a merged pull request, or an explicitly identified open pull request. Claims that depend on live infrastructure, credentials, or external evidence not obtainable from the repository are labelled **UNABLE TO VERIFY** and are not asserted. Open pull-request code is never described as implemented.

**This document does not claim** legal compliance, export approval, pharmaceutical or GxP certification, audit readiness, regulatory approval, complete security, or production verification where only static tests exist.

---

## 1. Status Vocabulary

These labels are used consistently throughout. Nothing outside this list is a status.

| Label | Meaning |
|---|---|
| **IMPLEMENTED** | Merged into `main` and directly verified in repository code. |
| **IMPLEMENTED — RUNTIME VERIFICATION REQUIRED** | Merged code exists, but a required production or database runtime check remains unresolved. |
| **ACTIVE IMPLEMENTATION** | Work exists on an open branch or pull request but is **not** merged. Not shipped. |
| **PARTIALLY IMPLEMENTED** | Some functional implementation exists, but a material product phase is missing. |
| **PLANNED** | Approved roadmap scope without functioning implementation. |
| **DEFERRED** | Deliberately parked; not part of the immediate execution sequence. |
| **SUPERSEDED** | Replaced by later work and no longer authoritative. |
| **UNABLE TO VERIFY** | Requires infrastructure, credentials, or external evidence not available from the repository. |

---

## 2. Executive Summary

DDP Brokerage is a **complete brokerage operations platform** for agricultural commodity supply between farmers and buyers, with DDP acting as the reviewing and transacting intermediary. The full product plan spans farmer onboarding and evidence collection, inventory and COA review, compliance monitoring, buyer relationship management, deal execution, fulfilment, and the **commercial and financial layer** — pricing, purchase and sale values, brokerage commission, invoicing, payment milestones, amounts due and received, commercial reporting, financial exports, and margin analysis. That commercial scope is retained in full (Section 3 and Section 8) and has **not** been reduced.

**What the repository actually contains today (verified at `afbe59e`):** a React 19 / TypeScript 6 / Vite 8 front end; two Vercel serverless API routes (`api/admin/provision-farmer.ts`, `api/compliance/ai-summary.ts`); 23 numbered SQL migrations plus a body of pre-numbering schema files; a GitHub Actions CI pipeline that gates lint, typecheck, unit tests, static SQL security checks, and production build, and which is the **only** authorised automated path to production; and **1,169 passing automated tests across 72 test files**.

**Material advances since the previous revision of this document.** The prior revision described a system with two roles, no CI, 103 tests, ungated Buyer Pack output, no server-side code, and no AI. All six of those statements are now false. The platform now has a three-role model with a non-operational `pending` state, DDP-controlled farmer provisioning replacing public self-registration, a read-only admin Operations Desk, server-authoritative Buyer Pack issuance logic, a fail-closed browser-output gate on the Buyer Pack, production browser-persistence suppression, privacy-safe observability, and a live, production-verified server-side AI draft-summarisation path for legal updates. Section 5 is the full correction register.

**The dominant risk is no longer missing code — it is unverified *production* database state.** The repository's own runtime ledger (`docs/MIGRATION_RUNTIME_STATUS.md`, last verified 2026-07-21) is the current authority for runtime application status and now covers migrations 10, 17 and **19–23** — the farm admin-field guard, controlled farmer provisioning, the operational-farmer RLS overlay, and server-authoritative Buyer Pack issuance. **Staging installation state is now materially clearer, but staging is only partially confirmed:** 20 and 21 are `APPLIED_AND_VERIFIED`; 19, 22 and 23 are `APPLIED_NOT_VERIFIED` — installed, but behaviour not fully exercised (for 22 the 11-table overlay is substantially covered while its storage `FOR ALL` surface is not) — see *Migrations 19–23 — status matrix*. Migration 23 in particular **is** installed in staging, superseding its runbook's earlier "runs no SQL against any database" claim; see *Conflicting evidence — migration 23 in staging*. The qualification is material: the 2026-07-21 harness returned **107 PASS · 5 FAIL · 0 SKIP · 0 BLOCK**, the pending-matrix merge gate is **NOT SATISFIED** (61 total · 59 pass · 2 fail), and storage cleanup is defective — so the outstanding behavioural checks for the migration-19 farm guard and migration-23 Buyer Pack issuance must **not** be treated as closed. **Production remains `UNKNOWN` for all five and was not contacted**; that production gap is the largest unresolved release-state item in the programme.

**Active work.** The Evidence Request & Resolution workflow — the next feature in the original sequence — has landed its **database phase on `main`**: migration 24 was merged via **PR #37 (merge `9496e1c`)** on 2026-07-23. **It is not, however, applied to any hosted database** — `NOT_APPLIED` to staging and to production — so its security properties are asserted, not demonstrated, on hosted Supabase. The **application layer** (service, pages, Operations Desk) is **not integrated on `main`**: it is authored on branch `feature/evidence-request-workflow-v2` (commit `4fb72f7`) and is unmerged and unverified. The feature is therefore **not shipped** (Section 7). The current binding behaviour contract is `docs/EVIDENCE_REQUEST_RESOLUTION_CONTRACT.md` (v1.5).

---

## 3. Product Vision and Scope

DDP Brokerage is a compliance-first B2B procurement and brokerage platform, not a retail marketplace. The intended end-to-end workflow is:

1. DDP provisions and onboards farmers under its own control; farmers build farm profiles and submit inventory batches with supporting evidence, including laboratory Certificates of Analysis.
2. DDP staff review farms and batches, chase missing evidence, flag risk, monitor regulatory developments, and make recorded procurement decisions.
3. DDP curates an evidence-backed Buyer Pack for an approved batch and issues it under an explicit, server-enforced human-approval gate.
4. DDP manages buyer relationships, matches buyer requirements to available inventory, and runs the deal through samples, contracts, fulfilment, and chain of custody.
5. **DDP records the commercial reality of each deal** — purchase price, sale price, brokerage commission, invoices, payment milestones, amounts due and received — and reports on margin and profitability.

**The commercial and financial layer is in scope and remains in scope.** It is currently **PLANNED** (Section 8, feature 9) rather than built: the repository contains farmer asking price (`pricePerKg`, `src/types.ts:382`), DDP market price benchmarks (`market_price_benchmarks`, `src/lib/db.ts:573-589`), and price-related review request types (`src/types.ts:346`), but a repository-wide search finds **no** occurrence of commission, invoice, payment, or margin logic anywhere in `src/`, `api/`, or the SQL corpus. Recording that honestly is not a reduction of scope — the scope is retained and sequenced.

**What the platform is explicitly not designed to assert.** It does not certify legal compliance, export readiness, or pharmaceutical-grade quality. It organises, evidences, and routes documentation and decisions to qualified humans — DDP staff, and ultimately legal and regulatory professionals — who make the actual judgements. Every automation touching compliance is designed so a human makes the final call and the system can prove a human did.

---

## 4. Verified Baseline (as at `afbe59e`)

### 4.1 Build, test, and quality tooling

| Fact | Evidence |
|---|---|
| React 19.2, TypeScript ~6.0, Vite 8.0, Vitest 4.1, ESLint 10 | `package.json` dependencies / devDependencies |
| Scripts: `dev`, `prebuild`, `build`, `lint`, `preview`, `test`, `security:sql`, `security:staging`, `ci:verify` | `package.json` scripts |
| `ci:verify` = `security:sql && test && tsc -b && lint && build` | `package.json` |
| **1,169 tests across 72 files, all passing** | `npx vitest run` executed against an exact `git archive` extract of `origin/main` @ `afbe59e` |
| Test split: 60 × `src/**/*.test.ts`, 12 × `scripts/**/*.test.mjs` | `vite.config.ts:11` include patterns |
| API project included in the root TypeScript build | `tsconfig.api.json`, merged PR #11 |

### 4.2 CI and deployment control

`.github/workflows/security-ci.yml` defines two jobs:

- **`verify`** — runs on pull requests to `main`, pushes to `main`, and `workflow_dispatch`. Steps: `npm ci` → `npm run security:sql` → `npm test` → `npx tsc -b` → `npm run lint` → `npm run build`. Permissions are `contents: read`. The job never connects to a database and uses no secrets.
- **`deploy-production`** — `needs: verify` (mechanically cannot start unless verification succeeded), `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, `environment: Production`, concurrency group `production-deploy` with `cancel-in-progress: false`. Installs a **pinned** `vercel@56.2.0`, runs `vercel pull/build/deploy --prebuilt --prod`, then **verifies the live site serves the exact deployed commit** by polling `https://www.ddpbrokerage.com/version.json` for `commitSha == GITHUB_SHA` (30 attempts, 10s apart) and fails the job otherwise.

`vercel.json` sets `git.deploymentEnabled.main = false`, so Vercel's own Git integration cannot deploy `main` — the CI workflow is the only automated production path. `scripts/deploy-workflow.test.mjs` is a regression test asserting this gate cannot be silently weakened (`needs`, `if`, `continue-on-error`).

**Status: IMPLEMENTED.** This directly supersedes the previous revision's claims that no CI pipeline existed and that production deployment was not CI-controlled.

### 4.3 Roles and authentication

`export type UserRole = 'ddp_admin' | 'farmer' | 'pending'` — `src/services/auth.ts:16`. **Three roles, not two.**

`pending` is documented in the same file (`:13-15`) as a **non-operational** role: a user who exists in Supabase Auth but has not been provisioned by DDP. `resolvePostLoginDecision` (`src/lib/postLoginRouting.ts:22-33`) returns `{ kind: 'denied', reason: 'pending-approval' }` for that role, and `App.tsx:584-602` signs the account out and returns it to the login screen.

Public self-registration is **removed**: `src/services/auth.ts:50-57` records that there is deliberately no client wrapper around the Supabase public sign-up endpoint, and `scripts/client-provisioning-boundary.test.mjs` is a standing test that `src/` contains no public signup path and no service-role key reference.

Authentication remains Supabase Auth, email + password. MFA, SSO/OAuth, and magic-link sign-in are **PLANNED** (absent from the auth code).

### 4.4 Server-side API surface

The previous revision stated "There is no `/api` directory." That is now false.

| Route | Enforcement | Evidence |
|---|---|---|
| `api/admin/provision-farmer.ts` | POST-only (405 otherwise); Bearer token required; caller resolved with a **service-role** client; role read from `profiles`, never from the client; requires `ddp_admin`; request body allowlist forbids caller-supplied `role`/`id`/`userId`/`profileId`; invites via Admin Auth then promotes `role='pending' → 'farmer'` with a constrained single-row UPDATE | `api/admin/provision-farmer.ts:33-105`; `src/lib/serverFarmerProvisioning.ts:59-137` |
| `api/compliance/ai-summary.ts` | POST + `application/json` only (405/415); Bearer token mandatory; authorization by `profiles.role === 'ddp_admin'` via an **RLS-scoped session client bound to the caller's own token** (no service-role key); strict field allowlist, 60,000-char cap, capability locked to `draft_summarisation`; outer catch never logs the exception object | `src/lib/serverAiSummary.ts:183-405`; `api/compliance/ai-summary.ts:37-112` |

Both routes are backed by pure, dependency-injected cores (`serverFarmerProvisioning.ts`, `serverAiSummary.ts`) that hold no secret and read no `process.env`, which is what makes them unit-testable.

**One residual finding:** `serverFarmerProvisioning.ts:105-106` forwards the raw Supabase Admin Auth `error.message` to the client on invite failure. This is narrower than a stack trace but is still vendor text crossing a trust boundary. Carried to Section 11.

### 4.5 SQL migration inventory

Numbered migrations present on `main`: **3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23.** Numbers **1, 2, 5, 6, 7 do not exist** — the ledger is not contiguous, predating the numbering convention.

| # | Purpose | VERIFY | ROLLBACK |
|---|---|---|---|
| 3 | search_path + grants hardening on SECURITY DEFINER functions | — | — |
| 4 | Enable RLS on `ddp_scores`, `risk_flags`, `status_history` | — | — |
| 8 | COA upload column + storage bucket + storage RLS | — | — |
| 9 | Compliance Watchtower tables (admin-only) | — | — |
| 10 | Buyer Pack snapshot tables + `issue_buyer_pack_snapshot()` RPC | ✅ | ✅ |
| 11 | Block TRUNCATE on `compliance_audit_log` | ✅ | ✅ |
| 12 | Function EXECUTE ACL hardening | ✅ | ✅ |
| 13 | Read-only drift check for public/anon-executable functions | self | — |
| 14 | Default privileges for future public tables | ✅ | ✅ |
| 15 | Revoke stray privileges on 20 tables + audit-log `ENABLE ALWAYS` triggers | ✅ | ✅ |
| 16 | Read-only production safety catalog check | self | — |
| 17 | Append-only procurement decision trail + `procurement_decisions_current` view | ✅ | ✅ |
| 18 | Behavioural (not catalog-only) proof for migrations 10 & 17 | self | — |
| 19 | Farm admin-field guard (INSERT + UPDATE trigger, `is_ddp_admin()`-based) | ✅ | ✅ |
| 20 | Corrective EXECUTE-ACL revoke on the migration-19 guard function | — | **none** |
| 21 | `pending` role + DDP-only role-change RLS | ✅ | ✅ |
| 22 | Restrictive operational-farmer overlay on 11 tables + storage + price benchmarks | ✅ | ✅ |
| 23 | Server-authoritative Buyer Pack release gate | ✅ | ✅ |

**Ordering and process hazards (real, and unresolved):**

- Migration 17 has a hard FK dependency on migration 10; the ordering is enforced only by documentation convention, not by a migration runner (`docs/MIGRATION_RUNTIME_STATUS.md`, *Migrations 10 and 17 — carried forward*).
- Migration 20 has **no rollback script**. Reversing it — re-granting EXECUTE to `authenticated` — is not scripted anywhere.
- Migration 23's header records that its number was assigned around an already-reserved 21/22 held by a then-open PR. No actual collision resulted, but migration numbers are being allocated optimistically across parallel branches. Migration 24 has since merged to `main` (PR #37, `9496e1c`); the same optimistic-reservation pattern now applies to **migration 25** (Watchtower ingestion), which exists only on a feature branch. This remains a process hazard worth closing before the next parallel feature branch.

### 4.6 Static and live security tooling

- `scripts/check-security-migrations.mjs` (`npm run security:sql`, and a CI gate) — dependency-free, **database-free** static checker over the SQL corpus: companion-file completeness, confinement of the `ACL-TEST-EXEMPT` token to exactly three known draft files, VERIFY scripts proven non-mutating, per-migration content locks for 11/12/14/15/19/23, and a corpus-wide check that no present or future migration re-grants direct client-role EXECUTE on the farm guard.
- `scripts/run-staging-security-tests.mjs` (`npm run security:staging`) — a **live** suite against the staging Supabase project using real anon, farmer, and admin sessions. It **requires live credentials** (`STAGING_SUPABASE_URL`, anon key, admin and two farmer accounts, optional pending account and `STAGING_DATABASE_URL`), refuses to run against the production ref or any unrecognised ref before any network call, applies no DDL, and **BLOCKs rather than skips** if migrations 21/22 are not actually present. It is deliberately **not** part of CI or `npm test`. **Cleanup is only partly reliable:** table-fixture cleanup was verified on the 2026-07-21 run, but **storage-object cleanup is defective** — synthetic objects accumulate and the harness's previous zero-residue signal was **not** trustworthy for storage. Each run also appends a permanent, by-design-immutable `compliance_audit_log` record. See *Cleanup verification* and *Storage residue — a pre-existing, accumulating defect* in `docs/MIGRATION_RUNTIME_STATUS.md`. **Do not re-run it casually** — see Section 13.

The 12 `scripts/*.test.mjs` files guard, respectively: migration 23's authoritative gate, the client provisioning boundary, migration 21, the CI deploy gate, migration 19, the migration-17 decision-set/TS-union parity, migration 22, pending-probe fail-closed behaviour, the pending-user probe matrix, the staging suite's cleanup helpers, the sign-out sensitive-storage allowlist, and the staging harness's non-vacuity.

---

## 5. Correction Register — Outdated Claims Now Rebutted

Each claim below appeared in, or was implied by, the previous revision of this document. Each was re-verified individually against `afbe59e`.

| # | Previous claim | Verdict | Current state and evidence |
|---|---|---|---|
| 1 | Only two roles exist | **FALSE** | Three: `ddp_admin`, `farmer`, `pending` — `src/services/auth.ts:16`; `pending` denied at login by `src/lib/postLoginRouting.ts:22-33` |
| 2 | No CI pipeline exists | **FALSE** | `.github/workflows/security-ci.yml`; `verify` job gates SQL checks, tests, typecheck, lint, build |
| 3 | Only 103 tests exist | **FALSE** | **1,169 tests / 72 files**, all passing; measured on an exact `afbe59e` extract |
| 4 | Controlled farmer provisioning is absent | **FALSE** | Migrations 21 + 22, `api/admin/provision-farmer.ts`, `src/lib/farmerProvisioning.ts`, `src/services/adminProvisioning.ts` — *but see Section 6.3, runtime unverified* |
| 5 | Public self-registration remains available | **FALSE** | Removed; `src/services/auth.ts:50-57`; enforced by `scripts/client-provisioning-boundary.test.mjs`. `FarmerRegister.tsx` still exists but is unreachable — see Section 11 |
| 6 | Operations Desk is not implemented | **FALSE** | `src/pages/admin/DDPOperationsDesk.tsx` + 6 `src/lib/operationsDesk*.ts` modules; merged PR #34 |
| 7 | Admin and farmer editorial redesign is not implemented | **FALSE** | Merged PRs #29, #30; `src/components/admin/AdminShell.tsx:47-80`, `src/App.tsx:1153`, 277 `.eo-*` rules in `src/App.css`. *Partial* — see Section 6.10 |
| 8 | Buyer Pack server-authoritative issuance is absent | **PARTLY FALSE** | Migration 23 authored and client wired (`src/lib/buyerPackSnapshotSupabaseStore.ts:167-171`). **Staging: `APPLIED_NOT_VERIFIED`** — catalog evidence confirms the migration-23 RPC definition is installed; behavioural issuance verification remains outstanding. **Production: `UNKNOWN`.** Application provenance is unknown — no record identifies who applied it, when, or how; **do not rerun it** merely because the historical runbook claimed it was unapplied. See `docs/MIGRATION_RUNTIME_STATUS.md` |
| 9 | Buyer Pack browser output remains ungated | **FALSE** | `src/lib/buyerPackOutputGate.ts:19-29`; enforced in-page at `src/pages/admin/DDPBuyerPreview.tsx:315, 380-400, 429-456`, plus a print-only blocking overlay outside `.no-print` (`:405-419`) so raw browser print fails closed; merged PR #32 |
| 10 | Production browser persistence controls are absent | **FALSE** | `src/lib/browserPersistence.ts:25-27, 39-63, 87-100`; sign-out sweep at `src/services/auth.ts:74`; allowlist enforced by `scripts/sensitive-storage-registry.test.mjs`. *One inconsistency* — Section 11 |
| 11 | API TypeScript is outside the root build | **FALSE** | `tsconfig.api.json` referenced by the root build; merged PR #11; CI runs `npx tsc -b` |
| 12 | Production deployment is not CI-controlled | **FALSE** | `deploy-production` job with `needs: verify`; `vercel.json` disables Git deploys for `main`; post-deploy commit-SHA verification against the live site |
| 13 | Privacy-safe observability is absent | **FALSE** | `src/lib/observability.ts` — closed `SafeLogEvent` field set (`:20-33`), `[a-z0-9_]{1,40}` machine-code regex with `unknown_error` fallback (`:39-43`), field-by-field construction that never spreads input (`:69-80`); wired at `src/components/shared/ErrorBoundary.tsx:33-42` and in the AI-summary endpoint |
| 14 | AI summary functionality is absent | **FALSE** | Server-side draft summariser live: `src/lib/serverAiProvider.ts`, `api/compliance/ai-summary.ts`, surfaced at `src/pages/admin/DDPComplianceWatchtower.tsx:1565-1594`; production-verified 2026-07-10 @ `ffb38be` |
| 15 | *(self-contradiction)* "No AI/LLM model is called anywhere in the codebase" | **FALSE** | Contradicted the same document's own Section 3. The Anthropic Messages API is called from `src/lib/serverAiProvider.ts` |
| 16 | *(self-contradiction)* "No dedicated backend server… no `/api` directory" | **FALSE** | Two Vercel serverless routes exist under `api/`. There is still no long-running Express/Fastify/Nest process — that part remains accurate |
| 17 | The immutable buyer-pack snapshot library is unwired dead code | **FALSE** | Wired: `src/pages/admin/DDPBuyerPreview.tsx:21-29, 38, 257-296`; repository selection at `src/lib/buyerPackSnapshotSupabaseStore.ts:258-264`; covered by `src/lib/buyerPackWiring.test.ts` |
| 18 | The `fn_protect_farm_admin_fields()` role-literal defect is open | **FIXED IN CODE** | Migration 19 replaces the role literal entirely with `public.is_ddp_admin()` (`19_..._HARDENING.sql:117-119`) and additionally closes farmer-INSERT self-assignment. Statically locked by `scripts/check-security-migrations.mjs:300-382`. **Runtime confirmation is still self-reported only** — Section 6.3 |

Claims from the previous revision that were re-checked and **remain true**: chain of custody is hardcoded `'missing'` (`src/lib/procurementControl.ts:114-116`); licence/certification fields are plain text inputs, not uploads (`src/pages/farmer/FarmerOnboarding.tsx:448-460`); inventory photos are base64 `data:` URLs held in state, not Storage objects (`src/pages/farmer/FarmerSubmitInventory.tsx:148-157`); carbon-programme actions are no-ops against Supabase (`src/App.tsx:748-760`); no farmer-scoped `DELETE` policy exists on any table (zero `FOR DELETE` matches across the SQL corpus); two Thai review documents contradict each other and two "needs native speaker review" comments remain live in `src/translations.ts`; no buyer role or account exists.

---

## 6. Current Product Area Map

### 6.1 Public bilingual website — IMPLEMENTED
Landing page and login (`src/pages/public/LandingPage.tsx`, `LoginPage.tsx`), Thai/English translation layer (`src/translations.ts`), language toggle (`src/components/shared/LangToggle.tsx`). Merged PRs #1, #2, #17.
*Caveat:* two "needs native speaker review" comments remain live in `src/translations.ts` and the two Thai review documents in `docs/` still contradict one another on the same phrase set.

### 6.2 Authentication and session restoration — IMPLEMENTED
Supabase Auth email/password; `onAuthStateChange` re-fetches the profile on every auth event; authenticated routing survives refresh (merged PR #27); sign-out clears sensitive browser storage (merged PR #25 regression test; `src/services/auth.ts:74`).
*Not implemented:* MFA, SSO/OAuth, magic link — **PLANNED**.

### 6.3 DDP-controlled farmer provisioning — IMPLEMENTED — RUNTIME VERIFICATION REQUIRED
**Merged PR #22.** Mechanism, verified in code and SQL:
- Migration 21 sets `profiles.role` default to `'pending'`, widens the CHECK to `('ddp_admin','farmer','pending')`, rewrites `handle_new_user()` so every new `auth.users` row lands as `pending`, and re-asserts RLS so a user may update their own profile **but not their own `role`** (`21_..._HARDENING.sql:37-97`).
- Migration 22 adds an `AS RESTRICTIVE FOR ALL` overlay keyed on `has_operational_farmer_access()` (role must be exactly `'farmer'`) across **11 operational tables**, both storage buckets, and `market_price_benchmarks` — closing the gap where a `pending` account could still write via the REST API directly (`22_..._HARDENING.sql:45-189`).
- Promotion runs server-side through `api/admin/provision-farmer.ts` with a constrained `UPDATE … WHERE id=? AND role='pending'` verifying exactly one row changed.

*Found during README reconciliation:* **no admin provisioning UI is wired on `main`.** No `.tsx` component imports `inviteFarmer`, `provisionFarmer`, or `listPendingProfiles` — the capability exists at the service and API layer only. Provisioning a farmer today requires calling the endpoint directly. An admin provisioning screen is an unbuilt phase of this feature.

**Runtime verification status:** `docs/MIGRATION_RUNTIME_STATUS.md` records migration **21 as `APPLIED_AND_VERIFIED` in staging**, and migration **22 as `APPLIED_NOT_VERIFIED`** — installed with its 11-table overlay substantially covered, but with incomplete behavioural coverage of its storage `FOR ALL` surface. See *Migrations 19–23 — status matrix*. Migration 21's own VERIFY script defers the "non-admin JWT cannot self-promote" proof to the live staging harness (`21_..._VERIFY.sql:14-16`), and that proof was obtained: the 2026-07-21 run recorded farmers A and B each denied self-elevation by RLS (`SQLSTATE 42501`) with role unchanged. Migration 21's staging enforcement is therefore confirmed at runtime, not merely authored. **Production remains `UNKNOWN`** — it was not contacted, and no production verification has been performed.

The same applies to the migration-19/20 farm admin-field guard: `docs/FARM_ADMIN_FIELD_GUARD_APPLICATION.md:31-40` asserts "Production is already corrected," but this is doc prose with no date, no commit, and no corroborating entry in the dated `docs/SECURITY_TEST_LOG.md`. **UNABLE TO VERIFY** independently.

### 6.4 Pending-user state — IMPLEMENTED
Routing decision at `src/lib/postLoginRouting.ts:22-33` distinguishes `pending-approval` from `unresolved-role`; `src/App.tsx:584-602` signs the account out and returns it to login. Offline probe-matrix coverage in `scripts/pending-user-matrix.test.mjs`; fail-closed behaviour pinned by `scripts/pending-gate-fail-closed.test.mjs`.
*Gap:* the two denial reasons produce an **identical generic UI message** ("Your account does not have an assigned DDP role"). A provisioned-but-pending farmer sees the same text as a broken account. Product gap, not a security gap.

### 6.5 Farmer onboarding, farm profiles, inventory and COA submission — PARTIALLY IMPLEMENTED
Working: 9-step onboarding wizard with per-step autosave and completion tracking; advanced profile; inventory batch submission with client-side MIME/extension validation and **real PDF upload to the private, path-scoped `farmer-documents` Storage bucket**; "My Stock" with a working replace-COA action; requests inbox; status timeline.
Missing phases: licence/certification "documents" are plain text inputs (`FarmerOnboarding.tsx:448-460`); farm/product photos are pasted external URLs (`:282-313`); inventory photos are base64 `data:` URLs capped at 4 and never uploaded (`FarmerSubmitInventory.tsx:148-157`); carbon-programme exclusion is a no-op against Supabase (`App.tsx:748-753`).

### 6.6 Farm review, inventory review, master inventory — IMPLEMENTED
Per-batch review with approve / reject / request-missing-document, internal notes, buyer-visibility toggle, farmer-facing request creation, and COA viewing via time-limited signed URL. Farm review with a 9-item scoring sidebar and decision actions. Master inventory table with a route into the Buyer Pack.
*Carried forward, still open:* where the 9 Farm Review compliance sub-scores are actually computed remains **UNABLE TO VERIFY** — they default to zero in onboarding and no reviewed admin surface writes to them, so they may only ever be seeded by demo fixtures. Do not describe this as a working scoring engine until traced end-to-end.
*Caveat:* the admin carbon-programme control is disabled against live Supabase with an on-screen warning (`App.tsx:755-760`).

### 6.7 Missing Documents, COA Intelligence, Risk Register — IMPLEMENTED (deterministic, not AI)
Missing Documents evaluates a fixed 12-type requirement set by hand-written boolean logic with manual admin override (`src/lib/procurementControl.ts`). COA Intelligence summarises lab values **typed by the farmer** and applies a rule-based red-flag scan — there is **no OCR, PDF parsing, or AI extraction anywhere in the codebase**. Risk Register emits entries from a small fixed if/else cascade; severity is not weighted or model-derived.
`chain_of_custody` is unconditionally `'missing'` (`procurementControl.ts:114-116`), so it surfaces as an unmet requirement everywhere it appears.

### 6.8 Operations Desk — IMPLEMENTED (read-only by construction)
**Merged PR #34.** `src/pages/admin/DDPOperationsDesk.tsx` states in its header (`:24-35`) that it performs no approve/reject, no procurement decision, no rule activation, and no Buyer Pack issue/print/download/copy — every action is a navigation. No mutation call exists in the file; buttons either adjust local filter/expansion state or route.
It is fed by loader-aware views that distinguish **loaded / loading / failed / filtered-empty**: `deskAdminDataView` (`App.tsx:521-524`), `deskReviewRequestsView` (`:489-492`), `resolveDeskComplianceAlerts` (`:535-546`), assembled by `src/lib/operationsDesk.ts` with filtering, priority, empty-state and routing modules alongside. Follow-up buttons are **disabled** when the target record is not loaded (`:296-309`), so no click can open an empty detail page. A footnote (`:336-341`) discloses that document/risk overrides are browser-local rather than organisation-wide, and that Buyer Pack matters are deliberately excluded from the desk.

### 6.9 Compliance Watchtower, Risk rules, and AI-assisted legal-update summaries — IMPLEMENTED
Manual legal-update intake, human review queue, rule approval, and rule-based alerting, persisted to seven RLS-protected admin-only tables with a database-enforced append-only audit trigger (migration 9; TRUNCATE additionally blocked by migration 11). Rules seed as `suggested` and only affect alerting once a human sets `approved`/`active`.

**The five-stage compliance principle and its current status:**

| Stage | Status | Evidence |
|---|---|---|
| AI detects | **PLANNED** | Intake is still a 100% manual paste form. `docs/CANNAMONITOR_WATCHTOWER_INTEGRATION.md` records the source connector as "INACTIVE AND UNREACHABLE" |
| AI summarises | **IMPLEMENTED** | `src/lib/serverAiProvider.ts` calls the Anthropic Messages API directly; `api/compliance/ai-summary.ts` is the POST-only, JSON-only, bearer-token, `ddp_admin`-only boundary. Output is five review-oriented sections, always stamped `requiresHumanReview: true`, **transient and never persisted** (`src/lib/watchtowerAiSummary.ts:30-35`), surfaced as a dismissible "Draft only" card (`DDPComplianceWatchtower.tsx:1565-1594`). Eligibility is re-checked inside `runAiDraftSummary` (`:176-183`) so a UI bug cannot reach the provider. `ANTHROPIC_API_KEY` is server-only |
| Human reviews | **IMPLEMENTED** | Review Queue with real, persisted state transitions |
| Approved rule | **IMPLEMENTED** | `isEnforcedRuleStatus`, `src/lib/complianceRules.ts` |
| System enforces | **IMPLEMENTED — alert-level only** | `deriveRuleBasedComplianceAlerts` raises alerts; no automated downstream action such as a batch hold |

*Production verification of the AI path:* 2026-07-10 @ `ffb38be2945e20f9d3056a7ad215f8bdc014c237` — HTTP 200, `ok:true`, `requiresHumanReview:true`, `provider: anthropic`, `model: claude-opus-4-5-20251101`, all five sections present, no prohibited approval/certification wording, no secret, token, stack trace, or vendor error exposed. **This is the only end-to-end production verification of a server route recorded in the repository.**

Separately, `src/lib/aiComplianceGuard.ts` is a deterministic regex/keyword scanner blocking unqualified claim-words in the intake form. It is a genuine working control but is a **wording linter, not AI** and must not be described as AI compliance detection.

### 6.10 Editorial admin and farmer appearance — PARTIALLY IMPLEMENTED
**Merged PRs #29, #30.** A single design system spans both surfaces: `.eo-*` shell/nav/header/content classes from `src/components/admin/AdminShell.tsx:47-80` for admin, and the same institutional frame applied additively to farmer pages via `isFarmerPage ? ' eo-farmer' : ''` (`src/App.tsx:1153`), with 277 `.eo-*` rules in `src/App.css`.
**Why partial:** `AdminShell.tsx:74` splits content into `eo-content-canvas` (only `ddp-overview`) versus `eo-content-legacy` (every other admin page). Only the Overview page received the full canvas treatment; the remaining Supply Ledger, Watchtower, and Operations Desk pages sit inside the new shell while keeping their pre-existing internal layout. The class name is the codebase's own admission of the remaining phase.

### 6.11 Procurement decisions — IMPLEMENTED — RUNTIME VERIFICATION REQUIRED
**Merged PR #4.** Migration 17 creates an append-only decision trail and the `procurement_decisions_current` view; `scripts/migration-17-decision-set.test.mjs` asserts the TypeScript union and the database CHECK constraint enumerate an identical decision set.
`docs/MIGRATION_RUNTIME_STATUS.md` (*Migrations 10 and 17 — carried forward*) records migration 17 as applied and verified on **staging** (2026-07-14) and **explicitly not applied to production**. Production therefore still relies on the localStorage fallback for procurement decisions.

### 6.12 Buyer Pack — preview, snapshots, issuance, browser output — mixed

| Sub-area | Status | Detail |
|---|---|---|
| Preview | **IMPLEMENTED** | Admin-only curated batch view with signed-URL COA link, completeness matrix, risk summary, recommended decision |
| Immutable snapshots | **IMPLEMENTED** | SHA-256 content hashing over a canonically ordered, deep-frozen evidence copy; append-only versioned store rejecting overwrites. **Now genuinely wired** — `DDPBuyerPreview.tsx:21-29, 38, 257-296`; `selectBuyerPackSnapshotRepository` (`buyerPackSnapshotSupabaseStore.ts:258-264`) prefers Supabase and falls back to localStorage **only** on a missing-schema error, never on permission, RLS, network, or append-only (23505) errors |
| Server-authoritative issuance | **ACTIVE / NOT LIVE** | Migration 23 makes the database the release gate: it reads `procurement_decisions_current` itself and requires `decision='progress'`, a non-null `decided_by`, and a non-blank reason, **ignoring** the client-supplied `p_procurement_decision` (`23_...sql:120-172`). The client still sends that parameter for signature compatibility only (`buyerPackSnapshotSupabaseStore.ts:167-171`). **Staging catalog evidence (2026-07-21) shows migration 23 IS applied in staging** — `issue_buyer_pack_snapshot` is present and reads `procurement_decisions_current`, i.e. the migration-23 definition, not migration 10's. Staging status is **`APPLIED_NOT_VERIFIED`**: behavioural issuance verification was not completed. **Production remains `UNKNOWN`** — it was not contacted — so the live production release gate is unproven and may still be migration 10's client-trusting RPC. No execution record identifies who applied it to staging, when, or through which process; it must **not** be re-run merely because this document previously said it was unapplied. The earlier runbook-sourced claim that it "has never been executed" (`docs/BUYER_PACK_AUTHORITATIVE_ISSUANCE_APPLICATION.md:9-10`) is **superseded** — current authority: `docs/MIGRATION_RUNTIME_STATUS.md` |
| Browser output gate | **IMPLEMENTED** | See Section 5, row 9 |
| Audit and download trail | **PARTIALLY IMPLEMENTED** | `src/lib/buyerPackAudit.ts` and `buyerPackDownloads.ts` are **localStorage-only** — no Supabase import, no server persistence. The pack *content* is server-authoritative once migration 23 is applied; the who-viewed / who-downloaded record is not durable and is erasable by clearing browser storage |
| Content hash authority | **PLANNED** | Migration 23 states explicitly (`:48-56`) that it does **not** claim `content_hash` is server-recomputed |

**Do not describe the Buyer Pack externally as having a durable, tamper-evident audit trail.** The snapshot is on a credible path to that; the access trail is not there yet.
*Stale UI copy:* `DDPBuyerPreview.tsx:793-796` still displays "Stored in this browser only for now — tamper-evident, not a durable server record," which is inaccurate once migration 23 is applied. Carried to Section 11.

### 6.13 RLS, private storage, and browser persistence — IMPLEMENTED — RUNTIME VERIFICATION REQUIRED
RLS with per-role policies across the farmer, admin, and Watchtower table sets; `is_ddp_admin()` as the canonical admin predicate; farmer access scoped by membership or `created_by`; no table grants `anon` access. Private, MIME-restricted, size-capped `farmer-documents` Storage bucket with three policies.
Browser persistence in production is suppressed by `shouldPersistToBrowser()` returning `false` whenever Supabase is configured (`browserPersistence.ts:25-27`), with a sensitive-key allowlist swept on sign-out and pinned by `scripts/sensitive-storage-registry.test.mjs`.
**No farmer-scoped `DELETE` policy exists on any table** — zero `FOR DELETE` matches corpus-wide. This is closure by omission (RLS default-deny), live-confirmed for `inventory_batches` + Farmer A on 2026-07-08 (`docs/SECURITY_TEST_LOG.md:567-636`), where the request returned HTTP 200 with zero rows affected rather than an explicit denial. The log itself caveats that `farms`, `farm_memberships`, admin DELETE, and other combinations were not tested.

### 6.14 Deployment and observability controls — IMPLEMENTED
Covered in 4.2 and Section 5 rows 12–13.

---

## 7. Active Implementation

### Evidence Request & Resolution — **DATABASE MERGED, APPLICATION NOT INTEGRATED**

**This feature is not shipped.** Its **database phase is merged into `main`**; its **application layer is not**, and migration 24 is **not applied to any hosted database**. Binding behaviour is defined by `docs/EVIDENCE_REQUEST_RESOLUTION_CONTRACT.md` (v1.5); release control is `docs/EVIDENCE_RELEASE_READINESS_CHECKLIST.md`.

The **database phase** — `24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql`, `..._VERIFY.sql`, `..._ROLLBACK.sql`, `..._STORAGE.sql` (plus `scripts/evidence-request-resolution-migration.test.mjs`) — was merged to `main` by **PR #37 (merge commit `9496e1c`, reviewed head `fd57135`)** on 2026-07-23. The earlier "draft PR #37 / no part merged" state recorded here is superseded. The **application layer** (`src/lib/evidenceRequests*.ts`, `src/domain/evidenceRequests*.ts`, `src/pages/**/evidence/**`, `src/components/shared/EvidenceThread.tsx`) is authored on branch `feature/evidence-request-workflow-v2` (commit `4fb72f7`) and is **NOT on `main`** — do not describe it as delivered.

Design properties claimed and asserted by that PR's tests: authorization via `can_operationally_access_farm(uuid)` ANDing farmer role, `has_operational_farmer_access()`, and an active `farm_memberships` row, reading the role from `profiles` and never from JWT metadata; non-disclosure by returning `NOT_FOUND` rather than `FORBIDDEN` for unauthorized ids; direct-DML denial with no INSERT/UPDATE/DELETE policy on any workflow table; optimistic concurrency via `expected_revision` under `FOR UPDATE`; an unconditional append-only history trigger; server-derived `farm_id` never accepted as an RPC parameter; and a private storage bucket with farm-scoped paths.

**Two documented contract deviations** are flagged in the SQL itself and are the points most warranting reviewer attention: `size_bytes` is nullable for linked existing documents (contract §6.4 requires NOT NULL, but `farmer_documents`/`documents` carry no size column and fabricating a byte count was rejected), and storage policies live in a companion file because `CREATE POLICY` on `storage.objects` requires `supabase_storage_admin` ownership.

**State as at 2026-07-24:**

| Signal | Value |
|---|---|
| Database phase merged to `main` | **Yes** — PR #37, merge `9496e1c`, reviewed head `fd57135`, landed 2026-07-23 |
| Migration 24 applied to a hosted database | **No** — `NOT_APPLIED` to staging and production; only runtime evidence is disposable local PostgreSQL (VERIFY A–M, 13/13) |
| Application layer on `main` | **No** — authored on `feature/evidence-request-workflow-v2` (`4fb72f7`), unmerged |
| Contract | **v1.5**, `docs/EVIDENCE_REQUEST_RESOLUTION_CONTRACT.md` (current, binding) |

**Remaining phases, in order:**

1. **~~Database review closeout~~ — DONE.** PR #37 review closed out and merged to `main` (`9496e1c`); the two documented contract deviations are ratified in contract §6.9 [v1.5].
2. **Runtime database verification** — apply migration 24 and run its VERIFY (sections A–R) against a real hosted database (staging first), under non-owner principals. This converts the security properties from *asserted* to *demonstrated* and gates everything below. See release checklist **G2**. Migration 24 is **not applied to any hosted database yet**.
3. **Admin interface** — request creation, tracking, and resolution surfaces for DDP staff.
4. **Farmer interface** — inbound request visibility, response drafting, and submission.
5. **Storage orchestration** — reserved-path upload, finalization, size measurement, and the 150 MB aggregate limit.
6. **Notifications** — informing farmers of new requests and DDP of submitted responses.
7. **Operations Desk integration** — surfacing outstanding evidence requests in the desk queue.
8. **End-to-end and adversarial validation** — full-flow testing plus deliberate attempts to defeat the authorization, non-disclosure, and append-only properties.

**Do not describe any part of Evidence Request & Resolution as available.** Phases 3–7 have code **only on the unmerged branch `feature/evidence-request-workflow-v2` (`4fb72f7`)** — none is on `main` and none is hosted-verified; phase 8 (end-to-end/adversarial validation on a hosted database) is not done. Nothing here is deployed.

**Related branches:** `feature/evidence-request-workflow-v2` (commit `4fb72f7`) carries the **unmerged application layer** built on top of the merged migration 24 — this is the branch a future agent integrates from, against contract v1.5. `feature/evidence-request-workflow` (contract and Phase-0 audit commits; **SUPERSEDED**) and `feature/evidence-intelligence-phase-a` (single commit, far behind `main`; **SUPERSEDED / stale**) are earlier attempts.

---

## 8. Original Planned Feature Sequence

The full brokerage plan, preserved in its original order. Feature 1 is in active implementation (Section 7); features 2–12 are **PLANNED** unless noted.

### 1. Evidence Request and Resolution
- **Business purpose** — close the evidence gap between what a farm has submitted and what DDP needs, with a tracked, auditable request/response loop instead of ad-hoc chasing.
- **Principal users** — DDP staff (raise, track, accept, reject); farmers (see, respond, upload).
- **Major capabilities** — request creation against a farm or batch; typed request categories; farmer response drafting and submission; attachment upload and linking of existing documents; state transitions with optimistic concurrency; append-only history.
- **Dependencies** — controlled farmer provisioning and the operational-farmer RLS overlay (migrations 21, 22); farm memberships; private storage.
- **Security boundaries** — farm-scoped authorization ANDed across role, operational access, and membership; non-disclosure of foreign request ids; no direct DML on workflow tables; append-only history with no bypass; server-derived scope.
- **Status** — **DATABASE MERGED, APPLICATION NOT INTEGRATED.** Migration 24 merged to `main` (PR #37, `9496e1c`) but **not applied to any hosted database**; application layer authored on `feature/evidence-request-workflow-v2` (`4fb72f7`), unmerged. Binding contract: `docs/EVIDENCE_REQUEST_RESOLUTION_CONTRACT.md` (v1.5).
- **Sequencing** — next. Phases per Section 7.
- **Must not claim** — that evidence requests are available to farmers or staff; that migration 24's properties are proven at runtime; that any evidence has been collected through this workflow.

### 2. Notification and Communications System
- **Business purpose** — ensure a request, decision, or state change actually reaches the person who must act, rather than depending on someone opening the app.
- **Principal users** — farmers, DDP staff.
- **Major capabilities** — event-driven notification generation; per-user inbox and read state; delivery channels (in-app first; email/LINE later); digest and escalation for overdue items; notification preferences.
- **Dependencies** — Evidence Request & Resolution (its first real event source); the existing farmer requests inbox as the in-app precedent.
- **Security boundaries** — notification content must not leak cross-farm data; delivery outside the app moves data past the RLS boundary and needs an explicit content policy; templates must be subject to the existing wording guard.
- **Status** — **PLANNED**. The current farmer requests inbox (`src/pages/farmer/FarmerRequests.tsx`) is a per-page fetch, not a notification system. No scheduled job, queue, or outbound channel exists.
- **Sequencing** — immediately after Evidence Request phases 3–5.
- **Must not claim** — reliable or guaranteed delivery; any email/SMS/LINE capability.

### 3. Buyer CRM and Controlled Buyer Accounts
- **Business purpose** — make buyers first-class entities so relationships, requirements, and deals attach to a real record rather than living in staff memory.
- **Principal users** — DDP staff; later, controlled buyer users.
- **Major capabilities** — buyer organisation and contact records; qualification and KYC status; interaction history; a controlled buyer login with narrowly scoped visibility; per-buyer pack access records.
- **Dependencies** — the provisioning pattern proven by migrations 21/22 (buyer accounts must be DDP-provisioned, never self-registered); Buyer Pack issuance.
- **Security boundaries** — a third role requires its own RLS scoping designed before any UI; buyers must never see farm identity or other buyers' data except where DDP has explicitly disclosed it; every pack view must be attributable.
- **Status** — **PLANNED**. No buyer role, buyer table, or buyer login exists anywhere in the schema or auth code. "Buyer Preview" is DDP staff previewing what a buyer *would* see.
- **Sequencing** — after notifications; the first genuinely new role since `pending`.
- **Must not claim** — that buyers have accounts, that pack access is currently attributable to a named buyer, or that any KYC has been performed.

### 4. Buyer Requirements and Inventory Matching
- **Business purpose** — convert a buyer's stated specification into a repeatable search against real inventory, so DDP proposes evidence-backed matches rather than recalling what is in stock.
- **Principal users** — DDP staff.
- **Major capabilities** — structured requirement capture (product type, cannabinoid ranges, volume, price band, certification and jurisdiction constraints, timing); deterministic match scoring against master inventory; explainable match rationale; saved requirements with re-run on new inventory.
- **Dependencies** — Buyer CRM; master inventory; COA data; document completeness; price benchmarks (`market_price_benchmarks`).
- **Security boundaries** — matching must respect batch buyer-visibility flags; rationale must not disclose non-visible batches or farm identity prematurely.
- **Status** — **PLANNED**. Master inventory has filtering and sorting but no requirement entity and no matching engine.
- **Sequencing** — directly after Buyer CRM.
- **Must not claim** — that matching is AI-powered or predictive; it should be deterministic and explainable, like the existing rule and risk engines.

### 5. Brokerage Deal Pipeline
- **Business purpose** — give every live opportunity a stage, an owner, and a next action, so the brokerage has an operational forecast rather than a list of conversations.
- **Principal users** — DDP staff and management.
- **Major capabilities** — deal records linking buyer, requirement, and one or more batches; stage model with entry and exit criteria; ownership and next-action tracking; stage-change history; pipeline reporting by stage, value, and age.
- **Dependencies** — Buyer CRM; requirements and matching; procurement decision trail (migration 17) as the existing precedent for append-only decision history.
- **Security boundaries** — pipeline value and buyer identity are commercially sensitive and are admin-only; farmers must never see deal-stage or buyer data.
- **Status** — **PLANNED**. Procurement decisions exist per batch; there is no deal entity, stage model, or pipeline view.
- **Sequencing** — after matching; it is the spine every later commercial feature hangs from.
- **Must not claim** — that pipeline figures are forecasts, or that any deal has been transacted through the platform.

### 6. Sample Request and Evaluation Workflow
- **Business purpose** — track physical samples from buyer request through dispatch to recorded evaluation, since sampling is normally the gate before any contract.
- **Principal users** — DDP staff, farmers, buyers (indirectly).
- **Major capabilities** — sample request against a batch; quantity and dispatch tracking; courier and reference capture; buyer evaluation outcome recorded against the sample; linkage of the outcome back to the deal.
- **Dependencies** — deal pipeline; Evidence Request patterns (a sample is an evidence artefact with a physical leg); notifications.
- **Security boundaries** — dispatch details include addresses and are personal data; retention and visibility need an explicit policy.
- **Status** — **PLANNED**. No sample entity exists.
- **Sequencing** — after the pipeline; the first workflow with a physical-world leg, which makes it the natural precursor to chain of custody.
- **Must not claim** — chain-of-custody coverage; a sample record is not custody evidence.

### 7. Contracts, Orders and Commercial Documents
- **Business purpose** — capture the binding commercial agreement and the resulting order so downstream fulfilment and finance work from an authoritative record.
- **Principal users** — DDP staff and management.
- **Major capabilities** — contract records with parties, terms, quantities, prices, Incoterms, and dates; order creation from a contract; document generation and versioning; signature and execution status; immutable execution snapshots.
- **Dependencies** — deal pipeline; buyer CRM; the Buyer Pack snapshot machinery, which is the existing precedent for hashed, append-only, versioned documents.
- **Security boundaries** — executed contracts must be immutable and server-persisted, not browser-held; access is admin-only plus, later, the counterparty buyer; e-signature is a legal question requiring qualified advice before implementation.
- **Status** — **PLANNED**. No contract or order entity; no server-side document generation (the Buyer Pack uses `window.print()`).
- **Sequencing** — after samples.
- **Must not claim** — legal enforceability of any generated document, or that any signature captured constitutes a qualified electronic signature.

### 8. Fulfilment and Chain of Custody
- **Business purpose** — evidence the physical movement of goods from farm through DDP to buyer, which is the missing spine of the current evidence story.
- **Principal users** — DDP operations staff, farmers, logistics partners.
- **Major capabilities** — custody transfer events with actor, timestamp, location, and supporting document; shipment and consignment records; hash-chained or otherwise tamper-evident event sequence; a custody timeline surfaced in the Buyer Pack.
- **Dependencies** — contracts and orders; private storage; the append-only trigger pattern already proven on `compliance_audit_log` (migrations 9, 11, 15).
- **Security boundaries** — custody events must be genuinely append-only at the database level, not by application convention; each transfer must be attributable to an identified actor.
- **Status** — **PLANNED**. `chain_of_custody` is a recognised requirement type whose status is unconditionally hardcoded to `'missing'` (`src/lib/procurementControl.ts:114-116`), with a source comment stating no custody record is captured. It is consequently an unmet requirement everywhere it surfaces, including the Buyer Pack.
- **Sequencing** — after contracts. This is the highest-value single unlock for buyer credibility.
- **Must not claim** — any custody, traceability, or provenance guarantee until real transfer events are captured and made tamper-evident.

### 9. Brokerage Commission and Financial Tracking
- **Business purpose** — record the commercial substance of the brokerage: what was paid, what was charged, what commission was earned, what is outstanding, and what margin resulted.
- **Principal users** — DDP management and finance.
- **Major capabilities** — purchase value and sale value per deal; commission model (rate, fixed, or tiered) with calculated and adjusted amounts; invoice generation and status; payment milestones and schedules; amounts due, received, and overdue; commercial reporting; financial exports (CSV/accounting-package format); margin and profitability analysis per deal, buyer, farm, and period.
- **Dependencies** — deal pipeline; contracts and orders; fulfilment for revenue-recognition triggers.
- **Security boundaries** — the most commercially sensitive data in the platform: strictly admin/finance-scoped RLS, no farmer or buyer visibility of margin or counterparty pricing; every amount change must be attributable and append-only; exports are an exfiltration surface and need explicit control.
- **Status** — **PLANNED**. Verified absent: a repository-wide search finds **no** occurrence of commission, invoice, payment, or margin logic in `src/`, `api/`, or the SQL corpus. What exists today is farmer asking price (`pricePerKg`, `src/types.ts:382`), DDP market price benchmarks (`src/lib/db.ts:573-589`), and a `'price'` review-request type (`src/types.ts:346`).
- **Sequencing** — after fulfilment, so revenue events have real triggers. **This feature is fully in scope and must not be dropped from the plan.**
- **Must not claim** — accounting-grade correctness, tax treatment, statutory reporting compliance, or that any figure is auditable, until reviewed by a qualified finance professional.

### 10. Complete Evidence and Document Platform
- **Business purpose** — make every document in the system a real, stored, access-controlled, versioned file, ending the current mix of uploads, pasted URLs, base64 blobs, and typed filenames.
- **Principal users** — all.
- **Major capabilities** — unified document entity with type, version, owner, and expiry; real Storage upload for every licence, certification, and photo field; expiry tracking and renewal prompts; a single document register per farm; retention policy.
- **Dependencies** — cross-cutting; the COA upload path (migration 8) is the working pattern to generalise.
- **Security boundaries** — every new document type inherits the private, path-scoped, MIME-restricted, size-capped, RLS-protected pattern; the vestigial `farmer_documents` / `farmer_photos` tables must be either adopted or removed, not left ambiguous.
- **Status** — **PARTIALLY IMPLEMENTED**. Real: COA PDFs to the private `farmer-documents` bucket with signed-URL retrieval. Not real: licence/certification fields (plain text, `FarmerOnboarding.tsx:448-460`), farm/product photos (pasted URLs, `:282-313`), inventory photos (base64 `data:` in state, `FarmerSubmitInventory.tsx:148-157`). The `farmer-photos` bucket exists only in a commented-out, never-applied SQL block.
- **Sequencing** — cross-cutting; advance opportunistically alongside every feature above.
- **Must not claim** — that a farm's licences or certifications are on file. Today, in most cases, only a typed string is.

### 11. Compliance Source Monitoring
- **Business purpose** — complete stage 1 of the compliance principle so regulatory change is detected rather than waiting for someone to paste it in.
- **Principal users** — DDP compliance staff.
- **Major capabilities** — registered regulatory sources per jurisdiction; scheduled polling; change detection and deduplication; automatic creation of a legal update in `pending` state for human review; source health monitoring.
- **Dependencies** — Compliance Watchtower (built); the AI draft summariser (built); scheduled execution, which the platform does not yet have.
- **Security boundaries** — detection must **never** create or activate a rule; every detected item must enter the existing human-review queue at the lowest-trust state; the existing wording guard must apply to all ingested text.
- **Status** — **PLANNED**, with foundations in place. Connector scaffolding exists (`src/lib/complianceSourceConnectors.ts`, `complianceSourceRegistry.ts`, `complianceSourceConnectorRuntime.ts`, `complianceRssConnector.ts`, `browserRssFetch.ts`) and `docs/CANNAMONITOR_WATCHTOWER_INTEGRATION.md` records the Cannamonitor integration as **"INACTIVE AND UNREACHABLE"** by design. There is no scheduled job, cron, or server-side poller.
- **Sequencing** — parallelisable; it depends on scheduling infrastructure rather than on the deal-flow chain.
- **Must not claim** — comprehensive regulatory coverage, or that any jurisdiction is monitored, until named sources are polling and their health is observable.

### 12. Enterprise Operations and Assurance
- **Business purpose** — the organisational and infrastructural capabilities an enterprise buyer, investor, or auditor will require once the product itself is complete.
- **Principal users** — DDP management, security, and external reviewers.
- **Major capabilities** — MFA and session hardening for admin accounts; structured audit logging of **all** admin actions, not only Compliance Watchtower actions; automated RLS/integration/end-to-end test suites replacing manual checklists; independent security review or penetration test; documented secrets management; data retention, backup and disaster recovery, and incident response policies; capacity and availability planning.
- **Dependencies** — cross-cutting.
- **Security boundaries** — this feature *is* the security boundary work.
- **Status** — **PLANNED**, partially seeded. Present: CI-gated deployment with live commit verification, privacy-safe observability, a database-enforced append-only Watchtower audit log, an extensive but self-declared-partial manual security log, and a credentialled staging security harness. Absent: MFA, platform-wide admin audit logging, automated RLS/E2E suites, external review, and the written policies.
- **Sequencing** — continuous, with MFA and platform-wide admin audit logging warranting early attention given admins hold broad `FOR ALL` RLS access.
- **Must not claim** — SOC 2, ISO 27001, audit readiness, or complete security. None of these has been granted or assessed.

---

## 9. Dependency Map

```
Controlled Farmer Provisioning  [IMPLEMENTED — runtime verification required]
        │   (migrations 21 + 22; api/admin/provision-farmer.ts)
        ▼
Evidence Request and Resolution  [DB MERGED (mig 24, PR #37) — NOT hosted-applied; app layer NOT on main]
        │
        ▼
Notification and Communications System  [PLANNED]
        │
        ▼
Buyer CRM and Controlled Buyer Accounts  [PLANNED]
        │
        ▼
Buyer Requirements and Inventory Matching  [PLANNED]
        │
        ▼
Brokerage Deal Pipeline  [PLANNED]
        │
        ▼
Sample Request and Evaluation Workflow  [PLANNED]
        │
        ▼
Contracts, Orders and Commercial Documents  [PLANNED]
        │
        ▼
Fulfilment and Chain of Custody  [PLANNED]
        │
        ▼
Brokerage Commission and Financial Tracking  [PLANNED]
```

**Why the chain holds.** Evidence Request depends on provisioning because its authorization predicate ANDs `has_operational_farmer_access()` with an active `farm_memberships` row — both established by migrations 21/22. Notifications depend on Evidence Request for their first genuine event source. Buyer CRM must precede requirements, which must precede matching-driven deals. Samples, contracts, fulfilment, and finance each consume the record the previous stage creates; commission and margin in particular cannot be computed before a contract exists and a fulfilment event triggers recognition.

**Cross-cutting capabilities** — these attach to every stage above rather than sitting at a point in the chain:

```
Complete Evidence and Document Platform ──┐
                                          ├──▶ applies to every feature 1–9
Compliance Source Monitoring ─────────────┤
                                          │
Enterprise Operations and Assurance ──────┘
```

The Evidence and Document Platform generalises the working COA upload pattern to every document any feature introduces. Compliance Source Monitoring feeds rules that alert against data produced at any stage. Enterprise Operations and Assurance governs all of it and is never "done."

---

## 10. Open and Superseded Work — Decision Register

**Record only. Nothing in this section was closed, edited, rebased, merged, or otherwise altered.**

### 10.1 Open pull requests

| PR | Title | State | Merge state | Threads | Assessment |
|---|---|---|---|---|---|
| **#37** | Evidence Request & Resolution — database phase (migration 24) | **MERGED** | Merged `9496e1c` (2026-07-23) | 0 (closed out) | **MERGED to `main`.** No longer an open PR. Next step is hosted runtime verification (checklist G2), not review. Section 7 |
| **#35** | Fail closed on missing hosted Supabase config | Draft | BEHIND by 2 | 0 | **Still relevant.** Addresses a real exposure: a hosted build missing `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` silently enters demo mode, where `isDemo` grants signed-in admin treatment on a public domain. Scope is a `prebuild` validator plus tests; no runtime, auth, or SQL change. Needs a rebase and a product decision |
| **#33** | Fix demo admin entry routing | Draft | **CONFLICTING**, 2 behind | 0 | **Awaiting a product decision.** Restores demo admin entry lost in the homepage redesign (#17). Its own security review produced #35. Question to settle: is a publicly reachable demo mode still wanted at all? If not, close both #33 and the demo-entry concern. Conflicts must be resolved either way |
| **#26** | Gate and harden Buyer Pack printing | Open, not draft | **CONFLICTING**, 6 behind | 3 unresolved | **Partly superseded.** Merged PR #32 delivered the browser-output gate, including a print-block overlay outside `.no-print` (`DDPBuyerPreview.tsx:405-419`). #26 additionally contains a `data-print-authorized` CSS-specificity mechanism, `beforeprint` provenance stamping, and substantial print-legibility fixes (contrast, page-break rules, A4/Letter measure) **not** present on `main`. Decide explicitly: harvest the print-presentation work, or close as superseded. Do not leave it open by default |
| **#20** | Remove public farmer self-registration | Open, not draft | **CONFLICTING**, 30 behind | 1 unresolved | **SUPERSEDED.** Its objective was achieved by merged PR #22 and migration 21 — self-registration is gone (`src/services/auth.ts:50-57`) and enforced by `scripts/client-provisioning-boundary.test.mjs`. Retained here only as a decision record |

### 10.2 Closed without merge

| PR | Title | Note |
|---|---|---|
| #28 | Redesign admin overview with truthful load states | Closed unmerged. Loader-truthfulness concerns were subsequently addressed within the Operations Desk work (#34) |
| #12 | Test branch protection with deliberate CI failure | Closed unmerged. Deliberate CI-gate test, not product work |

### 10.3 Branch register

| Branch | Relative to `origin/main` | Assessment |
|---|---|---|
| `feature/evidence-request-resolution-v2` | 4 ahead, 0 behind | **Active** — PR #37 |
| `feature/evidence-request-workflow` | 4 ahead, 1 behind | **SUPERSEDED** by v2 (contract and Phase-0 audit commits) |
| `feature/evidence-intelligence-phase-a` | 1 ahead, 67 behind | **Stale / SUPERSEDED** |
| `feature/admin-operations-desk-readonly` | 16 ahead, 2 behind | **Merged in squashed form** as PR #34. The unsquashed branch is redundant. *(This was the checked-out branch during the audit.)* |
| `feature/ddp-controlled-farmer-provisioning` | 19 ahead, 1 behind | **Merged in squashed form** as PR #22. Redundant |
| `fix/audit-actor-integrity` | 1 ahead, 12 behind | **Stale, no PR.** Carries unmerged work with no tracking issue — needs a decision |
| `fix/buyer-pack-print-gate` | 3 ahead, 6 behind | PR #26 — see above |
| `fix/fail-closed-hosted-supabase-config` | 1 ahead, 2 behind | PR #35 |
| `fix/demo-admin-entry-routing` | 1 ahead, 2 behind | PR #33 |
| `chore/staging-smoke-test` | 1 ahead, 30 behind | PR #20 — superseded |
| `design/editorial-appearance-only` | 5 ahead, 6 behind | Superseded by merged #29/#30 |
| `design/editorial-operations-overview` | 5 ahead, 6 behind | Superseded by merged #29/#30 |
| `feat/homepage-redesign` | 4 ahead, 34 behind | Superseded by merged #17 |
| `backend-mvp` | 3 ahead, 254 behind | **Stale**, last touched 2026-06-28 |
| `auth-rls-mvp`, `feat/cannamonitor-watchtower-restart`, `fix/buyer-pack-authoritative-issuance`, `fix/buyer-pack-verify-comment-sensitivity`, `fix/farm-admin-field-guard`, `fix/farm-guard-authenticated-acl` | fully merged | Safe to retire |

### 10.4 Unrelated to the next critical path
PRs #33 and #35 both concern demo-mode behaviour rather than the brokerage feature sequence. They are real and #35 describes a genuine exposure, but neither blocks Evidence Request & Resolution.

---

## 11. Known Defects, Gaps, and Inconsistencies

Consolidated; evidence cited once above is not repeated.

**Database state (highest priority)**
1. Migrations **19, 20, 21, 22, 23 are now recorded** in `docs/MIGRATION_RUNTIME_STATUS.md`, which is the current authority for runtime application status. **Staging:** 20 and 21 are `APPLIED_AND_VERIFIED`; 19, 22 and 23 are `APPLIED_NOT_VERIFIED`. **Production: `UNKNOWN` for all five** — production was not contacted.
2. Migrations 10 and 17 are recorded as **not applied to production** (`docs/MIGRATION_RUNTIME_STATUS.md`, *Migrations 10 and 17 — carried forward*). Production therefore still uses browser-local fallbacks for buyer-pack snapshots and procurement decisions.
3. Migration 23 is **applied in staging** (`APPLIED_NOT_VERIFIED`) per 2026-07-21 catalog evidence, and **`UNKNOWN` in production**, which was not contacted. The earlier runbook-sourced claim that it had "never been executed against any database" is **superseded** — see `docs/MIGRATION_RUNTIME_STATUS.md`. Behavioural issuance verification remains outstanding and the production release gate is unproven, so it may still be migration 10's client-trusting RPC. Migration 23 must **not** be re-run on the strength of the superseded claim.
4. The claim that migration 19 was applied to production (`docs/FARM_ADMIN_FIELD_GUARD_APPLICATION.md:31-40`) is undated, uncommitted prose with no corroborating entry in the dated `docs/SECURITY_TEST_LOG.md`. **UNABLE TO VERIFY.**
5. Migration 20 has **no rollback script**.
6. Migration ordering (10 before 17) is enforced by convention only — there is no migration runner.
7. Migration numbers are reserved optimistically across parallel branches (documented in migration 23's own header). Migration 24 is now merged to `main`; migration 25 (Watchtower ingestion) is the current branch-only reservation.

**Application**

8. `src/data.ts:637,651` — `persistInventory` / `persistFarms` call `safeSetItem` **unconditionally**, without the `shouldPersistToBrowser()` gate that `saveReviewRequests` (`:699-700`) and the demo reset (`:659-661`) use. `safeSetItem` swallows failures, so nothing breaks, but this is inconsistent with the stated design intent that "the browser must not hold a copy of production supply data" (`browserPersistence.ts:4-5`).
9. `src/pages/admin/DDPBuyerPreview.tsx:793-796` displays stale copy — "Stored in this browser only for now — tamper-evident, not a durable server record" — which will be inaccurate once migration 23 is applied.
10. `src/lib/serverFarmerProvisioning.ts:105-106` forwards raw Supabase Admin Auth `error.message` text to the client on invite failure.
11. `src/pages/farmer/FarmerRegister.tsx` still exists and is still rendered for `page === 'farmer-register'`, but **no `goTo('farmer-register')` call exists anywhere** in `src/`. It is unreachable dead code. It performs no Supabase call — only a local draft save — so it is not a signup path, but it should be removed or deliberately repurposed.
12. Pending and role-less accounts receive an identical generic denial message despite the routing layer distinguishing them (`App.tsx:599`).
13. Buyer Pack audit and download trails are localStorage-only, with no Supabase persistence.
14. Buyer Pack `content_hash` is **not** server-recomputed; migration 23 explicitly disclaims this.
15. Admin editorial redesign covers only `ddp-overview` with the full canvas treatment; all other admin pages remain `eo-content-legacy`.
16. Carbon-programme status changes do not persist against live Supabase on either side.
17. Chain of custody is hardcoded `'missing'`.
18. Licence/certification fields, farm/product photos, and inventory photos are not real stored files.
19. No farmer-scoped `DELETE` policy exists on any table; denial is by RLS default rather than explicit policy, and was live-tested for only one table and one identity.
20. The 9 Farm Review compliance sub-scores have no verified computation path. **UNABLE TO VERIFY.**
21. The vestigial `farmer_documents` / `farmer_photos` tables remain RLS-protected but entirely unreferenced by application code; the `farmer-photos` bucket was never created.

**Documentation**

22. ~~`README.md` contained multiple stale factual claims~~ — **corrected in this same documentation pass.** At `afbe59e` the README asserted Vercel Git auto-deploy of `main` (contradicted by `vercel.json` and the `deploy-production` job), a non-existent "fulfilment packing queue", "AI detects and summarises" (detection is manual), "no server-side component" (two serverless routes exist), a two-role model, admin creation "via the signup form", an in-app "Create farmer account" form, and a `handle_new_user()` trigger creating rows with `role = 'farmer'`. All are now corrected against `afbe59e`. The README's "SQL prerequisites" list — which stopped at migration 11, omitted migrations 12–23, and instructed the reader to run `FARM_RESAVE_PERSISTENCE_MIGRATION.sql` (a file marked *"Do not run… ACL-TEST-EXEMPT: INTENTIONAL-DRAFT"* and superseded by migration 19) — has also been **replaced** with a "Database setup and migration safety" register covering all 18 numbered migrations, their VERIFY/ROLLBACK companions, per-group runtime status, and an explicit do-not-run exclusion list.
    **Residual documentation limitation:** the register can only report runtime status as strongly as the repository's own evidence allows. That constraint has now been substantially relieved for staging — `docs/MIGRATION_RUNTIME_STATUS.md` covers migrations 10, 17 and 19–23, and the README records their staging status accordingly. What remains unresolved is **production status, `UNKNOWN` for migrations 19–23**, and the staging catalog VERIFY failures for migrations 12, 14 and 15. Closing those requires the runtime work in Section 13 — not further documentation.
23. `docs/THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md` (Status: Pending) and `docs/THAI_NATIVE_SPEAKER_REVIEW.md` (reviewed and approved) still contradict each other; two "needs native speaker review" comments remain live in `src/translations.ts`.
24. 29 root-level markdown files, mostly dated `PHASE_*_VALIDATION.md` snapshots, remain unarchived despite a prior audit recommending it. Section 12 marks them historical.

---

## 12. Historical Records

These documents are **preserved as historical evidence** and are **not** current status. Where they conflict with this document, this document governs.

| Document | Nature | Date / commit |
|---|---|---|
| `docs/AUDIT_2026_07_13_MULTI_AGENT_DUE_DILIGENCE.md` | 15-agent due-diligence audit | 2026-07-13 @ `f5c8cbb` — **historical snapshot** |
| `docs/AUDIT_PHASE2_EVIDENCE_REVIEW.md` | Falsification pass over the above | 2026-07-13 @ `f5c8cbb` — self-marked "SUPERSEDED IN PART" |
| `docs/DDP_AI_LEGAL_PRODUCTION_READINESS_MASTER_REPORT.md` | Execution plan for migrations 10/17 | References PRs #3–#6, commit `5b21999` — **historical**, superseded by `MIGRATION_RUNTIME_STATUS.md` |
| `docs/DDP_AI_LEGAL_PRODUCTION_READINESS_REVIEW.md` | Companion review to the above | Same cycle — **historical** |
| `docs/BUYER_PACK_PHASE_B_DESIGN.md` | Design sketch for durable evidence storage | Self-marked "design only… not migrations" — **superseded in practice** by migrations 10/17/23 |
| `docs/PROFESSIONALIZATION_ROADMAP.md` | 7-agent audit, Wave-1 implementation, Compliance-Rules-Operationalization closure | Branch `professional-site-elevation-v1` @ `1fe7885`, entries through 2026-07-08 — **historical closure record** |
| `docs/SECURITY_TEST_LOG.md` | Dated live RLS/Auth/storage functional tests | 2026-07-07 → 2026-07-11 — **historical but load-bearing**; the only dated live-test evidence in the repository |
| `docs/MIGRATION_RUNTIME_STATUS.md` | Per-environment migration ledger | Last verified 2026-07-21 — **the current authority for runtime migration application status.** Covers migrations 10, 17 and 19–23, and records the 2026-07-21 staging security harness result |
| `docs/BUYER_PACK_AUTHORITATIVE_ISSUANCE_APPLICATION.md` | Migration 23 runbook | Undated — **historical for migration-application status.** Its "runs no SQL against any database" / unapplied claim for migration 23 is **superseded**: staging catalog evidence shows the migration-23 RPC definition is installed. Useful only for its historical application procedure and design context; for current runtime status see `docs/MIGRATION_RUNTIME_STATUS.md`, *Conflicting evidence — migration 23 in staging* |
| `docs/FARM_ADMIN_FIELD_GUARD_APPLICATION.md` | Migrations 19/20 runbook | Undated — current for the narrative; its production claim is unverifiable |
| `docs/CANNAMONITOR_WATCHTOWER_INTEGRATION.md` | Source-connector safety boundary | "INACTIVE AND UNREACHABLE" — **current** |
| `docs/DEPLOYMENT_RUNBOOK.md` | Vercel production runbook | Undated — **historical / superseded for current deployment instructions.** Its §2, "Why Vercel Git auto-deploy is STILL ACTIVE", records the transition state in which the CI path had been added but the Vercel Git integration still auto-deployed `main` and a merge produced two Production deployments. That state was closed by merged PR #14, which set `git.deploymentEnabled.main` to `false`. **Current deployment authority is `.github/workflows/security-ci.yml`, `vercel.json`, and the README's "Deploy to Vercel" section.** The runbook retains real value as historical operational evidence — its account of the authorised CI path, the `Production` environment restriction, the deployment blast radius, and manual deployment as an emergency-only override remains accurate and is not restated elsewhere |
| `docs/BUYER_PACK_PHASE_A_SMOKE_TEST.md` | Manual browser checklist | Documentation only — current, low risk |
| `docs/THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md`, `docs/THAI_NATIVE_SPEAKER_REVIEW.md` | Thai wording review | **Open and mutually contradictory** |
| 29 root-level `*.md` files, incl. ~20 `PHASE_*_VALIDATION.md` | Point-in-time refactor/feature validations | **Historical.** Several are known to be stale or to disagree about what is deployed. Do **not** cite these in due diligence |

**For external review, cite:** this document, `docs/MIGRATION_RUNTIME_STATUS.md`, and `docs/SECURITY_TEST_LOG.md`. Nothing else in the repository is a reliable current-state reference. **Do not cite `docs/BUYER_PACK_AUTHORITATIVE_ISSUANCE_APPLICATION.md` as current-state evidence** — it is historical and superseded for migration-application status, and is **not** authoritative on whether migration 23 is installed.

---

## 13. Execution Sequence

### Immediate — resolve unverified database state
1. **DONE (2026-07-21).** `npm run security:staging` was run against the staging project and its result recorded in `docs/MIGRATION_RUNTIME_STATUS.md` — **107 PASS · 5 FAIL · 0 SKIP · 0 BLOCK**; the process exit code was **derived as 1**, not directly captured, because the capture wrapper did not preserve `PIPESTATUS`. The preflight gate confirmed migrations 21 and 22 present. **Do not re-run this harness as a routine step.** Each run appends a permanent, immutable `compliance_audit_log` record and — because storage cleanup is defective — leaves further synthetic storage residue; **36** synthetic objects were present after the recorded run. Any future rerun must wait until the storage-cleanup defect is fixed, and must then proceed only under an explicitly approved, staging-only procedure. Follow-up work is remediation of the migration 12/14/15 VERIFY baselines and of storage cleanup — not another harness run.
2. **DONE (2026-07-21).** `docs/MIGRATION_RUNTIME_STATUS.md` now covers migrations **19 through 23** with per-environment status and dates, alongside 10 and 17. Staging: 20/21 `APPLIED_AND_VERIFIED`, 19/22/23 `APPLIED_NOT_VERIFIED`. Production: `UNKNOWN` for all five. See *Migrations 19–23 — status matrix*.
3. Independently confirm the migration-19 farm admin-field guard in production and replace the undated prose claim with a dated, evidenced entry.
4. Decide and record whether migrations 10, 17, and 23 are to be applied to production, and on what change-control path.
5. Author a rollback script for migration 20.

### Short term — close out active work
6. Resolve the 83 open review threads on PR #37 and settle its two documented contract deviations.
7. Apply migration 24 and its VERIFY to staging; record the result. This is Evidence Request phase 2 and it gates phases 3–8.
8. Take an explicit decision on PRs #26, #33, #35, and #20 per Section 10.1 — harvest, rebase, or close. None should remain open by default.
9. Fix the Section 11 application inconsistencies: the ungated `persistInventory`/`persistFarms` writes, the stale Buyer Pack storage copy, the forwarded Admin Auth error text, and the unreachable `FarmerRegister.tsx`.
10. ~~Correct `README.md`'s deployment description, capability list, AI wording, role model, provisioning instructions, and unsafe SQL-prerequisites list~~ — **done** (Section 11, item 22). The README now carries a migration register with an explicit do-not-run exclusion list rather than an execution recipe. Its runtime-status column can only improve once steps 1–4 above are complete.
11. Reconcile the two Thai review documents and clear the two stale comments in `src/translations.ts`.
12. Archive the stale root-level `PHASE_*_VALIDATION.md` files into `docs/archive/`, as recommended by two prior audits and still not done.

### Medium term — build the sequence
13. Evidence Request phases 3–8 (Section 7).
14. Notifications, then Buyer CRM and controlled buyer accounts — the latter being the first new role since `pending`, and requiring RLS design before any UI.
15. Requirements and matching, then the deal pipeline.
16. Generalise the working COA upload pattern to every licence, certification, and photo field.
17. Design and implement the chain-of-custody data model, replacing the hardcoded placeholder.
18. Add MFA and platform-wide structured admin audit logging.
19. Replace the manual RLS checklist with an automated integration suite, and add UI/component and end-to-end tests. The unit layer is now strong (1,169 tests); the integration and UI layers remain absent.

### Long term
20. Samples, contracts and orders, fulfilment and chain of custody, then **commission and financial tracking** — in that order, because each supplies the record the next consumes.
21. Compliance source monitoring, once scheduled-execution infrastructure exists.
22. Commission an independent security review or penetration test. Current testing, while substantive, is performed by the same people building the system and is self-declared partial.
23. Establish formal data retention, backup and disaster recovery, and incident response policies.
24. Evaluate infrastructure-level tamper evidence (content-addressed or WORM storage) for buyer-facing evidence.
25. Engage qualified regulatory and legal counsel before building toward any GACP, GMP, GDP, or pharmaceutical-adjacent claim. The requirements are not yet defined by anyone qualified to define them, and no technical roadmap toward them is proposed here for that reason.

---

## 14. Verified Status Checklist

An item is checked only if directly confirmed in this repository at `afbe59e`.

**Confirmed**
- [x] Three-role model with a non-operational `pending` state (`ddp_admin`, `farmer`, `pending`)
- [x] Public self-registration removed and enforced by a standing test
- [x] DDP-controlled farmer provisioning through a server-side, service-role, admin-only endpoint
- [x] Database-level RLS access control, staged across 18 numbered migrations
- [x] Real, path-scoped, MIME-restricted, RLS-protected private storage for COA documents
- [x] Human-approval gate for buyer-facing evidence, enforced in-page and fail-closed for raw browser print
- [x] Buyer Pack immutable snapshot library genuinely wired into the Buyer Pack page
- [x] Database-enforced append-only audit log with TRUNCATE blocked (Compliance Watchtower)
- [x] Append-only procurement decision trail with TS/SQL decision-set parity under test
- [x] Read-only admin Operations Desk with truthful loading, failure, and empty states
- [x] Production browser-persistence suppression with a sign-out sweep and an enforced key allowlist
- [x] Privacy-safe observability with a closed field set and a machine-code regex
- [x] CI pipeline gating static SQL security checks, unit tests, typecheck, lint, and build
- [x] CI-exclusive production deployment with a pinned CLI and live commit-SHA verification
- [x] Server-side AI draft summarisation, transient and human-review-stamped, production-verified 2026-07-10
- [x] 1,169 automated tests across 72 files, all passing
- [x] Bilingual Thai/English UI *(two review documents still contradict each other — Section 11)*

**Not confirmed**
- [ ] Migrations 19–23 application status recorded for any environment
- [ ] Migrations 10, 17, and 23 applied to production
- [ ] Migration 19 farm admin-field guard independently confirmed in production
- [ ] Live staging security harness executed and its result recorded
- [ ] Server-recomputed Buyer Pack `content_hash`
- [ ] Durable, server-persisted Buyer Pack access and download trail
- [ ] Evidence Request and Resolution available to any user
- [ ] Real buyer role, account, or scoped access
- [ ] Chain-of-custody data model
- [ ] Commission, invoicing, payment, or margin tracking
- [ ] Real file storage for licence, certification, and photo fields
- [ ] MFA, SSO, or magic-link authentication
- [ ] Platform-wide structured admin audit logging
- [ ] Automated UI, integration, RLS, or end-to-end test coverage
- [ ] Automated compliance source detection
- [ ] Independent external security review or penetration test
- [ ] Formal data retention, backup/DR, and incident-response policies
- [ ] Consolidated, non-contradictory documentation set

---

## 15. Definition of Highest Standard

For this platform, "highest standard" means: every claim made to a farmer, buyer, investor, auditor, or regulator is traceable to working code or a dated, verified live test — never to a comment, an interface name, an open pull request, or a document written before the feature it describes existed. It means the security boundary that matters — database-level access control — is confirmed against live infrastructure rather than inferred from source files, which is precisely the gap this revision identifies as the programme's dominant risk. It means automation touching compliance or legal judgement is built so a human always makes the final call and the system can prove one did. It means documentation is consolidated and internally consistent rather than a trail of dated notes that disagree about what is deployed. And it means the platform never asserts a certification, legal compliance status, or regulatory approval that has not been granted by the party actually authorised to grant it.

Reaching that standard is a continuous process evidenced by verification, not a one-time declaration. This document is one step in it, not its conclusion.
