# DDP Inventory Demo

A single-page React/TypeScript demo simulating a **DDP (Delivered Duty Paid) Brokerage** workflow for agricultural commodities. It covers the full cycle: farmer onboarding, inventory submission, DDP operator review, master inventory management, and a buyer preview portal.

By default all data is stored in **browser localStorage**. When Supabase environment variables are provided, write operations are also mirrored to a Supabase database.

---

## Live Demo

| | |
|---|---|
| **URL** | https://ddp-brokerage-demo.onrender.com/ |
| **Deployed branch** | `main` |
| **Status** | Demo-ready |

> Auth and role-based access foundations are present in `main`. Static repo evidence and prior live behaviour indicate RLS was implemented and tested, but the current live Supabase state should be confirmed directly in the Supabase dashboard before using real buyer or farm data.

---

## What this demo is

This is a static front-end prototype built with **Vite + React + TypeScript**. It demonstrates:

- Farmer portal — onboarding and inventory submission (EN/Thai)
- DDP operator dashboard — farm approval, inventory review, fulfilment packing queue
- Master inventory and buyer preview views

There is no server-side component. Resetting the demo clears localStorage and restores seed data.

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

### Render environment variable names

When deploying to Render with Supabase, add the same two variables in **Render → Environment**:

| Key | Value |
|---|---|
| `VITE_SUPABASE_URL` | your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | your Supabase anon key |

Render injects these at build time so `import.meta.env.VITE_*` picks them up correctly.

### Local fallback

If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` are missing (empty or undefined), the app falls back entirely to localStorage. The Render static site demo works without any Supabase configuration.

---

## Deploy to Render (Static Site)

1. Push this repo to GitHub (or GitLab).
2. In [Render](https://render.com), click **New → Static Site**.
3. Connect your repository.
4. Set the following:

| Setting | Value |
|---|---|
| **Build Command** | `npm run build` |
| **Publish Directory** | `dist` |

5. Optionally add Supabase env vars in **Render → Environment** (see above).
6. Click **Create Static Site**. Render will install dependencies, build, and serve `dist/`.

---

## Auth setup (Stage 3)

The app has two roles: **DDP Admin** and **Farmer**. Role-based navigation is enforced in Supabase mode; in localStorage demo mode everything is unrestricted.

### SQL prerequisites

Run these files in order in the Supabase SQL Editor:

1. `SUPABASE_SCHEMA.sql` — base tables
2. `AUTH_RLS_SCHEMA.sql` — `profiles`, `farm_memberships`, helper functions, draft RLS policies

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

- The app uses in-app navigation (no URL routing), so all routes resolve to `index.html`. Render serves static sites from `index.html` by default — no rewrite rules needed.
- Demo data resets via the **Reset Demo** button in the app; this clears localStorage only and does not affect the Supabase database.
- Base schema: `SUPABASE_SCHEMA.sql`. Auth + RLS schema: `AUTH_RLS_SCHEMA.sql`.
