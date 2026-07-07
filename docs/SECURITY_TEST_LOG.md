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
- This remediation was verified via a fresh `pg_policies` re-check (owner-provided),
  not by this document's authors independently querying Supabase. It has not been
  re-tested with an actual attempted farmer INSERT carrying a disallowed value (e.g.
  `client_visible = true`) to confirm real-world rejection — that functional check
  remains a write-enabled test not yet performed (see Section 9).

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
- This does not test every table in the schema (only the 7 listed above).
- This does not test buyer or admin workflows.
- This does not test storage isolation with real uploaded files.
- This does not test `UPDATE`/`DELETE` cross-farmer isolation (only confirms the
  absence of farmer-level `DELETE` policies; it does not test `UPDATE` isolation
  behavior between two different farmers).

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
uploaded Farmer A/Farmer B documents was **not tested**.

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

## 9. What was not tested

- A functional re-test of the remediated `inventory_batches: farmer insert own` policy
  (Section 5A) — i.e., actually attempting a farmer INSERT with `client_visible = true`,
  `status = 'Approved'`, or an admin-only `stock_status` to confirm live rejection.
  Remediation was verified only via a fresh `pg_policies` metadata re-check, not a
  live write attempt.
- `INSERT` isolation beyond the controlled Phase 3 setup path (e.g., attempting to
  insert a row under another farmer's identity).
- `UPDATE` policies on any table.
- `DELETE` policies beyond the incidental discovery that farmers cannot delete these
  three tables' rows themselves.
- Storage/document isolation using real uploaded files between two farmers.
- Live parity check of deployed `pg_policies` against local migration files for tables
  beyond the 7 reviewed in Section 5A (e.g., `ddp_scores`, `risk_flags`,
  `status_history`, `documents`, `farm_profiles`).
- Buyer-role access model.
- Admin-role access model.
- Every table in the schema (only `farm_memberships`, `farmer_review_requests`,
  `farms`, `inventory_batches`, `market_price_benchmarks`, and `profiles` were probed).
- Penetration testing of any kind.

## 10. Recommended next tests

- Functionally verify the `inventory_batches: farmer insert own` remediation (Section
  5A) with an actual attempted farmer INSERT carrying a disallowed value, to confirm
  live rejection rather than relying on metadata parity alone. This is a write-enabled
  test requiring separate explicit authorization.
- Extend the live `pg_policies` parity check (Section 5A) to remaining tables not yet
  reviewed (`ddp_scores`, `risk_flags`, `status_history`, `documents`, `farm_profiles`).
- `UPDATE`-policy cross-farmer isolation test.
- Storage isolation test using one harmless placeholder document per farmer.
- Buyer-access model review before any buyer accounts are enabled.
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
