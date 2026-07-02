# Landing Page Redesign — Deployment Smoke Test

**Date:** 2026-07-02
**Tester:** Dylan Murtagh (manual)
**Result:** PASSED

---

## Deployed Commit

| Field | Value |
|---|---|
| Commit | `4c51d40` |
| Message | `UI: redesign landing page as operational supply desk` |
| Branch | `auth-rls-mvp` |
| Merged to | `main` (fast-forward) |
| Local HEAD | `4c51d40` |
| origin/auth-rls-mvp | `4c51d40` |
| origin/main | `4c51d40` |

---

## Render Service

| Field | Value |
|---|---|
| Service | `ddp-brokerage-demo` |
| Live URL | https://ddp-brokerage-demo.onrender.com |
| Deploy method | Manual deploy via Render Dashboard |
| Deploy status | Succeeded |
| Deployed commit confirmed | `4c51d40` |

---

## Smoke Test Checklist

### A. Render Deploy

| Check | Result |
|---|---|
| Deploy succeeded | PASS |
| Deployed commit shown as `4c51d40` | PASS |

### B. Core App

| Check | Result |
|---|---|
| Live app loads without blank/green screen | PASS |
| No fatal crash observed | PASS |
| Language toggle works | PASS |

### C. Landing Page — Desktop

| Check | Result |
|---|---|
| Landing page renders correctly at desktop width | PASS |
| Hero layout shows operational supply desk style | PASS |
| DDP monogram/logo renders | PASS |
| Headline renders | PASS |
| Farmer/Supplier access module visible | PASS |
| DDP Operations access module visible | PASS |
| Access modules appear above the fold | PASS |
| Proof/platform-function strip renders | PASS |
| Workflow/concept cards render below | PASS |
| No obvious overflow/cutoff | PASS |

### D. Landing Page — Mobile / Narrow Width

| Check | Result |
|---|---|
| Renders correctly at mobile width | PASS |
| Hero stacks cleanly | PASS |
| Access modules stack cleanly | PASS |
| No horizontal scrolling | PASS |

### E. Landing Page — English Copy

| Check | Result |
|---|---|
| Headline visible and institutional/compliance-led | PASS |
| No "prototype" language | PASS |
| No marketplace/"shop" language | PASS |

### F. Landing Page — Thai Copy

| Check | Result |
|---|---|
| Switch to Thai works | PASS |
| Thai headline renders | PASS |
| Thai farmer/supplier access text renders | PASS |
| Thai proof strip renders without layout breakage | PASS |

### G. Access Buttons

| Check | Result |
|---|---|
| Farmer/Supplier button routes correctly | PASS |
| DDP Operations button routes correctly | PASS |

### H. Regression Checks

| Check | Result |
|---|---|
| Farmer login works | PASS |
| Admin login works | PASS |
| Farmer Dashboard opens | PASS |
| Submit Inventory opens | PASS |
| My Stock opens | PASS |
| Admin Farm Review opens | PASS |
| Admin Inventory Review opens | PASS |
| Buyer Pack opens | PASS |

### I. Final Result

| Field | Value |
|---|---|
| Overall result | **PASSED** |
| Failures | None |
| Regressions | None observed |

---

## Scope Confirmation

This smoke test validates the landing page redesign deployment only. The following are explicitly confirmed as **out of scope and untouched**:

- No SQL executed
- No Supabase schema changes
- No Auth or RLS changes
- No migrations applied or modified
- No `db.ts` changes
- No secrets, environment variables, or deployment config changed
- No `RESET_*.sql` files touched
- No app logic changes introduced during this phase

Files changed in commit `4c51d40` (UI only):

| File | Change |
|---|---|
| `src/App.css` | Landing page layout and responsive styles |
| `src/pages/public/LandingPage.tsx` | Two-column hero, access modules, proof strip, workflow cards |
| `src/translations.ts` | English and Thai copy for all new landing sections |

---

## Phase Status

Phase 3E is closed. This deployment completes the Phase 3E landing page redesign milestone.

**Pending (not part of this phase):**
- Carbon programme persistence (Phase 3F) — `carbon_programme_status` DB column not yet added; carbon controls remain disabled in live Supabase mode
- Landing page stashes (`stash@{0}`, `stash@{1}`) — can be dropped at user discretion
- Backup branch `hold/landing-page-redesign-6c86032` — can be deleted at user discretion
