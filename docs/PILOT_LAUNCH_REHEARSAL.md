# Procurement-MVP Launch Rehearsal

Last updated: **2026-07-25**
Environment used for executed evidence: **staging `szqocdab…`**
`main` reference: `3c51627b58fc0b3890e06b33d74a43a86b3be091`

Two parts:

- **Part A — attack tests.** Several were **executed** against staging during
  this session; results are recorded below with the exact assertion that passed.
- **Part B — end-to-end functional rehearsal.** **Not executed.** The executable
  suite is blocked by credential drift (§B.0). Operator checklist provided.

---

## Part A — Attack tests

### A.1 Executed against staging

Evidence source: the behavioural `Section B` of each migration's VERIFY, run
under `psql -v ON_ERROR_STOP=1`. Each is a single `BEGIN … ROLLBACK` with no
`COMMIT`; every one asserted zero residue afterwards.

| # | Required attack test | Executed assertion | Result |
|---|---|---|---|
| 1 | **Pending farmer direct database access** | M22 `VERIFY F`: pending denied, farmer allowed, admin not treated as farmer. `VERIFY G`: farmer insert admitted; the *identical* pending insert denied by the restrictive overlay | **PASS** |
| 2 | **Farmer cross-farm access** | M19 `VERIFY B3`: farmer cannot modify a non-member farm (RLS row gate holds). M22 `VERIFY C`: all **11** tables carry a RESTRICTIVE `FOR ALL` operational-farmer policy gating on the helper in **both** `USING` and `WITH CHECK` | **PASS** |
| 3 | **Farmer admin-field mutation** | M19 `VERIFY B1`: farmer blocked on all **7** admin columns, allowed column still persisted. `VERIFY B5`: on INSERT, `created_by` forced to self and all 7 admin fields neutralised. `VERIFY B4`: guard function not directly executable by `authenticated` | **PASS** |
| 4 | **Admin forged `actor_id`** | Migration **27** installs the `BEFORE INSERT` trigger that overrides `actor_id` with `auth.uid()`. **Not applied in any environment** — PR #44 is open | **NOT COVERED** |
| 5 | **Buyer Pack without a valid procurement decision** | M23 `VERIFY B2` no decision blocks · `B3` current `hold` blocks · `B4` current `reject` blocks · `B5`/`B6` stale `progress` behind a newer `hold`/`reject` blocks · `B7` a decision for a *different* batch does not authorise this pack | **PASS** |
| 6 | **Buyer Pack with malformed approval evidence** | M23 `VERIFY B8/B9`: the decision trail rejects a blank reason and a null actor, so no such decision can authorise a pack. `B10`: client-supplied `progress` with server `hold` blocks — the client value is ignored entirely | **PASS** |
| 7 | **Unauthenticated provisioning** | Covered by unit tests only (`src/lib/serverFarmerProvisioning.test.ts`, part of the 1797 passing tests). **No runtime probe executed** against a hosted endpoint | **PARTIAL** |
| 8 | **Hosted app with missing Supabase config** | `scripts/validate-hosted-supabase-config.mjs` runs in `prebuild`. **No runtime probe executed** against a deployed instance with the variables removed | **PARTIAL** |

Supporting object-state evidence executed the same way:

- M19 `VERIFY A`: SECURITY DEFINER, fixed `search_path`, `is_ddp_admin`, all 7
  columns preserved, trigger fires on **INSERT and UPDATE**, not directly executable.
- M21 `VERIFY A/B/C`: a brand-new auth user is provisioned **pending**, the role
  `CHECK` still rejects invalid roles, admin-only role-change policies present.
- M22 `VERIFY A/B/D/D2/E`: helper is `SECURITY DEFINER STABLE` with pinned
  `search_path`, executable by `authenticated` but **not** `anon`; storage policy
  is restrictive, bucket-scoped, and guards reads **and** writes.
- M23 `VERIFY B13/B14/B15/B16/B17`: version increments; snapshot `UPDATE` and
  `DELETE` remain blocked; audit row written on valid issuance; no residue.
- `16_PRODUCTION_SAFETY_VERIFY.sql` → exit 0.

### A.2 Gaps in Part A

| Gap | Why it is open | To close |
|---|---|---|
| #4 forged `actor_id` | migration 27 unapplied anywhere | merge PR #44, apply 27 to staging, run `27_..._VERIFY.sql` (its Section B impersonates an admin via request JWT and asserts the stored actor is the authenticated caller, not the forged value) |
| #7 unauthenticated provisioning | no hosted probe run | `curl -X POST <deployment>/api/admin/provision-farmer` with (a) no bearer token, (b) a *farmer's* token. Expect non-2xx and **no** profile row created |
| #8 missing hosted config | no hosted probe run | deploy a preview with `VITE_SUPABASE_URL` unset; assert the app fails closed rather than rendering an unauthenticated shell |
| **All of Part A in production** | production migration state for 19–23 is `unknown` | complete `MIGRATION_RUNTIME_REGISTER.md` §5.3 first |

> Part A evidence is **staging only**. It does not transfer to production: the
> register shows the two environments have diverged (production has 25/26,
> staging does not).

---

## Part B — End-to-end functional rehearsal

### B.0 Blocker: staging test-credential drift

`npm run security:staging` **refuses to start**:

```
REFUSED / ERROR: could not sign in farmer A (check staging test-user creds)
```

Cause, measured directly:

| `.env.staging.local` expects | Exists in staging `auth.users`? |
|---|---|
| `ddp.staging.admin@ddpbrokerage.com` | **no** |
| `ddp.staging.farmer.a@ddpbrokerage.com` | **no** |
| `ddp.staging.farmer.b@ddpbrokerage.com` | **no** |
| `ddp-pending-probe-4b46595a@ddpbrokerage.com` | **no** |

The staging project actually contains four **different** accounts
(`caoticowvm@…` `ddp_admin`, `anfearathas@…` `farmer`, `dylusional88@…`
`farmer`, `pending@ddpbrokerage.com` `pending`). All four authenticate-tested
above return `400 Invalid login credentials`.

**Not remediated here.** Creating or re-pointing staging accounts is a write to
a hosted environment and a controlled provisioning operation — it is the
operator's call, not an audit action.

**To unblock:** either provision the four named accounts via the controlled
provisioning endpoint and set their passwords, **or** update
`.env.staging.local` to the four accounts that already exist and supply their
passwords. Then re-run `npm run security:staging`.

### B.1 Operator checklist — Farmer flow

Disposable records only. Prefix every record with `REHEARSAL-<date>-`.

| # | Step | Pass criterion |
|---|---|---|
| F1 | DDP admin invites farmer via `api/admin/provision-farmer` | 2xx; `profiles` row created with role **`pending`**, never `farmer` |
| F2 | Farmer accepts invite and logs in | session issued |
| F3 | Farmer attempts to use the app while still `pending` | **denied and signed back out**; no operational table readable |
| F4 | Admin promotes `pending` → `farmer` | only via `profiles: admin update role`; farmer cannot self-promote |
| F5 | Farmer completes onboarding | record persists, scoped to own farm |
| F6 | Farmer creates farm profile | `created_by` is forced to self (M19 B5) |
| F7 | Farmer adds inventory batch | visible to that farmer and to DDP only |
| F8 | Farmer uploads COA | lands in `farmer-documents` (private bucket); readable by owner + admin only |
| F9 | Farmer submits for review | status transitions recorded in `status_history` |

### B.2 Operator checklist — DDP flow

| # | Step | Pass criterion |
|---|---|---|
| D1 | Farm appears in DDP queue | visible to `ddp_admin` only |
| D2 | Review the submission | reviewer identity recorded from session, not client input |
| D3 | Raise a document request | **requires migration 24** — not applied in either environment. **Blocked.** |
| D4 | Resolve the request | **requires migration 24. Blocked.** |
| D5 | Approve inventory | admin-controlled columns settable by admin only (M19 B2/B6) |
| D6 | Risk / compliance review | writes an entry to `compliance_audit_log`; row is append-only (M9 triggers confirmed present) |

### B.3 Operator checklist — Buyer Pack

| # | Step | Pass criterion |
|---|---|---|
| P1 | Record a procurement decision | `decision`, `decided_by`, non-blank `reason` all required |
| P2 | Attempt issuance with **no** decision | **blocked** — verified B2 |
| P3 | Attempt issuance with `hold` / `reject` | **blocked** — verified B3/B4 |
| P4 | Attempt issuance with a stale `progress` behind a newer `hold` | **blocked** — verified B5/B6 |
| P5 | Attempt issuance passing client `procurement_decision = 'progress'` while the server says `hold` | **blocked**; client value never stored — verified B10 |
| P6 | Issue with a valid current `progress` | snapshot created at v1; audit row written — verified B1/B16 |
| P7 | Re-issue | version increments to v2, previous superseded — verified B13 |
| P8 | Attempt `UPDATE` / `DELETE` on a snapshot | **blocked** — verified B14/B15 |
| P9 | Preview / download the pack | content matches the frozen snapshot hash |

P2–P8 are already **executed and passing** against staging (Part A). P1, P6, P9
still need a UI-level pass.

### B.4 Operator checklist — Compliance / Watchtower

Migrations 25 and 26 are applied in **production** and **not** in staging, so
this flow cannot be rehearsed in staging as it stands.

| # | Step | Pass criterion |
|---|---|---|
| C1 | Source ingestion run starts | row in `watchtower_ingestion_runs`, status open |
| C2 | Candidate update ingested | row in `watchtower_ingestion_items` with `content_hash`; items are append-only |
| C3 | Run closes exactly once | the run-update guard rejects a second close |
| C4 | Human review of a candidate | reviewer recorded; no auto-publication |
| C5 | Rule created from an accepted update | Tier-3 authority guard applies (M26) |
| C6 | Affected farm / batch identified | linkage visible to admin only |
| C7 | Alert + audit trail | entry in `compliance_audit_log`, append-only |

### B.5 Evidence capture

For every step, record: UTC timestamp · actor identity · input · observed output
· pass/fail. Store under `evidence/<date>/pilot-rehearsal/`. Record the `main`
SHA the rehearsal ran against.
