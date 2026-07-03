# DDP Brokerage Demo — Baseline Record

## Live Deployment

| Item | Value |
|---|---|
| Live URL | https://ddp-brokerage-demo.onrender.com |
| Platform | Render (manual deploy) |
| Supabase project | `iihxjrfxmycjafbtjvvq.supabase.co` |
| Build tool | Vite 8 — React 19 / TypeScript SPA |

## Git Baseline

| Item | Value |
|---|---|
| Branch | `auth-rls-mvp` |
| HEAD commit | `40cb071` — Fix: show newest farmer profile on dashboard |
| `origin/auth-rls-mvp` | `40cb071` |
| `origin/main` | `40cb071` |
| Live JS bundle | `assets/index-BQ9yucCS.js` |
| Working tree | Clean — RESET_A/B/C untracked only |

## Smoke Test Results (2026-07-03)

| Path | Result |
|---|---|
| Landing page loads | ✅ Pass |
| Login page (single auth-card layout) | ✅ Pass |
| Signup page (single auth-card layout) | ✅ Pass |
| Province select — custom CSS chevron | ✅ Pass (`appearance: none` + SVG bg) |
| Nav Sign-in button visible when signed out | ✅ Pass |
| Auth-card-brand divider present | ✅ Pass |
| Farmer portal — authenticated login | ⚠ Blocked — demo accounts not provisioned |
| Admin portal — authenticated login | ⚠ Blocked — demo accounts not provisioned |
| Buyer Preview page | ✅ Passed in previous session (source-verified) |
| No non-auth HTTP errors | ✅ Pass |
| No JS console errors | ✅ Pass |
| Expected Supabase 401 (session check) | ✅ 1 — expected, UI unaffected |

## latestFarm Fix (40cb071)

`FarmerDashboard.tsx` previously used `farms[farms.length - 1]` (oldest farm).
Fixed to `farms[0]` because `loadFarmerFarmsFromDB` orders by `created_at DESC`.
The dashboard now always shows the most recently created farm profile.

**Multi-profile functional verification:** Not completed — smoke farmer account
has no multi-profile data. Fix is verified by source inspection and build audit.

## Protected Areas — Confirmed Untouched

- `db.ts`, `supabase.ts`, `auth.ts` — not modified
- Supabase Auth / RLS — not touched
- `.env.local`, secrets, schema, migrations — not modified
- Deploy config, Render settings — not modified
- `RESET_A/B/C.sql` — untracked, not staged or committed

## RESET Files Warning

Three SQL files are present in the working directory as untracked files:

- `RESET_A_BACKUP_COUNTS.sql` — read-only SELECT counts, safe to run anytime
- `RESET_B_DEMO_DATA.sql` — **DESTRUCTIVE**: deletes all farms, inventory, farm profiles, farmer profiles. Preserves admin profile and all `auth.users`.
- `RESET_C_SEED_BASELINE.sql` — seed-only: inserts one demo farm + batch. Requires an existing farmer `auth.users` row. Uses placeholder email `demo-farmer@example.com` that must be substituted.

**Do not run B or C without a pre-run backup (A first) and explicit approval.**

## Smoke Credentials Warning

Demo test accounts (`dylan+farmer1@gmail.com`, `dylan+admin1@gmail.com`) were
provided verbally during development. These accounts have not yet been created
in the live Supabase project. Before any stakeholder demo:

1. Create accounts in Supabase Auth (Authentication → Users)
2. Insert matching rows in `public.profiles` with correct `role` values
3. Rotate or delete accounts immediately after the demo

## Carbon Programme Caveat

The Carbon Programme feature (`carbonProgrammeStatus` on farm profiles) persists
**only in demo mode (localStorage)**. In the live Supabase-connected app, carbon
actions update local React state only — they are not written to the database.
This is noted in console warnings (`console.warn`) and is a known incomplete
feature, not a regression.

## Handover Status

- UI polish: **complete**
- Auth flow: **working** (Supabase mode, login/signup single-card layout)
- Demo accounts: **not provisioned** — must create before stakeholder demo
- Code freeze: **active** — no uncommitted changes
- Docs: `DEMO_BASELINE.md`, `DEMO_SCRIPT.md`, `HANDOVER_CHECKLIST.md` added
