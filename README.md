# DDP Inventory Demo

A React/TypeScript application simulating a **DDP (Delivered Duty Paid) Brokerage** workflow for agricultural commodities — a compliance-first B2B procurement-control platform, not a retail marketplace. It covers the full cycle: farmer onboarding, inventory submission, DDP operator review, master inventory management, a buyer preview portal, and a Compliance Watchtower for tracking legal updates, human-approved compliance rules, and their effect on farms/batches.

By default all data is stored in **browser localStorage**. When Supabase environment variables are provided, the app runs against a live Supabase (Postgres + Auth + RLS) backend instead.

---

## Live Demo

| | |
|---|---|
| **Deployed via** | GitHub Actions (`.github/workflows/security-ci.yml`) — a push to `main` deploys to Production only after the verification job succeeds. Vercel Git-triggered Production deploys for `main` are disabled. |
| **Deployed branch** | `main` |
| **Status** | Demo-ready |

> Check the project's Vercel dashboard for the current production URL. Auth and role-based access foundations are present in `main`. Static repo evidence and prior live behaviour indicate RLS was implemented and tested, but the current live Supabase state should be confirmed directly in the Supabase dashboard before using real buyer or farm data.

---

## What this demo is

This is a front-end application built with **Vite + React + TypeScript**, backed by Supabase when configured. It demonstrates:

- Farmer portal — onboarding and inventory submission (EN/Thai)
- DDP operator dashboard — farm review, inventory review, master inventory, Missing Documents, COA Intelligence, Risk Register, and a read-only Operations Desk
- Buyer Pack preview — an admin-only curated view of an approved batch, gated on recorded human approval
- Compliance Watchtower — regulatory update tracking, human-approved compliance rules, and rule-impact alerts on farms/batches

Fulfilment and chain-of-custody tracking are **planned, not implemented** — see `docs/MASTER_DEVELOPMENT_ROADMAP.md`.

On the Watchtower and AI: intake and detection of legal/regulatory updates are currently **manual** (a paste form) — there is no automated source monitoring. **AI-assisted draft summarisation** of a single update exists and runs server-side. Every summary is transient, is stamped as requiring human review, and is never persisted. **AI does not approve rules, certify compliance, or enforce anything automatically.** A human reviews each update and explicitly approves a rule, and only human-approved rules affect alerts.

Application data in local demo mode lives entirely in browser `localStorage`; resetting the demo clears it and restores seed data. In Supabase mode the "Reset Demo" button still only clears local state. There is **no traditional dedicated backend server** — no long-running Express/Fastify/Nest process. The repository does, however, contain two serverless API routes, used only when the relevant hosted configuration is present:

- `api/admin/provision-farmer.ts` — controlled farmer provisioning
- `api/compliance/ai-summary.ts` — compliance AI draft summarisation

---

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Other scripts:

| Script | Purpose |
|---|---|
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve the `dist/` build locally |

---

## Supabase setup (optional)

The app runs without Supabase. When env vars are absent the navbar shows **"Demo mode: localStorage"** and all data stays in the browser. To connect a real database:

### 1. Create a Supabase project

Sign up at [supabase.com](https://supabase.com), create a project, then run `SUPABASE_SCHEMA.sql` in the **SQL Editor** to create the required tables.

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your project credentials:

```bash
cp .env.example .env.local
```

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key-here
```

> **Never commit `.env` or `.env.local`** — they are listed in `.gitignore`.

### 3. Verify

Run `npm run dev`. The navbar badge should switch to **"Database mode: Supabase"**.

### Client configuration

These two are `VITE_`-prefixed, which means Vite inlines them into the browser bundle. Only ever put public values here.

| Variable | Purpose | Where to find it |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL used by the browser client | Supabase dashboard → Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Public anon key used by the browser client | Supabase dashboard → Settings → API → anon public key |

When deploying to Vercel, add the same two variables in **Vercel → Project Settings → Environment Variables**. Vercel injects them at build time so `import.meta.env.VITE_*` resolves correctly.

### Server-only provisioning configuration

Controlled farmer provisioning runs in the serverless function `api/admin/provision-farmer.ts`, which reads two variables from `process.env`. They are **server-only** and are never part of the browser bundle.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL used by the server-side Admin Auth client |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key, required to invite a user via Admin Auth and to promote a `pending` profile |

**Hosted controlled provisioning does not function unless both server-only variables are configured.** Without them the endpoint cannot construct its Admin Auth client, and no farmer can be provisioned.

Rules for `SUPABASE_SERVICE_ROLE_KEY`:

- **It must never carry a `VITE_` prefix.** A `VITE_`-prefixed variable is inlined into the browser bundle and would publish the key to every visitor.
- **It must never be committed** to the repository, and never exposed to browser code. Set it only as a Vercel Environment Variable, or locally in a git-ignored `.env.local`.
- It is read exclusively from `process.env` in server-side code. A standing test (`scripts/client-provisioning-boundary.test.mjs`) fails the build if `src/` references a service-role key or reads it from `import.meta.env`.

> `SUPABASE_URL` is shared with the compliance AI-summary route, which additionally uses `SUPABASE_ANON_KEY` and its own AI provider variables — see `.env.example`. That route uses no service-role key.

**Current status:** `main` has the provisioning API and service layer, but **no admin provisioning UI is wired** — no component imports `inviteFarmer`, `provisionFarmer`, or `listPendingProfiles`. Provisioning today means calling the endpoint directly.

### Local fallback

If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` are missing (empty or undefined), the app falls back entirely to localStorage. The deployed demo works without any Supabase configuration.

---

## Deploy to Vercel

**Vercel Git-triggered Production deployment for `main` is disabled** — `vercel.json` sets `git.deploymentEnabled.main` to `false`. Pushing to `main` does **not** cause Vercel to build and deploy Production on its own.

Routine Production deployment runs through GitHub Actions (`.github/workflows/security-ci.yml`), and verification must succeed before any deployment begins:

1. A push to `main` first runs the `verify` job: `npm ci` → `npm run security:sql` → `npm test` → `npx tsc -b` → `npm run lint` → `npm run build`. This job connects to no database and uses no secrets.
2. The `deploy-production` job `needs: verify`, so it cannot start unless verification succeeded, and it runs only for a push to `refs/heads/main`.
3. It pulls the Production Vercel configuration, builds with the pinned Vercel CLI, and deploys the **prebuilt** verified artifact.
4. After deploying, it polls the live site's `/version.json` and fails the job unless the served `commitSha` equals `GITHUB_SHA` — so a stale alias or a half-finished promotion fails rather than passing silently.

**Preview deployments for pull requests remain available** and are separate from the Production path.

Manual deployment or promotion by the project owner from the Vercel dashboard or CLI is an **emergency override, not the routine path** — it bypasses the verification gate and the post-deploy commit check.

For first-time project setup, import the repository in [Vercel](https://vercel.com) (**Add New → Project**). Vercel auto-detects the Vite preset:

| Setting | Value |
|---|---|
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |

Add Supabase env vars in **Project Settings → Environment Variables** (see above). Production releases thereafter go through the workflow described above.

---

## Auth setup (Stage 3)

The app has three roles, stored on `public.profiles.role`:

| Role | Meaning |
|---|---|
| `ddp_admin` | DDP staff. Full operator access. |
| `farmer` | An operational farmer account, provisioned by DDP. |
| `pending` | **Fail-closed default.** A new Auth user starts here. |

`pending` is a non-operational state: a pending user receives **neither farmer nor administrator access**. Post-login routing denies the account and signs it back out, and a restrictive RLS overlay (`has_operational_farmer_access()`, migration 22) additionally blocks pending accounts from the operational tables and storage buckets even via a direct API call. **Only controlled DDP provisioning promotes an account to `farmer`** — a user cannot change their own role (migration 21 RLS: `profiles: update own no role change`).

Role-based navigation is enforced in Supabase mode; in localStorage demo mode everything is unrestricted.

### Database setup and migration safety

> **This section is a register, not a recipe.** There is no migration runner in this repository — SQL files sit in the repository root and are applied by hand. Read the rules below before executing anything.

**Rules**

1. **Do not blindly execute every `.sql` file in the repository.** They are not all forward migrations, and several must never be run.
2. **Do not infer the current state of any database from these files.** The repository records what was *authored*, not what was *applied*. The repository already documents one confirmed divergence, where a validation document recorded a trigger as applied and the live database reported it absent (`FARM_ADMIN_ROLE_CHECK_FIX.sql`).
3. **Inspect the target project first.** Before applying anything, examine the actual schema, functions, RLS policies, function/table ACLs and whatever migration history exists for that project. `16_PRODUCTION_SAFETY_VERIFY.sql` is strictly read-only (catalog `SELECT`s only, no DDL or DML) and is the safe way to inspect Production.
4. **`*_VERIFY.sql` and `*_ROLLBACK.sql` files are not forward migrations.** VERIFY files check that a migration took effect; ROLLBACK files reverse one. Neither installs anything.
5. **Historical, superseded and draft files must never be replayed.** See the exclusion list below.
6. **An existing database needs a state-aware corrective plan**, not a replay of the sequence. Determine the delta between the live state and the intended state, then apply only what is missing, in dependency order.
7. **A fresh environment needs the complete reviewed migration chain**, worked out from the register below — not the truncated list this README previously carried, which stopped at migration 11 and omitted every security migration from 12 onward.
8. **Production and non-production verification differ.** Read-only catalog verification is safe anywhere. Behavioural verification writes synthetic rows and must not be run casually against Production — `18_SYNTHETIC_RUNTIME_VERIFY.sql` exercises behaviour rather than structure and requires migrations 10 and 17 to be applied and verified first.

**Migration register (current `main`)**

Numbered migrations run 3 → 23. Numbers 1, 2, 5, 6, 7 do not exist; the numbering convention was introduced partway through the project's history.

| Group | Forward migration(s) | VERIFY / ROLLBACK | Repository status | Runtime application |
|---|---|---|---|---|
| Base schema | `SUPABASE_SCHEMA.sql`, `AUTH_RLS_SCHEMA.sql` | — | Implemented | Assumed present in any working environment; not independently verified here |
| Early RLS rollout | `RLS_ENABLE_STAGED.sql` | `RLS_ROLLBACK.sql` (rollback) | Implemented, staged by design | Partly evidenced by `docs/SECURITY_TEST_LOG.md` (2026-07-07 → 07-11) |
| Farmer MVP | `FARMER_MVP_MIGRATION.sql`, `FARMER_MVP_SECURITY_PATCH.sql` | — | Implemented | Not independently verified here |
| `inventory_batches` corrections | `INVENTORY_BATCHES_RLS_PATCH.sql`, `INVENTORY_BATCHES_INSERT_GUARDRAIL_FIX.sql` | — | Implemented; both record live drift found and corrected | Applied manually per their own headers |
| Function hardening | `3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql` | — | Implemented | Not independently verified here |
| Remaining RLS | `4_RLS_ENABLE_REMAINING_TABLES.sql` | — | Implemented | Not independently verified here |
| COA / private storage | `8_COA_UPLOAD_STORAGE_MIGRATION.sql` | — | Implemented | Storage isolation tested live (`docs/SECURITY_TEST_LOG.md`) |
| Compliance Watchtower | `9_COMPLIANCE_WATCHTOWER_MVP.sql` | — | Implemented | End-to-end pipeline verified live 2026-07-08 (`docs/PROFESSIONALIZATION_ROADMAP.md`) |
| Buyer Pack snapshots | `10_BUYER_PACK_SNAPSHOTS_MVP.sql` | `10_..._VERIFY.sql`, `10_..._ROLLBACK.sql` | Implemented | **Staging: applied + verified 2026-07-14. Production: NOT applied** (`docs/MIGRATION_RUNTIME_STATUS.md`) |
| Audit-log TRUNCATE guard | `11_COMPLIANCE_AUDIT_LOG_TRUNCATE_HARDENING.sql` | `11_..._VERIFY.sql`, `11_..._ROLLBACK.sql` | Implemented | Unable to verify from the repository |
| Function EXECUTE ACL | `12_PUBLIC_FUNCTION_EXECUTE_HARDENING.sql` | `12_..._VERIFY.sql`, `12_..._ROLLBACK.sql` | Implemented | Unable to verify from the repository |
| Function ACL drift check | — | `13_PUBLIC_FUNCTION_EXECUTE_DRIFT_CHECK.sql` (SELECT-only) | Verification only | Safe to run read-only anywhere |
| Default privileges | `14_PUBLIC_TABLE_DEFAULT_PRIVILEGE_HARDENING.sql` | `14_..._VERIFY.sql`, `14_..._ROLLBACK.sql` | Implemented | Unable to verify from the repository |
| Existing-table + audit-log hardening | `15_EXISTING_TABLE_AND_AUDIT_LOG_HARDENING.sql` | `15_..._VERIFY.sql`, `15_..._ROLLBACK.sql` | Implemented | Unable to verify from the repository |
| Production safety inspection | — | `16_PRODUCTION_SAFETY_VERIFY.sql` (read-only) | Verification only | **Production-safe.** Run this first when assessing a live project |
| Procurement decisions | `17_PROCUREMENT_DECISIONS_MVP.sql` | `17_..._VERIFY.sql`, `17_..._ROLLBACK.sql` | Implemented | **Staging: applied + verified 2026-07-14. Production: NOT applied.** Requires migration 10 first (FK dependency) |
| Behavioural runtime proof | — | `18_SYNTHETIC_RUNTIME_VERIFY.sql` | Verification only | **Non-production.** Writes synthetic rows; requires 10 and 17 applied and verified first |
| Farm admin-field guard | `19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql` | `19_..._VERIFY.sql`, `19_..._ROLLBACK.sql` | Implemented; supersedes the earlier draft guard | Its companion runbook and `20_...` header both state Production was corrected manually, but this is undated self-reported prose — treat as **unable to verify** from the repository |
| Guard ACL correction | `20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql` | **no rollback script exists** | Implemented | Makes the manual Production `REVOKE` durable for fresh environments |
| Controlled farmer provisioning | `21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql` | `21_..._VERIFY.sql`, `21_..._ROLLBACK.sql` | Implemented | **Unable to verify** — no entry in `docs/MIGRATION_RUNTIME_STATUS.md` |
| Operational-farmer access overlay | `22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql` | `22_..._VERIFY.sql`, `22_..._ROLLBACK.sql` | Implemented | **Unable to verify** — no entry in `docs/MIGRATION_RUNTIME_STATUS.md` |
| Server-authoritative Buyer Pack issuance | `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql` | `23_..._VERIFY.sql`, `23_..._ROLLBACK.sql` | Implemented | **Not applied anywhere.** Its runbook states it "runs no SQL against any database" (`docs/BUYER_PACK_AUTHORITATIVE_ISSUANCE_APPLICATION.md`) |

**Do not run — historical, draft or superseded**

| File | Why |
|---|---|
| `FARM_RESAVE_PERSISTENCE_MIGRATION.sql` | **Draft, never approved for automatic application.** Its own header says "Do not run this file automatically" and marks it `ACL-TEST-EXEMPT: INTENTIONAL-DRAFT`. Its `fn_protect_farm_admin_fields()` checks `p.role = 'admin'`, a value the `profiles.role` constraint never permits, so the guard could never recognise an admin. **Superseded by migration 19**, which delegates to the canonical `is_ddp_admin()` predicate and carries no role literal at all |
| `FARM_ADMIN_ROLE_CHECK_FIX.sql` | **Draft — "NOT APPLIED. NOT RUN. NOT DEPLOYED."** A proposed hotfix for the above, also superseded by migration 19. Retained as the record of a read-only Production check that found the trigger absent |
| `RLS_ROLLBACK.sql`, and every `*_ROLLBACK.sql` | Rollback scripts. They reverse a migration; they never install one |
| Every `*_VERIFY.sql`, plus `13_...DRIFT_CHECK.sql`, `16_...SAFETY_VERIFY.sql`, `18_...RUNTIME_VERIFY.sql` | Verification scripts, not forward migrations |

Migration 24 (Evidence Request & Resolution) is **not part of `main`** — it exists only on draft PR #37 and has not been applied to any environment. It is not a prerequisite for anything.

For the authoritative per-environment position, read `docs/MIGRATION_RUNTIME_STATUS.md` and `docs/MASTER_DEVELOPMENT_ROADMAP.md`. Note that the runtime ledger currently covers only migrations 10 and 17.

### Bootstrap the first DDP Admin user

This is the **initial administrator bootstrap** — a one-off, dashboard-driven operation that is distinct from normal farmer provisioning (below). There is **no public signup form**; public self-registration was deliberately removed, so an account cannot be created from within the application.

Supabase Auth does not expose a role field, so the role must be set manually after account creation.

**Step 1 — Create the account via the Supabase dashboard:**

Go to **Authentication → Users → Invite user**. The `handle_new_user()` trigger creates the matching `profiles` row with `role = 'pending'`.

**Step 2 — Promote to `ddp_admin` in the SQL Editor.** RLS permits a role change only for an existing `ddp_admin`, so the very first admin must be set from the SQL Editor, which runs as a privileged role and is not subject to RLS:

```sql
-- Replace with the actual user UUID from Authentication → Users
UPDATE public.profiles
SET role = 'ddp_admin'
WHERE id = 'paste-user-uuid-here';
```

**Step 3 — Verify:**

```sql
SELECT id, email, display_name, role FROM public.profiles;
```

### Provision a farmer

Farmers are provisioned by DDP. There is **no in-app "Create farmer account" form and no public signup** — both were deliberately removed, and a standing test (`scripts/client-provisioning-boundary.test.mjs`) fails the build if a public signup path reappears in `src/`. Creating a Supabase Auth user by any route does **not** produce an operational farmer.

The controlled flow:

1. A verified `ddp_admin` calls the controlled provisioning API. The client wrapper is `src/services/adminProvisioning.ts` (`inviteFarmer`), which sends the admin's **own** session access token — never a service-role key.
2. The server-side endpoint `api/admin/provision-farmer.ts` verifies the bearer token, re-reads the caller's role from `profiles` (never trusting the client), and issues the invitation using Supabase **Admin Auth**.
3. The new profile begins as `pending`.
4. Controlled promotion changes the role to `farmer` — a constrained `UPDATE … WHERE id = ? AND role = 'pending'` that must affect exactly one row.
5. Operational access additionally depends on farm membership and the migration-22 access controls: `has_operational_farmer_access()` requires the role to be exactly `farmer`, and farm-scoped policies require an active `farm_memberships` row. A promoted account with no membership still sees no farm data.

> **Note:** provisioning is currently exposed through the service and API layer only. No admin provisioning screen is wired into the UI on `main` — no component imports `inviteFarmer`, `provisionFarmer`, or `listPendingProfiles`. The supporting functions `provisionFarmer()` and `listPendingProfiles()` are exported from `src/services/auth.ts` and run under the caller's own session, relying on the `profiles: admin update role` RLS policy rather than any elevated key.

Never place a service-role key in client code or in any `VITE_`-prefixed environment variable. It is read server-side from `process.env` only.

### The `handle_new_user()` trigger

`handle_new_user()` fires when a new `auth.users` row is created and inserts the matching `public.profiles` row. Since migration 21 (`21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql`) it assigns **`role = 'pending'`, never `'farmer'`**, and `profiles.role` defaults to `'pending'` as a second layer.

Creating a profile row therefore **does not grant operational farmer access**. The trigger is part of the fail-closed provisioning model: however an Auth user comes into existence — dashboard invite, direct Auth API call, or the provisioning endpoint — the resulting account lands in the non-operational `pending` state and stays there until a `ddp_admin` explicitly promotes it. The function is trigger-only: `EXECUTE` is revoked from `PUBLIC`, `anon`, and `authenticated`, and granted to `service_role` alone.

### Test role-based navigation

| Action | Expected behaviour |
|---|---|
| Open app without Supabase env vars | Full demo mode, no auth required |
| Open app with Supabase env vars, not signed in | Landing page shows "Sign in" button |
| Sign in as **farmer** | Farmer nav group only; DDP pages show "Access Denied" |
| Sign in as **ddp_admin** | Full nav (Farmer + DDP groups) |
| Farmer submits farm registration | Row appears in `farms`, `farm_profiles`, `farm_memberships` |
| Farmer submits inventory | Row appears in `inventory_batches` |
| Admin approves/rejects | Status updated in `farms` or `inventory_batches`; row in `status_history` |

### Enable email confirmation (optional)

By default Supabase requires email confirmation. For local testing, disable it:
**Authentication → Settings → Email Auth → "Confirm email"** — turn off.

### RLS policies

`AUTH_RLS_SCHEMA.sql` (Part 3) still contains an early set of draft/commented-out policy examples — that section itself was never uncommented and run as-is. It was superseded by a later, separately-written RLS rollout (`RLS_ENABLE_STAGED.sql`, `4_RLS_ENABLE_REMAINING_TABLES.sql`, and related hardening/patch files), whose commits appear directly in `main`'s own history alongside a status doc claiming the rollout was completed and tested against the live app.

Static repo evidence (committed SQL, commit history, and status docs) points to RLS being live, but this has not been independently confirmed against the actual Supabase project from this codebase alone. Before relying on this for real buyer or farm data, confirm directly with a read-only query in the Supabase SQL Editor:

```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
SELECT * FROM pg_policies WHERE schemaname = 'public';
```

If you ever do need to apply the `AUTH_RLS_SCHEMA.sql` Part 3 draft directly (e.g. rebuilding from scratch), only do so after:

1. Auth UI is tested end-to-end.
2. At least one `ddp_admin` profile exists.
3. At least one farmer with a `farm_memberships` row exists.
4. You have verified data reads work correctly without RLS.

---

## Notes

- The app uses in-app navigation (no URL routing), so all routes resolve to `index.html`. Vercel serves this as a static Vite build from `index.html` by default — no rewrite rules needed.
- Demo data resets via the **Reset Demo** button in the app; this clears localStorage only and does not affect the Supabase database.
- Base schema: `SUPABASE_SCHEMA.sql`. Auth + RLS schema: `AUTH_RLS_SCHEMA.sql`. See [Database setup and migration safety](#database-setup-and-migration-safety) above for the full migration register, the files that must never be replayed, and the rules for applying anything to a live database.
