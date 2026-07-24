<!--
  REPOSITORY GOVERNANCE HEADER — added when this contract was brought into the repo.
  Everything BELOW the "=== BEGIN BINDING CONTRACT BODY (v1.5, verbatim) ===" marker
  is the owner-approved contract text, imported without alteration. This header is the
  only repo-authored material and is where any correction to the body is recorded, so
  the owner-approved text is never silently rewritten.
-->

# Evidence Request & Resolution — Current Binding Implementation Contract

> **This is the single, current, repository-visible binding contract for the
> Evidence Request & Resolution workflow.** It is the authority a future
> Claude/Codex agent must implement against. Where any other repository document
> (roadmap, runbooks, historical audits) disagrees with the *behaviour of merged
> migration 24*, that migration and this contract govern; the other document is
> stale and should be corrected, not followed.

| | |
|---|---|
| **Status** | **CURRENT / BINDING** |
| **Contract version** | **v1.5** — supersedes v1.0, v1.1, v1.2, v1.3, v1.4 (all now historical) |
| **Aligned to** | Merged **migration 24** (`24_EVIDENCE_REQUEST_RESOLUTION_{HARDENING,VERIFY,ROLLBACK,STORAGE}.sql`) |
| **Merge provenance** | PR #37, merge commit `9496e1c`, reviewed head `fd57135`, landed on `main` 2026-07-23 |
| **Verification of fidelity** | The database, storage and RLS clauses (§4–§8, §12) were re-verified against the merged SQL on 2026-07-24: status/priority/category enumerations, the category→target matrix, per-category and aggregate size limits, the 100 MiB bucket ceiling, `draft_owner_user_id` handoff, `removal_requested_at` durable tombstones, post-submission cleanup survival, and server-forced audit actor attribution all match the merged implementation. |
| **Placement rationale** | The migration directory IS the repository root (there is no `migrations/` or `supabase/` directory); the contract lives under `docs/` per the release checklist gate **G1**. |

## Implementation status of the Evidence workflow — read before acting

This contract *specifies* the whole feature (database, storage, service layer, UI,
Operations Desk). Do not confuse specification with delivery. Status by layer, using
the repository's own status vocabulary (see `docs/MIGRATION_RUNTIME_STATUS.md`):

| Layer | In-repo status | Hosted status | Notes |
|---|---|---|---|
| **Database / storage / RLS (migration 24)** | **MERGED to `main`** (`9496e1c`, since 2026-07-23) | **`NOT_APPLIED`** to staging; **`NOT_APPLIED`** to production | Only runtime evidence to date is disposable local PostgreSQL (`VERIFY` sections A–M, 13/13). No hosted-Supabase verification exists. |
| **Application layer** (`src/lib/evidenceRequests*.ts`, `src/domain/evidenceRequests*.ts`, `src/pages/**/evidence/**`, `src/components/shared/EvidenceThread.tsx`) | **NOT INTEGRATED on `main`** | n/a | Authored on branch `feature/evidence-request-workflow-v2` (commit `4fb72f7`, "application layer (contract v1.5)"). Not merged to `main`; not hosted-verified. Do **not** describe it as shipped. |
| **UI routing / Operations Desk integration** | **PLANNED — not on `main`** | n/a | Specified in §10–§11 of the body. Blocked behind the release checklist gates below. |

Four-tier status language to use consistently everywhere downstream:

- **Merged in repo** — the code/SQL is on `main`. (True only for migration 24 SQL.)
- **Staged and hosted-verified** — applied to hosted staging AND behaviourally
  verified there. (Not yet true for any Evidence layer.)
- **Production-applied** — applied to hosted production with post-apply verification.
  (Not yet true for any Evidence layer.)
- **Planned but not implemented** — specified here, no merged implementation on `main`.
  (True for the application/UI/Desk layers, per the table above.)

## Corrections recorded against the imported body (do not edit the body)

Per repository governance, the owner-approved body is imported verbatim and any
divergence from *merged reality* is corrected here instead of by rewriting it.

1. **§6.8 / §16 Phase 8 "merging to `main` automatically deploys production" is
   superseded.** The merged deployment configuration `vercel.json` sets
   `git.deploymentEnabled.main = false`, so a merge to `main` does **not**
   auto-deploy production. The contract's *safety conclusion is unaffected and still
   binding*: the DB-first ordering (migration applied and hosted-verified before the
   Evidence application layer is merged) remains mandatory. The actual enforcement
   mechanism is the release checklist's **G4 CI schema-readiness gate**, not an
   auto-deploy hazard. Treat §6.8/§16's auto-deploy premise as historical.

2. **"Single source of truth" scoping.** `docs/MASTER_DEVELOPMENT_ROADMAP.md` calls
   itself the single source of truth for the product plan; that remains true for the
   *plan*. For **runtime application status**, the authority is
   `docs/MIGRATION_RUNTIME_STATUS.md`. For **Evidence Request & Resolution
   behaviour**, the authority is **this contract**. These three are complementary,
   not competing.

## What changed relative to the older (v1.0) model

The v1.0 contract defined the MVP loop (admin requests → farmer responds → submit →
review → resolve/reject/clarify) with immutable submitted evidence and append-only
history. Everything load-bearing in v1.0 is preserved. The current model adds four
owner-approved amendments, each now proven against the merged SQL:

- **[v1.1] Draft edit-authority + ownership handoff (§4.8).** Responses now carry
  `draft_owner_user_id` (mutable edit authority while `draft`) distinct from the
  immutable `created_by_user_id` (provenance). A dedicated, audited handoff RPC
  (`claim_evidence_response_draft`, emitting a `draft_ownership_transferred` history
  event) lets a currently-operational farmer take over the single draft **only when
  the current owner is no longer operational** — resolving the abandoned-draft
  deadlock without ever creating a second draft or rewriting provenance.
- **[v1.2] Durable request-upload tombstones (§7.8).** Draft attachment removal is a
  two-phase controlled protocol keyed on `removal_requested_at`, which is **immutable
  once set**. The row is never hard-deleted (it becomes a tombstone), because a
  Storage object whose INSERT policy was evaluated before the marker was set can still
  commit late; the tombstone guarantees any late object always has an authoritative
  row that authorises controlled Storage-API deletion. Naive `DELETE` is prohibited —
  it would orphan the file and re-open the pending-read finding.
- **[v1.3] Post-submission tombstone cleanup + internal-helper ACLs (§7.9, §8.6).** A
  tombstone is logically removed *before* submission and is never submitted evidence,
  so its cleanup authority (the frozen `draft_owner_user_id`) survives the response
  becoming submitted and the request reaching a terminal state — a narrow, versioned
  exception to submitted-response immutability. Internal `SECURITY DEFINER` helpers
  (`evidence_apply_transition`, `evidence_actor_role`, …) are non-executable by
  `service_role` as well as `PUBLIC`/`anon`/`authenticated`.
- **[v1.4] Storage bucket size ceiling (§7.10).** The private `evidence-request-files`
  bucket carries a platform `file_size_limit` of 104857600 bytes (100 MiB) — the
  absolute individual-object boundary, defense-in-depth against oversized/abandoned
  pending uploads. It does **not** replace the stricter per-category limits (20 MiB for
  everything except `inventory_video`), the 150 MiB aggregate per-response limit, or
  the reserve/finalize size checks, all of which remain authoritative underneath it.
- **[v1.5] Delivered-phase reconciliation (§6.8, §6.9).** Records that §6–§8 are merged
  as migration 24 under the delivered `24_EVIDENCE_REQUEST_RESOLUTION_*` filenames
  (superseding the §14 template names), and ratifies exactly two accepted schema
  deviations: (a) `evidence_request_attachments.size_bytes` is nullable for *linked
  existing documents* (source tables carry no size column; uploads are still
  `NOT NULL` and `> 0`); (b) there is **no** `draft_owner_user_id` column on
  `evidence_request_attachments` — edit authority is enforced through the response's
  `draft_owner_user_id`, consistent with §4.8. No third deviation is accepted.

**Audit-integrity note (server-forced actor attribution).** Every history write in
migration 24 sets `actor_user_id = auth.uid()` inside a `SECURITY DEFINER` RPC — the
actor is derived server-side from the authenticated session and is **not**
caller-supplied. This satisfies the audit-attribution requirement *for
`evidence_request_history`*. The still-open, conceptual audit-integrity item in the
release checklist (**G3**) concerns the broader compliance audit log under
**migration 25 (Watchtower ingestion)**, which is a separate migration family and is
out of scope for this contract.

## Final verification / acceptance expectation for the migration-24 family

The authoritative acceptance surface is `24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql`,
a single-transaction, ROLLBACK-terminated behavioural script whose sections **A–R**
each build a real fixture and prove the database refuses what the contract forbids
(A–M cover the public schema; N–R add CoA/tombstone/internal-ACL/storage-bucket
checks). Acceptance for a hosted environment requires **all** sections to pass on that
hosted target **under non-owner principals** (the disposable-Postgres, owner-role run
is necessary but not sufficient — see checklist **G2**). Until that hosted run exists,
the family's security properties are *asserted, not demonstrated*, on staging and
production.

## Related repository control documents

- `docs/EVIDENCE_RELEASE_READINESS_CHECKLIST.md` — the release gates (G0–G6). This
  contract satisfies **G1** (single current binding contract) and is a required input
  to **G5** (application-layer completeness).
- `docs/MIGRATION_RUNTIME_STATUS.md` — authoritative per-environment runtime status.
- `docs/MASTER_DEVELOPMENT_ROADMAP.md` — product plan and sequencing (cross-references
  this contract from its Evidence section).

---

=== BEGIN BINDING CONTRACT BODY (v1.5, verbatim) ===

# DDP EVIDENCE REQUEST & RESOLUTION WORKFLOW — BINDING IMPLEMENTATION CONTRACT v1.5

> **Amendment v1.4 → v1.5 (delivered database phase reconciliation).** Preserves
> all of v1.4 and reconciles the contract with verified repository reality found
> in the Phase 0 preflight of 2026-07-23. It changes NO security boundary, NO
> workflow rule, NO status, category, RPC name, storage rule or UI requirement.
> It records three facts and one filename correction: (i) the Phase 2 database,
> RLS, storage and RPC deliverable is ALREADY IMPLEMENTED AND MERGED to `main`
> as migration 24 (`9496e1c`, PR #37) under the filename family
> `24_EVIDENCE_REQUEST_RESOLUTION_{HARDENING,VERIFY,ROLLBACK,STORAGE}.sql`, so
> §14's `<N>_EVIDENCE_REQUEST_WORKFLOW*.sql` template is superseded by the
> delivered names rather than merged SQL being renamed; (ii) the nullable
> `size_bytes` deviation for linked existing documents is accepted; (iii) the
> absence of `draft_owner_user_id` on `evidence_request_attachments` is accepted
> because §4.8 — which is authoritative on edit authority — requires attachments
> to retain their original creators, and the edit-authority gate is correctly
> enforced through the response's `draft_owner_user_id`. Owner-approved for this
> amendment only. Full statement in §6.9; §14 and §16 Phase 2 are updated to
> match. No other v1.4 decision changes.

> **Amendment v1.3 → v1.4 (storage bucket size ceiling).** Preserves all of v1.3
> and adds one storage-boundary guarantee (§7.10): the private evidence bucket
> carries a platform `file_size_limit` of 104857600 bytes (100 MiB), the absolute
> maximum individual object size, matching the largest legitimate attachment
> (inventory_video). This is defense-in-depth against oversized/abandoned pending
> uploads and does NOT change the existing per-category limits, the 150 MiB
> aggregate response limit, or the reserve/finalize size validation, which remain
> authoritative and stricter underneath it. Owner-approved for this amendment
> only. Full statement in §7.10.

> **Amendment v1.2 → v1.3 (post-submission tombstone cleanup + internal-helper ACLs).**
> Preserves all of v1.2 and adds two narrow rules. (i) A request_upload tombstone
> (§7.8) is logically removed BEFORE submission and is never submitted evidence, so
> its cleanup authority must survive the response becoming submitted and the request
> reaching a terminal state — this is a documented, versioned exception to submitted-
> response immutability, and it is cleanup-only (§7.9). (ii) Internal SECURITY DEFINER
> helpers are not service entry points and must be non-executable by service_role as
> well as PUBLIC/anon/authenticated (§8.6). Owner-approved for these amendments only;
> no other decision changes. Full statements in §7.9 and §8.6.

> **Amendment v1.1 → v1.2 (durable request-upload tombstones).** Preserves all of
> v1.1 and adds one narrowly-scoped rule (§7.8) to close a cross-transaction race:
> a Storage INSERT whose RLS policy was evaluated while `removal_requested_at` was
> still NULL can commit AFTER the removal marker and a point-in-time absence check,
> so hard-deleting the attachment row on that absence could strand an ownerless
> object. Fix: once removal begins on a `request_upload`, the attachment row is
> NEVER hard-deleted — it becomes a permanent tombstone. No cross-system atomicity
> between PostgreSQL and Supabase Storage is claimed. Owner-approved for this
> amendment only; no other v1.1 decision changes. The full statement is §7.8.

> **Amendment v1.0 → v1.1 (draft edit-authority handoff).** This version preserves
> all of v1.0 verbatim and adds one narrowly-scoped concept: a mutable
> `draft_owner_user_id` (current edit authority) distinct from the immutable
> `created_by_user_id` (provenance). It exists solely to resolve the
> abandoned-draft liveness defect where the single per-request draft was created
> by a farm member who is no longer operational, leaving the request stuck behind
> the one-draft-per-request rule. Approved in writing by the owner for this
> amendment only; no other v1.0 decision is changed. Amended clauses are marked
> **[v1.1]** in §4.6, §5.4, §6.3 and §7.4; the full statement is §4.8.

## 1. Executive Summary

This contract defines the MVP implementation for a controlled evidence-request workflow in DDP Brokerage.

The workflow closes the operational loop between DDP administrators and authorized farmers:

**Matter detected → administrator requests evidence → farmer responds → evidence is submitted → human reviews → request is resolved, rejected, or returned for clarification.**

The feature is an evidence-management and human-review mechanism. It is **not** an approval engine and must not create, infer, or imply any automatic compliance, export, pharmaceutical, supplier, farm, batch, licence, COA, or buyer approval.

The Operations Desk remains read-only. It may aggregate and display evidence-request work, but all review and mutation occurs on the authoritative evidence-request pages.

The implementation is governed by these locked principles:

1. Every request targets exactly one farm profile or one inventory batch.
2. Every request has one authoritative current status.
3. Farmer submissions are versioned and preserved.
4. Submitted responses and attachments are immutable.
5. Clarification creates a new response cycle; it does not overwrite prior evidence.
6. All request transitions are atomic database operations.
7. Every transition writes an append-only history event in the same transaction.
8. Farmers are authorized by farm membership and operational farmer status, never by client-side filtering.
9. Pending users and anonymous users receive no operational access.
10. No browser code uses `service_role`.
11. Storage is private and request-specific.
12. Empty data, unavailable data, and failed data are distinct application states.
13. Resolved, rejected, and cancelled requests are terminal.
14. No automatic approval or compliance conclusion is permitted.

---

## 2. Product Boundaries

### 2.1 In scope

The MVP must provide:

- Administrator creation of farm-level and inventory-level evidence requests.
- Farmer request visibility restricted to authorized farms.
- Farmer response text.
- Secure upload of new evidence.
- Linking of suitable existing farmer or inventory documents.
- Farmer submission for human review.
- Administrator clarification, resolution, rejection, and cancellation actions.
- Append-only request history.
- Operations Desk aggregation and navigation.
- Integration entry points from Farm Review and Inventory Review.
- Row-level security, storage isolation, ownership validation, and transition validation.
- Explicit loading, empty, unavailable, and failure states.
- Account-switch and stale-request protection.
- Regression protection for Buyer Pack snapshots and Compliance Watchtower.

### 2.2 Out of scope

The MVP must not include:

- Email, SMS, push, or external notifications.
- Free-form chat or message threads.
- Automated reminders or escalation.
- Real-time subscriptions.
- AI approval or AI-generated decisions.
- Automatic compliance conclusions.
- Automatic export-readiness conclusions.
- Buyer-facing access.
- Automatic Buyer Pack inclusion.
- Public routes.
- External integrations.
- Broad visual redesign.
- Editing previously submitted evidence.
- Reopening terminal requests.
- Permanent deletion of operational records.
- Background document processing.
- Virus-scanning claims unless an actual scanning service is later implemented.

### 2.3 Safety boundary

The feature may report only workflow and evidence states. It may say:

- Evidence requested
- Awaiting farmer response
- Submitted for review
- Clarification requested
- Reviewed
- Missing evidence
- Rejected evidence
- Human review required
- No rule impact
- Buyer-ready for discussion

It must not say or imply:

- Fully compliant
- Legally compliant
- Approved for export
- Export-ready
- Verified supplier
- Verified batch
- Pharmaceutical approved
- Certified pharmaceutical
- Ready to buy

---

## 3. Canonical Terminology

| Technical value | Required UI label | Meaning |
|---|---|---|
| `open` | Awaiting farmer response | Administrator created the request; no current submission awaits review. |
| `farmer_submitted` | Submitted for review | Farmer submitted a response and evidence for human review. |
| `clarification_requested` | Clarification requested | Administrator returned the matter to the farmer with a required explanation. |
| `resolved` | Reviewed and resolved | Administrator completed human review and closed the request without making a broader compliance claim. |
| `rejected` | Evidence rejected | Administrator rejected the submitted evidence and closed the request. |
| `cancelled` | Cancelled | Administrator closed the request without accepting or rejecting evidence. |
| `draft` | Draft response | Farmer work that has not been submitted and is not visible as reviewed evidence. |
| `submitted` | Submitted response | Immutable response version submitted by the farmer. |
| `farm_profile` | Farm profile | Request concerns the farm-level record. |
| `inventory_batch` | Inventory batch | Request concerns one inventory batch. |

### 3.1 Status excluded from the MVP

`under_review` is **not** a stored request status.

Reason:

- Opening a page must not mutate workflow state.
- An explicit under-review claim can become stale when an administrator closes a browser or loses connectivity.
- `farmer_submitted` already means that the item is awaiting human review.
- The UI may display “Submitted for review,” but it must not create a separate database transition merely because an administrator viewed the record.

### 3.2 Due-date semantics

- `due_date` is optional.
- It is a calendar date, not a timestamp.
- It must not be earlier than the creation date.
- Overdue is a derived UI condition only.
- Overdue does not change request status.
- No automatic reminder or escalation is created.

---

## 4. Domain Model

### 4.1 Request status values

```ts
export const EVIDENCE_REQUEST_STATUSES = [
  'open',
  'farmer_submitted',
  'clarification_requested',
  'resolved',
  'rejected',
  'cancelled',
] as const;
```

### 4.2 Priority values

```ts
export const EVIDENCE_REQUEST_PRIORITIES = [
  'low',
  'normal',
  'high',
  'urgent',
] as const;
```

Default priority: `normal`.

### 4.3 Target values

```ts
export const EVIDENCE_REQUEST_TARGET_TYPES = [
  'farm_profile',
  'inventory_batch',
] as const;
```

A request must have exactly one target.

### 4.4 Category values

```ts
export const EVIDENCE_REQUEST_CATEGORIES = [
  'farm_identity',
  'farm_license',
  'gacp_evidence',
  'gmp_evidence',
  'export_supporting_document',
  'responsible_contact',
  'coa',
  'batch_identity',
  'inventory_quantity_evidence',
  'inventory_photo',
  'inventory_video',
  'storage_evidence',
  'chain_of_custody',
  'other',
] as const;
```

### 4.5 Category-to-target matrix

| Category | Farm profile | Inventory batch |
|---|:---:|:---:|
| `farm_identity` | Yes | No |
| `farm_license` | Yes | No |
| `gacp_evidence` | Yes | No |
| `gmp_evidence` | Yes | No |
| `export_supporting_document` | Yes | Yes |
| `responsible_contact` | Yes | No |
| `coa` | No | Yes |
| `batch_identity` | No | Yes |
| `inventory_quantity_evidence` | No | Yes |
| `inventory_photo` | No | Yes |
| `inventory_video` | No | Yes |
| `storage_evidence` | Yes | Yes |
| `chain_of_custody` | Yes | Yes |
| `other` | Yes | Yes |

The database mutation function must validate this matrix. The client may duplicate the validation for usability, but client validation is never authoritative.

### 4.6 Response model

A request can contain multiple response versions.

- One response may be in `draft`.
- Submitted responses are numbered `1, 2, 3...`.
- A new response after clarification references the preceding submitted response through `supersedes_response_id`.
- Only one draft may exist per request. **[v1.1] This is unchanged: the
  per-request single-draft rule and its partial unique index remain exactly as
  in v1.0. v1.1 does NOT introduce per-member drafts.**
- **[v1.1] Each response carries `draft_owner_user_id` — the farmer currently
  authorised to edit the single draft. It is initialised to `created_by_user_id`
  and may change ONLY through the explicit, audited handoff RPC while
  `state = 'draft'`. `created_by_user_id` is never rewritten.**
- A submitted response cannot be edited or deleted.
- Clarification does not convert the prior response back to draft.
- A new draft is created for the next response cycle.

### 4.7 Terminal states

The following are terminal:

- `resolved`
- `rejected`
- `cancelled`

Terminal requests cannot be reopened or changed. A new request must be created if further evidence is required.

### 4.8 Draft edit-authority and ownership handoff [v1.1]

This section is the authoritative statement of the v1.1 amendment.

- **`created_by_user_id` = immutable provenance.** It identifies the user who
  originally created the response and is never rewritten — not by handoff, not by
  any RPC, not by direct DML. It survives submission unchanged.
- **`draft_owner_user_id` = mutable edit authority while `state = 'draft'`.** It
  identifies the single farmer currently permitted to edit the draft. It is
  initialised equal to `created_by_user_id` for every new draft.
- **Only one draft still exists per request.** The unique one-draft-per-request
  index is retained; ownership handoff transfers authority over that one draft
  and never creates a second.
- **Handoff is explicit and audited.** It occurs only through the dedicated
  handoff RPC, which writes a `draft_ownership_transferred` history event
  recording the previous and new owner. It is never implicit in
  `get_or_create_evidence_response_draft`.
- **Submitted responses cannot be handed off.** Once `state = 'submitted'`,
  `draft_owner_user_id` is frozen as the provenance of the final edit owner.
- **Handoff requires current operational farm access** for the caller, checked
  server-side via `can_operationally_access_farm(request.farm_id)`; client role
  and farm claims are never trusted.
- **The old owner loses edit authority immediately** and atomically when handoff
  commits.
- **An active owner's draft cannot be stolen.** Handoff is permitted ONLY when
  the current `draft_owner_user_id` no longer satisfies the operational
  authorization model for the request's farm (membership removed, role no longer
  farmer, or operational access disabled). If the current owner is still
  operational, handoff returns `CONFLICT`.
- **Terminal requests cannot be claimed** — consistent with §4.7, a terminal
  request is not reopened by a handoff.
- **Attachments retain their original creators.** `evidence_request_attachments.created_by_user_id`
  is never rewritten by handoff. A new owner may not finalize an upload
  reservation created by the former owner (they cannot prove the in-flight object
  belongs to their client operation); such a reservation is cleaned up through
  the controlled removal protocol and the new owner reserves a replacement. A
  ready, already-uploaded draft attachment keeps its original creator and may be
  carried into submission only if all farm/request/category integrity rules still
  hold.
- **Handoff implies nothing about approval, verification or compliance.** It is
  purely an operational edit-authority transfer.
- **Concurrency.** Handoff locks the request and response rows and increments the
  request revision, so concurrent claims resolve to exactly one winner and stale
  clients are invalidated.

---

## 5. Status Transition Matrix

### 5.1 Allowed transitions

| From | To | Actor | Required data | Reversible |
|---|---|---|---|---|
| None | `open` | `ddp_admin` | Valid target, category, title, explanation, priority; optional due date | No |
| `open` | `farmer_submitted` | Authorized `farmer` | Submitted response with non-empty text or at least one ready attachment | No; later clarification may create a new cycle |
| `clarification_requested` | `farmer_submitted` | Authorized `farmer` | New submitted response; must supersede latest submitted response | No; later clarification may create another cycle |
| `farmer_submitted` | `clarification_requested` | `ddp_admin` | Clarification reason and reviewed response ID | Yes only through a new farmer submission |
| `farmer_submitted` | `resolved` | `ddp_admin` | Resolution note and reviewed response ID | No |
| `farmer_submitted` | `rejected` | `ddp_admin` | Rejection reason and reviewed response ID | No |
| `open` | `cancelled` | `ddp_admin` | Cancellation reason | No |
| `clarification_requested` | `cancelled` | `ddp_admin` | Cancellation reason | No |
| `farmer_submitted` | `cancelled` | `ddp_admin` | Cancellation reason | No |

### 5.2 Invalid transitions

All transitions not listed above are invalid, including:

- Farmer creating a request.
- Farmer resolving, rejecting, cancelling, or requesting clarification.
- Administrator submitting a farmer response.
- `open` directly to `resolved`.
- `open` directly to `rejected`.
- `clarification_requested` directly to `resolved`.
- `clarification_requested` directly to `rejected`.
- Any transition from a terminal status.
- `farmer_submitted` to `open`.
- `resolved` to any status.
- `rejected` to any status.
- `cancelled` to any status.
- A second farmer submission while the request is already `farmer_submitted`.
- A clarification action referencing an older response rather than the current submitted response.

### 5.3 Required text lengths

| Field | Minimum | Maximum |
|---|---:|---:|
| Title | 3 characters | 140 characters |
| Explanation | 20 characters | 4,000 characters |
| Response text | 1 character when used | 4,000 characters |
| Clarification reason | 10 characters | 2,000 characters |
| Resolution note | 10 characters | 2,000 characters |
| Rejection reason | 10 characters | 2,000 characters |
| Cancellation reason | 10 characters | 2,000 characters |

Whitespace-only values are invalid.

### 5.4 Concurrency rule

Every mutation receives `expected_revision`.

The database function must:

1. Lock the request row.
2. Confirm the current revision equals `expected_revision`.
3. Validate the transition.
4. Apply the transition.
5. Increment revision by one.
6. Write the history event.
7. Commit all changes atomically.

A revision mismatch returns `CONFLICT`. The UI must reload the authoritative request and must not silently retry a decision.

**[v1.1]** Draft ownership handoff is a revision-bearing mutation: it takes
`expected_revision`, locks the request then the response row (documented order),
increments the request revision, and writes its history event, so two concurrent
claims cannot both succeed and any stale edit/submit against the old ownership
state is rejected with `CONFLICT`.

---

## 6. Database Contract

### 6.1 SQL value strategy

PostgreSQL enum types must **not** be created for this feature.

Canonical values are stored as `text` columns with named `CHECK` constraints and mirrored TypeScript constant tuples. This avoids unsafe enum migrations and keeps rollback practical.

### 6.2 Table: `evidence_requests`

| Column | Type | Rules |
|---|---|---|
| `id` | `uuid` | Primary key; `gen_random_uuid()` |
| `farm_id` | `uuid` | Not null; FK to `farms(id)`; derived from target; `ON DELETE RESTRICT` |
| `target_type` | `text` | `farm_profile` or `inventory_batch` |
| `farm_profile_id` | `uuid` | Nullable FK to `farm_profiles(id)`; `ON DELETE RESTRICT` |
| `inventory_batch_id` | `uuid` | Nullable FK to `inventory_batches(id)`; `ON DELETE RESTRICT` |
| `category` | `text` | Canonical category check |
| `title` | `varchar(140)` | Not null; trimmed length 3–140 |
| `explanation` | `text` | Not null; trimmed length 20–4,000 |
| `priority` | `text` | Not null; default `normal` |
| `due_date` | `date` | Nullable; not earlier than creation date |
| `status` | `text` | Not null; default `open` |
| `revision` | `integer` | Not null; default 1; positive |
| `created_by_user_id` | `uuid` | Not null; FK to `auth.users(id)`; `ON DELETE RESTRICT` |
| `closed_by_user_id` | `uuid` | Nullable; FK to `auth.users(id)`; `ON DELETE RESTRICT` |
| `created_at` | `timestamptz` | Not null; default `now()` |
| `updated_at` | `timestamptz` | Not null; default `now()` |
| `status_changed_at` | `timestamptz` | Not null; default `now()` |
| `closed_at` | `timestamptz` | Nullable; required only for terminal status |

#### Target constraint

Exactly one target must exist:

```sql
(
  target_type = 'farm_profile'
  AND farm_profile_id IS NOT NULL
  AND inventory_batch_id IS NULL
)
OR
(
  target_type = 'inventory_batch'
  AND inventory_batch_id IS NOT NULL
  AND farm_profile_id IS NULL
)
```

#### Scope validation

A trigger and the creation RPC must both validate:

- Farm-profile request: `farm_id` equals the farm owning the selected farm profile.
- Inventory request: `farm_id` equals the farm owning the selected inventory batch.
- Category is valid for target type.

The caller must not be allowed to choose an unrelated `farm_id`.

#### Mutability

After creation, these fields are immutable:

- Target
- Category
- Title
- Explanation
- Priority
- Due date
- Creator

Only these fields may change through approved transition functions:

- `status`
- `revision`
- `updated_at`
- `status_changed_at`
- `closed_by_user_id`
- `closed_at`

If an administrator created the wrong request, the request is cancelled and a new request is created.

#### Indexes

Required indexes:

- `(farm_id, status, created_at DESC)`
- `(status, priority, due_date, created_at DESC)`
- Partial active index on statuses `open`, `farmer_submitted`, `clarification_requested`
- `(farm_profile_id)` where not null
- `(inventory_batch_id)` where not null
- `(created_by_user_id, created_at DESC)`

No active-request uniqueness constraint is imposed. Multiple legitimate requests may concern the same category and target.

### 6.3 Table: `evidence_request_responses`

| Column | Type | Rules |
|---|---|---|
| `id` | `uuid` | Primary key |
| `request_id` | `uuid` | Not null; FK to `evidence_requests(id)`; `ON DELETE RESTRICT` |
| `response_number` | `integer` | Not null; positive |
| `state` | `text` | `draft` or `submitted` |
| `response_text` | `text` | Nullable; max 4,000 |
| `supersedes_response_id` | `uuid` | Nullable self-FK; `ON DELETE RESTRICT` |
| `created_by_user_id` | `uuid` | Not null; FK to `auth.users(id)`; **[v1.1] immutable provenance — never rewritten** |
| `draft_owner_user_id` | `uuid` | **[v1.1]** Not null; FK to `auth.users(id)` `ON DELETE RESTRICT`; initialised = `created_by_user_id`; mutable only via the handoff RPC while `state='draft'`; frozen at submission |
| `created_at` | `timestamptz` | Not null |
| `updated_at` | `timestamptz` | Not null |
| `submitted_at` | `timestamptz` | Null for draft; required for submitted |

Required constraints:

- Unique `(request_id, response_number)`.
- Partial unique index allowing only one `draft` per request.
- `submitted_at` must be null for draft and non-null for submitted.
- `supersedes_response_id` must belong to the same request.
- The first response has no superseded response.
- A response after clarification must supersede the immediately preceding submitted response.

#### Mutability

Draft response:

- **[v1.1]** The farmer identified by `draft_owner_user_id` (the current edit
  authority, initially the creator) may change `response_text` through an
  approved RPC. `created_by_user_id` remains the immutable provenance.
- Farmer (current draft owner) may attach or remove evidence before submission.
- Administrator cannot edit it.
- **[v1.1]** Edit authority may be transferred to another operationally-authorised
  farmer through the explicit handoff RPC only when the current owner is no longer
  operational; see §4.8.

Submitted response:

- Fully immutable.
- Cannot be deleted.
- Cannot be reverted to draft.
- Remains visible after clarification, rejection, resolution, or cancellation.

### 6.4 Table: `evidence_request_attachments`

| Column | Type | Rules |
|---|---|---|
| `id` | `uuid` | Primary key |
| `request_id` | `uuid` | Not null; FK; `ON DELETE RESTRICT` |
| `response_id` | `uuid` | Not null; FK; `ON DELETE RESTRICT` |
| `origin` | `text` | `request_upload`, `existing_farm_document`, or `existing_inventory_document` |
| `farmer_document_id` | `uuid` | Nullable FK to `farmer_documents(id)` |
| `inventory_document_id` | `uuid` | Nullable FK to `documents(id)` |
| `storage_bucket` | `text` | Required only for `request_upload` |
| `storage_object_path` | `text` | Required only for `request_upload` |
| `upload_state` | `text` | `pending_upload` or `ready` |
| `original_filename` | `text` | Not null |
| `mime_type` | `text` | Not null |
| `size_bytes` | `bigint` | Not null; positive |
| `sha256_hex` | `char(64)` | Not null for ready uploads |
| `created_by_user_id` | `uuid` | Not null; FK to `auth.users(id)`; **[v1.1] immutable provenance — never rewritten** |
| `draft_owner_user_id` | `uuid` | **[v1.1]** Not null; FK to `auth.users(id)` `ON DELETE RESTRICT`; initialised = `created_by_user_id`; mutable only via the handoff RPC while `state='draft'`; frozen at submission |
| `created_at` | `timestamptz` | Not null |
| `finalized_at` | `timestamptz` | Required when ready |

Required origin constraint:

- `request_upload`: bucket and object path present; both existing-document IDs null.
- `existing_farm_document`: `farmer_document_id` present; inventory document and storage path null.
- `existing_inventory_document`: `inventory_document_id` present; farmer document and storage path null.

Required integrity rules:

- Attachment request ID must equal the response request ID.
- Existing documents must belong to the same farm.
- Inventory documents must belong to the targeted inventory batch when the category is `coa`.
- A response cannot be submitted while any attachment is `pending_upload`.
- Maximum ten ready attachments per response.
- Maximum aggregate submitted attachment size: 150 MB.

#### Mutability and deletion

- A pending or ready attachment may be removed only while its response remains draft.
- Removal deletes the request-specific storage object and database row through one controlled operation.
- Once the response is submitted, the attachment cannot be replaced, updated, or deleted.
- Rejected evidence is preserved.
- Clarification uses a new response and new attachment records.
- Existing source documents are linked, never copied or silently reclassified.

### 6.5 Table: `evidence_request_history`

| Column | Type | Rules |
|---|---|---|
| `id` | `uuid` | Primary key |
| `request_id` | `uuid` | Not null; FK; `ON DELETE RESTRICT` |
| `previous_status` | `text` | Nullable only for creation |
| `next_status` | `text` | Not null |
| `actor_user_id` | `uuid` | Not null; FK to `auth.users(id)` |
| `actor_role` | `text` | `ddp_admin` or `farmer` |
| `event_type` | `text` | Canonical event type |
| `response_id` | `uuid` | Nullable FK |
| `attachment_id` | `uuid` | Nullable FK |
| `note` | `text` | Required for clarification, resolution, rejection, cancellation |
| `event_data` | `jsonb` | Not null; default `{}`; non-authoritative metadata only |
| `created_at` | `timestamptz` | Not null; default `now()` |

Canonical event types:

- `request_created`
- `response_submitted`
- `clarification_requested`
- `request_resolved`
- `response_rejected`
- `request_cancelled`
- `attachment_uploaded`
- `existing_document_linked`

History rows are append-only. No authenticated role may update or delete them.

### 6.6 Deletion policy

Permanent deletion is prohibited for:

- Requests
- Submitted responses
- Submitted attachments
- History

Targets referenced by requests use `ON DELETE RESTRICT`.

Draft response and draft attachment cleanup is permitted only before submission. No end-user “delete request” operation exists.

### 6.7 Atomic mutation functions

All workflow state changes must be implemented as database functions with:

- `SECURITY DEFINER`
- Explicit `SET search_path`
- Explicit role and ownership checks
- Explicit request row locking
- Explicit revision checks
- No reliance on caller-provided role claims
- Minimal `EXECUTE` grants
- Revoked public execution
- Transactional request update and history insert

Canonical RPC names:

- `create_evidence_request`
- `get_or_create_evidence_response_draft`
- `save_evidence_response_draft`
- `reserve_evidence_attachment`
- `finalize_evidence_attachment`
- `remove_draft_evidence_attachment`
- `link_existing_evidence_document`
- `submit_evidence_response`
- `request_evidence_clarification`
- `resolve_evidence_request`
- `reject_evidence_response`
- `cancel_evidence_request`

Direct browser `INSERT`, `UPDATE`, and `DELETE` permissions on workflow tables are denied.

### 6.8 Delivered database phase [v1.5]

The §6 database contract, the §7 storage contract and the §8 RLS matrix are
**implemented and merged** as repository migration 24, delivered by PR #37
(merge commit `9496e1c`, reviewed head `fd57135`) at contract v1.4. The
authoritative files are, at the repository root (which IS the migration
directory — there is no `migrations/` or `supabase/` directory):

```text
24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql
24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql
24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql
24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql
```

These names are now binding and supersede the §14 template
`<migration-dir>/<N>_EVIDENCE_REQUEST_WORKFLOW*.sql`. Merged, reviewed SQL is
not renamed to satisfy a naming template. The delivered family has FOUR members:
the storage bucket and its `storage.objects` policies are a separate companion
file because `CREATE POLICY` on `storage.objects` requires an ownership context
the main migration cannot assume.

No new migration number is allocated for the contracted workflow. A migration 25
is created ONLY if a defect is found in migration 24, and only for that defect.

**Runtime status is not implementation status.** Migration 24 is `NOT_APPLIED`
to staging and `NOT_APPLIED` to production. The only runtime evidence is
disposable local PostgreSQL. §16 Phase 8's database-first ordering therefore
still governs in full, and is mandatory rather than optional because merging to
`main` automatically deploys production (see §16 Phase 8 note [v1.5]).

### 6.9 Accepted deviations in the delivered database phase [v1.5]

This section is the authoritative statement of the v1.5 amendment. Exactly two
deviations from the §6.4 column table are accepted. Both are recorded here so
that §17 stop condition 24 is satisfied by a versioned amendment rather than by
silence. No third deviation is accepted, and neither of these may be widened.

**(a) `evidence_request_attachments.size_bytes` is nullable for linked existing
documents.** §6.4 specifies `NOT NULL`. `public.farmer_documents` and
`public.documents` carry no size column, so a byte count for a linked row would
be fabricated data. The delivered constraint set is stricter where it matters: a
CHECK requires `size_bytes IS NOT NULL` whenever `origin = 'request_upload'`, and
a second CHECK requires `size_bytes > 0` whenever present. Consequence, recorded
explicitly: the 150 MB aggregate per-response limit counts uploaded bytes only.
The already-in-file `CONTRACT DEVIATION` comment in
`24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql` is ratified by this clause.

**(b) `evidence_request_attachments` carries no `draft_owner_user_id` column.**
§6.4 lists one; the delivered schema places `draft_owner_user_id` only on
`evidence_request_responses`. This is a correction to §6.4, not a defect, because
§4.8 — which is authoritative on edit authority and ownership handoff — states
that "Attachments retain their original creators" and that
`evidence_request_attachments.created_by_user_id` "is never rewritten by
handoff". A mutable per-attachment owner column would contradict §4.8. The
edit-authority boundary the contract actually requires is enforced, in the
delivered RPCs, by gating every attachment mutation on the RESPONSE's current
`draft_owner_user_id`:

- `reserve_evidence_attachment` requires `state = 'draft'` AND
  `resp.draft_owner_user_id = auth.uid()`.
- `finalize_evidence_attachment` requires the caller to be the attachment's own
  `created_by_user_id` (§7.4 [v1.1] reservation binding).
- `remove_draft_evidence_attachment` and `link_existing_evidence_document`
  require `resp.draft_owner_user_id = auth.uid()`.
- Post-submission tombstone cleanup (§7.9) requires the FROZEN
  `resp.draft_owner_user_id`, as §7.9(3) specifies.

Accordingly, in §6.4 the `draft_owner_user_id` row is struck and
`created_by_user_id` remains the attachment's sole, immutable principal column.
§6.3's `draft_owner_user_id` on `evidence_request_responses` is unchanged and
remains mandatory.

---

## 7. Attachment and Storage Contract

### 7.1 Bucket

Canonical private bucket:

```text
evidence-request-files
```

The bucket is private. No public URLs are permitted.

### 7.2 Canonical path

```text
<farm_id>/<request_id>/<response_id>/<attachment_id>/<sanitized_filename>
```

Rules:

- All identifiers are UUIDs.
- Path identifiers must match database records.
- The farmer must be authorized for `farm_id`.
- The request must belong to `farm_id`.
- The response must belong to the request.
- The response must be `draft`.
- The request status must be `open` or `clarification_requested`.
- The attachment row must be in `pending_upload`.
- The authenticated user must equal the attachment creator.

The original filename is stored separately. The path filename must be sanitized and must not be trusted as metadata.

### 7.3 Allowed formats

| Request category | Allowed MIME types | Maximum individual size |
|---|---|---:|
| `coa` | `application/pdf` | 20 MB |
| `inventory_photo` | `image/jpeg`, `image/png`, `image/webp` | 20 MB |
| `inventory_video` | `video/mp4` | 100 MB |
| All other categories | `application/pdf`, `image/jpeg`, `image/png`, `image/webp` | 20 MB |

Disallowed formats include:

- SVG
- HTML
- JavaScript
- Executables
- Archives
- Office macro formats
- ZIP
- Arbitrary binary files
- MIME types inferred only from filename extension

Both MIME type and extension must be validated. The application must not claim malware scanning unless a real scanning service is later introduced.

### 7.4 Upload sequence

1. Farmer creates or retrieves the draft response.
2. Client requests an upload reservation.
3. RPC creates a `pending_upload` attachment row with the fixed path.
4. Client uploads directly to the private bucket under storage RLS.
5. Client computes SHA-256 with Web Crypto and supplies actual size and MIME metadata.
6. Finalization RPC validates path ownership, object existence, size, format, and request state.
7. Attachment becomes `ready`.
8. Response submission refuses pending or failed attachments.

A failed upload must not create a submitted evidence record.

> **[v1.1]** A request_upload reservation is bound to the farmer who created it.
> After a draft ownership handoff, a reservation created by the former owner
> cannot be finalized by the new owner; it is removed through the controlled
> cleanup protocol and the new owner reserves a replacement. This preserves the
> guarantee that a finalized object was uploaded under the reserving user's own
> client operation.

### 7.5 Existing-document linking

The farmer may link an existing document only when:

- The farmer can already select that document under existing RLS.
- The document belongs to the same farm.
- An inventory document belongs to the targeted inventory batch when applicable.
- The document type is compatible with the request category.
- The request status permits a farmer response.
- The link is attached to the current draft response.

Existing document records are not duplicated and are not automatically added to a Buyer Pack.

### 7.6 Read access

- Authorized farmer: may read attachments for requests belonging to an authorized farm.
- DDP administrator: may read all request attachments.
- Pending user: no access.
- Anonymous user: no access.
- Buyer/public route: no access.
- Service role: platform bypass only; never exposed to browser code.

### 7.8 Durable request-upload tombstones [v1.2]

This section is the authoritative statement of the v1.2 amendment.

1. **Removal of a request-specific upload is logically destructive, but its
   database attachment record is RETAINED as a tombstone.** For
   `origin = 'request_upload'`, once `removal_requested_at IS NOT NULL` the
   attachment row is never hard-deleted.
2. **`removal_requested_at IS NOT NULL` means the request-upload attachment is no
   longer active evidence.**
3. A tombstoned request-upload: cannot be uploaded again; cannot be finalized;
   cannot be submitted as evidence; does not count toward the per-response
   attachment limit; does not count toward the aggregate size limit; does not
   satisfy the "response has evidence" requirement; is not farmer-readable through
   Storage SELECT by other farm members; and remains available **solely** to
   authorize cleanup of any current or late-arriving object.
4. `created_by_user_id`, storage path, request ID, response ID and provenance
   remain immutable. `removal_requested_at` is immutable once set (NULL→timestamp
   only; never cleared or changed).
5. **A late-arriving storage object is residue, not submitted evidence, and remains
   deletable because its tombstone survives.**
6. No claim is made that absence from `storage.objects` proves no upload can
   subsequently commit. `REMOVED` means "no object present now", never "no object
   can ever arrive".
7. **Existing-document links (`existing_farm_document`, `existing_inventory_document`)
   are not subject to this cross-system race** and keep the existing controlled
   draft-unlink (hard-delete) semantics; they do not become permanent tombstones.
8. **Storage read of a tombstone** is permitted ONLY to the current draft owner,
   solely so the controlled cleanup DELETE can locate the object (PostgreSQL
   requires SELECT visibility for a WHERE-clause DELETE). Other farm members never
   read a tombstone; a non-tombstoned pending object is readable by no one. This
   preserves the v1.1/pending-upload guarantee that unvalidated content is not
   exposed across farm members.

### 7.9 Post-submission tombstone cleanup [v1.3]

A request_upload tombstone (§7.8) was removed while the response was a draft and
is NOT submitted evidence. Its cleanup authority therefore CONTINUES after the
response becomes `submitted` and after the request becomes `farmer_submitted`,
`resolved`, `rejected` or `cancelled` — for as long as the tombstone row exists.

1. **Cleanup-only.** The continuation permits ONLY locating and deleting the
   physical late-arriving storage object bound to the tombstone's exact path, and
   reporting that state. It does NOT permit: marking a new attachment removed after
   submission; removing a genuine submitted attachment; modifying submitted
   attachment metadata; replacing submitted evidence; editing a submitted response;
   or reopening a request.
2. **Creation boundary.** A NEW tombstone may be created only while the response is
   a draft. After submission, `removal_requested_at NULL → timestamp` is impossible;
   only cleanup of an already-marked tombstone continues.
3. **Frozen cleanup principal.** After submission `draft_owner_user_id` is frozen;
   its edit-authority meaning ends, but for pre-existing tombstones it also
   identifies the final authorised cleanup principal. A former owner (pre-handoff)
   and same-farm non-owners cannot clean it; cross-farm/pending/anon see nothing.
4. **Submitted-evidence immutability.** A submitted attachment is canonical evidence
   only when `removal_requested_at IS NULL`. A tombstone is excluded from the
   submitted evidence set even when its parent response is submitted. Cleanup never
   deletes or mutates a `removal_requested_at IS NULL` submitted attachment.
5. Cleanup authorization must NOT depend on `response.state = 'draft'` or on the
   request remaining actionable, but MUST still require the exact
   bucket/attachment/path, `origin='request_upload'`, `removal_requested_at IS NOT
   NULL`, the frozen draft owner, and current operational farm access.

### 7.10 Storage bucket size ceiling [v1.4]

1. `evidence-request-files` remains a PRIVATE bucket (public = false); no public
   URLs are ever permitted.
2. Its platform bucket configuration carries a maximum individual object size of
   **104857600 bytes / 100 MiB** (`file_size_limit`).
3. This is an ABSOLUTE storage boundary only, enforced by the Supabase Storage
   server before it accepts bytes.
4. Category-specific limits remain authoritative and may be lower:
   `coa` ≤ 20 MiB, `inventory_photo` ≤ 20 MiB, `inventory_video` ≤ 100 MiB, all
   other categories ≤ 20 MiB. A 50 MiB PDF still fails even though the bucket
   permits objects up to 100 MiB.
5. `reserve_evidence_attachment` still validates the declared category size.
6. `finalize_evidence_attachment` still validates the actual stored size.
7. The 150 MiB aggregate per-response limit is unchanged.
8. The 100 MiB bucket ceiling is defense-in-depth against oversized pending or
   abandoned uploads; it is NOT evidence validation by itself.
9. No malware-scanning or content-inspection guarantee is introduced by this
   amendment.

### 7.7 Replacement rule

There is no replacement after submission.

Before submission, a farmer may remove a draft attachment and add another. After submission, a replacement is represented by a new response cycle following clarification.

---

## 8. RLS and Permission Matrix

### 8.1 Canonical authorization helper

The implementation must use one canonical farm authorization predicate:

```sql
can_operationally_access_farm(target_farm_id uuid)
```

It must return true only when:

- The authenticated profile role is `farmer`.
- `has_operational_farmer_access()` is true.
- The authenticated user has an active membership for the farm.
- The membership grants operational access under the existing farm-membership model.

Administrators use the existing authoritative DDP-admin predicate.

No policy may grant access merely because the user is `authenticated`.

### 8.2 Table permissions

#### `evidence_requests`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `ddp_admin` | All | RPC only | RPC only | Never |
| `farmer` | Authorized farm only | Never | Never directly; submission RPC changes status | Never |
| `pending` | None | None | None | None |
| `anon` | None | None | None | None |
| `service_role` | Platform bypass | Server/migration only | Server/migration only | Operational deletion prohibited |

#### `evidence_request_responses`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `ddp_admin` | All | Never as farmer | Never | Never |
| `farmer` | Authorized farm only | RPC creates draft | RPC edits own draft only | RPC may remove draft only |
| `pending` | None | None | None | None |
| `anon` | None | None | None | None |
| `service_role` | Platform bypass | Restricted server use | Restricted server use | Draft cleanup only |

#### `evidence_request_attachments`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `ddp_admin` | All | Never as farmer | Never | Never |
| `farmer` | Authorized farm only | RPC reservation/link only | RPC finalize pending upload only | RPC removes own draft attachment only |
| `pending` | None | None | None | None |
| `anon` | None | None | None | None |
| `service_role` | Platform bypass | Restricted server use | Restricted server use | Orphan/draft cleanup only |

#### `evidence_request_history`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `ddp_admin` | All | Transition RPC only | Never | Never |
| `farmer` | Authorized farm only | Transition RPC only | Never | Never |
| `pending` | None | None | None | None |
| `anon` | None | None | None | None |
| `service_role` | Platform bypass | Controlled audit/migration only | Never | Never |

### 8.3 Storage permissions

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `ddp_admin` | Objects linked to evidence records | None | None | None |
| `farmer` | Authorized request objects | Reserved draft path only | None | Own draft object only |
| `pending` | None | None | None | None |
| `anon` | None | None | None | None |
| `service_role` | Platform bypass | Cleanup/server only | Cleanup/server only | Orphan cleanup only |

### 8.4 Non-disclosure rule

For request-detail reads, an unauthorized request ID must return `NOT_FOUND`, not a message confirming that the request exists for another farm.

### 8.5 Browser prohibition

The browser must never:

- Use a service-role key.
- Directly update request status.
- Directly insert history.
- Trust a role passed by the client.
- Trust a farm ID supplied by the client without target validation.
- Treat client-side list filtering as authorization.

---

### 8.6 Internal helper execution [v1.3]

Internal implementation helpers are not public or service entry points. `service_role`
may execute only the explicitly-approved public validated RPCs. Internal
transition/locking/serialization/value helpers — including `evidence_apply_transition`,
`evidence_lock_visible_request`, `evidence_request_as_json`, `evidence_actor_role` and
the value helpers — receive NO direct EXECUTE for PUBLIC, anon, authenticated OR
service_role, unless an individual call-site (e.g. an RLS policy PostgreSQL evaluates
as that role) genuinely requires it and that requirement is documented. Supabase's
default service_role EXECUTE grant on new public functions is explicitly revoked for
these helpers; the SECURITY DEFINER wrappers still reach them because they run as the
function owner, not the caller.

## 9. TypeScript and Service Contract

### 9.1 Canonical domain types

```ts
export type EvidenceRequestStatus =
  | 'open'
  | 'farmer_submitted'
  | 'clarification_requested'
  | 'resolved'
  | 'rejected'
  | 'cancelled';

export type EvidenceRequestPriority =
  | 'low'
  | 'normal'
  | 'high'
  | 'urgent';

export type EvidenceRequestTargetType =
  | 'farm_profile'
  | 'inventory_batch';

export type EvidenceResponseState =
  | 'draft'
  | 'submitted';

export type EvidenceAttachmentOrigin =
  | 'request_upload'
  | 'existing_farm_document'
  | 'existing_inventory_document';

export type EvidenceRequestActorRole =
  | 'ddp_admin'
  | 'farmer';
```

### 9.2 Request shape

```ts
export interface EvidenceRequest {
  id: string;
  farmId: string;
  target:
    | { type: 'farm_profile'; farmProfileId: string }
    | { type: 'inventory_batch'; inventoryBatchId: string };
  category: EvidenceRequestCategory;
  title: string;
  explanation: string;
  priority: EvidenceRequestPriority;
  dueDate: string | null;
  status: EvidenceRequestStatus;
  revision: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  closedAt: string | null;
}
```

### 9.3 Service result

All service methods return a discriminated result:

```ts
export type EvidenceServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: EvidenceServiceError };

export interface EvidenceServiceError {
  code:
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'VALIDATION_ERROR'
    | 'INVALID_TRANSITION'
    | 'CONFLICT'
    | 'TARGET_UNAVAILABLE'
    | 'UPLOAD_NOT_READY'
    | 'FILE_TYPE_NOT_ALLOWED'
    | 'FILE_TOO_LARGE'
    | 'STORAGE_ERROR'
    | 'DATA_UNAVAILABLE'
    | 'UNKNOWN';
  message: string;
  field?: string;
  retryable: boolean;
}
```

UI code must not infer an empty list from an error.

### 9.4 Canonical service methods

```ts
createEvidenceRequest(
  input: CreateEvidenceRequestInput
): Promise<EvidenceServiceResult<EvidenceRequest>>;

listAdminEvidenceRequests(
  filters: AdminEvidenceRequestFilters
): Promise<EvidenceServiceResult<EvidenceRequestListItem[]>>;

listFarmerEvidenceRequests(
  filters: FarmerEvidenceRequestFilters
): Promise<EvidenceServiceResult<EvidenceRequestListItem[]>>;

getEvidenceRequest(
  requestId: string
): Promise<EvidenceServiceResult<EvidenceRequestDetail>>;

getOrCreateEvidenceResponseDraft(
  input: { requestId: string; expectedRequestRevision: number }
): Promise<EvidenceServiceResult<EvidenceResponseDraft>>;

saveEvidenceResponseDraft(
  input: {
    requestId: string;
    responseId: string;
    responseText: string;
  }
): Promise<EvidenceServiceResult<EvidenceResponseDraft>>;

reserveEvidenceAttachment(
  input: {
    requestId: string;
    responseId: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
  }
): Promise<EvidenceServiceResult<EvidenceUploadReservation>>;

finalizeEvidenceAttachment(
  input: {
    requestId: string;
    responseId: string;
    attachmentId: string;
    sha256Hex: string;
    actualSizeBytes: number;
    actualMimeType: string;
  }
): Promise<EvidenceServiceResult<EvidenceAttachment>>;

removeDraftEvidenceAttachment(
  input: {
    requestId: string;
    responseId: string;
    attachmentId: string;
  }
): Promise<EvidenceServiceResult<void>>;

linkExistingEvidenceDocument(
  input: LinkExistingEvidenceDocumentInput
): Promise<EvidenceServiceResult<EvidenceAttachment>>;

submitEvidenceResponse(
  input: {
    requestId: string;
    responseId: string;
    expectedRequestRevision: number;
  }
): Promise<EvidenceServiceResult<EvidenceRequestDetail>>;

requestEvidenceClarification(
  input: {
    requestId: string;
    reviewedResponseId: string;
    reason: string;
    expectedRequestRevision: number;
  }
): Promise<EvidenceServiceResult<EvidenceRequestDetail>>;

resolveEvidenceRequest(
  input: {
    requestId: string;
    reviewedResponseId: string;
    resolutionNote: string;
    expectedRequestRevision: number;
  }
): Promise<EvidenceServiceResult<EvidenceRequestDetail>>;

rejectEvidenceResponse(
  input: {
    requestId: string;
    reviewedResponseId: string;
    rejectionReason: string;
    expectedRequestRevision: number;
  }
): Promise<EvidenceServiceResult<EvidenceRequestDetail>>;

cancelEvidenceRequest(
  input: {
    requestId: string;
    cancellationReason: string;
    expectedRequestRevision: number;
  }
): Promise<EvidenceServiceResult<EvidenceRequestDetail>>;

listEvidenceRequestHistory(
  requestId: string
): Promise<EvidenceServiceResult<EvidenceRequestHistoryEvent[]>>;
```

### 9.5 State replacement rule

Successful service reads replace the prior scope data. They do not merge across:

- User IDs
- Roles
- Farms
- Request IDs
- Route instances

Mutation results replace the current request detail with the returned authoritative database representation.

### 9.6 Empty versus unavailable

- Successful list with no records: `{ ok: true, data: [] }`.
- Failed list: `{ ok: false, error: ... }`.
- The application must never transform a failed load into `[]`.
- “No requests” is shown only after a successful empty result.
- Operations Desk must not show an all-clear state when evidence-request data is loading, failed, or unavailable.

### 9.7 Stale-load and account-switch rules

Every request load is scoped by:

```text
authenticated_user_id + role + route + request_id/filter
```

Required behavior:

- Account change clears protected data immediately.
- Role change clears protected data immediately.
- Farm-scope change clears protected data immediately.
- Late responses from a previous scope are discarded.
- `AbortController` or an equivalent request-generation token is mandatory.
- Same-user token refresh starts a new pending load.
- Previous data may remain in memory but must not be rendered as current while refetching.
- A stale mutation conflict forces a reload and explicit user retry.
- No stale administrator data may appear to a farmer.
- No farmer A data may appear to farmer B.

---

## 10. UI and Routing Contract

### 10.1 Routing architecture

The existing application route mechanism remains authoritative. This feature must not introduce a new routing library.

Canonical logical page IDs:

```ts
'admin-evidence-requests'
'admin-evidence-request-create'
'admin-evidence-request-detail'
'farmer-requests'
'farmer-evidence-request-detail'
```

Canonical route payloads:

```ts
type AdminEvidenceRequestCreateRoute = {
  page: 'admin-evidence-request-create';
  targetType?: 'farm_profile' | 'inventory_batch';
  targetId?: string;
};

type AdminEvidenceRequestDetailRoute = {
  page: 'admin-evidence-request-detail';
  requestId: string;
};

type FarmerEvidenceRequestDetailRoute = {
  page: 'farmer-evidence-request-detail';
  requestId: string;
};
```

No public deep-link route is required for the MVP.

### 10.2 Administrator request list

**Page:** `admin-evidence-requests`

Purpose:

- Authoritative administrator list and archive.
- Filter by active/closed status, priority, category, and target type.
- Create a new request.
- Open request detail.

States:

- Loading: skeleton or explicit loading panel.
- Empty: shown only after successful load.
- Failure: persistent error panel with retry.
- Partial target failure: request remains visible with “Target unavailable — human review required.”
- No all-clear language on failed or incomplete loads.

Actions:

- Create request.
- Open request.
- No inline status mutation.

### 10.3 Administrator create page

**Page:** `admin-evidence-request-create`

Entry points:

- Administrator request list.
- Farm Review with farm profile preselected.
- Inventory Review with inventory batch preselected.

Fields:

- Target type.
- Target.
- Category filtered by target type.
- Title.
- Explanation.
- Priority.
- Optional due date.

Rules:

- Target data must load from authoritative services.
- Disabled submit while target unavailable, form invalid, or mutation pending.
- Duplicate clicks must not create duplicate requests.
- Success navigates to the created request detail.
- Failure preserves typed form content and displays a non-success state.

The Operations Desk must not contain a create action.

### 10.4 Administrator detail/review page

**Page:** `admin-evidence-request-detail`

Purpose:

- Authoritative request review.
- Display request instructions, target, status, priority, due date, responses, attachments, and history.
- Perform clarification, resolution, rejection, or cancellation.

Actions by status:

| Status | Allowed administrator actions |
|---|---|
| `open` | Cancel |
| `farmer_submitted` | Request clarification, resolve, reject, cancel |
| `clarification_requested` | Cancel |
| Terminal | None |

Rules:

- Review actions require an explicit confirmation section and mandatory note.
- Buttons disable while mutation is pending.
- Conflict response reloads the request and does not silently apply the prior action.
- Target-unavailable requests remain reviewable for cancellation and history inspection.
- Administrator cannot edit farmer response text or attachments.
- Administrator cannot upload evidence as the farmer.

### 10.5 Farmer requests list

**Page:** existing `farmer-requests`

Tabs:

- **Needs response:** `open`, `clarification_requested`
- **Submitted:** `farmer_submitted`
- **Closed:** `resolved`, `rejected`, `cancelled`

Each row displays:

- Title
- Category label
- Farm or batch target
- Status label
- Priority
- Due date
- Last status-change age
- Action label: `Open request`

States:

- Loading, empty, and failure are distinct.
- No request from an unauthorized farm may appear.
- Closed requests remain readable.
- Failed loads never display “No requests.”

### 10.6 Farmer detail and response page

**Page:** `farmer-evidence-request-detail`

Purpose:

- Read administrator request.
- View target.
- Review earlier submissions and administrator notes.
- Create or edit the current draft.
- Upload or link evidence.
- Submit for human review.

Editable only when status is:

- `open`
- `clarification_requested`

Read-only when status is:

- `farmer_submitted`
- `resolved`
- `rejected`
- `cancelled`

Submission requirements:

- Response text or at least one ready attachment.
- No pending upload.
- No upload error.
- Request revision unchanged.
- Farmer remains authorized at submission time.

Clarification display:

- The administrator’s clarification reason is prominent.
- Previous submitted response and evidence remain visible.
- New response starts as a separate draft.

### 10.7 Farm Review integration

Farm Review receives one administrator-only action:

```text
Request evidence
```

It opens the create page with:

- `targetType = farm_profile`
- Current farm profile ID preselected

Farm Review does not write request records itself.

### 10.8 Inventory Review integration

Inventory Review receives one administrator-only action:

```text
Request evidence
```

It opens the create page with:

- `targetType = inventory_batch`
- Current inventory batch ID preselected

Inventory Review does not write request records itself.

---

## 11. Operations Desk Contract

### 11.1 Desk role

The Operations Desk remains:

- Read-only
- Aggregation-only
- Navigation-only

It must not:

- Create a request
- Resolve a request
- Reject evidence
- Request clarification
- Cancel a request
- Upload evidence
- Mutate a response

### 11.2 Included statuses

Active desk rows include:

- `open`
- `clarification_requested`
- `farmer_submitted`

The desk excludes:

- `resolved`
- `rejected`
- `cancelled`

Closed requests remain available in the administrator request archive.

### 11.3 Canonical row

| Field | Rule |
|---|---|
| Queue category | `Evidence requests` |
| Title | Request title |
| Subtitle | Status label plus farm or batch summary |
| Priority | Request priority |
| Age | Time since `status_changed_at` |
| Target | Farm profile or inventory batch label |
| Action label | `Open request` |
| Route | `admin-evidence-request-detail` with request ID |

### 11.4 Target-unavailable behavior

A missing or unavailable target must not remove the row.

Display:

```text
Target unavailable — human review required
```

Action still opens the evidence-request detail page.

### 11.5 Loading and failure behavior

- Loading evidence requests prevents an all-clear state.
- Evidence-request load failure prevents an all-clear state.
- Partial data prevents an all-clear state.
- The desk displays a visible unavailable-data item with retry/navigation guidance.
- An empty active queue is valid only after a successful complete load.

### 11.6 Priority ordering

Canonical order:

1. Urgent overdue
2. Urgent
3. High overdue
4. High
5. Normal overdue
6. Normal
7. Low overdue
8. Low

Within the same group, oldest `status_changed_at` first.

---

## 12. Audit History Contract

### 12.1 Mandatory events

| Event | Required |
|---|:---:|
| Request created | Yes |
| Farmer response submitted | Yes |
| Clarification requested | Yes |
| Request resolved | Yes |
| Evidence rejected | Yes |
| Request cancelled | Yes |
| New upload finalized | Yes |
| Existing document linked | Yes |

### 12.2 Event content

Every history event records:

- Request ID
- Previous status
- Next status
- Actor user ID
- Actor role
- Event type
- Response ID when applicable
- Attachment ID when applicable
- Required note or reason when applicable
- Timestamp

### 12.3 Atomicity

A request transition and its history event must succeed or fail together.

It is invalid for:

- Status to change without history.
- History to claim a transition that did not occur.
- A submitted response to exist without a `response_submitted` event.
- A terminal request to lack its terminal history event.

### 12.4 Immutability

- No application role can update history.
- No application role can delete history.
- Corrective information is represented by a later event, not by editing an earlier event.
- History notes must not contain automatic compliance conclusions.

---

## 13. Parallel Agent Workstreams

### 13.1 Integration Lead

**Branch**

```text
feature/evidence-request-workflow
```

**Worktree**

```text
../ddp-wt-evidence-integration
```

Responsibilities:

- Repository and migration-number audit.
- Freeze this contract.
- Create shared TypeScript contracts.
- Own all central files.
- Allocate migration number.
- Integrate agent branches.
- Resolve conflicts.
- Wire routes and central navigation.
- Wire Operations Desk aggregation.
- Implement the shared service adapter.
- Run integrated validation.
- Prepare the review PR.
- Control merge and deployment.

Only the Integration Lead may change shared central files during integration.

### 13.2 Agent A — Database and RLS

**Branch**

```text
agent/evidence-db-rls
```

**Worktree**

```text
../ddp-wt-evidence-db
```

Owns:

- Schema migration.
- RLS policies.
- Storage bucket and storage policies.
- RPC functions.
- Validation triggers.
- Rollback SQL.
- Verification SQL.
- Database-focused behavioral tests.

Must not touch:

- `src/App.tsx`
- UI components
- Shared route definitions
- Operations Desk TypeScript
- Shared TypeScript domain files
- Buyer Pack code
- Compliance Watchtower code

### 13.3 Agent B — Administrator Workflow

**Branch**

```text
agent/evidence-admin-workflow
```

**Worktree**

```text
../ddp-wt-evidence-admin
```

Owns:

- Administrator request list.
- Administrator create page.
- Administrator detail/review page.
- Administrator page-level tests.
- New administrator evidence UI styles.
- Farm Review and Inventory Review integration adapters.
- Operations Desk row adapter, but not the central aggregator.

Must not touch:

- SQL migrations
- `src/App.tsx`
- `src/types.ts`
- `src/lib/db.ts`
- Shared service implementation
- Shared route definitions
- Shared storage constants
- Central Operations Desk aggregation
- Farmer pages

### 13.4 Agent C — Farmer Workflow

**Branch**

```text
agent/evidence-farmer-workflow
```

**Worktree**

```text
../ddp-wt-evidence-farmer
```

Owns:

- Farmer request list integration.
- Farmer request detail.
- Draft response form.
- Attachment upload and existing-document selection UI.
- Farmer page-level tests.
- New farmer evidence UI styles.

Must not touch:

- SQL migrations
- `src/App.tsx`
- `src/types.ts`
- `src/lib/db.ts`
- Shared service implementation
- Shared route definitions
- Shared storage constants
- Central Operations Desk aggregation
- Administrator pages

### 13.5 Agent D — Tests and Safety Audit

**Branch**

```text
agent/evidence-tests-safety
```

**Worktree**

```text
../ddp-wt-evidence-tests
```

Owns:

- Transition matrix tests.
- Authorization isolation tests.
- Upload-security tests.
- Stale-load and account-switch tests.
- Terminology guards.
- Operations Desk failure-state tests.
- Buyer Pack and Watchtower regression tests.
- Final contract conformance report.

Must not make production behavior changes. If a defect is found, Agent D reports it to the Integration Lead with a minimal reproduction. The owning agent or Integration Lead applies the fix.

### 13.6 Conflict prevention

- Agents branch from the exact frozen integration base SHA.
- No agent rebases after work begins without Integration Lead instruction.
- No agent merges another agent’s branch.
- No agent edits central shared files.
- No agent allocates a migration number.
- No agent opens or merges the final production PR.
- No agent deploys.
- No agent changes the contract.
- Contract deviations require written Integration Lead approval before implementation.
- Agents commit only their owned files.
- Every handoff must have a clean working tree.

### 13.7 Handoff format

Each agent returns:

1. Branch name.
2. Exact head SHA.
3. Base SHA.
4. Changed file list.
5. Tests run and results.
6. Validation not run and reason.
7. Contract clauses implemented.
8. Known limitations.
9. Security assumptions.
10. Confirmation that prohibited files were not changed.
11. Confirmation that the worktree is clean.
12. Any requested Integration Lead changes.

---

## 14. File Ownership Matrix

The exact migration directory is confirmed during Phase 0. The naming template is binding.

**[v1.5]** Phase 0 confirmed the migration directory is the **repository root**,
and that the SQL rows below were already delivered as migration 24 under the
names fixed in §6.8. The four delivered filenames supersede the
`<N>_EVIDENCE_REQUEST_WORKFLOW*` template for this feature. The remaining rows
are unchanged.

| Area/file | Owner |
|---|---|
| `src/App.tsx` | Integration Lead only |
| `src/types.ts` | Integration Lead only |
| `src/lib/db.ts` | Integration Lead only |
| `src/domain/evidenceRequests.ts` | Integration Lead only |
| `src/lib/evidenceRequests.ts` | Integration Lead only |
| `src/lib/evidenceRequestRoutes.ts` | Integration Lead only |
| `src/lib/evidenceRequestStorage.ts` | Integration Lead only |
| Shared route definitions | Integration Lead only |
| Central navigation registration | Integration Lead only |
| Central Operations Desk aggregation | Integration Lead only |
| SQL migration number | Integration Lead only |
| `24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql` **[v1.5] delivered** | Agent A |
| `24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql` **[v1.5] delivered** | Agent A |
| `24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql` **[v1.5] delivered** | Agent A |
| `24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql` **[v1.5] delivered** | Agent A |
| Database and storage behavioral tests | Agent A |
| `src/pages/admin/evidence/**` | Agent B |
| Farm/Inventory Review evidence adapters | Agent B |
| Admin evidence page tests | Agent B |
| `src/pages/farmer/evidence/**` | Agent C |
| Farmer request-list evidence component | Agent C |
| Farmer evidence page tests | Agent C |
| New cross-feature safety tests | Agent D |
| Contract conformance report | Agent D |
| Final conflict resolution | Integration Lead only |
| Final PR and deployment | Integration Lead only |

If an existing repository layout differs, the Integration Lead maps these logical ownership areas to the existing directories before agents start. Agents do not independently choose alternative locations.

---

## 15. Test and Security Matrix

### 15.1 Transition tests

Required tests:

- Create request: administrator succeeds.
- Create request: farmer denied.
- Create request: pending denied.
- Create request: anonymous denied.
- Every allowed transition succeeds.
- Every unlisted transition fails.
- Terminal statuses reject all later transitions.
- Clarification requires a reason.
- Resolution requires a reason and current response ID.
- Rejection requires a reason and current response ID.
- Cancellation requires a reason.
- Farmer submission requires response text or ready attachment.
- Farmer submission rejects pending attachment.
- Repeated submission while already submitted fails.
- Old response ID cannot be resolved, rejected, or clarified.
- Revision mismatch returns conflict.
- Transition and history event are atomic.

### 15.2 Authorization tests

- Farmer A can see requests for farmer A farms.
- Farmer A cannot see farmer B requests.
- Farmer B cannot infer farmer A request existence by ID.
- Administrator can see all requests.
- Pending user has no request access.
- Anonymous user has no request access.
- Farm-level request uses farm-profile ownership.
- Inventory-level request uses inventory-batch ownership.
- Removed or inactive membership revokes access.
- Client-supplied unrelated farm ID is rejected.
- Direct table writes from authenticated clients are denied.
- Browser service role is absent.

### 15.3 Attachment tests

- Allowed PDF upload succeeds for compatible category.
- Allowed image upload succeeds.
- MP4 succeeds only for `inventory_video`.
- SVG rejected.
- HTML rejected.
- Executable rejected.
- MIME/extension mismatch rejected.
- Oversized PDF/image rejected.
- Oversized MP4 rejected.
- Aggregate response limit enforced.
- More than ten attachments rejected.
- Path with another farm ID rejected.
- Path with another request ID rejected.
- Path with another response ID rejected.
- Upload to submitted response rejected.
- Upload while request is `farmer_submitted` rejected.
- Existing document from another farm rejected.
- Existing inventory document from another batch rejected for COA.
- Draft attachment may be removed.
- Submitted attachment cannot be removed or replaced.
- Rejected evidence remains readable and unchanged.
- Storage objects are private.
- Public URL access fails.

### 15.4 Loading and account-state tests

- Account switch clears current request before new load.
- Farmer A to farmer B switch never renders farmer A data.
- Administrator to farmer switch never renders administrator data.
- Same-user token refresh marks refetch pending.
- Late stale response is discarded.
- Late stale mutation result is discarded.
- Route change discards previous detail response.
- Failed list load is not converted to empty.
- Partial load failure does not show all clear.
- Target-unavailable request remains visible.
- Retry replaces unavailable state with authoritative data.

### 15.5 Operations Desk tests

- Active request statuses appear.
- Terminal statuses do not appear.
- Row routes to administrator request detail.
- Desk cannot mutate requests.
- Failed evidence load blocks all-clear.
- Loading evidence data blocks all-clear.
- Target-unavailable row remains visible.
- Priority and overdue ordering follows the contract.
- Age uses `status_changed_at`.

### 15.6 Audit tests

- Every status transition writes one matching history event.
- No status transition succeeds without history.
- History update denied.
- History delete denied.
- Previous and next statuses are correct.
- Actor user and role are correct.
- Farmer cannot forge administrator event.
- Administrator cannot forge farmer response event.
- Attachment events reference the correct attachment.
- Terminal history event contains the required reason.

### 15.7 Safety-language tests

Guard tests must reject prohibited phrases in new evidence workflow UI copy and generated summaries.

The feature must not automatically label:

- A farm as verified.
- A batch as verified.
- A COA as approved.
- Evidence as compliant.
- A request as proof of export readiness.
- A supplier as approved.
- A product as ready to buy.

### 15.8 Regression tests

Buyer Pack:

- No evidence attachment is automatically included.
- Immutable snapshot generation remains unchanged.
- Existing snapshot hashes remain stable.
- Evidence-request status does not change buyer gating.

Compliance Watchtower:

- No rule is created or approved.
- No alert is automatically resolved.
- No legal or compliance conclusion is inferred.
- Existing human-review controls remain unchanged.

Existing farmer security:

- Operational farmer RLS remains restrictive.
- Pending-user denial remains intact.
- Existing document and storage isolation remains intact.

### 15.9 Validation gates

Before review PR:

- Typecheck passes.
- Lint passes.
- Build passes.
- Full test suite passes.
- New migration tests pass.
- RLS behavioral tests pass.
- Storage isolation tests pass.
- Rollback test passes.
- Verification SQL passes.
- Authenticated browser workflow passes for administrator, farmer A, farmer B, and pending user.

---

## 16. Integration Sequence

### Phase 0 — Repository and migration-number audit

**Preconditions**

- Main branch fetched.
- Working tree clean.
- No active evidence-workflow implementation branch.
- Current production and main SHAs recorded.
- Existing migration directory and highest migration number identified.
- Existing document tables and storage buckets mapped.
- Baseline typecheck, lint, build, and test count recorded.

**Permitted changes**

- None.
- Audit report only.

**Validation gates**

- Confirm actual target ownership columns.
- Confirm farm-membership authorization model.
- Confirm existing `farmer_documents` and `documents` responsibilities.
- Confirm route mechanism.
- Confirm Operations Desk aggregation location.
- Confirm automatic deployment behavior.

**Stop conditions**

- Existing unmerged evidence workflow found.
- Migration-number collision.
- Existing document ownership cannot be established.
- Baseline tests fail.
- Main is moving during contract freeze.

**Completion evidence**

- Signed audit report with base SHA, migration number, file map, and baseline results.

### Phase 1 — Binding contract

**Preconditions**

- Phase 0 complete.
- This document reconciled against repository facts.

**Permitted changes**

- Contract corrections only.
- No application code.

**Validation gates**

- All canonical names frozen.
- File ownership frozen.
- Branch and worktree plan frozen.
- Owner review complete.

**Stop conditions**

- Repository facts contradict a locked design in a security-relevant way.
- Owner changes MVP scope.

**Completion evidence**

- Contract v1.0 marked approved.
- Exact implementation base SHA recorded.

### Phase 2 — Schema and RLS foundation

> **[v1.5] DELIVERED.** This phase is complete in code. It was implemented and
> merged as migration 24 (§6.8) via PR #37, at contract v1.4, with its two
> accepted deviations recorded in §6.9. Phase 2 is NOT re-executed and NO new
> migration number is allocated. Its validation gates below are RETAINED and
> remain outstanding against a hosted database: migration 24 is `NOT_APPLIED` to
> staging and to production, and the only runtime evidence is disposable local
> PostgreSQL. The gates are discharged at the controlled staging apply, before
> Phase 8, not by the merge that landed the SQL.

**Preconditions**

- Contract approved.
- Migration number allocated by Integration Lead.
- Agent A worktree created from frozen base.

**Permitted changes**

- SQL migration, verification, rollback, storage policies, and DB tests only.

**Validation gates**

- Fresh database apply succeeds.
- Existing database upgrade succeeds.
- Verification SQL succeeds.
- Rollback succeeds in test environment.
- Role matrix passes.
- Cross-farm isolation passes.
- Pending and anonymous denial pass.
- Direct authenticated DML denial passes.

**Stop conditions**

- Any policy requires broad authenticated access.
- Existing security policy must be weakened.
- Storage path isolation cannot be expressed safely.
- Transition and history cannot be atomic.
- Rollback damages pre-existing data.

**Completion evidence**

- Agent A handoff with exact SHA and test output.

### Phase 3 — Parallel administrator and farmer implementation

**Preconditions**

- Integration Lead has frozen shared TypeScript interfaces and service stubs.
- Agent B and C branch from the same exact base.

**Permitted changes**

- Agent-owned UI and tests only.
- Mocked service adapter may be used in isolated tests.
- No central route or application wiring.

**Validation gates**

- Page unit tests pass.
- Loading, empty, failure, disabled, and conflict states exist.
- No prohibited terminology.
- No direct Supabase table mutation from page components.
- No agent touches shared files.

**Stop conditions**

- Shared contract needs changing.
- Agent requires direct service-role or direct status update.
- Agent introduces a new router or broad redesign.
- Agent crosses file ownership.

**Completion evidence**

- Separate clean handoffs from Agent B and Agent C.

### Phase 4 — Integration

**Preconditions**

- Agent A, B, and C handoffs complete.
- All branches based on frozen contract.
- Integration worktree clean.

**Permitted changes**

- Integration Lead cherry-picks or selectively integrates.
- Shared service implementation.
- Route registration.
- `App.tsx` wiring.
- Operations Desk aggregation.
- Shared error and load-state wiring.
- Integration fixes.

**Integration order**

1. Shared domain and route contracts.
2. Agent A schema/RLS.
3. Shared service adapter.
4. Agent B administrator UI.
5. Agent C farmer UI.
6. Route and navigation wiring.
7. Operations Desk integration.
8. Agent D tests.
9. Integration-only fixes.

**Validation gates**

- Typecheck, lint, build, and full test suite pass after each major integration step.
- No agent branch is merged wholesale if it modifies prohibited files.
- Diff audit confirms no unrelated behavior changes.

**Stop conditions**

- Contract divergence.
- Unresolved migration collision.
- Cross-role data leakage.
- UI requires weakening RLS.
- Buyer Pack or Watchtower changes appear.

**Completion evidence**

- Clean integration branch.
- Integrated test report.
- File-ownership conformance report.

### Phase 5 — Security verification

**Preconditions**

- Integrated build is green.
- Test environment has administrator, farmer A, farmer B, and pending accounts.

**Permitted changes**

- Security fixes only.
- No scope expansion.

**Validation gates**

- RLS matrix.
- Direct-write denial.
- Cross-farm denial.
- Storage path isolation.
- MIME and size enforcement.
- Audit immutability.
- Stale-load protection.
- No service-role exposure.

**Stop conditions**

- Any cross-tenant read or write.
- Any pending-user operational access.
- Any missing history event.
- Any submitted evidence mutation.
- Any public storage access.
- Any all-clear shown on failed data.

**Completion evidence**

- Security verification report with exact head SHA.

### Phase 6 — Authenticated browser verification

**Preconditions**

- Security verification passes.
- Stable preview environment.
- Required test users available.
- No production mutation.

**Required journeys**

Administrator:

1. Create farm request.
2. Create inventory request.
3. View open request.
4. Review farmer submission.
5. Request clarification.
6. Resolve a resubmission.
7. Reject a separate request.
8. Cancel a request.
9. Verify Operations Desk routing.

Farmer A:

1. View own requests.
2. Create draft.
3. Upload evidence.
4. Link existing evidence.
5. Submit response.
6. Respond to clarification.
7. Verify submitted evidence is read-only.

Farmer B:

1. Confirm farmer A requests are absent.
2. Attempt direct farmer A request URL/ID and receive not found.
3. Attempt cross-farm storage path and fail.

Pending:

1. Confirm no operational request access.

**Validation gates**

- All journeys pass.
- Account switching clears prior data.
- Refresh preserves authoritative status.
- No stale route data.
- No prohibited terminology.
- Layout remains usable at supported desktop and mobile widths.

**Stop conditions**

- Any workflow mismatch.
- Any stale data.
- Any cross-account data.
- Any upload isolation issue.
- Any status displayed differently from database state.

**Completion evidence**

- Browser verification log and screenshots tied to exact preview SHA.

### Phase 7 — Review PR

**Preconditions**

- All earlier phases complete.
- Branch clean and pushed.
- PR diff contains only contracted work.

**Permitted changes**

- Review fixes only.

**Validation gates**

- CI green.
- Exact-head review requested.
- Review explicitly covers current head SHA.
- No unresolved P1 or P2 finding.
- Contract conformance report attached.
- Migration and deployment order documented.

**Stop conditions**

- Review covers an older SHA.
- New finding exists.
- CI is stale or failing.
- Production migration plan is unclear.
- Unrelated changes enter the PR.

**Completion evidence**

- Exact-head clean review and zero unresolved blocking threads.

### Phase 8 — Controlled merge and deployment

**Preconditions**

- Exact-head review clean.
- Production database backup/snapshot complete.
- Automatic deployment behavior confirmed.
- Rollback scripts reviewed.
- Test accounts and post-deploy verification plan ready.

**Required order**

1. Record production application and database state.
2. Apply backward-compatible database migration.
3. Run production-safe verification SQL.
4. Confirm new tables and policies without exposing routes.
5. Merge/deploy application code.
6. Verify production version SHA.
7. Run administrator and farmer smoke tests.
8. Confirm pending and anonymous denial.
9. Confirm Operations Desk does not show false all-clear.
10. Record deployment evidence.

If merging automatically deploys the application, the database migration must be applied and verified **before** the merge.

> **[v1.5] Determined, not assumed.** Merging to `main` DOES automatically deploy
> production. `vercel.json` disables only Vercel's own Git integration
> (`git.deploymentEnabled.main = false`); the `deploy-production` job in
> `.github/workflows/security-ci.yml` runs on every push to `main`, requires the
> `verify` job, and deploys with a pinned Vercel CLI, then polls
> `https://www.ddpbrokerage.com/version.json` until it serves the exact
> `GITHUB_SHA`. The database-first ordering above is therefore MANDATORY for this
> repository, and migration 24 must be applied and verified on staging, then on
> production, BEFORE any application code that calls its RPCs is merged to `main`.

**Stop conditions**

- Migration verification fails.
- Automatic deployment order is uncertain.
- Production app deploys before schema readiness.
- RLS differs from verified environment.
- Smoke test fails.
- Cross-role access appears.
- Rollback path is unavailable.

**Completion evidence**

- Production migration record.
- Production deployment SHA.
- Post-deploy security smoke-test report.
- No unresolved incident.

---

## 17. Stop Conditions

Implementation stops immediately when any of the following occurs:

1. Migration number or migration directory is uncertain.
2. Existing document ownership cannot be mapped safely.
3. A requested design requires broad `authenticated` access.
4. A pending user receives any operational access.
5. Farmer A can read or write farmer B data.
6. A request can target both or neither target type.
7. A caller can choose an unrelated farm scope.
8. A status transition can occur without history.
9. Submitted response or attachment data can be edited or deleted.
10. An administrator can impersonate a farmer response.
11. A farmer can perform an administrator decision.
12. A storage object can be read publicly.
13. MIME, size, or path checks are client-only.
14. A failed load is shown as an empty list.
15. Operations Desk shows all clear with incomplete evidence data.
16. Account switching renders stale protected data.
17. Service-role credentials appear in browser code or build output.
18. Evidence is automatically included in a Buyer Pack.
19. Compliance Watchtower behavior changes.
20. Prohibited approval or compliance language appears.
21. CI or review covers an older head.
22. Production deployment order is not proven.
23. Any agent edits files outside its ownership without approval.
24. Any implementation decision contradicts this contract without a versioned contract amendment.

---

## 18. Time Estimate

### 18.1 Estimated effort

| Work | Agent-hours |
|---|---:|
| Phase 0 repository audit and contract reconciliation | 4–6 |
| Shared contracts and integration scaffolding | 5–8 |
| Database, RPC, RLS, storage, verification, rollback | 14–20 |
| Administrator workflow | 10–14 |
| Farmer workflow | 12–16 |
| Safety and regression testing | 12–18 |
| Integration and conflict resolution | 8–12 |
| Security and authenticated browser verification | 10–16 |
| Review fixes and controlled release preparation | 6–10 |
| **Total** | **81–120 agent-hours** |

### 18.2 Likely elapsed time with parallel agents

Assuming disciplined parallel work and no security redesign:

- **Fast path:** 4 focused working days.
- **Likely path:** 5–7 focused working days.
- **Review or security-finding path:** 7–10 working days.

External review queue time is not included.

### 18.3 Critical path

1. Repository and migration audit.
2. Contract reconciliation.
3. Shared TypeScript/service contract freeze.
4. Database/RLS foundation.
5. Integrated service adapter.
6. Integration of administrator and farmer workflows.
7. Security verification.
8. Authenticated browser verification.
9. Exact-head review.
10. Database-first controlled release.

### 18.4 Work that cannot be parallelized

- Migration-number allocation.
- Final schema naming.
- Shared type and service contract changes.
- `src/App.tsx` wiring.
- Shared route registration.
- Central Operations Desk aggregation.
- Final conflict resolution.
- Integrated RLS verification.
- Authenticated end-to-end verification.
- Exact-head review acceptance.
- Production migration and deployment ordering.

### 18.5 Likely integration risks

- Existing document tables have overlapping responsibilities.
- Existing farmer request terminology conflicts with the new canonical statuses.
- Central `App.tsx` route state is edited by multiple active workstreams.
- Storage policies become too broad to accommodate multiple evidence categories.
- UI code treats failed data as empty.
- Token refresh or account switching renders stale requests.
- Agent branches independently invent status or category values.
- Auto-deployment occurs before production schema readiness.
- Reviewer findings expose a cross-role or stale-state path not covered by unit tests.

---

## 19. Final Locked Decisions

1. The request status enum has exactly six values: `open`, `farmer_submitted`, `clarification_requested`, `resolved`, `rejected`, `cancelled`.
2. `under_review` is not stored.
3. Resolved, rejected, and cancelled are terminal.
4. Rejected requests are not reopened; a new request is required.
5. Cancelled is administrator-only.
6. A request targets exactly one farm profile or inventory batch.
7. `farm_id` is an authoritative derived authorization scope, not caller-selected data.
8. Request core fields are immutable after creation.
9. Submitted responses are append-only and immutable.
10. Clarification creates a new response version.
11. Submitted attachments are immutable and preserved after rejection.
12. Both secure new uploads and links to existing documents are supported.
13. The private bucket is `evidence-request-files`.
14. No public attachment URLs are allowed.
15. Direct browser writes to workflow tables are denied.
16. All transitions occur through atomic RPCs.
17. Every transition writes append-only history in the same transaction.
18. Farmers are authorized by operational role and farm membership.
19. Pending and anonymous users receive no access.
20. Administrators cannot impersonate farmer submissions.
21. Farmers cannot perform administrator decisions.
22. Operations Desk remains read-only and navigation-only.
23. Failed or partial loads never become empty or all-clear states.
24. Account and role changes clear protected state before reload.
25. No evidence is automatically approved or added to Buyer Packs.
26. No Compliance Watchtower decision is created by this workflow.
27. No new routing library is introduced.
28. Central files have one owner: the Integration Lead.
29. Database migration precedes application deployment.
30. Any change to these decisions requires a versioned contract amendment.

---

## 20. Questions Requiring Owner Approval

None for the MVP.

All routine product, security, workflow, storage, status, routing, and integration decisions required to begin implementation are locked in this contract. Any later scope expansion—such as notifications, buyer access, automated reminders, document scanning, or automatic Buyer Pack inclusion—requires a separate owner-approved contract.

---

**CONTRACT STATUS v1.5: APPROVED FOR IMPLEMENTATION.** Phase 0 preflight complete
and signed (2026-07-23). Phase 1 reconciliation complete. Phase 2 delivered as
migration 24 (§6.8), unapplied to any hosted database. Frozen implementation base
SHA: `f53a348b592b40252dd204837cd0244a2f870053` (`main`). Implementation resumes at
Phase 3.
