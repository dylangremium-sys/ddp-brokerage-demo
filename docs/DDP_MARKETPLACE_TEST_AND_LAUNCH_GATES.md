# DDP Supply Exchange — Test Plan and Launch Gates

**Companion to:** `DDP_MARKETPLACE_GROUND_TRUTH.md`, `_TARGET_ARCHITECTURE.md`, `_IMPLEMENTATION_PLAN.md`

---

## 0. The rule that governs every security test in this document

> **Every access-control test must assert against a seeded row owned by a different principal.**

An empty result from an empty table proves nothing. A test that asserts "buyer B sees 0 listings" against a database containing 0 listings is green forever and detects nothing. Each isolation test below therefore requires a fixture with **at least two populated tenants**, and each must be accompanied by a **positive control** — the owning principal *does* see the row — so that a broken fixture fails loudly instead of passing silently.

**Current state of this capability (measured):** the repository has 129 test files and 2634 tests, all passing (`npm test` exit 0). `runtime-verify.yml` runs migrations against a disposable PostgreSQL. **No test in the repository executes an RLS policy as a non-admin principal.** WP-0.6 exists to close this, and it blocks every gate below except G1.

---

## 1. Test plan

### 1.1 Role and permission

| # | Assertion | Fixture |
| -- | --- | --- |
| R-1 | `buyer` cannot reach any farmer or admin surface | seeded buyer + seeded farmer + seeded admin |
| R-2 | `farmer` cannot read any `buyer_organisations`, `buyer_requirements` or `matches` row | ≥1 row in each, owned elsewhere |
| R-3 | `pending` reaches no operational surface | pending profile |
| R-4 | `anon` denied on all 20 new tables | ≥1 row per table |
| R-5 | Widening the role CHECK in one of the three migrations but not the others fails | harness applies partial migration |
| R-6 | Buyer `viewer` sub-role can read a deal room but cannot write a message or commit a quantity | buyer org with owner + viewer |

### 1.2 Cross-tenant isolation

| # | Assertion |
| -- | --- |
| T-1 | Farm A cannot read farm B's `farms`, `farm_profiles`, `inventory_batches`, `farmer_documents`, `farmer_photos` (regression on the existing, proven boundary) |
| T-2 | Buyer A cannot read buyer B's org, memberships, documents, requirements or requirement documents |
| T-3 | Buyer A cannot read a `deal_room` it does not participate in — **including by direct id** |
| T-4 | Farm A cannot read a deal room concerning farm B |
| T-5 | Suspending buyer A's org removes catalogue and deal-room reads immediately, **with no grant row modified** |
| T-6 | A revoked `deal_room_participants` row (`revoked_at` set) loses read access on the next statement |

### 1.3 Farm↔buyer disclosure

| # | Assertion |
| -- | --- |
| D-1 | Before an `introductions` row exists, a buyer principal selecting the listing's farm receives **no** legal name, address, contact or membership field |
| D-2 | `region_label` is the only location field a buyer can obtain |
| D-3 | After an authorised introduction, disclosure is limited to `introductions.scope`; fields outside scope remain unreadable |
| D-4 | `disclosure_snapshots` is append-only: UPDATE, DELETE and TRUNCATE all raise, including as owner |
| D-5 | A listing whose text, filename or extracted PDF text contains an email, phone, LINE ID or URL **cannot** transition to `published` |
| D-6 | Uploaded images and PDFs reaching a buyer carry no EXIF/XMP/author metadata |
| D-7 | `deal_messages` with `visibility='internal'` are unreadable by every non-admin principal — asserted **at the policy level with the UI bypassed** |
| D-8 | `farm_only` messages unreadable by buyers; `buyer_only` unreadable by farms |

### 1.4 Catalogue and listing

| # | Assertion |
| -- | --- |
| C-1 | A `draft`, `pending_review`, `approved`-but-unpublished, `suspended` or `withdrawn` listing is invisible to every buyer — **five seeded rows, one per state** |
| C-2 | A `listing_visibility` row with `mode='deny'` hides an otherwise-published listing from that buyer only |
| C-3 | Every catalogue filter returns a subset of what the unfiltered query returns for the same principal (no filter widens visibility) |
| C-4 | A listing whose batch has `rejected` or `expired` evidence does not appear as buyer-ready |

### 1.5 Evidence

| # | Assertion |
| -- | --- |
| E-1 | `verified` cannot be written by any non-admin actor, and not by any automated process even as admin, without a recorded review row |
| E-2 | No mechanical check can set `buyer_ready`: absence of blockers **without** a recorded `progress` procurement decision leaves the batch not buyer-ready (direct port of the `buyerApprovalGate.ts` invariant — **this test must fail if that rule is weakened**) |
| E-3 | An `expired` document removes buyer-ready status from every listing depending on it |
| E-4 | A rejected evidence request cannot close as satisfied |
| E-5 | Terminal-status closure invariants from migration 24 hold (`closed_at`/`closed_by` set iff terminal) |
| E-6 | A photograph can never raise evidence status for cultivar, batch identity or test result |
| E-7 | A farm-scoped certificate cannot be attached as batch-scoped evidence |

### 1.6 State machines

| # | Assertion |
| -- | --- |
| S-1 | Every invalid opportunity transition is rejected by the database, enumerated exhaustively over the 13×13 matrix |
| S-2 | `won` without a `commission_agreements` row is rejected |
| S-3 | `lost`/`cancelled` without a non-empty reason is rejected |
| S-4 | Every accepted transition writes exactly one `opportunity_events` row |
| S-5 | A buyer or farmer principal cannot write `opportunities.state` directly |
| S-6 | Requirement, listing and enquiry machines each reject their full invalid-transition set |
| S-7 | A second non-terminal enquiry for the same `(listing, buyer_org)` is rejected by the unique partial index |
| S-8 | A `matches` row referencing a non-`published` listing or non-`approved` buyer org is rejected **at the database**, not the UI |
| S-9 | A `matches` row with empty or whitespace `rationale` is rejected |

### 1.7 Buyer Pack

| # | Assertion |
| -- | --- |
| P-1 | UPDATE, DELETE and TRUNCATE on `buyer_pack_snapshots`, `buyer_pack_audit_log`, `buyer_pack_download_log` all raise, including as owner (regression on the live, proven control) |
| P-2 | `UNIQUE (pack_id, version)` rejects a duplicate version |
| P-3 | A snapshot with `procurement_decision <> 'progress'` is rejected |
| P-4 | **A client-supplied `content_hash` that disagrees with the server recomputation is rejected** (closes the audit's limitation 1) |
| P-5 | `issued_by` equals the caller's `auth.uid()` and cannot be overridden by request body |
| P-6 | `approved_by` resolves to an existing profile id (closes limitation 2) |
| P-7 | A pack issued to buyer A cannot be fetched by buyer B, including with a valid-format signed URL |
| P-8 | The rendered artefact contains the recipient org, issue timestamp and snapshot id as a watermark |
| P-9 | A signed URL past `expires_at` is refused |
| P-10 | Every view/download/link-issue/expiry/revocation writes `document_access_events` |
| P-11 | Superseding creates a new version; **the prior version's bytes and hash are unchanged** |
| P-12 | Documentation and UI never assert legal/WORM immutability — asserted by a string test over user-facing copy |

### 1.8 Commission

| # | Assertion |
| -- | --- |
| M-1 | Percentage and fixed calculations correct across currencies, including a zero-rate and a 100%-rate boundary |
| M-2 | Rounding is explicit and consistent; no floating-point drift in stored amounts (use exact numeric types) |
| M-3 | Status transitions `expected → invoiced → paid` valid; `paid → expected` rejected |
| M-4 | `overdue` derives from date, not manual entry |
| M-5 | Ledger totals equal the sum of `commission_events` — no independent aggregate can disagree |
| M-6 | No code path holds, moves or references custody of transaction funds |

### 1.9 Notifications

| # | Assertion |
| -- | --- |
| N-1 | No notification body for a cross-org event contains any field from the counterparty record — asserted field-by-field, not by keyword |
| N-2 | No body contains price, quantity or document content |
| N-3 | A notification for a deal room is delivered only to current, non-revoked participants |
| N-4 | Failed email dispatch retries then dead-letters; the in-app row persists regardless |
| N-5 | A revoked participant stops receiving notifications for that room |

### 1.10 Storage

| # | Assertion |
| -- | --- |
| ST-1 | All buckets are private (`public = false`), asserted **by predicate, not by policy name** |
| ST-2 | Buyer B cannot read an object under buyer A's path **given the exact object name** |
| ST-3 | Farm B cannot read farm A's documents or photos (regression) |
| ST-4 | An object outside the `{org_type}/{org_id}/…` convention is unreachable by every non-admin principal |
| ST-5 | Malware-flagged uploads are quarantined and never reach a buyer path |

### 1.11 Migrations, backup, resilience

| # | Assertion |
| -- | --- |
| G-1 | Every migration applies cleanly to a fresh disposable PostgreSQL in order |
| G-2 | Every `_ROLLBACK.sql` reverses its migration, verified by schema diff |
| G-3 | Re-applying an earlier migration does **not** revert a later one (a known hazard in this repository's history — must be tested, not assumed) |
| G-4 | Duplicate and skipped migration numbers both fail CI |
| G-5 | A restore from backup into an empty database reproduces schema and RLS exactly, verified by `pg_policy` count per table |
| G-6 | Concurrent writes to the same opportunity or pack serialise correctly under load |

### 1.12 End-to-end lifecycle

**One test, real principals, no admin shortcuts:** admin approves buyer org → buyer signs in → browses catalogue (sees only published, permitted listings) → creates and submits a requirement → admin matches with rationale → deal room opens with masked identities → evidence requested and satisfied → authorised introduction recorded and snapshotted → Buyer Pack issued, watermarked, accessed and logged → opportunity advances to `won` → commission agreement and event recorded.

**Negative twin, same fixture:** a second buyer org observes none of the above at any step.

---

## 2. Launch gates

Each gate is a go/no-go. **A gate passes only on the listed objective evidence.** A gate does not pass because a page renders, a table exists, a test command exits 0, a mocked repository works, TypeScript compiles, or an admin can see a preview.

### G1 — Architecture and schema approval
- All 20 proposed entities reviewed against reuse-vs-add rationale; every "add" justified against an existing structure.
- Migration ledger (WP-0.1) live; positive record of applied state per environment.
- Duplicate `24_*` number and 31/32/33 gap resolved; CI fails on recurrence.
- **Evidence:** signed schema review; `npm run ci:runtime` green; ledger read matches a fresh `pg_tables` query.

### G2 — RLS and storage isolation *(blocks every subsequent gate)*
- RLS harness (WP-0.6) operational, with principals: admin, farmer A, farmer B, buyer A, buyer B.
- Tests R-1…R-6, T-1…T-6, ST-1…ST-5 all pass **with seeded counterpart rows and positive controls**.
- Deliberately removing any one policy turns the harness red — demonstrated, not asserted.
- All 27 existing + 20 new tables have `relrowsecurity = t` and ≥1 policy, measured by query.
- **Evidence:** harness output; the deliberate-break demonstration; the `pg_class`/`pg_policy` query result.

### G3 — Buyer onboarding
- Buyer role widening applied atomically across all three CHECK constraints; R-5 passes.
- Approve / suspend / reject all round-trip; T-5 passes.
- Buyer documents stored privately with expiry recorded.
- **Evidence:** G2 tests green; a real buyer account walked through by a human, not simulated.

### G4 — Buyer catalogue
- C-1…C-4 pass, with all five non-published listing states seeded.
- D-1, D-2, D-5, D-6 pass — no identity leak through data, text, filename or file metadata.
- No "Buy now", no public/unauthenticated catalogue route — asserted by test.
- **Evidence:** test output; a manual attempt by a real second buyer account to reach a denied listing by direct id.

### G5 — RFQ and matching
- S-6, S-7, S-8, S-9 pass.
- Every match carries a non-empty rationale and displays unresolved evidence gaps.
- Rejected matches retained and auditable.
- **Evidence:** database-level rejection of an ineligible match, captured with the UI bypassed.

### G6 — Deal rooms
- D-3, D-4, D-7, D-8 pass.
- **Internal notes proven unreadable at the policy layer with the client bypassed** — this is the gate's decisive test.
- Participant revocation takes effect on the next statement (T-6).
- **Evidence:** raw SQL session transcripts as each principal.

### G7 — Buyer Packs
- P-1…P-12 all pass.
- Server-side hash parity enforced (P-4) — the audit's limitation 1 closed.
- Recipient binding, watermark, expiry and access logging all live.
- **Documented limitation retained, not quietly dropped:** a service-role or direct-Postgres actor can still alter rows; the claim is "immutable to application roles, tamper-evident by hash", never "legally immutable" (P-12).
- **Evidence:** a hash-mismatch rejection captured; a cross-buyer fetch refused; the `document_access_events` rows produced.

### G8 — Opportunity and commission
- S-1…S-5 pass with the 13×13 transition matrix enumerated exhaustively.
- M-1…M-6 pass. No funds-custody code path exists.
- **Evidence:** the transition matrix result table; ledger reconciliation against `commission_events`.

### G9 — Complete end-to-end lifecycle
- §1.12 passes, including the negative twin.
- Walked once by a human against staging with real accounts on real devices — not only by an automated run.
- N-1…N-5 pass; no confidential content in any notification body.
- **Evidence:** the E2E run, plus a dated human walkthrough record naming who performed it.

### G10 — Production deployment readiness
- G1…G9 all green.
- Migration backlog (24, 28, 30, 36) applied and each `_VERIFY.sql` passing against production.
- G-2, G-3, G-5 rehearsed on disposable PostgreSQL **before** any production application; a proven restore point exists.
- Rate limiting live on public intake, catalogue search and pack access.
- Malware scanning, metadata stripping and contact detection live on every buyer-reaching path.
- Retention/deletion policy published; incident-response runbook written and rehearsed.
- Demo mode proven unreachable in a production build — specifically that `isDemo` cannot be true (`src/App.tsx:466` currently grants admin authority when it is), and that `selectBuyerPackSnapshotRepository` cannot silently fall back to `localStorage`.
- No user-facing string claims products are legal, compliant, pharmaceutical-grade or export-ready; no string claims software prevents circumvention.
- Thai legal review completed against the buyer-facing surfaces.
- **Evidence:** the full CI run; production `_VERIFY` output; the restore rehearsal record; the string audit; the legal sign-off.

---

## 3. Standing conditions

These hold at every gate and are re-checked at G10.

1. Human review remains mandatory. No automated process may transform uploaded evidence into `verified`, `certified`, `pharmaceutical-grade`, `approved for export` or `legally compliant`.
2. Absence of blocking issues is never approval (E-2).
3. Uncertainty in document linkage is displayed, never collapsed to a confident state.
4. DDP records and facilitates; licensed parties remain responsible for contracts, permits, payments, imports, exports and delivery. No gate may pass with UI copy implying otherwise.
5. Non-circumvention is contractual. The system evidences circumvention; it does not prevent it, and must never claim to.
