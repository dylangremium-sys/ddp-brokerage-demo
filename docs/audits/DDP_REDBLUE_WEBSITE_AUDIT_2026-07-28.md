# DDP Brokerage — Red vs Blue Audit of the Live Website

**Date:** 2026-07-28
**Repository (single scope lock):** `/Users/mac/DDP AUDIT/ddp-brokerage-demo`
**Commit audited:** `507d8386f5d5ec624cda52e60be2c0ada330747c` (`main`, = `origin/main`)
**Production surfaces:** `www.ddpbrokerage.com`, `ddpbrokerage.com` (308 → www), `ddp-brokerage-demo.vercel.app`
**Production database:** Supabase `iihxjrfxmycjafbtjvvq`, read via role `ddp_ro` (`SELECT`-only) inside `BEGIN READ ONLY`
**Writes performed:** none — no file changed, no production write attempted, no secret printed.

---

## A) Verdict

**CONDITIONAL GO for the existing pilot cohort — NO-GO for supplier onboarding.**

The *security* posture of production measured stronger than the paper record claims: RLS is on for
27/27 tables, exactly one anon-satisfiable write policy exists (and it is the intended public form),
no function is executable by `anon`/`PUBLIC`, no `SECURITY DEFINER` function has an unpinned
`search_path`, and the deployed bundle carries no secret and no source map.

What fails is **delivery and governance**, not access control:

1. The admin-only farmer-provisioning endpoint is **unconfigured in production** — no new supplier
   can be onboarded end to end, on any prod domain.
2. A **schema change reached production during an active change freeze** whose break-glass log is
   empty, so the control record no longer describes the system.
3. Two safety-critical backstops that `main` already contains — the durable override store
   (migration 30) and the server-side contaminant gate (migration 29) — are **not applied to
   production**, so a controlled-substance release label still rests partly on browser-local state.

---

## B) RED TEAM — findings, highest severity first

Each finding is labelled **FACT** (directly measured) or **INFERENCE** (reasoned, with confidence).

### R1 — HIGH — Farmer provisioning is dead in production
**FACT.** `POST /api/admin/provision-farmer` returns `500 {"ok":false,"error":"Provisioning endpoint
is not configured."}` on both `www.ddpbrokerage.com` and `ddp-brokerage-demo.vercel.app`, with and
without a bearer token. That string is emitted only when `buildDeps()` returns `null`
(`api/admin/provision-farmer.ts:42-45,106-110`), i.e. `SUPABASE_URL` or
`SUPABASE_SERVICE_ROLE_KEY` is unset/empty.

**FACT (corroborated).** The missing variable is `SUPABASE_SERVICE_ROLE_KEY`. Two independent lines
agree: (a) the sibling endpoint `/api/compliance/ai-summary` reads the *same* `SUPABASE_URL` plus
`SUPABASE_ANON_KEY` and gets as far as token validation (`401 "Invalid or expired access token."`),
proving both of those are present in Production; (b) the 2026-07-28 funnel session recorded directly
that `SUPABASE_SERVICE_ROLE_KEY` is not set in Vercel Production.

**Impact.** Migration 21 makes provisioning deliberately admin-only — this endpoint is the only
supported way an account comes into existence. With it down, the entire supplier funnel terminates:
a visitor can now file an access request (R2/migration 34), but no administrator can act on it.

**Minimal fix.** Set `SUPABASE_SERVICE_ROLE_KEY` in Vercel → Project → Settings → Environment
Variables → **Production**, redeploy, re-probe for a `401` (not `500`) with no token.

---

### R2 — HIGH — Production DDL applied during an ACTIVE change freeze, with no break-glass record
*(Not an unauthorised change: migration 34 was applied by the owner via the Supabase SQL editor on
2026-07-28. The defect is that the freeze document was never amended, so the written control record
now contradicts the system it governs.)*
**FACT.** `docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md` is `**Status:** ACTIVE`; §1.1 states "**No
migration may be applied to production**, in whole or in part"; §5 Break-glass log reads `_(none)_`.

Measured in production today, all four artefacts of migration 34 are present:

| Object | Measured state |
|---|---|
| `public.farmer_access_requests` | exists, 13 columns matching `34_..._HARDENING.sql:56-100` |
| Policies | 3 — `public submit` (INSERT, `{anon,authenticated}`), `admin read`, `admin triage` |
| Trigger | `farmer_access_requests_stamp_review` present (non-internal trigger count 16 → 17) |
| Function ACL | `stamp_farmer_access_request_review` = `postgres:EXECUTE service_role:EXECUTE` only — the migration's `REVOKE`s landed |

**Impact.** An authorised change was executed without the §3-mandated written record. The freeze
document is now false, and §4's close-of-freeze verification can no longer distinguish "authorised
change" from "drift" — which is the whole function of the control the pilot leans on.

**Minimal fix (owner: release owner).** Append the migration-34 event to §5 with statements,
pre-state, rollback and operator, and re-baseline §4 (see R11).

---

### R3 — HIGH — Buyer-pack release-gate overrides are browser-local in production
**FACT.** `risk_overrides` and `requirement_overrides` do not exist in production (`PGRST205` on
PostgREST; absent from the 27-table `pg_class` listing). Migration 30 is not applied.

**FACT.** `src/lib/procurementOverrideStore.ts:114-116,204,263,308` degrades to `'local-cache'`
precisely on `42P01`/`PGRST205` — the state production is in. So in production, risk-status and
requirement-status overrides are written to `localStorage` (`ddp_risk_overrides`,
`ddp_requirement_overrides`).

**FACT — the coupling.** Requirement overrides feed `hasBlockingIssues`, which
`src/lib/buyerApprovalGate.ts:24` combines with a recorded procurement decision to produce
`"DDP Reviewed — Human Approved for Buyer Discussion"`. Those keys are also in
`SENSITIVE_DDP_KEYS` (`src/lib/browserPersistence.ts:47-49`), so **sign-out deletes them**.

**Impact.** A clearance that materially participates in a controlled-substance release label is
unattributable, invisible to other administrators, editable from devtools, and destroyed by
sign-out.

**Partial mitigation already in place (blue).** `BrowserOnlyProvenanceNotice` renders on both
override surfaces in Supabase mode — `DDPRiskRegister.tsx:231`, `DDPMissingDocuments.tsx:252`.

**Minimal fix.** Apply migration 30 to production under a recorded break-glass entry; the client
already prefers the server unconditionally once the tables exist.

---

### R4 — HIGH (requires an authenticated `ddp_admin`) — no server-side contaminant gate on issuance
**FACT.** Production's `public.issue_buyer_pack_snapshot`:
`md5(prosrc) = c4a255b81f220d2e6f67b4d59a97f961`, `length = 3934`, `prosecdef = t`,
`search_path = public, auth, pg_temp`, body references `procurement_decisions_current`, and contains
**no** contaminant/lab-status marker. That is migration 23's hardened function; migration 29 is not
applied.

**Impact (the repo states it itself, `29_..._HARDENING.sql:29-34`).** Migration 23's gate is
admin + decision + named approver, never blockers — so the database will mint an immutable,
audit-logged snapshot for a batch whose own `heavy_metals/pesticides/mycotoxins/microbial` status is
`'fail'`, if the client-side derivation is bypassed.

**Accidental path is closed (blue).** The client half (F1a) *is* on `main` and deployed:
`composeRiskId()` (`src/lib/procurementControl.ts:242-280`) folds an FNV-1a fingerprint of
`severity + issue` into every risk id, so a risk whose content changes to a lab failure arrives as a
new, un-overridden `'open'` blocker, and pre-fix overrides are inert by construction. Exploitation
now requires deliberate tampering by an authenticated administrator, not the accidental route.

**Minimal fix.** Apply migration 29 under break-glass. Until then this is defence-in-depth that does
not exist.

---

### R5 — MEDIUM — Unauthenticated, unthrottleable public write path into production
**FACT.** `farmer_access_requests: public submit` is the **only** anon-satisfiable write policy in
production (measured across all 72 policies: every other INSERT/UPDATE/DELETE/ALL policy references
`auth.uid()`, `is_ddp_admin()`, `has_farm_membership()` or `has_operational_farmer_access()`). `anon`
holds table-level `INSERT`. The publishable key is, by design, in the public JS bundle.

**INFERENCE (high confidence, deliberately not tested — testing means writing to production).** Any
party can insert unlimited rows. Per-row size is bounded by the column CHECKs (~2.5 KB), the row
count is not. There is no CAPTCHA, no origin check, no per-IP limit anywhere in the stack.

**Design-level point.** The migration's own note says "rate limiting belongs at the edge"
(`34_..._HARDENING.sql:26`) — but this write goes **browser → Supabase directly**, never traversing
Vercel, so a Vercel WAF rule cannot see it. As designed, the stated mitigation is unreachable.

**Second-order.** §"Deliberately NO delete policy" means an administrator cannot purge spam through
the application at all — only via direct SQL, which the freeze forbids.

**Minimal fix.** Either route submission through a Vercel Function (then edge rate-limiting becomes
real and the anon INSERT grant can be revoked), or add a Supabase-side throttle plus an admin
soft-delete/`status='duplicate'` triage path.

---

### R5b — MEDIUM — Supabase self-signup is open on production (contained, not an escalation)
**FACT.** `GET /auth/v1/settings` on the production project returns `disable_signup: false` and
`mailer_autoconfirm: false`. Anyone can create an Auth account directly against the Supabase
endpoint, entirely bypassing the application's invite-only design.

**Contained — do not treat as a breach.** Production's `handle_new_user()` stamps every new user
`pending` (migration 21 **is** applied, verified directly on 2026-07-28), the self-promotion guard
policy is present, every farmer-facing RLS policy is scoped to farm **membership** rather than
`role='farmer'`, and `postLoginRouting.ts:28-29` denies a `pending` account with
`reason: 'pending-approval'`. A self-registrant therefore lands on an inert account with no
memberships, no data and no route to promotion. The real severity is unwanted account creation
(spam/noise) plus the fact that it makes the intake queue in R5 duplicable through a second channel.

**Minimal fix.** One dashboard toggle: Authentication → "Allow new users to sign up" → OFF. Do **not**
run `scripts/prod-selfsignup-containment.sql` — it is a no-op against this project's current state.

---

### R6 — MEDIUM — No browser security headers on the live site
**FACT** (`curl -I https://www.ddpbrokerage.com/`): no `content-security-policy`, no
`x-frame-options`, no `x-content-type-options`, no `referrer-policy`, no `permissions-policy`.
Present: `strict-transport-security: max-age=63072000` (no `includeSubDomains`, no `preload`) and
`access-control-allow-origin: *` on the HTML document. `vercel.json` contains only a `git` block —
no `headers`.

**Impact.** The administrator console is framable → clickjacking of approve/reject/issue controls.
Supabase keeps the session token in `localStorage`, so any future XSS is full session theft with no
CSP backstop.

**Blue counterweight.** There is no XSS sink today: `0` hits for `dangerouslySetInnerHTML`,
`innerHTML`, `eval(`, `new Function`, `document.write` across `src/` and `api/`.

**Minimal fix.** Add a `headers` block to `vercel.json`: `frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a CSP
allowing only `'self'` plus the Supabase origin.

---

### R7 — MEDIUM — Status transitions are still non-atomic (audit trail can diverge from state)
**FACT.** `src/lib/db.ts:302` and `src/lib/db.ts:404` — the entity `UPDATE` and the
`status_history` `INSERT` are two independent PostgREST calls with no transaction. `sbInsert`
throws on any error (`src/lib/db.ts:28-34`), so a failed history insert surfaces to the operator as
a failed action **while the farm/batch row is already at the new status in the database**.

**Production policies do permit the insert** (`status_history: admin all` and
`status_history: operational farmer or admin`), so this fires only on transient/edge failures — but
`status_history` is the compliance artefact, and the failure mode is silent divergence plus a
misleading error.

**Minimal fix.** One `SECURITY DEFINER` RPC that performs both writes in a single transaction, or a
compensating re-read before reporting failure.

---

### R8 — MEDIUM — Untracked staging database dumps sit in the repository working tree
**FACT.** `backups/staging_pre_reset_20260724_220215.dump` and
`backups/staging_pre_userdelete_20260724_231605.dump` — 428,257 bytes each, PostgreSQL custom-format
dumps. Both contain `auth.users`, `encrypted_password`, `profiles`, `phone`.
`git check-ignore -v backups/` exits `1` — **not ignored**; `git status` shows `?? backups/`.

**Impact.** A single `git add -A && git push` publishes staging password hashes and supplier PII to a
public GitHub repository. PR **#76**, whose entire content is the `backups/` gitignore rule, is open
and unmerged.

**Minimal fix.** Merge PR #76 (or add the rule locally) and move the dumps outside the repo root.

---

### R9 — MEDIUM — Storage overlay gap: role-blind upload policy, one bucket unpoliced
**FACT.** `storage.objects` carries exactly three policies in production, all scoped to
`farmer-documents`:

- `farmer-documents: admin all` — `bucket_id='farmer-documents' AND is_ddp_admin()`
- `farmer-documents: farmer read own` — `... AND (is_ddp_admin() OR auth.uid()::text = (string_to_array(name,'/'))[1])`
- `farmer-documents: farmer upload own` — `... AND auth.uid()::text = (string_to_array(name,'/'))[1]`

The upload check is a **path-prefix test only — no role check**. Migration 22's RESTRICTIVE
`farmer buckets: operational farmer or admin` overlay is absent, and `farmer-photos` has no policy at
all.

**INFERENCE (medium confidence).** Any authenticated identity — including a `pending`, not-yet-
approved account — can upload under its own uid prefix in `farmer-documents`.
**UNPROVEN:** whether any `pending` identity currently exists. `ddp_ro` has no `EXECUTE` on
`is_ddp_admin()`, so RLS-gated `public.profiles` cannot be counted from this credential.

**Blue counterweight.** No bucket is publicly readable: the public object path returns
`"Bucket not found"` for `farmer-documents`, `farmer-photos`, `coa-uploads`, `evidence-files`,
`buyer-packs`, and an anonymous `storage/object/list` returns `[]`.

**Minimal fix.** Apply migration 22's storage overlay under break-glass (`docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md` already drafts it).

---

### R10 — LOW — Build-chain dependency advisories, and no dependency gate in CI
**FACT.** `npm audit --omit=dev` → **0 vulnerabilities** (production tree clean).
`npm audit` (incl. dev) → 2 high: `postcss <=8.5.17` (path traversal via `sourceMappingURL`,
GHSA-r28c-9q8g-f849) and `brace-expansion <=5.0.7` (DoS, GHSA-3jxr-9vmj-r5cp). Neither ships to the
browser. Neither CI workflow runs `npm audit`.

**Minimal fix.** `npm audit fix`, then add `npm audit --omit=dev --audit-level=high` to the `verify` job.

---

### R11 — LOW (but it invalidates the sign-off gate) — the close-of-freeze checklist is wrong
**FACT.** Freeze §4 requires "0 INSERT/UPDATE/DELETE/TRUNCATE grants to `anon`/`authenticated`".
Measured today via `pg_class.relacl` + `aclexplode`: **144** such grants across 24 tables (`anon` holds
`INSERT,UPDATE,DELETE,SELECT` on 23 of them; `compliance_audit_log` correctly reduced to
`INSERT,SELECT` by migration 11). `TRUNCATE` grants = **0**.

This is not drift — it is Supabase's normal posture, and migrations 14/15 deliberately revoke only
`TRUNCATE, TRIGGER, REFERENCES, MAINTAIN` (`14_...:31`, `15_...:36`) plus `UPDATE, DELETE` on
`compliance_audit_log` (`15_...:60`). The expectation was never achievable.

**Root cause, reproduced.** Querying `information_schema.role_table_grants` as `ddp_ro` returns
**0 rows** — that view only shows grants involving roles the querying role is a member of. I hit the
same false negative earlier in this audit and corrected it with `pg_class.relacl`. Any prior "PASS"
on that row was produced by a blind query.

Three of §4's four control rows are now stale: RLS "26/26" → **27/27**; "0 anon-satisfiable policies"
→ **1** (by design, migration 34); "16 non-internal triggers" → **17**. Only the issuance-identity
row still matches exactly (and it does — see B5).

**Minimal fix.** Re-baseline §4 against the measurements in section D, and specify `pg_class.relacl`
as the measurement method for grants.

---

### R12 — LOW — Migration-number gaps hide unmerged work
**FACT.** `npm run verify:migration-numbers` → `PASS — 57 numbered migration files across 24 numbers
(3,4,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,29,30,34)`. Numbers **27, 28, 31, 32, 33**
are unclaimed on `main`; 27/28 live on unmerged PR #44. The guard detects duplicates, not gaps, so a
reader of `main` cannot tell a reserved number from a free one.

---

### Observed during the audit (not a defect, but operationally relevant)
At **14:44 UTC** `farmer_access_requests` returned `PGRST205` (absent from PostgREST's schema cache)
while the table already existed in the catalog; by **14:55 UTC** the same probe returned `42501`
(present, RLS-denied). PostgREST schema-cache lag after DDL. During that window the live public form
would have shown its `backend_unavailable` message — "The request form is not available yet."
The client handles this honestly (`src/lib/accessRequestClient.ts:95-100`), which is why the window
was survivable.

---

## C) BLUE TEAM — controls verified to hold

| # | Control | Evidence |
|---|---|---|
| B1 | RLS enabled on **27/27** public tables; 72 policies; **0** tables with RLS and no policy | `pg_class.relrowsecurity`, `pg_policies` |
| B2 | Exactly **1** anon-satisfiable write policy — the intended public intake | scan of all INSERT/UPDATE/DELETE/ALL policies for an auth predicate |
| B3 | **0** `SECURITY DEFINER` functions with unpinned `search_path`; **0** functions with `PUBLIC`/`anon` `EXECUTE` | `pg_proc.proconfig`, `aclexplode(proacl)` |
| B4 | **0** `TRUNCATE` grants to `anon`/`authenticated` | `pg_class.relacl` |
| B5 | Production runs migration **23**'s server-authoritative issuance, not migration 10's client-trusting one | `md5=c4a255b81f220d2e6f67b4d59a97f961`, `len=3934`, body references `procurement_decisions_current` — matches freeze §4 exactly |
| B6 | Anonymous probe of all 16 client-referenced tables: every one present-and-denied (`42501`) | direct PostgREST probe with the public publishable key |
| B7 | No secret, no source map, no dotfile in the deployed artefact | `0` hits for `service_role`/`ANTHROPIC_API_KEY`/`sk-ant`/`postgres://` in the 905 KB bundle; `.js.map`, `.env`, `.env.local`, `.git/config` all `404` |
| B8 | Server endpoints fail closed | `ai-summary`: `401` no-token, `401` bogus-token, correlation ID returned, no vendor text; both endpoints `405` on GET |
| B9 | The "demo mode = everyone is an admin" trap is closed at build time | `scripts/validate-hosted-supabase-config.mjs` aborts any `VERCEL_ENV in {preview,production}` build missing a `VITE_` var; runs via `prebuild`, which covers both Vercel build paths |
| B10 | Zero XSS sinks | `0` hits for `dangerouslySetInnerHTML`/`innerHTML`/`eval(`/`new Function`/`document.write` in `src/` + `api/` |
| B11 | Production data is not mirrored into the browser; sign-out sweeps an 18-key allowlist; a drift test fails the build on a new unlisted `ddp_*` key | `src/lib/browserPersistence.ts` |
| B12 | The decision store fails closed correctly — only `42P01`/`PGRST205` may degrade; `42501`/`42703`/auth/transient raise `DecisionReadUnavailableError` | `src/lib/procurementDecisionStore.ts:135-160`; `procurement_decisions_current` exists in prod with matching columns |
| B13 | Provisioning authorisation is sound *by design*: role read from the DB (never token/body), fail-closed on non-admin, `role/id/userId/user_id/profileId/profile_id` rejected, partial success reported honestly | `src/lib/serverFarmerProvisioning.ts:59-136` |
| B14 | Full local gate green | `vitest`: **2091 passed / 15 skipped / 0 failed** (99 files); `tsc -b` clean; `eslint` clean; `security:sql` PASS; `verify:migration-numbers` PASS |
| B15 | Deployment path is CI-only and self-verifying | `vercel.json` disables git-triggered prod deploys; `deploy-production` is `needs: verify`, `if: push && refs/heads/main`, `environment: Production`; the job then polls `/version.json` until it equals `GITHUB_SHA` or fails |
| B16 | Release chain intact today | live `/version.json` on both surfaces = `507d838` = local `HEAD` = `origin/main` |
| B17 | No bucket is publicly readable | public object path → `Bucket not found` on all five candidates; anon list → `[]` |
| B18 | **Correction to a prior finding (F3).** The carbon feature no longer lies: controls are `disabled` with an explicit "not connected to production storage yet" notice in Supabase mode (`carbonPersistenceAvailable={isDemo}`, `App.tsx:1153,1187`); production confirms `farms.carbon_programme_status` does not exist. It is an honest feature gap, not a silent-write bug |
| B19 | **Correction to a prior finding (F4).** The dead-end supplier signup is fixed: `farmer-register` is in `PUBLIC_PAGES` (`App.tsx:92`) and posts to a real server-side queue with an honest `backend_unavailable` path |
| B20 | **Correction to a prior finding (F1a).** The content-independent risk id is fixed on `main` and deployed (`composeRiskId`, FNV-1a over `severity + issue`) |

---

## D) Verification matrix

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Repo = origin = live production build | **PASS** | `507d838` in all three |
| 2 | Unit suite | **PASS** | 2091 passed, 15 skipped, 0 failed |
| 3 | `tsc -b` / `eslint` / `security:sql` / `verify:migration-numbers` | **PASS** | exit 0 / clean / `RESULT: PASS` / `PASS — 57 files, 24 numbers` |
| 4 | RLS coverage (prod) | **PASS** | 27/27 tables, 72 policies, 0 policy-less RLS tables |
| 5 | Anon-satisfiable write policies (prod) | **PASS (1, by design)** | migration-34 public intake only |
| 6 | `SECURITY DEFINER` `search_path` pinning (prod) | **PASS** | 0 unpinned |
| 7 | `PUBLIC`/`anon` function EXECUTE (prod) | **PASS** | 0 |
| 8 | `anon` TRUNCATE (prod) | **PASS** | 0 |
| 9 | `anon` INSERT/UPDATE/DELETE (prod) | **FAIL vs freeze §4 / EXPECTED vs migrations 14-15** | 144 grants, 24 tables — see R11 |
| 10 | Issuance function identity (prod) | **PASS** | `md5 c4a255b8…`, `len 3934`, `secdef t`, `search_path public, auth, pg_temp` |
| 11 | Contaminant blocker gate in DB (prod) | **FAIL** | migration 29 absent; body has no contaminant marker |
| 12 | Durable override store (prod) | **FAIL** | `risk_overrides`, `requirement_overrides` absent |
| 13 | Evidence-request schema (prod) | **NOT APPLIED (as intended)** | `evidence_requests` `PGRST205`; migration 24 explicitly deferred by freeze §1.1 |
| 14 | `/api/compliance/ai-summary` fail-closed | **PASS** | `401` no-token, `401` bogus token, request ID echoed |
| 15 | `/api/admin/provision-farmer` operational | **FAIL** | `500 not configured` on both prod surfaces |
| 16 | Secrets / source maps in deployed artefact | **PASS** | 0 hits; `.js.map` 404 |
| 17 | Browser security headers | **FAIL** | no CSP / XFO / nosniff / referrer-policy / permissions-policy |
| 18 | Storage bucket public read | **PASS** | all probes `Bucket not found`; anon list `[]` |
| 19 | Storage upload role gating | **FAIL** | path-prefix only; migration 22 overlay absent; `farmer-photos` unpoliced |
| 20 | Production dependency advisories | **PASS** | `npm audit --omit=dev` → 0 |
| 21 | Freeze compliance | **FAIL** | migration 34 applied; §5 log empty |
| 22 | `backups/` ignored by git | **FAIL** | `git check-ignore` exit 1; PR #76 unmerged |
| 23 | Authenticated `pending`-role reachability of storage | **BLOCKED / UNPROVEN** | `ddp_ro` has no EXECUTE on `is_ddp_admin()`, cannot read RLS-gated `profiles`; no test identity available |
| 24 | Public-form flooding (R5) | **NOT RUN — by design** | proving it requires writing to production |
| 25 | Supabase self-signup disabled (prod) | **FAIL (contained)** | `/auth/v1/settings` → `disable_signup: false`; new users land `pending` and inert — see R5b |

---

## E) Final state

**Changes made by this audit: none.** No file was modified (`git diff` empty, `HEAD` unchanged at
`507d838`), no production write was attempted, no secret was printed. All database access was via
`ddp_ro` inside `BEGIN READ ONLY`.

**Out-of-band churn disclosed:** `backups/` was already untracked and unignored before this audit
(R8). 12 pull requests are open; **all 12 carry `reviewDecision = NONE`** — there is still no review
quorum anywhere in the project.

**Residual risks / explicit unknowns**
- Whether any `pending` identity exists that could exercise R9 — **UNPROVEN**, needs a credential
  `ddp_ro` does not have.
- Whether R5 is being exploited today — **unknown**; `farmer_access_requests` row counts are readable
  only by an administrator.
- Whether the AI provider key is configured in Production — untested (auth fails first, correctly).
- Migration 34's application to production was measured, but its *authorisation* is unknown.

**Next actions, in priority order**

| # | Action | Owner |
|---|---|---|
| 1 | Set `SUPABASE_SERVICE_ROLE_KEY` in Vercel Production; redeploy; confirm the endpoint returns `401` (not `500`) with no token | Release owner |
| 2 | Reconcile the freeze: append the migration-34 event to §5 with statements/pre-state/rollback/operator, or record it as a breach | Release owner |
| 3 | Re-baseline freeze §4 to the section-D measurements, and pin `pg_class.relacl` as the grants-measurement method | Release owner |
| 4 | Under recorded break-glass, apply migrations **30** then **29** to production (durable overrides, then the contaminant gate) | Release owner + DB operator |
| 5 | Turn OFF Authentication → "Allow new users to sign up" in the Supabase dashboard (R5b) | Release owner |
| 6 | Merge PR #76 and move `backups/*.dump` outside the repository root | Engineering |
| 7 | Add a `headers` block to `vercel.json` (CSP with `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`) | Engineering |
| 8 | Give the public intake a real throttle — route it through a Vercel Function, or add a Supabase-side limit — and add an admin triage/soft-delete path | Engineering |
| 9 | Make the status transition atomic (single transactional RPC) | Engineering |
| 10 | Apply migration 22's storage overlay under break-glass | Release owner + DB operator |
| 11 | `npm audit fix`; add `npm audit --omit=dev --audit-level=high` to the `verify` job | Engineering |

**Single most important next action:** #1 — until the service-role key is set, the site can collect
supplier enquiries it is structurally incapable of fulfilling.
