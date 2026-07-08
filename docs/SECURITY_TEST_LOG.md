# DDP Brokerage Security / RLS Test Log

## 1. Scope

This document records a series of controlled, read-mostly Auth/RLS/storage/cross-farmer
tests performed against the DDP Brokerage Supabase project using the anon key only.

**This is documentation of completed controlled tests. It is explicitly:**
- **Not** a full security audit.
- **Not** penetration testing.
- **Not** proof that all RLS policies are correct.
- **Not** a claim of production security completeness.

Findings below are scoped strictly to the tables, rows, and probes described. Anything
not listed in Section 10 ("What was not tested") should be treated as unverified.

## 2. Test fixtures retained

- **Farmer A:** `farmertest@ddpbrokerage.com`
- **Farmer B:** `farmertest2@ddpbrokerage.com`
- Both are retained as controlled, non-admin farmer test identities for future
  regression checks.
- Credentials are stored locally in `.env.local` only (`DDP_TEST_FARMER_EMAIL` /
  `DDP_TEST_FARMER_PASSWORD`, `DDP_TEST_FARMER_B_EMAIL` / `DDP_TEST_FARMER_B_PASSWORD`).
  Passwords are not documented here or anywhere else.
- Farmer B was manually created in the Supabase Dashboard; the anon-key signup flow
  was not exercised for Farmer B (it was exercised and verified for Farmer A).

## 3. Auth verification

- Farmer A password sign-in verified via Supabase Auth REST (`/auth/v1/token?grant_type=password`)
  using the anon key only.
- Farmer B password sign-in verified the same way, using the anon key only.
- No tokens, passwords, or other secrets were printed or stored outside `.env.local`
  during any of these checks.

## 4. Farmer SELECT/RLS baseline (Farmer A, no associated farm)

Tables probed via authenticated REST `SELECT` (anon key + Farmer A's own access token):

- `farm_memberships`
- `farmer_review_requests`
- `farms`
- `inventory_batches`
- `market_price_benchmarks`
- `profiles`

Results:
- `farm_memberships`, `farmer_review_requests`, `farms`, `inventory_batches` returned
  **no rows** to the baseline Farmer A test user (expected, since this account had no
  associated farm/batch at the time).
- `market_price_benchmarks` returned the expected `visible_to_farmers = true` row(s).
- `profiles` returned exactly Farmer A's own profile row, no others.

## 5. Local RLS policy review (not live-verified)

Reviewed from local migration SQL files in the repository root
(`FARMER_MVP_MIGRATION.sql`, `RLS_ENABLE_STAGED.sql`):

- `market_price_benchmarks`: the `"market_price_benchmarks: farmer select visible"`
  policy allows any authenticated user to read rows where `visible_to_farmers = true`
  (no anonymous access). A separate `admin all` policy grants full access to
  `ddp_admin` accounts.
- `profiles`: the `"profiles: select own or admin"` policy allows a user to read a row
  only where `id = auth.uid()`, or unconditionally if `is_ddp_admin()` is true.

**Caveat:** this is a review of local migration files, not a live read of
`pg_policies` via the Supabase Dashboard or SQL editor. It is corroborated by, but not
a substitute for, direct confirmation that the deployed database matches these files.
**Update:** see Section 5A — this caveat has since been addressed by a live
`pg_policies` comparison, which surfaced and led to remediation of one real mismatch
(`inventory_batches` INSERT guardrails).

## 5A. Live pg_policies parity check

- **Source:** owner-exported Supabase SQL Editor `pg_policies` query result, provided
  as a local CSV (`tmp/live_pg_policies_snapshot.csv`, git-excluded via
  `.git/info/exclude`, never committed).
- **Date of check:** 2026-07-07.
- **Policy rows reviewed:** 21 (all rows present in the export).
- **Tables/schemas reviewed:** `public.farms`, `public.farm_memberships`,
  `public.inventory_batches`, `public.market_price_benchmarks`, `public.profiles`,
  `public.farmer_review_requests`, `storage.objects` (policies scoped to the
  `farmer-documents` bucket).
- **Fields compared per policy:** `schemaname`, `tablename`, `policyname`,
  `permissive`, `roles`, `cmd`, `qual`, `with_check`.
- **Local files compared against:** `RLS_ENABLE_STAGED.sql`, `AUTH_RLS_SCHEMA.sql`,
  `FARMER_MVP_MIGRATION.sql`, `INVENTORY_BATCHES_RLS_PATCH.sql`,
  `8_COA_UPLOAD_STORAGE_MIGRATION.sql`.

**Per-table classification:**

| Table | Policies (live) | Classification |
|---|---|---|
| `farms` | admin all, farmer insert own, farmer select own | MATCH |
| `farm_memberships` | admin all, farmer insert own, farmer select own | MATCH |
| `inventory_batches` | admin all, farmer select own, farmer insert own, farmer update own | MATCH (remediated — see below) |
| `market_price_benchmarks` | admin all, farmer select visible | MATCH |
| `profiles` | admin update role, select own or admin, update own no role change | MATCH |
| `farmer_review_requests` | admin all, farmer select own, farmer resolve own | MATCH |
| `storage.objects` (`farmer-documents`) | admin all, farmer read own, farmer upload own | MATCH |

**Original mismatch detail (now remediated) — `inventory_batches: farmer insert own`:**
- Live `with_check`: `((created_by = auth.uid()) OR has_farm_membership(farm_id))` — only
  an ownership check.
- `INVENTORY_BATCHES_RLS_PATCH.sql` (the file that documents itself as "the record of a
  manual production hotfix," intended to be authoritative) specifies a stricter
  `WITH CHECK` that additionally requires `client_visible = false`, `status NOT IN
  ('Approved')`, and `stock_status IS NULL OR stock_status IN ('draft', 'submitted',
  'needs_changes')`.
- The live database does **not** enforce these three additional guardrail conditions on
  INSERT, even though the local patch file states they were applied. In practice this
  means a farmer's own INSERT into `inventory_batches` is not currently blocked at the
  database level from setting `client_visible = true`, `status = 'Approved'`, or an
  admin-only `stock_status` directly at creation time — only the corresponding `farmer
  update own` policy (Section F of `FARMER_MVP_MIGRATION.sql`) enforces those guardrails,
  and that policy's live `with_check` **does** match its local definition exactly.
- All other `inventory_batches` policies (`admin all`, `farmer select own`, `farmer
  update own`) match their local definitions exactly.

**Remediation (2026-07-07):**
- A new migration file, `INVENTORY_BATCHES_INSERT_GUARDRAIL_FIX.sql`, was prepared to
  reapply `"inventory_batches: farmer insert own"` with the full guardrail `WITH CHECK`
  from `INVENTORY_BATCHES_RLS_PATCH.sql`. Before creating it, the app's insert path
  (`src/lib/db.ts`, `src/pages/farmer/FarmerSubmitInventory.tsx`, `src/data.ts`) was
  reviewed to confirm `status` is always explicitly set to `'Pending Review'` (never
  null, never `'Approved'`) on every real insert path, so the stricter `status NOT IN
  ('Approved')` clause would not reject legitimate farmer submissions.
- The owner manually applied this file via Supabase SQL Editor.
- A fresh owner-run `pg_policies` verification query confirmed all four guardrail
  conditions are now live on `"inventory_batches: farmer insert own"`:
  - `created_by = auth.uid()` guard: confirmed present
  - `has_farm_membership(farm_id)` guard: confirmed present
  - `client_visible = false` guard: confirmed present
  - `status NOT IN ('Approved')` guard: confirmed present
  - `stock_status` restricted to `draft`/`submitted`/`needs_changes`/`NULL`: confirmed present
- **Status updated: MISMATCH → MATCH.** `inventory_batches` now shows full live/local
  parity across all four of its policies (`admin all`, `farmer select own`, `farmer
  insert own`, `farmer update own`).
- This remediation was initially verified via a fresh `pg_policies` re-check
  (owner-provided), not by this document's authors independently querying Supabase.

**Functional verification completed (2026-07-08):**
- A live, write-enabled test attempted three separate farmer-authenticated INSERTs
  against `inventory_batches`, using the retained Farmer A test identity
  (`farmertest@ddpbrokerage.com`), anon key + Farmer A's own access token only (no
  service-role key, no admin API). Each payload was an otherwise-valid insert
  (`created_by = auth.uid()`, `product_name = "[TEST] ddp_insert_guardrail_check"`)
  differing from a normal valid submission by exactly one deliberately disallowed field:
  - Attempt 1 — `client_visible = true`: **HTTP 403, Postgres error code `42501`
    (row-level security policy violation)**. Follow-up `SELECT id` (same marker):
    no rows visible.
  - Attempt 2 — `status = 'Approved'`: **HTTP 403, Postgres error code `42501`**.
    Follow-up `SELECT id`: no rows visible.
  - Attempt 3 — `stock_status = 'approved_internal'`: **HTTP 403, Postgres error
    code `42501`**. Follow-up `SELECT id`: no rows visible.
  - Database writes attempted: 3. Database writes succeeded: 0. No cleanup required.
- All three rejections carried Postgres error code `42501`, confirming they were
  genuine RLS/policy violations — not generic constraint, schema, or payload
  failures, which would have been classified as inconclusive rather than a pass.
- **Both metadata verification (`pg_policies`) and live functional rejection testing
  now confirm the `inventory_batches` INSERT guardrail remediation.** The previous
  caveat that this functional check was outstanding no longer applies.

**Live confirmation of the DELETE-policy gap:** the live export confirms there is no
`cmd: DELETE` (farmer-scoped) policy on `farms`, `farm_memberships`, or
`inventory_batches` — only `ALL` (admin-only, via `is_ddp_admin()`), `SELECT`, `INSERT`,
and (for `inventory_batches` only) `UPDATE`. This directly explains the Section 8
cleanup result, where farmer-authenticated `DELETE` REST calls returned HTTP 204 but
did not remove the target rows: PostgREST accepted the request, but RLS matched zero
rows because no farmer-level DELETE policy exists, and `Prefer: return=minimal`
suppressed any indication that zero rows were affected.

**Caveats (unchanged in kind):**
- This confirms live/local parity for all 7 reviewed tables/schemas, including
  `inventory_batches` after remediation of its original INSERT guardrail mismatch —
  it does not prove every policy on every table in the schema is correct, and it
  does not prove no other undiscovered mismatches exist on the reviewed tables'
  other policies or on unreviewed tables.
- This is not a full security audit.
- This is not penetration testing.
- This does not test every table in the schema (only the 7 listed above; see
  Section 5B for the remaining tables).
- This does not test buyer or admin workflows.
- This does not test storage isolation with real uploaded files.
- This does not test `UPDATE`/`DELETE` cross-farmer isolation (only confirms the
  absence of farmer-level `DELETE` policies; it does not test `UPDATE` isolation
  behavior between two different farmers).

## 5B. Extended live pg_policies parity check (remaining tables)

- **Source:** owner-exported Supabase SQL Editor query result (one row per table,
  `rowsecurity` flag plus a nested JSON array of that table's policies), provided as
  a local CSV (`tmp/live_pg_policies_snapshot_full.csv`, git-excluded via
  `.git/info/exclude`, never committed).
- **Date of check:** 2026-07-08.
- **Scope of this export:** every table in the `public` and `storage` schemas (28
  table rows total), not limited to tables with already-known policies — this
  closes the gap from Section 5A, which only queried a pre-selected table list.

**Live table inventory vs. local migration files:**
- **Public schema:** 20 live tables, 20 tables discoverable across local `*.sql`
  files, identical names on both sides. No table exists live without a
  corresponding local definition, and no locally-defined table is missing live.
- **Storage schema:** 8 live tables — `objects` (app-relevant, reviewed below) plus
  7 Supabase Storage extension internals (`buckets`, `buckets_analytics`,
  `buckets_vectors`, `migrations`, `s3_multipart_uploads`,
  `s3_multipart_uploads_parts`, `vector_indexes`). These 7 are not defined in any
  local DDP migration file — they are managed by the Supabase Storage extension
  itself, not application schema, so their absence from local files is expected,
  not a finding.

**`rowsecurity` findings:**
- Tables with `rowsecurity = false`: **none**. All 28 table rows in the export show
  `rowsecurity = true`.
- Tables with `rowsecurity = true` and zero policies: the 7 Storage-extension
  internal tables listed above only. This is Supabase's own default deny-all
  posture for its internal Storage tables (not application-configured), consistent
  with them having no admin/farmer policies defined anywhere locally either. No
  application-schema table (`public.*` or `storage.objects`) was found with
  `rowsecurity = true` and zero policies.

**Per-table classification (14 previously-unreviewed public tables):**

| Table | Live policies | Classification |
|---|---|---|
| `compliance_alerts` | admin all | MATCH |
| `compliance_audit_log` | admin insert, admin select | MATCH |
| `compliance_entity_status` | admin all | MATCH |
| `compliance_reviews` | admin all | MATCH |
| `compliance_rules` | admin all | MATCH |
| `ddp_scores` | admin all, farmer select own farm | MATCH |
| `documents` | admin all, farmer select own | MATCH |
| `farm_profiles` | admin all, farmer insert own, farmer select own | MATCH |
| `farmer_documents` | admin all, farmer select own, farmer insert own | MATCH (see vestigial-schema note below) |
| `farmer_photos` | admin all, farmer select own, farmer insert own | MATCH (see vestigial-schema note below) |
| `legal_updates` | admin all | MATCH |
| `regulatory_sources` | admin all | MATCH |
| `risk_flags` | admin all, farmer select own farm | MATCH |
| `status_history` | admin all, farmer select own | MATCH |

All 14 tables compared exactly against their local `CREATE POLICY` definitions
(`4_RLS_ENABLE_REMAINING_TABLES.sql` for `ddp_scores`/`risk_flags`/`status_history`/
`documents`; `RLS_ENABLE_STAGED.sql` for `farm_profiles`; `FARMER_MVP_MIGRATION.sql`
Sections I/J for `farmer_documents`/`farmer_photos`; `9_COMPLIANCE_WATCHTOWER_MVP.sql`
for the 7 compliance/legal/regulatory tables) — no mismatches, no extra live
policies, no missing local policies found in this pass.

The Compliance Watchtower tables (`compliance_alerts`, `compliance_audit_log`,
`compliance_entity_status`, `compliance_reviews`, `compliance_rules`,
`legal_updates`, `regulatory_sources`) are all admin-only (`is_ddp_admin()`), with
no farmer or anonymous access path of any kind — consistent with this being an
admin-facing feature.

**`storage.objects` re-check:** still exactly 3 policies, all scoped to
`bucket_id = 'farmer-documents'` (`admin all`, `farmer read own`, `farmer upload
own`), matching `8_COA_UPLOAD_STORAGE_MIGRATION.sql` exactly. **No policies exist
for any other bucket** — confirming the earlier scope assumption (only
`farmer-documents` reviewed) was not hiding an unreviewed bucket; there simply
isn't one with any policies.

**`farmer_documents` / `farmer_photos` — REVIEW REQUIRED (possible vestigial
schema, not a security finding):**
- Both tables exist live with fully correct, locally-matching RLS policies
  (admin-all, farmer-select-own, farmer-insert-own, each properly scoped via
  `has_farm_membership`/`created_by = auth.uid()`).
- However, a repo-wide search of `src/**/*.ts` and `src/**/*.tsx` found **zero**
  references to either table (no `.from('farmer_documents')` or
  `.from('farmer_photos')` anywhere in application code).
- The app's actual document-upload path uses Supabase **Storage** (the
  `farmer-documents` bucket via `supabase.storage.from(...)` in `src/lib/db.ts`),
  not these two database tables.
- This is classified as REVIEW REQUIRED rather than a pass/fail security
  classification: the policies themselves are correct and safe as written, but the
  tables appear to be unused/superseded schema from an earlier design iteration.
  This is a schema-hygiene question for the app owner, not an access-control gap —
  there is no evidence of a security failure here, only unused-but-correctly-locked
  schema.

**Caveats (in addition to Section 5A's, unchanged in kind):**
- This extended check covers every currently-discoverable `public`/`storage` table
  as of 2026-07-08 — it does not prove every policy's `qual`/`with_check` logic is
  behaviorally correct (only that live matches local text), and it does not
  functionally test any of these 14 tables the way `inventory_batches` was
  functionally tested in Section 5A (no live INSERT/SELECT/UPDATE rejection tests
  were run against these tables).
- This is not a full security audit.
- This is not penetration testing.
- This does not prove every access path in the application is correct.
- This does not test buyer-role or admin-role workflows functionally (only their
  policy definitions were compared).
- This does not test every possible mutation path (INSERT was reviewed for
  `farm_profiles`/`farmer_documents`/`farmer_photos`; UPDATE/DELETE were not
  separately enumerated for every table beyond noting `ALL` covers them for admin).

## 6. Storage read-only probe

Bucket: `farmer-documents`

Results (Farmer A, authenticated, anon key only):
- Could not list any visible objects at the bucket root.
- Could not list any visible objects under Farmer A's own `{userId}/` prefix
  (path pattern discovered from `src/lib/db.ts`, not invented).
- No downloads were performed.
- No signed URLs were created.
- No uploads were performed.
- No storage writes occurred.

**Caveat:** this account had no uploaded documents. Storage isolation with real
uploaded Farmer A/Farmer B documents was **not tested** at the time — see Section 6A.

## 6A. Storage isolation — farmer-documents bucket (2026-07-08)

This section closes the caveat from Section 6 by testing storage isolation with
real uploaded objects, one per farmer, using each farmer's own authenticated
session (anon key + Farmer A's/Farmer B's own access token). It verifies isolation
for the specific object paths tested under real anon-key farmer sessions — it does
not prove storage policies are universally correct for every possible path, file
type, or access pattern.

**Setup note — initial attempt (INCOMPLETE):**
- Farmer A sign-in: success (HTTP 200). Farmer B sign-in: success (HTTP 200).
- Farmer A's upload attempt (marker file, `text/plain` content type) failed before
  any storage object was created: `invalid_mime_type`, HTTP statusCode `415`,
  "mime type text/plain is not supported."
- No storage writes succeeded, so no cleanup was required. No repo files,
  database rows, or Auth state changed. No service-role key was used.
- Classified INCOMPLETE rather than a policy result: this was a **bucket-level
  MIME-type allowlist rejection**, not RLS/policy-driven behavior, so it could not
  be attributed to storage access control one way or the other.

**Retry — `application/pdf` placeholder (PASS):**
- Bucket: `farmer-documents`. Filename: `ddp-storage-isolation-check.pdf`.
  Content type: `application/pdf`. Content: a tiny synthetic placeholder PDF
  (marker text: "DDP TEST -- storage isolation check -- not a real document"),
  built in memory only — never written to the repo.
- Object paths, following the app's own upload convention
  (`{userId}/{farmId}/{batchId}/...` from `src/lib/db.ts`) with placeholder
  farm/batch segments:
  - `{FarmerA_uid}/test-isolation/test-isolation/ddp-storage-isolation-check.pdf`
  - `{FarmerB_uid}/test-isolation/test-isolation/ddp-storage-isolation-check.pdf`
- Farmer A signed in and uploaded successfully to Farmer A's own path.
  Farmer B signed in and uploaded successfully to Farmer B's own path.
- Farmer A: own prefix listed as visible, own object downloadable.
- Farmer B: own prefix listed as visible, own object downloadable.
- Farmer A attempting to list or download Farmer B's object: **not visible, not
  downloadable.**
- Farmer B attempting to list or download Farmer A's object: **not visible, not
  downloadable.**
- No service-role key used. No admin API used. No database rows written. No Auth
  users created or modified. No repo files changed during the test. No secrets,
  tokens, passwords, or object contents were printed at any point.
- **Result: PASS** — for the two tested object paths, each farmer could access
  only their own uploaded object; cross-farmer access was blocked in both
  directions.

**Manual cleanup:**
- The owner manually deleted both synthetic PDF objects via Supabase Dashboard →
  Storage → `farmer-documents`. This deletion was performed by the owner directly
  in the Dashboard, not by an automated process — farmers have no delete policy on
  this bucket (only `admin all`, `farmer read own`, `farmer upload own`, per
  Section 5A/5B), so farmer-token deletion was never attempted, and no
  service-role-based cleanup was performed.

**Cleanup verification (read-only):**
- Branch `main`, local HEAD and origin/main HEAD both `df3219e`, working tree
  clean, `.env.local` present/gitignored/untracked.
- Farmer A sign-in: success (HTTP 200). Farmer B sign-in: success (HTTP 200).
- Farmer A's deleted object: not visible (HTTP 200, empty list result), not
  downloadable (HTTP 400).
- Farmer B's deleted object: not visible (HTTP 200, empty list result), not
  downloadable (HTTP 400).
- No files changed, no storage writes (read-only checks only), no database/Auth
  writes, no service-role key used, no secrets/tokens/passwords/object contents
  printed.
- **Cleanup verified:** both test objects are confirmed fully removed from the
  bucket.

**Caveats:**
- This is not a full security audit and not penetration testing.
- This does not prove `farmer-documents` storage policies are correct for every
  possible object path, file type, or access pattern — only the two specific
  paths tested under two real, anon-key-authenticated farmer sessions.
- This does not test admin or buyer access to this bucket, nor storage policies
  for any bucket other than `farmer-documents`.

## 6B. inventory_batches UPDATE guardrail — functional rejection test (2026-07-08)

This test verifies only the tested own-row `UPDATE` guardrail behavior for Farmer
A's anon-auth session against the `"inventory_batches: farmer update own"` policy.
It does not prove all `UPDATE` policies are correct, does not test cross-farmer
`UPDATE` isolation, does not test `DELETE` policy behavior, does not test
admin-role behavior, and does not claim inventory security is complete overall.

**Scope:** table `inventory_batches`, policy `"inventory_batches: farmer update
own"`, identity Farmer A only, own-row guardrail only. No cross-farmer `UPDATE`,
no `DELETE` test, no admin-role test, no storage test, and no service-role key
were used at any point.

**Setup nuance:** the policy's `USING` clause requires the pre-update row to
already have `stock_status` in `('draft', 'submitted', 'needs_changes')` — a row
with `stock_status = NULL` or an admin-only value is not eligible for farmer
`UPDATE` at all under this clause. The setup row explicitly used `stock_status =
'draft'` so it was genuinely `UPDATE`-eligible, avoiding a false result where the
row simply wasn't updateable in the first place.

**Live execution result:**
- Farmer A signed in successfully (anon key only).
- One synthetic setup row was inserted into `inventory_batches`
  (`created_by` = Farmer A's own `auth.uid()`, `product_name` marker `[TEST]
  ddp_update_guardrail_check`, `status = 'Pending Review'`, `client_visible =
  false`, `stock_status = 'draft'`).
- A baseline allowed `UPDATE` (setting the farmer-facing `farmer_notes` field)
  succeeded and was confirmed persisted — proving the row was genuinely
  updateable by Farmer A before testing the guardrail fields specifically.
- Three rejected `UPDATE` attempts were made, each isolated to one guardrail
  field:
  - `client_visible = true` — rejected (HTTP 403, Postgres error code `42501`);
    follow-up check confirmed the value did not persist.
  - `status = 'Approved'` — rejected (HTTP 403, Postgres error code `42501`);
    follow-up check confirmed the value did not persist.
  - `stock_status = 'approved_internal'` — rejected (HTTP 403, Postgres error
    code `42501`); follow-up check confirmed the value did not persist.
- No disallowed value was persisted in any case. No files changed, no storage
  operations occurred, no Auth writes occurred, and no service-role key was used.
- **Result: PASS** — for this tested row and session, the farmer could perform
  an allowed update but could not use `UPDATE` to self-approve
  (`status = 'Approved'`), self-publish (`client_visible = true`), or advance to
  an admin-only stock lifecycle state (`stock_status = 'approved_internal'`).

**Manual cleanup:** the owner manually deleted the synthetic setup row via
Supabase Dashboard → Table Editor → `inventory_batches`. This deletion was
performed by the owner directly, not by farmer-token `DELETE` (no such policy
exists on this table) and not via service-role key.

**Cleanup verification (read-only):** Farmer A signed in again and queried for
the setup row by id (`select=id` only, no row contents). The row was confirmed
no longer visible (0 rows returned). Row id, retained here only as the cleanup
verification identifier consistent with this log's existing style:
`6530387a-1b4e-4dd1-8074-1b44ea0362ee`.

**Caveats:**
- This is not a full security audit and not penetration testing.
- This does not prove every `UPDATE` policy on every table is correct — only
  the one policy, one table, one field set, and one farmer session tested here.
- This does not test cross-farmer `UPDATE` isolation (a different farmer
  attempting to `UPDATE` this row) — that remains a separate, untested case.
- This does not test `DELETE` policy behavior beyond what was already noted in
  Section 8, nor admin-role `UPDATE` behavior.
- This does not claim overall inventory security is complete.

## 6C. inventory_batches cross-farmer UPDATE isolation — functional test (2026-07-08)

This test verifies only tested cross-farmer `UPDATE` isolation for
`inventory_batches`, using the two retained farmer fixtures (Farmer A and
Farmer B) and the `farmer_notes` field only. It does not claim all `UPDATE`
policies are proven, does not claim all fields are covered, does not claim
`DELETE` policy behavior is proven, does not claim admin-role or buyer-role
behavior is proven, and does not claim overall inventory security is complete.

**Scope:** table `inventory_batches`, policy `"inventory_batches: farmer
update own"`, both farmer identities, one synthetic row per farmer, own-row
baseline `UPDATE` for each farmer, then cross-farmer `UPDATE` attempts in both
directions, field tested: `farmer_notes` only (no guardrail-field cross-farmer
test — that is a separate, more complex case not covered here). No `DELETE`
test, no admin-role test, no storage test, and no service-role key were used.

**Policy/behavior nuance:** both setup rows explicitly used `stock_status =
'draft'` (same nuance as Section 6B) so each owner could genuinely update
their own row. Cross-farmer `UPDATE` is a `USING`-clause failure (the row
simply isn't matched by the acting farmer's ownership condition), which is a
different failure mode from the `WITH CHECK` failures seen in Section 6B —
it can present as HTTP 200 with zero rows affected, rather than an explicit
HTTP 403. This was the actual observed result: both cross-farmer attempts
returned HTTP 200 with an empty response body (0 rows), not 403. The
deciding evidence was target-owner verification that no attacker-supplied
value persisted on the target row — HTTP status alone was not treated as
sufficient.

**Live execution result:**
- Farmer A and Farmer B both signed in successfully (anon key only).
- One synthetic setup row was inserted per farmer (`created_by` = the
  respective farmer's own `auth.uid()`, distinct `[TEST]
  ddp_cross_update_isolation_A` / `_B` product-name markers, `status =
  'Pending Review'`, `client_visible = false`, `stock_status = 'draft'`).
- Each farmer's own-row baseline `UPDATE` (setting `farmer_notes`) succeeded
  and was confirmed persisted — proving each row was genuinely updateable by
  its owner before testing cross-farmer isolation.
- Farmer A attempted to `UPDATE` Farmer B's row's `farmer_notes`: HTTP 200,
  zero rows in the response body. Farmer B's own verification confirmed the
  row's `farmer_notes` remained at Farmer B's baseline value — the attacker's
  value did not persist.
- Farmer B attempted to `UPDATE` Farmer A's row's `farmer_notes`: HTTP 200,
  zero rows in the response body. Farmer A's own verification confirmed the
  row's `farmer_notes` remained at Farmer A's baseline value — the attacker's
  value did not persist.
- No files changed, no storage operations occurred, no Auth writes occurred,
  and no service-role key was used at any point.
- **Result: PASS** — for the tested rows, sessions, and field, each farmer
  could update only their own row; cross-farmer `UPDATE` attempts affected
  zero rows and did not modify the target farmer's data.

**Manual cleanup:** the owner manually deleted both synthetic setup rows via
Supabase Dashboard → Table Editor → `inventory_batches`. This deletion was
performed by the owner directly, not by farmer-token `DELETE` (no such policy
exists on this table) and not via service-role key.

**Cleanup verification (read-only):** both farmers signed in again and
queried for their respective setup row by id (`select=id` only, no row
contents). Both rows were confirmed no longer visible (0 rows returned for
each). Row ids, retained here only as cleanup verification identifiers
consistent with this log's existing style: `382cf56c-e84f-499d-bfce-2fe878f57dbc`
(Farmer A's row), `db9b6c8b-2206-47d4-8ec7-6719f85bdcdd` (Farmer B's row).

**Caveats:**
- This is not a full security audit and not penetration testing.
- This does not prove every `UPDATE` policy on every table is correct — only
  the one policy, one table, one field, and two farmer sessions tested here.
- This does not test cross-farmer `UPDATE` isolation with guardrail-field
  combinations (e.g. an attacker also attempting to set a disallowed
  guardrail value while targeting another farmer's row).
- This does not test `DELETE` policy behavior, admin-role behavior, or
  buyer-role behavior.
- This does not claim overall inventory security is complete.

## 7. Cross-farmer SELECT isolation

Test marker used on all synthetic rows: `[TEST] ddp_cross_farmer_isolation`

Test rows created for this cycle (since deleted — see Section 8):

**Farmer A:**
- farm: `8b0cf68b-e9c0-461b-afe6-2b4030cf6cfd`
- farm_membership: `2f759d84-f7fd-4877-860a-08485cbb1224`
- inventory_batch: `cad33483-9b1b-482b-a08a-b553c24c83d1`

**Farmer B:**
- farm: `83c3145b-c0c0-41a8-b6e0-e71706b4dde6`
- farm_membership: `5c2dd4d1-f3ba-4235-8248-36719822fc6e`
- inventory_batch: `0a7a23e2-a057-49d5-b81f-25e946a2b470`

Results (`select=id` probes only, row contents never printed):
- Farmer A could read Farmer A's own farm, membership, inventory batch, and profile.
- Farmer A could **not** read Farmer B's farm, membership, inventory batch, or profile.
- Farmer B could read Farmer B's own farm, membership, inventory batch, and profile.
- Farmer B could **not** read Farmer A's farm, membership, inventory batch, or profile.
- Both farmers could read the same `visible_to_farmers = true` `market_price_benchmarks`
  rows (expected shared, non-owner-scoped data).

**Safe conclusion:** PASS — cross-farmer SELECT isolation passed for the tested rows only.

## 8. Cleanup

- Farmer-level `DELETE` REST calls against the six test rows returned HTTP 204
  (no error), but **did not actually delete the rows**.
- Cause: local migration files define no farmer-level `DELETE` policy for `farms`,
  `farm_memberships`, or `inventory_batches` — only `admin all`, `farmer select own`,
  and `farmer insert own`. PostgREST + RLS silently matched zero rows on delete and
  returned an empty success response, masking the failure.
- This is consistent with farmers being able to insert and select their own rows in
  these tables, but not delete them, under the current policy set.
- The owner manually deleted the six test rows through the Supabase Dashboard.
- A read-only post-cleanup check confirmed all six row IDs were no longer visible to
  either farmer.
- Farmer A and Farmer B Auth users were retained (not deleted) as standing test fixtures.

## 8A. Farmer-token DELETE rejection — functional test (2026-07-08)

This test verifies only deliberate farmer-token `DELETE` rejection for
`inventory_batches`, using the retained Farmer A fixture. It does not claim
`DELETE` behavior is proven for `farms` or `farm_memberships`, does not claim
admin-role `DELETE` behavior is tested, does not claim buyer-role behavior is
tested, does not claim all `DELETE` policies are proven, and does not claim
overall security is complete. This test formalizes, by deliberate design, the
same mechanism first incidentally observed during Phase 5 cleanup (Section 8).

**Scope:** table `inventory_batches` only, identity Farmer A only, one
synthetic row owned by Farmer A. A pre-`DELETE` `SELECT` proved the row was
visible, a farmer-token `DELETE` attempt was made against that row, and a
post-`DELETE` `SELECT` proved the row remained. No `farms` `DELETE` test, no
`farm_memberships` `DELETE` test, no admin-role `DELETE` test, no buyer-role
test, no storage test, and no service-role key were used.

**Policy finding:** no farmer-scoped `DELETE` policy exists for
`inventory_batches` — only `admin all` (`is_ddp_admin()`) covers `DELETE`, for
admin sessions only. Unlike `INSERT`/`UPDATE`, `DELETE` policies have no `WITH
CHECK` clause, so classification for this test was based on row persistence
evidence, not HTTP status alone. Either an explicit HTTP 403 / Postgres 42501
rejection, or an HTTP 200/204 response with zero rows deleted, were both
treated as safe outcomes, provided the row was confirmed to still exist
afterward.

**Live execution result:**
- Farmer A signed in successfully (anon key only).
- One synthetic setup row was inserted into `inventory_batches` (`created_by`
  = Farmer A's own `auth.uid()`, `product_name` marker `[TEST]
  ddp_delete_rejection_check`, `status = 'Pending Review'`, `client_visible =
  false`, `stock_status = 'draft'`).
- A pre-`DELETE` `SELECT` confirmed the row was visible to Farmer A (HTTP 200,
  1 row returned).
- Farmer A's own token attempted to `DELETE` the row: **HTTP 200, with an
  empty response body (0 rows deleted)** — this was the actual observed
  behavior, not an explicit 403.
- A post-`DELETE` `SELECT` confirmed the row still existed (HTTP 200, 1 row
  returned) — this was the deciding evidence that the `DELETE` attempt had no
  effect.
- No files changed, no storage operations occurred, no Auth writes occurred,
  and no service-role key was used at any point.
- **Result: PASS** — for this tested row and session, a farmer's own token
  could not delete a row the farmer owned and could see, even though no
  explicit error was returned; the row was confirmed present both before and
  after the attempt.

**Manual cleanup:** the owner manually deleted the synthetic setup row via
Supabase Dashboard → Table Editor → `inventory_batches`. This deletion was
performed by the owner directly, not by farmer-token `DELETE` (the capability
this test confirmed is absent) and not via service-role key. The first two
read-only cleanup verification attempts found the row still visible, so
cleanup was initially incomplete; a third verification, after the owner
re-confirmed the deletion in the Dashboard, found the row gone.

**Cleanup verification (read-only):** Farmer A signed in again and queried
for the setup row by id (`select=id` only, no row contents). The row was
confirmed no longer visible (0 rows returned) on the final check. Row id,
retained here only as the cleanup verification identifier consistent with
this log's existing style: `71feb43a-bc09-4f00-9fa5-6eb915fd9f28`.

**Caveats:**
- This is not a full security audit and not penetration testing.
- This does not prove `DELETE` behavior for `farms` or `farm_memberships` —
  those tables share the identical "no farmer DELETE policy" structure
  (confirmed in Sections 5A/5B/8) but were not deliberately re-tested here.
- This does not test admin-role `DELETE` behavior, nor buyer-role behavior.
- This does not claim all `DELETE` policies are proven, or that overall
  security is complete.

## 8B. Admin-role Tier 1 read access — functional test (2026-07-08)

This test verifies only Tier 1 read-only admin functional access for
`profiles`, `farms`, `farm_memberships`, and `inventory_batches`, using a
retained admin test fixture over normal anon-key Supabase Auth. It does not
test service-role access, does not test Supabase Dashboard/Postgres-role
access as a stand-in for app-level admin access, does not test admin
INSERT/UPDATE/DELETE, does not test every table or every field, does not
test buyer-role behavior, does not prove all admin policies are correct, and
does not claim overall security is complete.

**Fixture verification (prerequisite, performed separately before this
sweep):** a retained admin test fixture
(`ddp.test.admin.20260708@ddpbrokerage.com`) was created, with credentials
stored only in `.env.local` (confirmed existing, gitignored, and untracked).
Admin sign-in succeeded via anon key only, and a query of the signed-in
user's own `profiles` row confirmed `role = ddp_admin`. No service-role key
was used and no Auth writes occurred during this verification.

**Scope:** identity — the verified admin fixture only. Auth method — anon
key + admin email/password only, no service-role key, no admin API. Tables —
`profiles`, `farms`, `farm_memberships`, `inventory_batches` only
("Tier 1", the four tables already most thoroughly tested from the farmer
side earlier in this thread). Read-only count-only checks only; no writes,
no cleanup required.

**Live execution result:**
- Admin sign-in: success (HTTP 200).
- Admin role self-check (own profile, `role` field only): HTTP 200, role
  confirmed `ddp_admin`.
- Table access checks used `HEAD` requests with `Prefer: count=exact`
  (count-only, no row bodies returned). HTTP 206 (Partial Content) was the
  expected, correct response for this ranged/count query pattern — not
  treated as an error.
- `profiles`: HTTP 206, accessible, count = 9. This count being greater than
  1 is the key distinguishing evidence of genuine broad admin visibility,
  as opposed to the own-row-only access every farmer session has shown
  throughout this thread.
- `farms`: HTTP 206, accessible, count = 2.
- `farm_memberships`: HTTP 206, accessible, count = 2.
- `inventory_batches`: HTTP 206, accessible, count = 4.
- No row contents were printed for any table at any point — only HTTP
  status and counts.
- No files changed, no storage operations occurred, no database writes
  occurred, no Auth writes occurred, no service-role key was used, and no
  admin API was used.
- **Result: PASS** — the verified admin fixture could functionally read all
  four Tier 1 admin-visible RLS-protected tables using normal anon-key
  Supabase Auth, with unrestricted (non-owner-scoped) visibility consistent
  with each table's `admin all`-style policy.

**Cleanup:** none required — this was a read-only test; no rows were
created, updated, or deleted, and no storage objects or Auth state were
touched.

**Caveats:**
- This is not a full security audit and not penetration testing.
- This does not test service-role access, nor Supabase Dashboard/Postgres-role
  access as a stand-in for app-level admin access — those are different
  mechanisms from the `is_ddp_admin()`-gated anon-key path tested here.
- This does not test admin `INSERT`/`UPDATE`/`DELETE` functional behavior —
  read-only only.
- This does not test every table (only the four Tier 1 tables) or every
  field.
- This does not test buyer-role behavior (no such role exists in the schema).
- This does not prove all admin policies are correct, or that overall
  security is complete.

## 8C. Admin-role Tier 2 read access — functional test (2026-07-08)

This test extends the Tier 1 admin functional read access test (Section 8B)
to the remaining 16 admin-visible public tables, using the same retained
`ddp_admin` fixture over normal anon-key Supabase Auth. It does not test
admin `INSERT`/`UPDATE`/`DELETE`, does not test storage admin behavior, does
not test service-role access, does not test Supabase Dashboard/Postgres-role
access, does not test buyer-role behavior, does not prove every field is
covered, and does not claim overall security is complete.

**Scope:** identity — the same verified admin fixture from Section 8B, no
new fixture created. Auth method — anon key + admin email/password only, no
service-role key, no admin API. Tables — the 16 tables not covered by Tier 1:
`compliance_alerts`, `compliance_audit_log`, `compliance_entity_status`,
`compliance_reviews`, `compliance_rules`, `ddp_scores`, `documents`,
`farm_profiles`, `farmer_documents`, `farmer_photos`,
`farmer_review_requests`, `legal_updates`, `market_price_benchmarks`,
`regulatory_sources`, `risk_flags`, `status_history`. Read-only count-only
checks only; no writes, no cleanup required.

**Live execution result:**
- Admin sign-in: success (HTTP 200). Own-profile role self-check: HTTP 200,
  role confirmed `ddp_admin`.
- Table access checks used the same `HEAD` + `Prefer: count=exact` method as
  Tier 1 (count-only, no row bodies). HTTP 200 or 206 were both treated as
  successful, consistent with PostgREST's expected count/range behavior.
- All 16 tables returned a successful HTTP status confirming access:
  - Non-zero counts (8 tables): `compliance_alerts` (1),
    `compliance_audit_log` (5), `compliance_reviews` (2),
    `compliance_rules` (1), `farm_profiles` (2), `legal_updates` (2),
    `market_price_benchmarks` (5), `status_history` (7).
  - Accessible but empty (8 tables, count = 0, HTTP status still confirmed
    success — not treated as a failure): `compliance_entity_status`,
    `ddp_scores`, `documents`, `farmer_documents`, `farmer_photos`,
    `farmer_review_requests`, `regulatory_sources`, `risk_flags`.
- No row contents were printed for any table — only HTTP status and counts.
- No files changed, no storage operations occurred, no database writes
  occurred, no Auth writes occurred, no service-role key was used, and no
  admin API was used.
- **Result: PASS** — the verified admin fixture could functionally read all
  16 Tier 2 tables using normal anon-key Supabase Auth. Combined with
  Section 8B, this completes read-only admin functional access coverage
  across the 20 public non-storage tables tested in this thread.

**Cleanup:** none required — this was a read-only, count-only test; no
rows were created, updated, or deleted, and no storage objects or Auth
state were touched.

**Caveats:**
- This is not a full security audit and not penetration testing.
- This does not test admin `INSERT`/`UPDATE`/`DELETE` functional behavior —
  read-only only.
- This does not test storage admin behavior, service-role access, or
  Supabase Dashboard/Postgres-role access as a stand-in for app-level admin
  access.
- This does not test buyer-role behavior (no such role exists in the
  schema).
- This does not prove every field within each table is covered, that all
  admin policies are correct, or that overall security is complete.

## 9. What was not tested

- `INSERT` isolation beyond the controlled Phase 3 setup path (e.g., attempting to
  insert a row under another farmer's identity).
- `UPDATE` policies on tables other than `inventory_batches` (`profiles: update own
  no role change`, `farmer_review_requests: farmer resolve own` have only been
  metadata-compared, never functionally exercised). For `inventory_batches` itself,
  own-row guardrail rejection (Section 6B) and cross-farmer isolation (Section 6C)
  are tested for the `farmer_notes`/`client_visible`/`status`/`stock_status` fields
  only — other fields and guardrail-plus-cross-farmer combinations remain untested.
- `DELETE` policies for `farms` and `farm_memberships` — these share the identical
  "no farmer DELETE policy" structure confirmed for `inventory_batches` (Section
  8A), but were not deliberately re-tested. `DELETE` for `inventory_batches` itself
  has now been deliberately tested (Section 8A) for a single farmer's own row;
  admin-role `DELETE` behavior remains untested for all three tables.
- Storage isolation for object paths/patterns beyond the one tested in Section 6A,
  such as the real `{userId}/{farmId}/{batchId}/...` path with an actual farm/batch,
  or admin access to farmer documents.
- Live `pg_policies` parity for schema drift after 2026-07-08 is not covered unless
  new migrations/policies are reviewed.
- Buyer-role access model — not applicable at this time: `profiles.role` currently
  permits only `'ddp_admin'` and `'farmer'`; no buyer Auth role exists in the schema
  to test. If a buyer Auth role is introduced later, it must receive its own policy
  design and testing.
- Admin-role access model — read-only functional access across all 20
  public non-storage tables is now tested (Tier 1: Section 8B; Tier 2:
  Section 8C). Admin `INSERT`/`UPDATE`/`DELETE` functional behavior and
  admin storage access remain untested.
- Every table in the schema (only `farm_memberships`, `farmer_review_requests`,
  `farms`, `inventory_batches`, `market_price_benchmarks`, and `profiles` were probed).
- Penetration testing of any kind.

## 10. Recommended next tests

- Admin-role functional write test (`INSERT`/`UPDATE`/`DELETE`) — read-only
  access across all 20 public non-storage tables is now tested (Sections
  8B, 8C); write behavior remains untested and would need its own separate
  approved plan.
- Admin storage access (the `farmer-documents` bucket, and any others) —
  not yet tested from an admin session.
- If a buyer Auth role is introduced in the future, define and test its access
  policies before enabling buyer accounts; no buyer Auth role exists today.
- Optional: document or implement an admin-driven cleanup workflow for test data,
  since farmers cannot delete their own `farms`/`farm_memberships`/`inventory_batches`
  rows under the current policy set.

## 11. Operational notes

- Keep Farmer A (`farmertest@ddpbrokerage.com`) and Farmer B
  (`farmertest2@ddpbrokerage.com`) as retained regression-test fixtures.
- Never expose `.env.local` contents in logs, chat, commits, or documentation.
- Any future write-enabled test (data rows, Auth users, storage objects) requires
  explicit owner authorization before execution.
- Any use of the Supabase service-role key requires separate, explicit owner approval
  and is not covered by anything in this log.
