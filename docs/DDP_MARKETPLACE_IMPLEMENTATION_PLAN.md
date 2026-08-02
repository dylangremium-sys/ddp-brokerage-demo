# DDP Supply Exchange — Gap Analysis and Implementation Roadmap

**Companion to:** `DDP_MARKETPLACE_GROUND_TRUTH.md`, `DDP_MARKETPLACE_TARGET_ARCHITECTURE.md`
**Baseline:** audited at `feature/ai-summary-hardening` @ `55c2808`; re-verified unchanged on current `main` @ `0e65608` (only `.deepsource.toml` differs)

---

## Part 1 — Traceability matrix

Status values: **BP** built and proven · **PB** partially built · **PU** present but unsafe/incomplete · **NF** not found · **CV** cannot verify.

| ID | Capability | Existing evidence | Status | Missing work | Depends on | Security / compliance risk | Pri |
| -- | --- | --- | --- | --- | --- | --- | -- |
| MC-01 | Controlled farm onboarding | `api/admin/provision-farmer.ts`; `serverFarmerProvisioning.ts:76` role check; migrations 21/34/36; `DDPAccessRequests.tsx`; 5 test files | **PB** | Licence/cert expiry tracking; suspension state; apply migration 36 (intake is **unthrottled in prod**) | — | Med — unthrottled public intake is a live abuse surface | P1 |
| MC-02 | Controlled buyer onboarding | none | **NF** | Entire subsystem: `buyer_organisations`, `buyer_memberships`, `buyer_documents`, `buyer` role, invitation path, approval workflow | MC-18 | **Critical** — role widening touches 3 CHECK constraints across 3 migrations | P0 |
| MC-03 | Farm & supply profiles | `farms`/`farm_profiles`/`farm_memberships`/`inventory_batches`/`farmer_photos` live w/ 4–5 policies each; `StockStatus` 8-state union; `batchPhotoStorage.ts` | **PB** | Harvest/upcoming-harvest dates, sample availability, buyer-facing projection | MC-05 | Low — additive columns | P1 |
| MC-04 | Evidence review | `EvidenceStatus` (`types.ts:28`); `ComplianceVerificationTier` (`types.ts:17`); `buyerApprovalGate.ts`; `procurementControl.ts`; migration 24 (**not in prod**) | **PU** | Add `under_review` + `buyer_ready`; store `buyer_ready` instead of deriving; **apply migration 24**; guard `verified` against non-human assignment | MC-18 | **High** — evidence-request workflow does not exist in production | P0 |
| MC-05 | Buyer catalogue | `DDPBuyerPreview.tsx` is under `src/pages/admin/`; `buyerPreviewApprovedList.ts` | **PB** as internal preview / **NF** as buyer surface | `listings`, `listing_visibility`, buyer-side search/filter/compare, request-access | MC-02, MC-03 | **High** — first surface an external party ever sees | P0 |
| MC-06 | Buyer requirements / RFQ | none (grep: 0 hits) | **NF** | `buyer_requirements`, `requirement_documents`, 8-state machine, buyer + admin UI | MC-02 | Med | P0 |
| MC-07 | Matching | none. `DDPOperationsDesk.tsx` is an internal queue, not matching | **NF** | `matches` w/ mandatory rationale, admin workspace, gap display, eligibility guard | MC-05, MC-06 | **High** — an unapproved batch reaching a buyer is the headline failure | P0 |
| MC-08 | Enquiries | none as buyer↔farm. `farmer_review_requests` is admin↔farm (reusable pattern) | **NF** | `enquiries`, duplicate guard, ownership, deadlines, event history | MC-05 | Med | P1 |
| MC-09 | Private deal rooms | none | **NF** | `deal_rooms`, `deal_room_participants`, `deal_messages` w/ 4-way visibility, terms fields | MC-07 | **Critical** — internal notes leaking to a party is unrecoverable | P0 |
| MC-10 | Progressive identity disclosure | `fn_protect_owner_notes` (internal/external primitive only) | **NF** | Masking, `introductions`, `disclosure_snapshots`, metadata stripping, contact detection | MC-09 | **Critical** — leak defeats the whole brokerage model | P0 |
| MC-11 | Buyer Packs | `buyer_pack_snapshots`/`_audit_log`/`_download_log` **live in prod, RLS on**; `issue_buyer_pack_snapshot` + `prevent_buyer_pack_mutation` in `pg_proc`; `UNIQUE(pack_id,version)`; `CHECK(procurement_decision='progress')`; 5 test files | **BP** within scope | Server-side hash recompute; `approved_by` → profile id; recipient binding; watermark; expiry; revocation; access logging | MC-02, MC-09 | **High** — client-supplied hash means tamper-evidence trusts the client | P0 |
| MC-12 | Opportunity pipeline | `procurement_decisions` (7 values, mandatory reason, `decided_by = auth.uid()`, anti-mutation trigger) — a decision log, not a pipeline | **NF** | `opportunities`, `opportunity_events`, 13-state machine w/ DB-enforced transitions | MC-09 | Med | P1 |
| MC-13 | Commission tracking | none (grep: 0 hits) | **NF** | `commission_agreements`, `commission_events`, ledger UI. No funds custody. | MC-12 | Med — financial record accuracy | P1 |
| MC-14 | Marketplace protections | RLS **27/27** prod tables; 20 storage policies; migrations 11–16/19/20/37/38; anti-TRUNCATE triggers; CSP + XFO + Permissions-Policy in `vercel.json`; `npm audit` in CI | **PB** — strongest area | Malware scan, metadata strip, contact detection, rate limits, watermarking, expiring links, retention policy, IR plan, tested restore | MC-18 | **High** for the gaps; existing base is sound | P0/P2 |
| MC-15 | Notifications | invitation email only (`api/admin/resend-invitation.ts`); `compliance_alerts` | **PB** | `notifications` table, triggers, digest, confidentiality constraint | MC-09, MC-12 | **High** — a notification body is the easiest accidental disclosure | P2 |
| MC-16 | Administration & reporting | 13 admin pages | **PB** | Buyer mgmt, listing moderation, requirement mgmt, matching workspace, deal oversight, commission ledger, audit search | most | Low | P2 |
| MC-17 | Revenue model support | none | **NF** | Membership/fee/service-order data; billing deferred | MC-13 | Low | P3 |
| MC-18 | **Commercial audit trail** | `compliance_audit_log` exists but its `action` CHECK is a **closed 15-value regulatory vocabulary** — cannot absorb commercial events | **NF** | `commercial_audit_log` + anti-mutation trigger + closed commercial vocabulary | — | **Critical** — no commercial event is currently auditable | P0 |
| MC-19 | **Routing** | none — `Page` union of 26 members in a 1515-line `App.tsx`; `vercel.json` SPA rewrite present but path unread | **PU** | Real router; deep links; per-deal-room URLs | — | Med — blocks MC-09 usability | P0 |
| MC-20 | **Controlled asset ingestion** | `batchPhotoStorage.ts`; migration 28 digest dedup (**not in prod**) | **PB** | Owner attribution, hash+dedup, authenticity, uncertainty recording, human gate | MC-04 | **High** — mislinked COA is a false claim about a product | P1 |

### Distinctions the matrix asserts explicitly

- **UI present vs backend complete** — MC-05: `DDPBuyerPreview.tsx` renders fully; there is no buyer backend at all.
- **Table present vs RLS safe** — every one of the 27 production tables has RLS *and* ≥1 policy (measured), so this distinction currently resolves favourably. It must be re-asserted for all 20 new tables.
- **Unit-tested vs integration-tested** — 2600 Vitest assertions pass against in-process fakes; `runtime-verify.yml` exercises real PostgreSQL for migrations only. **No test executes an RLS policy as a non-admin principal.** This is the single largest testing gap.
- **Demo/localStorage vs live Supabase** — `selectBuyerPackSnapshotRepository` deliberately falls back to `createLocalStorageBuyerPackSnapshotRepository`. `isDemo` grants admin authority at `App.tsx:466`. Both must be proven unreachable in production builds before an external buyer exists.
- **Admin preview vs buyer account** — no buyer account exists. Every "buyer" surface today is an admin looking at a mock-up.
- **Document upload vs reviewed evidence** — uploads work; the evidence-**request** loop (migration 24) is absent from production.
- **Pack generation vs secure disclosure** — issuance is genuinely append-only and live; watermarking, recipient binding, expiry, revocation and access logging do not exist.
- **Compliance audit vs commercial audit** — MC-18. Measured, not inferred: the 15 permitted `action` values are all regulatory.

### Completion, calculated after the matrix

Capability count: 1 BP (in-scope), 6 PB, 3 PU, 10 NF. Weighted by the estimates in Part 2 (≈118 agent-days of remaining Release 0–2 work against a notional ≈175-day full build): **the platform supplies ~32% of the marketplace.** The inherited third is the expensive-to-retrofit third — tenancy, RLS, evidence semantics, human-approval gating, append-only issuance, real-PostgreSQL CI.

---

## Part 2 — Roadmap

Estimates are **agent-hours** for implementation + tests + migration + verify/rollback SQL. They exclude human review, legal review and production application. "Parallel: yes" means no shared file or migration number with a sibling in the same release.

---

## Release 0 — Foundation and safety

*Objective: make it structurally possible to add a second party without weakening the first. No buyer-visible behaviour ships.*

### WP-0.1 — Migration governance and baseline reconciliation
- **Objective:** establish, positively, which migrations are applied where. Today this is inferred from absent tables.
- **Scope:** add `schema_migrations` (number, filename, sha256, applied_at, applied_by); backfill from measured production state; reconcile the duplicate `24_*` number and the 31/32/33 gap; extend `check-migration-numbers.mjs` to fail on both.
- **Files:** `39_MIGRATION_LEDGER.sql` + `_VERIFY` + `_ROLLBACK`; `scripts/check-migration-numbers.mjs`.
- **DB:** 1 new table. **Depends on:** none. **Parallel:** yes.
- **Acceptance:** ledger row exists for every applied migration; CI fails on a duplicate or skipped number.
- **Tests:** harness test asserting duplicate and gap both fail. **Security tests:** ledger readable by admin only.
- **Rollback:** drop table; revert script. **DoD:** `npm run ci:runtime` green; ledger matches a fresh `pg_tables` read.
- **Est:** 8h.

### WP-0.2 — `buyer` role widening (atomic)
- **Objective:** admit a fourth role without breaking the three existing constraints.
- **Scope:** widen `CHECK (role IN …)` at `AUTH_RLS_SCHEMA.sql:21`, `21_…:44`, `27_…:473` **in one migration**; update `UserRole` in `src/services/auth.ts`; ensure `resolvePostLoginRouting` denies `buyer` until MC-02 lands (fail-closed).
- **Files:** `40_BUYER_ROLE.sql` (+V+R); `src/services/auth.ts`; `src/lib/postLoginRouting.ts`.
- **DB:** 3 constraint alterations. **Depends on:** WP-0.1. **Parallel:** **no** — blocks all buyer work.
- **Acceptance:** a `buyer` profile can be created; it can reach **no** existing page; all 2600 tests still pass.
- **Security tests:** buyer principal denied on every farmer and admin surface; a partial widening (one constraint only) fails a harness test.
- **Rollback:** narrow constraints after asserting zero `buyer` rows. **Est:** 10h.

### WP-0.3 — Buyer tenancy tables + predicate
- **Scope:** `buyer_organisations`, `buyer_memberships`, `buyer_documents`; `is_approved_buyer_member()`, `buyer_org_of()` as `SECURITY DEFINER, search_path=''`, EXECUTE to `authenticated` only.
- **Files:** `41_BUYER_TENANCY.sql` (+V+R). **Depends on:** WP-0.2. **Parallel:** no.
- **Acceptance:** buyer A cannot read buyer B's org, memberships or documents **with rows seeded for both**; a `suspended` org loses read access without any grant row changing.
- **Security tests:** cross-buyer isolation; suspension revokes; `anon` denied on all three.
- **Est:** 16h.

### WP-0.4 — `commercial_audit_log` (MC-18)
- **Scope:** table + closed commercial `action` vocabulary + `prevent_commercial_audit_log_mutation()` + anti-TRUNCATE, modelled on migrations 9 and 11.
- **Files:** `42_COMMERCIAL_AUDIT_LOG.sql` (+V+R). **Depends on:** WP-0.1. **Parallel:** yes.
- **Acceptance:** UPDATE, DELETE and TRUNCATE all raise, including as table owner.
- **Est:** 10h.

### WP-0.5 — Storage buckets and policies
- **Scope:** `buyer-documents`, `deal-room-files`, `buyer-packs`; private; path convention `{bucket}/{org_type}/{org_id}/{subject}/{sha256}`; policies **verified by predicate, not name** (per commit `1ebe693`).
- **Files:** `43_MARKETPLACE_STORAGE.sql` (+V+R). **Depends on:** WP-0.3. **Parallel:** no.
- **Security tests:** buyer B cannot read a `buyer-documents` object under buyer A's path even with the exact object name.
- **Est:** 14h.

### WP-0.6 — RLS contract-test harness (the gap that matters most)
- **Objective:** make it possible to assert a policy from a non-admin principal. **No such test exists today.**
- **Scope:** extend `scripts/disposable-pg/` to seed principals (admin, farmer A, farmer B, buyer A, buyer B) and run assertions under `SET LOCAL role` / JWT claims. Every assertion must use a **seeded row owned by another principal** — an empty result from an empty table proves nothing.
- **Files:** `scripts/disposable-pg/rls-harness.mjs`, `rls-harness.test.mjs`; `.github/workflows/runtime-verify.yml`.
- **Depends on:** WP-0.3. **Parallel:** no. **Blocks:** every subsequent security test.
- **Acceptance:** a deliberately removed policy turns the harness red.
- **Est:** 20h.

### WP-0.7 — Router introduction (MC-19)
- **Scope:** introduce a router; map the 26 `Page` members to paths; preserve the invite/recovery redirect capture in `lib/authRedirect.ts` **exactly** — it is load-bearing and subtle.
- **Files:** `src/App.tsx`, `src/types.ts`, `src/lib/postLoginRouting.ts`, new `src/routes/`.
- **Depends on:** none. **Parallel:** yes (but touches `App.tsx` — serialise against anything else that does).
- **Acceptance:** every existing page reachable by URL; back/forward correct; a supplier arriving from an invite link still lands on set-password and nowhere else; all `navigationGuard` / `postLoginRouting` / `inviteRedirect` tests pass unmodified.
- **Rollback:** revert; no DB change. **Est:** 24h.

### WP-0.8 — Apply the backlog: migrations 24, 28, 30, 36
- **Objective:** close the measured drift — 8 tables exist in the repository and not in production.
- **Scope:** staged application to a disposable PG, then staging, then production under change control. **This work package changes production and is the only one in Release 0 that does; it requires an explicit owner go/no-go and a proven restore point.**
- **Depends on:** WP-0.1. **Parallel:** no.
- **Acceptance:** `pg_tables` returns 35; each migration's `_VERIFY.sql` passes against the live database.
- **Rollback:** each has a `_ROLLBACK.sql`; rehearse every one on disposable PG **first**. Note the known hazard that replaying an early migration can revert a later one — sequence must be verified, not assumed.
- **Est:** 20h + owner time.

**Release 0 total: ~122 agent-hours (~15 agent-days).** Parallel tracks: {0.1, 0.4, 0.7} ∥ {0.2 → 0.3 → 0.5/0.6}. WP-0.8 last.

---

## Release 1 — Minimum launchable marketplace

*The smallest complete workflow: approved buyer → approved listing → requirement/enquiry → admin match → controlled deal room → Buyer Pack → opportunity outcome → commission record.*

| WP | Objective | Scope | Files / DB | Deps | ∥ | Est |
| -- | --- | --- | --- | --- | -- | -- |
| 1.1 | Buyer onboarding (MC-02) | Invitation-only registration, company + representative capture, destination countries, import-auth upload, admin approve/suspend/reject | `api/admin/provision-buyer.ts`; `src/lib/buyerProvisioning.ts`; `src/pages/admin/DDPBuyerOrganisations.tsx`; `src/pages/buyer/BuyerRegister.tsx`; mig 44 | 0.3 | no | 32h |
| 1.2 | Buyer portal shell | Buyer layout, nav, session guard, fail-closed on non-approved org | `src/pages/buyer/*`, `src/routes/buyer.tsx` | 0.7, 1.1 | no | 16h |
| 1.3 | Listings (MC-05a) | `listings` + `listing_visibility`, 6-state machine, admin publish/suspend | mig 45 (+V+R); `src/lib/listings.ts`; `DDPListingModeration.tsx` | 0.3 | yes | 24h |
| 1.4 | Buyer catalogue (MC-05b) | Search + filters (cultivar, product type, cannabinoid range, quantity, harvest date, price, certification, test coverage, cultivation method, evidence status), compare, evidence completeness, request access | `src/pages/buyer/BuyerCatalogue.tsx`, `src/lib/catalogueQuery.ts` | 1.2, 1.3 | no | 32h |
| 1.5 | Requirements / RFQ (MC-06) | `buyer_requirements` + `requirement_documents`, 8-state machine, buyer create/submit, admin review | mig 46; `BuyerRequirements.tsx`; `DDPRequirements.tsx` | 1.2 | yes | 28h |
| 1.6 | Manual matching (MC-07) | `matches` w/ **non-empty rationale enforced by CHECK**, admin workspace, evidence-gap display, DB-level guard rejecting a non-`published` listing or non-`approved` buyer | mig 47; `DDPMatchingWorkspace.tsx`; `src/lib/matching.ts` | 1.3, 1.5 | no | 28h |
| 1.7 | Enquiries (MC-08) | `enquiries`, duplicate guard via unique partial index on non-terminal status, ownership, deadlines, event history | mig 48; `src/lib/enquiries.ts` | 1.4 | yes | 24h |
| 1.8 | Deal rooms (MC-09) | `deal_rooms`, `deal_room_participants`, `deal_messages` w/ 4-way visibility **enforced in RLS**, terms fields, blockers, closure reason | mig 49; `src/pages/*/DealRoom.tsx` | 1.6, 0.6 | no | 40h |
| 1.9 | Identity disclosure (MC-10) | Masking projection, `introductions`, `disclosure_snapshots` (hashed, append-only), authorised-introduction action | mig 50; `src/lib/disclosure.ts` | 1.8 | no | 28h |
| 1.10 | Buyer Pack hardening (MC-11) | **Server-side hash recompute + parity check**; `approved_by` → profile id; `recipient_buyer_org_id`; `expires_at`; watermark at render; signed-URL issuance; `document_access_events` | mig 51; `api/buyer-pack/issue.ts`, `api/buyer-pack/access.ts`; `src/lib/buyerPackSnapshot.ts` | 1.1, 1.8 | no | 36h |
| 1.11 | Opportunity pipeline (MC-12) | `opportunities` + `opportunity_events`, 13-state machine, transitions admin-only and forward-only (except → `evidence_resolution`), `won` requires commission agreement, mandatory `lost_reason` | mig 52; `src/lib/opportunityState.ts`; `DDPPipeline.tsx` | 1.8 | yes | 28h |
| 1.12 | Commission tracking (MC-13) | `commission_agreements` + `commission_events`, calculation, ledger view. **No funds custody.** | mig 53; `src/lib/commission.ts`; `DDPCommissionLedger.tsx` | 1.11 | yes | 24h |
| 1.13 | Evidence state extension (MC-04) | Add `under_review` + `buyer_ready`; store `buyer_ready`; port `deriveBuyerApprovalGate` logic to the transition guard **preserving its refusal to treat no-blockers as approval**; trigger rejecting non-human `verified` | mig 54; `src/types.ts`; `src/lib/buyerApprovalGate.ts` | 0.8 | yes | 20h |
| 1.14 | E2E lifecycle test | One test walking approved buyer → catalogue → requirement → match → deal room → pack → won → commission, as **real principals** | `tests/e2e/marketplace-lifecycle.spec.ts` | all | no | 24h |

**Release 1 total: ~384 agent-hours (~48 agent-days).**
Parallel tracks: A {1.1→1.2→1.4}, B {1.3→1.6}, C {1.5, 1.7}, D {1.11→1.12}, E {1.13}. Converge at 1.8 → 1.9/1.10 → 1.14.

---

## Release 2 — Operational maturity

| WP | Objective | Deps | ∥ | Est |
| -- | --- | --- | -- | -- |
| 2.1 | `notifications` + triggers + **confidentiality constraint** (no counterparty identity, price, quantity or document content in any body) | 1.8, 1.11 | no | 32h |
| 2.2 | Email dispatch worker, retry + dead-letter, unsubscribe | 2.1 | no | 20h |
| 2.3 | Expiring-evidence engine: `expires_on` sweeps, warning ladder, auto-transition to `expired`, admin queue | 1.13 | yes | 24h |
| 2.4 | Document controls: malware scan, metadata/EXIF stripping, contact-detail detection **blocking publication rather than silently redacting** | 0.5, 1.3 | yes | 36h |
| 2.5 | Rate limiting at the edge for public intake, catalogue search and pack access | 0.8 | yes | 16h |
| 2.6 | Duplicate detection: batch fingerprints + document `sha256` reuse across farms (extends migration 28) | 0.8 | yes | 20h |
| 2.7 | Admin reporting: evidence queue, expiring-document queue, deal oversight, audit-log search | 1.11, 1.12 | yes | 32h |
| 2.8 | Retention/deletion policy + **tested** backup & restore + incident-response runbook | 0.1 | yes | 24h |

**Release 2 total: ~204 agent-hours (~26 agent-days).**

---

## Release 3 — Scale and automation

| WP | Objective | Deps | Est |
| -- | --- | --- | -- |
| 3.1 | Suggested matching (ranked, **advisory only — never auto-matches**) | 1.6 | 40h |
| 3.2 | Marketplace performance analytics | 2.7 | 24h |
| 3.3 | Farm memberships / buyer sourcing fees data model | 1.12 | 28h |
| 3.4 | Subscription billing integration | 3.3 | 40h |
| 3.5 | Private buyer portals (branded, scoped catalogues) | 1.4 | 32h |
| 3.6 | Document-readiness & pack-preparation service orders | 1.12 | 24h |

**Release 3 total: ~188 agent-hours (~24 agent-days).**

---

## Part 3 — Effort summary

| Release | Agent-hours | Agent-days | Conservative range |
| --- | --- | --- | --- |
| Release 0 | 122 | 15 | 13–20 |
| Release 1 | 384 | 48 | 42–62 |
| Release 2 | 204 | 26 | 22–34 |
| Release 3 | 188 | 24 | 20–32 |
| **0–1 (launchable)** | **506** | **63** | **55–82** |
| **0–2 (operationally mature)** | **710** | **89** | **77–116** |

Excludes human code review, Thai legal review, penetration testing, production application windows and owner decision latency. The **63 agent-days to a launchable marketplace** assumes the parallel tracks above are actually run in parallel; serialised, it is closer to 95.

---

## Part 4 — Recommended Release 1 scope (the honest minimum)

Ship WP-0.1 → 0.8, then 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 1.9, 1.10, 1.11, 1.13, 1.14.

**Defer to Release 2 without harming the core loop:** 1.7 (enquiries — a buyer can reach a deal room via requirement → match without a standalone enquiry object) and 1.12 (commission — the agreement can be recorded manually for the first handful of deals, and getting the ledger wrong is worse than not having it).

**Nothing in the security column may be deferred.** WP-0.6 (the RLS harness) and WP-1.9 (identity disclosure) are the two that will be tempting to postpone and are the two whose absence makes a pilot indefensible.

---

## Part 5 — Controlled ingestion of supplied photographs and COAs

**Precondition, stated plainly:** no such photographs or COA PDFs were located in this repository. The design below is written against the requirement, not against inspected files. Their existence, count and provenance are **unverified**.

Pipeline, admin-only, staging-first, **never against production during design work**:

1. **Quarantine** — upload to a `quarantine/` prefix no buyer policy can read. Nothing leaves quarantine without step 10.
2. **Identify** — record `sha256`, original filename, byte size, MIME sniffed from content (not extension), upload actor, upload timestamp.
3. **Attribute owner** — a named legal farm owner must be asserted by a human. **No inference from filename or folder.** Absent an owner, the asset stays in quarantine indefinitely.
4. **Deduplicate** — `sha256` match against all existing assets, across farms. A cross-farm hash collision is an alert, not an auto-merge: the same file under two owners is either a copy or a provenance problem, and both need a human.
5. **Authenticate where possible** — for COAs: extract issuer, lab accreditation reference, issue date, test date, expiry, sample id, batch reference. Record extraction confidence per field. Where the issuer publishes a verification endpoint, record the check result; where not, record `authenticity: unverifiable`.
6. **Link only on evidence** — a COA links to a batch **only** when a batch identifier in the document matches a `inventory_batches` record. A filename, a date proximity or an operator's recollection is not evidence.
7. **Record uncertainty as a first-class value** — `linkage_status ∈ linked | unlinked | disputed | ambiguous`, with `linkage_basis` text. `ambiguous` must render as ambiguous everywhere, never collapse to linked.
8. **Photographs prove nothing about identity** — a photo may be attached to a batch as illustrative material and is **structurally barred** from contributing to `EvidenceStatus` for cultivar, batch identity or test results. Enforce in the derivation function, not in review guidance.
9. **Certification scope** — a farm-level certificate is stored as farm-level evidence and **cannot** be presented as batch-specific. A separate `evidence_scope ∈ farm | batch` column makes the wrong presentation impossible rather than merely discouraged.
10. **Human approval gate** — an asset becomes buyer-visible only on an explicit admin action, recorded in `commercial_audit_log` with actor, timestamp and reason. Reuse the `buyerApprovalGate.ts` principle exactly: mechanical checks passing is a precondition, never the approval.

**Do not seed these assets into production.** Ingestion is exercised on disposable PostgreSQL and staging only, until the pipeline has passed the Release 2 document-controls gate (WP-2.4).
