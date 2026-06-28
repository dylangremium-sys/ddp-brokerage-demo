# DDP Inventory Demo

A single-page React/TypeScript demo simulating a **DDP (Delivered Duty Paid) Brokerage** workflow for agricultural commodities. It covers the full cycle: farmer onboarding, inventory submission, DDP operator review, master inventory management, and a buyer preview portal.

By default all data is stored in **browser localStorage**. When Supabase environment variables are provided, write operations are also mirrored to a Supabase database.

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

## Notes

- The app uses in-app navigation (no URL routing), so all routes resolve to `index.html`. Render serves static sites from `index.html` by default — no rewrite rules needed.
- Demo data resets via the **Reset Demo** button in the app; this clears localStorage only and does not affect the Supabase database.
- Database schema is documented in `SUPABASE_SCHEMA.sql`.
