# DDP Brokerage — Professionalisation Roadmap

Produced by a 7-agent read-only audit (public site/brand, procurement workflow,
security/auth/RLS, buyer pack/data room, farm onboarding/Thai UX, visual
design/UI system, QA/release) plus a Wave 1 implementation pass, on branch
`professional-site-elevation-v1` off `main` at commit `1fe7885`.

Core principle preserved throughout: **never overclaim**. The evidence
taxonomy CLAIMED → DOCUMENTED → REVIEWED → VERIFIED → MISSING → REJECTED is
untouched — every change below is copy, CSS, or additive tooling, never a
change to what a status label is allowed to claim.

---

## Wave 1 — implemented now (this pass)

Safe, frontend-only, public-site-and-tooling changes. Files touched:
`src/translations.ts`, `src/pages/public/LandingPage.tsx`, `src/App.css`,
`src/App.tsx`, `package.json`, `.gitignore`, `scripts/generate-version.js`
(new), `docs/THAI_NATIVE_SPEAKER_REVIEW.md` (updated).

1. **Removed an ambiguous claim.** "Licensed Cannabis Supply Platform" (hero
   tagline/nav descriptor) could read as DDP itself holding a cannabis
   licence rather than serving licensed operators. Reworded to
   "Buyer-Readiness Platform for Licensed Cannabis Supply" / nav-short
   "Buyer-Readiness Platform."
2. **Added a buyer entry point.** The public page previously had zero path
   for a buyer/procurement visitor — only farmer and DDP-staff CTAs. Added a
   low-weight text link, "Buyer or procurement partner? Contact DDP," under
   the hero CTAs, reusing the same DDP LINE contact channel already used for
   farmer support (`FarmerDashboard.tsx`) — no new backend, no invented
   contact detail.
3. **Labeled the hero mockup as illustrative.** Added "Illustrative example —
   not a live batch" under the hero product mockup, matching the framing
   already used on the lower "Sample Buyer Pack" section.
4. **Removed marketplace-language drift.** "...ready to buy" → "...ready to
   progress," matching the Progress/Hold/Reject decision vocabulary used
   everywhere else.
5. **Added an explicit scope-of-authority note**, distinct from the existing
   jurisdiction/onboarding disclaimer: "DDP organizes, consolidates, and
   reviews supplier documentation. DDP does not certify export readiness,
   pharmaceutical readiness, or legal compliance in any jurisdiction. Buyer
   decisions should rely only on reviewed documents and confirmation from a
   qualified party."
6. **Fixed a badge color collision.** `.status-verified`, `.status-buyer-ready`,
   and `.tier-certified-pharma-ready` were byte-for-byte identical (solid
   jade) — three distinct claims rendering as one indistinguishable badge.
   `.status-buyer-ready` is now a lighter green outline (still "good," but
   visually subordinate to the deeper `.status-verified` fill);
   `.tier-certified-pharma-ready` (an internal, rare compliance tier) now
   uses a distinct muted violet, so it can never be mistaken for either
   public-facing green state.
7. **Added a safe, git-independent build identifier.** `scripts/generate-version.js`
   runs automatically via a new `prebuild` npm script (works identically
   locally and on Render, no `.git` dependency, no secrets) and writes
   `public/version.json` (`{ version, builtAt }`, gitignored — regenerated
   every build). Displayed as small text in the existing bottom utility strip,
   now rendered regardless of demo/live mode so it's visible for future
   live-deploy audits without needing bundle-hash comparison.
8. **New Thai strings tracked for native review**, following the established
   pattern in `docs/THAI_NATIVE_SPEAKER_REVIEW.md`: reworded tagline/nav
   descriptor, the new buyer-CTA string, the hero-mock caption, the
   "ready to progress" fix, and the new authority note. None of these were
   asserted as final — each carries an inline `// NOTE: ... needs native
   speaker review` comment, matching prior practice.

Explicitly **not** touched in Wave 1 (per scope): Supabase schema, RLS,
migrations, storage, PDF generation pipeline, buyer accounts/data room,
payment/commercial workflow, any *existing* Thai string finalized before this
pass, navigation structure, or risky renames.

---

## Unified roadmap by phase

### A. Must-fix-now
All items were addressed in Wave 1 above — nothing in the "must-fix" class
was left unimplemented within this pass's safe scope.

### B. Phase 1 — safe frontend/public-site upgrade (this Wave 1; remaining items for a follow-up Wave 2)
- Differentiate the four "Why DDP" concept-card icons (currently identical
  checkmark icon on all four — Agent 1/6).
- Rebalance the 5-item "What DDP Organizes" grid at the 1100px/900px
  breakpoints (Agent 1).
- Consolidate 5 duplicated hand-rolled empty-state `<div>`s across admin
  pages into the existing `.empty-state`/`.empty-table-cell` classes
  (Agent 6 — mechanical, low-risk, but touches 5 page files so deferred out
  of this tightly-scoped Wave 1 patch).
- Unify ~8 near-duplicate "eyebrow/label" CSS classes into one shared
  utility, and audit the 92 inline `fontSize` usages in favor of a real type
  scale (Agent 6 — a real design-system pass, bigger than Wave 1).
- Reconcile `DDPMasterInventory`'s unique `.master-banner` header treatment
  against the shared `.page-header.ddp-header` used by every sibling admin
  page (Agent 6).
- Archive the 39 stale/contradictory root-level `PHASE_*.md`/`*_VALIDATION.md`
  files (several claim different branches/commits as "currently deployed")
  into `docs/archive/` — flagged as actively misleading by Agent 7, high
  value, but a large mechanical file-move better done as its own reviewable
  commit rather than folded into this copy/CSS patch.

### C. Phase 2 — buyer-pack/data-room upgrade
- Print CSS currently doesn't override the dark-theme variables — printing
  the Buyer Pack today produces a dark navy card on a white page, not a
  clean document. Needs `@media print` overrides forcing light colors on
  `.buyer-pack-card`/`.card` and the `DDPVerifiedSupplySeal` SVG fills.
- Add a pack reference/timestamp to the on-screen header, print output, and
  `buildSummaryText()` — currently the Copy Summary date has no time and
  there's no pack ID at all.
- Add an inline CLAIMED/DOCUMENTED/REVIEWED/VERIFIED/MISSING/REJECTED legend
  to the pack itself — the taxonomy is used via badges but never explained
  on the document a buyer actually receives.
- Move the COA caveat ("as documented by the farm, DDP review required
  before commercial reliance") to appear near the top of the pack, not only
  lower down.
- Add a static DDP contact line to the pack footer.
- The "Executive Summary (Internal Draft)" block always renders on-screen
  (only `no-print`-hidden, not gated by review/decision state) — a fragile
  internal/buyer-safe split that should be tied to actual pack state, not
  just a CSS class.
- Later (needs backend): persisted pack generation history/version numbers,
  buyer access logging, real expiry enforcement.

### D. Phase 3 — auth/RLS/security upgrade
- **Key finding:** substantial RLS migration SQL already exists on disk
  (`AUTH_RLS_SCHEMA.sql`, `RLS_ENABLE_STAGED.sql`, `4_RLS_ENABLE_REMAINING_TABLES.sql`,
  `FARMER_MVP_SECURITY_PATCH.sql`, `8_COA_UPLOAD_STORAGE_MIGRATION.sql`, dated
  as late as 2026-06-30, described in their own headers as staged/"confirmed
  stable") — but README/handover docs elsewhere say RLS "is not part of this
  deployed demo." **This is a documentation-vs-reality conflict that needs a
  human to confirm against the actual Supabase dashboard** — not something
  this audit could verify safely (no SQL was run, no Supabase project was
  touched, per the strict rules for this pass).
- Until confirmed: all `isAdminRole`/`isFarmerRole`/page-gating checks in
  `App.tsx` are UI-only and trivially bypassable — real enforcement depends
  entirely on whether the on-disk RLS policies are actually applied.
- Must-verify before real buyer use: anonymous reads are actually rejected
  at the DB layer for `market_price_benchmarks`, `farms`, `inventory_batches`.
- Must-verify before real farm use: a farmer cannot self-escalate
  `profiles.role` to `ddp_admin` via a raw REST call; farm-membership scoping
  is enforced by RLS, not just by client-side query shape; the
  owner-notes/review-request tamper-protection triggers are actually
  installed.
- This entire phase requires Supabase dashboard access and explicit
  approval before any policy is touched — correctly out of scope here.

**Update — follow-up RLS/security audit result:** a dedicated read-only audit
of the SQL/migration files and commit history (no SQL run, no Supabase
project touched) classified this as **high-confidence C: RLS appears
implemented from committed SQL, commit history, and status docs, but current
live `pg_tables`/`pg_policies` confirmation remains outstanding.** The
RLS-enabling commits exist directly in `main`'s own history (not an
abandoned branch), and a status doc claims the rollout was tested against
the live app — but this has not been independently confirmed against the
actual Supabase project from this codebase alone. Before real buyer/farm
use, run this read-only confirmation directly in the Supabase SQL Editor:

```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
SELECT * FROM pg_policies WHERE schemaname = 'public';
```

Additional findings from that audit:
- No buyer role or buyer-scoped table exists in the schema at all — the
  Buyer Preview/Buyer Pack remains a pure frontend simulation with no
  database-level access control of its own. Buyer data-room work (a real
  buyer role, scoped access, audit logging) remains a future phase, not
  something to infer from this audit.
- `FARM_RESAVE_PERSISTENCE_MIGRATION.sql` contains a pending bug in its
  *proposed* (not yet applied) `fn_protect_farm_admin_fields()` function: it
  checks `profiles.role = 'admin'`, while every other policy/function in the
  codebase uses `'ddp_admin'`. As written, this function would never
  recognize a real admin. The file is already marked "do not run
  automatically, pending approval" — **do not run until this is reviewed and
  fixed**, regardless of anything else in this roadmap.

### E. Phase 4 — farm onboarding upgrade
- `FarmerOnboarding.tsx` step 8 licence field is labeled "Upload document, or
  type a reference" but the control is plain text, not a file input — a
  genuine copy/functionality mismatch (contrast with the honest, real file
  upload already used for COA/photo in `FarmerSubmitInventory.tsx`). Same
  issue across every licence/cert field in `FarmerAdvancedProfile.tsx`.
  Low-risk copy-only fix (stop saying "upload"); a real file-upload feature
  for these fields is a bigger, separate undertaking.
- Completion-percentage logic (`calcCompletion`) counts two fields that only
  exist in the optional Advanced Profile, so the basic onboarding wizard can
  never show 100% — may confuse farmers into thinking something's broken.
- Regulatory jargon in the optional Advanced Profile (QP, CAPA, change
  control, stability program, seed-to-sale, Incoterms) is transliterated but
  unexplained in Thai — flagged for a native speaker's plain-language pass,
  not rewritten here.
- Mobile form inputs are 14px, below the 16px iOS Safari auto-zoom
  threshold — minor but real friction on the primary device farmers likely
  use.

### F. Phase 5 — production/monitoring upgrade
- No automated test suite, no CI (no `.github/workflows`, no `render.yaml`)
  — build/lint aren't gated before deploy.
- No error monitoring (Sentry/LogRocket/etc.) — all error handling is
  `console.error`/`console.warn` with silent fallback, no user-facing
  failure state for Supabase write errors.
- No backup mechanism for localStorage demo data; if Supabase becomes
  primary, its own backup tier is sufficient — no custom tooling needed.
- QA checklist (pre-deploy): `npm run lint` + `npm run build` clean; manual
  click-through farmer submit → admin review → buyer preview in both
  localStorage and Supabase modes; EN/TH toggle renders without breaking
  layout; Reset Demo restores seed data correctly.
- Smoke-test checklist (post-deploy): live URL loads with no console errors;
  demo-mode badge reflects the correct mode; the new build-id tag (Wave 1)
  matches the intended commit; a quick farmer→admin→buyer flow works.

### G. Out of scope / blocked pending approval
- Any Supabase schema, RLS policy, migration, or storage bucket change.
- A real buyer role/login/scoped-access system (procurement workflow Agent 2
  found this doesn't exist at all today — Buyer Preview is an admin-only
  simulation with Print/Copy as the only "disclosure" mechanism). This is a
  meaningful product decision (new role, new auth surface, new RLS) that
  needs explicit direction, not something to infer from an audit.
- PDF generation pipeline / full buyer data room.
- Payment or commercial-terms workflow.
- Any *existing* Thai copy finalized without native-speaker sign-off.
- Consolidating the 39 stale root docs (recommended, but as its own
  reviewable commit — see Phase 1 above).

---

## Recommended next steps, in order

1. Review and approve/reject this Wave 1 patch; commit if satisfied.
2. Resolve the RLS documentation-vs-reality conflict (Phase 3) — this is the
   single highest-leverage next step before any real buyer/farm goes live,
   and only you can confirm it against the actual Supabase dashboard.
3. A second, tightly-scoped Wave (Phase 2 above) making the Buyer Pack
   print-safe and adding the pack reference/timestamp/legend — everything
   needed is frontend-only.
4. Decide whether a real buyer role/account is in scope for this product at
   all, before investing further in the Buyer Preview simulation.
5. Archive the stale root docs and consolidate release notes into `docs/`.

---

## Compliance Rules Operationalization v1 — Phase 1 (Closure)

*Unrelated to the lettered roadmap above (A–G), which covers an earlier,
separate public-site/buyer-pack/auth-RLS initiative. This section documents
a later, distinct workstream: making Compliance Watchtower rule approvals
visible on the operational Supply Ledger pages.*

**Production state at closure:**
- Commit: `c33e6b6` ("Make compliance rule check empty state visible").
- Deployment: READY, deployed automatically through the Vercel Git
  integration (no manual deploy).
- Production UI was hard-refreshed and visually verified directly.

**Verified pages:**
- Supply Ledger → Master Inventory
- Supply Ledger → Missing Documents
- Supply Ledger → Risk Register

**Verified visible result:**
- Each page shows an additive "Compliance Rule Check" column, separate from
  the existing evidence/status/risk/compliance-tier columns.
- Each row shows a neutral "NO RULE IMPACT" badge where no approved/active
  compliance rule has an unresolved alert against that entity.
- Existing evidence/status/risk/compliance-tier tables continue to render
  normally — nothing pre-existing was altered.

**Confirmed safety for this workstream:**
- No SQL or migration changes.
- No RLS changes.
- No env var changes.
- No service-role key usage.
- No Supabase data changes made during UI verification.
- No buyer-facing or public page changes.
- No forbidden compliance/export-claim wording introduced or spotted in
  verification screenshots.

**Known limitations:**
- No real approved/active rule currently has an alert against a real
  production entity, so every row shows "NO RULE IMPACT" — this is the
  correct, honest state until an admin approves a rule that produces one.
- Entity matching is string equality on `entity_id`, not a hard foreign key.
- Rule/alert data refreshes once per admin session load, not live.
- This phase is read-only display only — there is no "apply rule impact" or
  "acknowledge rule impact" action yet.

**Human-review principle preserved throughout:** every visible rule impact
still requires a human-approved compliance rule (`status = approved` or
`active`) — the system never treats an AI-detected legal update as
automatically accepted; a human review and an approved rule remain the only
path to a visible operational effect.

### Demo readiness baseline

Current demo-safe state is read-only rule-impact visibility only. All rows
currently show "NO RULE IMPACT" until an approved/active rule produces an
unresolved alert against a clearly marked demo entity.

**Recommended next controlled demo — "Controlled demo rule impact proof":**
Create one clearly labelled TEST/demo legal update, take it through human
review to an approved rule, and let that rule generate one cautious,
unresolved alert against a single non-critical demo entity — so exactly one
Supply Ledger row shows a cautious label (`needs review`, `missing
evidence`, or `blocked pending legal review`) instead of "NO RULE IMPACT."
This proves the full chain end to end: Watchtower legal update → human
review → approved rule → generated alert → Supply Ledger rule-impact badge.

Safety rules for that demo, when it is run:
- All demo content clearly labelled TEST/DEMO in every field.
- Cautious safe-vocabulary labels only — no real legal or compliance claim.
- No alteration of any real buyer-facing status.
- No forbidden wording.
- Affects at most one clearly-marked demo entity, not real farm/batch data.

This section is planning only — the demo data has not been created, and no
production data was touched in writing this baseline.

### Controlled Demo Rule Impact Proof — Closure

Executed and verified against production Supabase on 2026-07-08, using the
admin fixture account (anon key only, no service-role key) — the same
approach used for the Watchtower Persistence v1 admin verification earlier
in this project.

**Demo entity used:** `inventory_batches` row **DEMO-BATCH-001**
(`entity_id: 00000000-0000-4000-8000-000000000002`), belonging to the
pre-existing "DDP Demo Farm" fixture. No real farm, farmer, or client data
was used or touched.

**Records created:**
- TEST/DEMO legal update: "TEST ONLY / DEMO ONLY — Rule impact chain proof"
  — id `f67a1ec1-e557-4b4d-995f-79b945f72b32`.
- Active demo rule: `LEGAL_F67A1EC1_...` — id
  `341cf753-edf6-46eb-b55c-a98c48ecb66c`, human-approved and activated
  through the normal Review Queue → Rules tab flow.
- Linked manual alert — id `048b721f-5a01-48fb-9cd3-46d0a6cdf685`,
  `entity_type: batch`, `entity_id: 00000000-0000-4000-8000-000000000002`,
  `severity: medium`, `status: open`, linked via `rule_id` to the demo rule
  above using the rule-link field added in the prior workstream.

**Confirmed Supply Ledger result:** DEMO-BATCH-001 shows a **needs review**
badge in the Compliance Rule Check column. All other rows remain **No rule
impact** — confirmed no duplicates and no other entity was affected.

**Confirmed safety:** No real farm, batch, or client data was changed. No
files, code, env vars, SQL, or deployments were touched in the proof or in
its verification.

**Remaining demo artifacts (not yet cleaned up):**
- One TEST/DEMO legal update (status `rule_suggested`).
- One active demo rule.
- One open demo alert linked to that rule, against DEMO-BATCH-001.

**Cleanup recommendation (pending separate approval):**
- Resolve or dismiss the demo alert.
- Pause or retire the demo rule.
- Leave the TEST/DEMO legal update as a labelled historical record, or
  archive it if the UI supports that action — decide and execute as its own
  explicitly-approved step.

This proof confirms the full operational loop end to end: Watchtower legal
update → human review → approved/active rule → linked alert → Supply Ledger
rule-impact badge — with the human-approval gate preserved throughout.
