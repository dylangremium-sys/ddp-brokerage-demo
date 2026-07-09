# DDP Inventory Demo

A React/TypeScript application simulating a **DDP (Delivered Duty Paid) Brokerage** workflow for agricultural commodities — a compliance-first B2B procurement-control platform, not a retail marketplace. It covers the full cycle: farmer onboarding, inventory submission, DDP operator review, master inventory management, a buyer preview portal, and a Compliance Watchtower for tracking legal updates, human-approved compliance rules, and their effect on farms/batches.

By default all data is stored in **browser localStorage**. When Supabase environment variables are provided, the app runs against a live Supabase (Postgres + Auth + RLS) backend instead.

---

## Live Demo

| | |
|---|---|
| **Deployed via** | Vercel (Git integration — auto-deploys `main` on push) |
| **Deployed branch** | `main` |
| **Status** | Demo-ready |

> Check the project's Vercel dashboard for the current production URL. Auth and role-based access foundations are present in `main`. Static repo evidence and prior live behaviour indicate RLS was implemented and tested, but the current live Supabase state should be confirmed directly in the Supabase dashboard before using real buyer or farm data.

---

## What this demo is

This is a front-end application built with **Vite + React + TypeScript**, backed by Supabase when configured. It demonstrates:

- Farmer portal — onboarding and inventory submission (EN/Thai)
- DDP operator dashboard — farm approval, inventory review, fulfilment packing queue
- Master inventory and buyer preview views
- Compliance Watchtower — regulatory update tracking, human-approved compliance rules, and rule-impact alerts on farms/batches (AI detects and summarises; a human reviews and approves; only approved rules are enforced)

In localStorage-only mode there is no server-side component, and resetting the demo clears localStorage and restores seed data. In Supabase mode, the "Reset Demo" button still only clears local state.

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

### Required environment variable names

| Variable | Where to find it |
|---|---|
| `VITE_SUPABASE_URL` | Supabase dashboard → Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase dashboard → Settings → API → anon public key |

### Vercel environment variable names

When deploying to Vercel with Supabase, add the same two variables in **Vercel → Project Settings → Environment Variables**:

| Key | Value |
|---|---|
| `VITE_SUPABASE_URL` | your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | your Supabase anon key |

Vercel injects these at build time so `import.meta.env.VITE_*` picks them up correctly.

### Local fallback

If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` are missing (empty or undefined), the app falls back entirely to localStorage. The deployed demo works without any Supabase configuration.

---

## Deploy to Vercel

This project deploys through Vercel's Git integration — pushing to `main` triggers an automatic build and deploy, with no manual deploy step. Vercel auto-detects the Vite framework preset.

1. Push this repo to GitHub (or import it directly in Vercel).
2. In [Vercel](https://vercel.com), click **Add New → Project** and import the repository.
3. Vercel auto-fills the build settings for a Vite project:

| Setting | Value |
|---|---|
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |

4. Optionally add Supabase env vars in **Project Settings → Environment Variables** (see above).
5. Click **Deploy**. Subsequent pushes to `main` redeploy automatically.

---

## Auth setup (Stage 3)

The app has two roles: **DDP Admin** and **Farmer**. Role-based navigation is enforced in Supabase mode; in localStorage demo mode everything is unrestricted.

### SQL prerequisites

Run these files in order in the Supabase SQL Editor (chronological order they were introduced in this repo's history):

1. `SUPABASE_SCHEMA.sql` — base tables
2. `AUTH_RLS_SCHEMA.sql` — `profiles`, `farm_memberships`, helper functions, draft RLS policies
3. `RLS_ENABLE_STAGED.sql` — staged RLS rollout (see [RLS policies](#rls-policies) below); `RLS_ROLLBACK.sql` reverts it if needed
4. `FARMER_MVP_MIGRATION.sql` and `FARMER_MVP_SECURITY_PATCH.sql` — farmer-submission tables and their security patch
5. `INVENTORY_BATCHES_RLS_PATCH.sql` — RLS patch for `inventory_batches`
6. `3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql` — hardens `SECURITY DEFINER` functions (`search_path`, revoked `PUBLIC EXECUTE`)
7. `4_RLS_ENABLE_REMAINING_TABLES.sql` — enables RLS on `ddp_scores`, `risk_flags`, `status_history`, `documents`
8. `FARM_RESAVE_PERSISTENCE_MIGRATION.sql` — farm re-save persistence fix
9. `8_COA_UPLOAD_STORAGE_MIGRATION.sql` — COA PDF upload storage bucket/policies
10. `9_COMPLIANCE_WATCHTOWER_MVP.sql` — Compliance Watchtower tables (`legal_updates`, `compliance_rules`, `compliance_alerts`, `compliance_reviews`, `compliance_audit_log`)
11. `INVENTORY_BATCHES_INSERT_GUARDRAIL_FIX.sql` — insert guardrail fix for `inventory_batches`

Confirm against the live Supabase project's migration history before re-running any of these against a database that may already have them applied.

### Create the first DDP Admin user

Supabase Auth does not expose a role field — you must set it manually after account creation.

**Step 1 — Create the account via Supabase dashboard:**

Go to **Authentication → Users → Invite user** (or create via the signup form and confirm the email).

**Step 2 — Set the role to `ddp_admin` in SQL Editor:**

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

### Create a farmer test user

Use the in-app **Create farmer account** form (Sign in → Create a farmer account). The `handle_new_user()` trigger auto-creates a `profiles` row with `role = 'farmer'`.

If the trigger is not yet installed, run `AUTH_RLS_SCHEMA.sql` first, then the profile row will be created automatically on next signup. Alternatively, insert it manually:

```sql
INSERT INTO public.profiles (id, email, display_name, role)
VALUES ('paste-farmer-uuid', 'farmer@example.com', 'Test Farmer', 'farmer');
```

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
- Base schema: `SUPABASE_SCHEMA.sql`. Auth + RLS schema: `AUTH_RLS_SCHEMA.sql`. See [SQL prerequisites](#sql-prerequisites) above for the full, chronologically-ordered migration list.
