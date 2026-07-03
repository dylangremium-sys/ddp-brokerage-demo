# DDP Brokerage Demo — Handover Checklist

Branch: `auth-rls-mvp` | Commit: `40cb071` | Date: 2026-07-03

---

## Pre-Demo Account Setup (Required)

### Farmer demo account
- [ ] Create in Supabase Dashboard → Authentication → Users
  - Email: _(your chosen farmer demo email)_
  - Password: _(set a strong demo password)_
  - Check "Auto Confirm User"
- [ ] Insert into `public.profiles` via Table Editor:
  - `id` = UUID from auth.users
  - `email` = same email
  - `display_name` = "Demo Farmer"
  - `role` = `farmer`
- [ ] Optional: run RESET_C_SEED_BASELINE.sql (after updating the placeholder email) to create a linked demo farm and inventory batch

### Admin demo account
- [ ] Create in Supabase Dashboard → Authentication → Users
  - Email: _(your chosen admin demo email)_
  - Password: _(set a strong demo password)_
  - Check "Auto Confirm User"
- [ ] Insert into `public.profiles` via Table Editor:
  - `id` = UUID from auth.users
  - `email` = same email
  - `display_name` = "DDP Operator"
  - `role` = `ddp_admin`

---

## Credential Rotation (Required After Each Demo)

- [ ] Change farmer demo account password in Supabase Auth immediately after demo
- [ ] Change admin demo account password in Supabase Auth immediately after demo
- [ ] Or delete accounts entirely if demo is complete

---

## Render Deployment Verification

- [ ] Confirm live URL loads: https://ddp-brokerage-demo.onrender.com
- [ ] Confirm live JS bundle matches expected hash: `assets/index-BQ9yucCS.js`
  - (Check browser DevTools → Network → JS bundles)
- [ ] Note: Render API key expired as of June 2026 — all deploys must be triggered manually from the Render Dashboard, not via CLI or API
- [ ] Confirm `origin/main` = `40cb071` before triggering a deploy

---

## Supabase Project Verification

- [ ] Confirm Supabase project: `iihxjrfxmycjafbtjvvq.supabase.co`
- [ ] Confirm RLS is enabled on all tables (do not disable for demo)
- [ ] Do not run RESET_B or RESET_C without running RESET_A first and taking a manual backup

---

## RESET File Confirmation

Three SQL files are in the repo root as **untracked** files only:

| File | Nature | Safe to run? |
|---|---|---|
| `RESET_A_BACKUP_COUNTS.sql` | Read-only SELECT counts | ✅ Yes, anytime |
| `RESET_B_DEMO_DATA.sql` | Destructive DELETE (preserves admin + auth.users) | ⚠ Only after backup |
| `RESET_C_SEED_BASELINE.sql` | Seed INSERT (idempotent) | ⚠ Only after B, update email first |

- [ ] Confirm RESET files are untracked (`git status` shows `??` only)
- [ ] Confirm RESET files have NOT been staged or committed
- [ ] Confirm RESET_B has NOT been run without explicit approval

---

## Live Smoke Test Sign-Off

Run before every stakeholder demo:

- [ ] Landing page loads without errors
- [ ] Login page shows single-card layout (DDP BROKERAGE eyebrow + "Sign in" h1 + divider)
- [ ] Signup page shows single-card layout ("Join DDP Farmer Network" h1)
- [ ] Province select shows custom CSS chevron (not OS-native arrow)
- [ ] Farmer login succeeds with demo farmer account
- [ ] Farmer dashboard shows correct (newest) farm profile completion %
- [ ] Admin login succeeds with demo admin account
- [ ] Admin overview loads with farm/inventory counts
- [ ] Farm Profiles page loads
- [ ] Inventory Review page loads
- [ ] Master Inventory page loads
- [ ] Buyer Preview page loads and Print/Save PDF works
- [ ] No JS console errors (non-401)
- [ ] No non-auth HTTP errors

---

## Known Caveats for Handover

### Carbon Programme feature
Carbon programme status changes (`carbonProgrammeStatus`) are written to React
state only — not persisted to Supabase. This is intentional pending an approved
schema migration. Console warns but UI is unaffected for demo purposes.

### latestFarm dashboard fix
`FarmerDashboard.tsx:78` now uses `farms[0]` (newest farm, since DB orders
`created_at DESC`). Multi-profile functional test not completed — fix is
source-verified. Caveat: if demo farmer has no farm profiles, the completion
card will show 0% / local draft state.

### Authenticated smoke test
Full authenticated Playwright smoke (farmer path + admin path) could not be
completed because demo accounts were not provisioned in the live Supabase
project at time of handover. The Playwright script at
`$SCRATCHPAD/auth_smoke.mjs` is ready and tested; credentials must be passed
as environment variables only.

### Demo mode vs Supabase mode
`isDemo = !isSupabaseConfigured`. On the live Render app, Supabase IS configured,
so `isDemo = false`. This means:
- No demo reset button visible
- No localStorage seed data shown
- All farmer data requires actual Supabase `farms` + `inventory_batches` rows

---

## Next Phase Recommendations

1. **Provision demo accounts** — minimum: one farmer, one admin — before any stakeholder demo
2. **Seed demo data** — run RESET_C (after updating email) to create a pre-filled demo farm and inventory batch
3. **Carbon persistence** — approve and apply the SQL/RLS migration for `carbon_programme_status` column to make carbon actions durable
4. **Multi-farm test** — create two farm profiles under the demo farmer to verify `farms[0]` (newest) fix in a live environment
5. **Email confirmation** — consider disabling Supabase email confirmation for demo accounts to simplify sign-up flow during demos
6. **Render API key** — renew or replace the expired Render API key so deploys can be automated again
7. **Branch cleanup** — merge `auth-rls-mvp` into `main` via PR when ready for production handover; delete `backend-mvp` if obsolete

---

## Code Freeze Confirmation

As of `40cb071`:
- [ ] No uncommitted changes in working tree
- [ ] RESET files remain untracked
- [ ] `db.ts`, `supabase.ts`, `auth.ts` not modified
- [ ] `.env.local`, Supabase RLS, schema, migrations not modified
- [ ] No code changes made during this closeout (docs only)
