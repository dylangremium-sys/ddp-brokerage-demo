# DDP Supply Exchange — Target Architecture

**Companion to:** `DDP_MARKETPLACE_GROUND_TRUTH.md` (audited at `feature/ai-summary-hardening` @ `55c2808`; re-verified unchanged on `main` @ `0e65608`)
**Status:** proposal. Nothing here is implemented.

> **Amended 2026-08-02.** Sections 1.1, 1.2, 2.1, 2.6 and 4 were written before migrations 39–44
> existed, and are superseded where they conflict with what was built. Those migrations are now
> merged to `main` (`42833ac`, `48230f0`) and `docs/OPTION_B_SEAM_CONTRACT.md` is **binding**;
> this document defers to it. Evidence for each resolution:
> `~/Desktop/DDP_PLAN_RECONCILIATION_2026-08-02.md`.

---

## 0. Design position

Three facts from the audit drive every decision below.

1. **RLS on 27/27 production tables, with `is_ddp_admin()` / `has_operational_farmer_access()` / `has_farm_membership()` as the enforcement primitives.** This is the platform's best asset. The buyer side must be built *in the same idiom* — a new `is_approved_buyer_member(org)` predicate alongside the existing three — not with a parallel mechanism.
2. **`compliance_audit_log` has a closed 15-value `action` CHECK constraint, all of them regulatory.** The commercial audit trail cannot live there. A second, structurally similar but separately governed log is required.
3. **`App.tsx` is a 1515-line `useState` machine over a 26-member `Page` union with no router.** Adding a buyer portal, deal rooms and a pipeline to that shell without addressing routing produces an unmaintainable file and makes per-deal-room URLs impossible.

The guiding rule for reuse: **extend where the existing structure already models the concept correctly; add where it does not.** Concretely — reuse `farms`, `inventory_batches`, `procurement_decisions`, `EvidenceStatus`, `buyer_pack_snapshots`, the storage-policy pattern and the disposable-PG harness. Add the entire buyer and commercial layer. Do **not** rebuild farm profiles, evidence semantics or pack issuance.

---

## 1. Roles, organisations and tenancy

### 1.1 Role model

Today: `ddp_admin | farmer | pending`. Target:

```
ddp_admin        unchanged — DDP staff, full operational authority
farmer           unchanged — supplier-side operator, scoped by farm_memberships
buyer            NEW — buyer-side operator, scoped by buyer_memberships
pending          unchanged — authenticated but non-operational
```

`buyer` is a **fourth peer role**, not a farmer variant. Three `CHECK (role IN (...))` constraints must be widened together (`AUTH_RLS_SCHEMA.sql:21`, `21_…:44`, `27_…:473`); a migration that widens one and not the others will pass tests and fail in production. This is a single atomic work package (WP-0.2).

**Partly done, and the technique is the one to copy.** Migration 39 adds `'buyer'` to `profiles.role` by dropping and re-adding `profiles_role_check` **by constraint name**, so it covers whichever definition is live rather than assuming which file defined it. It does not cover `24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql:473`, a separate `CHECK (actor_role IN ('ddp_admin','farmer'))` on a different table. Migration 24 is unapplied, so nothing is broken today; the seam contract records why it is applied as written rather than edited retroactively.

**Sub-roles within an organisation** follow the existing `farm_memberships` precedent, which already uses `CHECK (role IN ('owner','operator'))`. Buyer memberships use the same two values plus `viewer` (read-only; a procurement analyst who may read a pack but may not commit to a quantity).

### 1.2 Tenant model

Two organisation types, symmetric:

```
farms              (exists)  ←── farm_memberships   (exists) ──→ profiles
buyer_organisations (NEW)    ←── buyer_memberships  (NEW)    ──→ profiles
```

**SUPERSEDED by Seam 5 of the seam contract.** This section originally read *"**Do not** create a generic `organisations` supertype. It would require migrating `farms`, `farm_memberships` and every policy that references them."*

That objection does not apply to what migration 39 actually built. It migrates nothing: it adds `public.organisations` alongside `farms`, with a nullable `farm_id` FK and `CHECK (farm_id IS NULL OR org_type = 'farm')`. The `farms` subsystem is untouched, so the risk this paragraph was avoiding was never taken.

`public.organisations` is therefore the single counterparty identity table, with `org_type IN ('farm','buyer','laboratory','carrier','broker','internal')`. Membership is `public.organisation_memberships`. **Do not build `buyer_organisations` or `buyer_memberships`** — they are superseded names for tables that now exist on `main`.

**Tenancy invariant:** every row in every new table is reachable by exactly one of three predicates — `is_ddp_admin()`, `has_operational_farmer_access(farm_id)`, `is_approved_buyer_member(buyer_org_id)` — or by an explicit participant grant (deal rooms, §5). No new table may be readable by `authenticated` at large.

### 1.3 Buyer approval is a gate, not a flag

**The principle here survives; only the column name changes.** Approval must be a gate rather than a flag, and suspension must remove catalogue and deal-room read access immediately without touching any grant row — the same fail-closed shape as the existing farmer predicate.

As built, the gate is `organisations.verification_state`, which admits only `unverified | verified | rejected`. **It has no `suspended` value, and needs one** — that is the single change Seam 5 carries across from this section. Every buyer-side read predicate must return true only for `verified`.

---

## 2. Entities

Proposed names follow the brief; deviations are justified inline. `→` denotes a foreign key.

### 2.1 Buyer identity

**SUPERSEDED by Seam 5.** Buyer identity is `public.organisations` (`org_type = 'buyer'`) and `public.organisation_memberships`, both merged to `main` in migration 39. The `buyer_organisations` / `buyer_memberships` tables proposed here must not be built.

Two requirements from the superseded proposal survive and are carried into Seam 5:

- **A `suspended` state on the approval gate** (see §1.3).
- **`expires_on` is mandatory on any document type that can expire** — the audit found no expiry tracking anywhere, and expiring-evidence is a named Release 2 requirement. Adding the column when the table is first created costs nothing; retrofitting it later means backfilling dates nobody has.

Buyer documents remain to be designed. When they are, mirror `farmer_documents` **exactly**, including its storage-policy shape, and scope them by `organisation_id` rather than a buyer-specific key.

### 2.2 Supply presentation

| Table | Purpose |
| --- | --- |
| `listings` | The buyer-visible projection of an `inventory_batches` row. `batch_id → inventory_batches`, `farm_id → farms`, `status`, `approved_by → profiles`, `approved_at`, `region_label` (region only, never precise location), `min_order_qty`, `indicative_price`, `price_currency`, `available_from`, `available_until`, `sample_available boolean`. |
| `listing_visibility` | Per-buyer-org overrides. `listing_id`, `buyer_org_id`, `mode CHECK IN ('allow','deny')`. Absent row = default policy. |

**Why a separate `listings` table rather than a `client_visible` flag on `inventory_batches`?** Three reasons the audit supports: (a) the batch carries internal fields farmers own and buyers must never see, and `fn_protect_farm_admin_fields` already exists precisely because internal/external separation on that table is delicate; (b) the buyer-facing commercial terms (min order, indicative price, currency) are DDP's presentation, not the farm's data; (c) a listing must be independently approvable and revocable without mutating the batch. `StockStatus.client_visible` remains the farm-side signal of intent; the `listings` row is the admin's act of publishing.

### 2.3 Demand

| Table | Purpose |
| --- | --- |
| `buyer_requirements` | The RFQ. `buyer_org_id`, `status`, `product_type`, `quantity`, `quantity_unit`, `frequency`, `destination_country`, `required_specs jsonb`, `required_certifications text[]`, `target_price`, `price_currency`, `pricing_model`, `delivery_window_start/end`, `sample_required boolean`, `submission_deadline`, `confidentiality CHECK IN ('standard','restricted')` |
| `requirement_documents` | Buyer-supplied attachments. Same storage shape as `buyer_documents`. |

### 2.4 Match and conversation

| Table | Purpose |
| --- | --- |
| `matches` | Admin-created link. `requirement_id`, `listing_id`, `status CHECK IN ('proposed','accepted','rejected','withdrawn')`, `rationale text NOT NULL CHECK (length(btrim(rationale)) > 0)`, `evidence_gaps jsonb`, `created_by`, `decided_by`, `decided_at`, unique `(requirement_id, listing_id)`. |
| `enquiries` | Buyer-initiated interest in a listing. `listing_id`, `buyer_org_id`, `requirement_id` (nullable), `status`, `owner_admin → profiles`, `due_at`. Unique partial index on `(listing_id, buyer_org_id)` where status is non-terminal — this is the duplicate-enquiry guard. |
| `deal_rooms` | `requirement_id`, `match_id`, `status`, `opened_by`, `closed_at`, `closure_reason`, commercial terms (`proposed_qty`, `proposed_price`, `currency`, `incoterm`, `payment_terms`, `permit_conditions jsonb`). |
| `deal_room_participants` | `deal_room_id`, `profile_id`, `side CHECK IN ('ddp','farm','buyer')`, `granted_by`, `granted_at`, `revoked_at`. **The revocable participant grant is the authorisation primitive for the whole deal-room subsystem.** |
| `deal_messages` | `deal_room_id`, `author_id`, `visibility CHECK IN ('internal','participants','farm_only','buyer_only')`, `body`, `created_at`. Append-only. |
| `evidence_requests` | **Reuse migration 24 as written.** It already models targets (`farm_profile`/`inventory_batch`), status vocabulary via `evidence_request_statuses()`, priority, category, terminal-closure invariants and a revision counter. Extend `target_type` to admit `deal_room`; do not redesign. |
| `introductions` | The identity-disclosure act. `deal_room_id`, `disclosed_side`, `disclosed_to_org`, `authorised_by → profiles`, `authorised_at`, `scope jsonb`. |
| `disclosure_snapshots` | Immutable record of exactly what was revealed. `introduction_id`, `payload jsonb`, `content_hash CHAR(64)`, append-only. |

### 2.5 Commerce

| Table | Purpose |
| --- | --- |
| `opportunities` | The pipeline entity. `requirement_id`, `deal_room_id`, `state`, `state_changed_at`, `state_changed_by`, `expected_value`, `currency`, `lost_reason`. |
| `opportunity_events` | Append-only transition log. `opportunity_id`, `from_state`, `to_state`, `actor_id`, `reason NOT NULL`, `created_at`. |
| `commission_agreements` | `opportunity_id`, `basis CHECK IN ('fixed','percentage')`, `rate`, `currency`, `payer CHECK IN ('buyer','farm','split')`, `trigger_event`, `agreed_by`, `agreed_at`, `document_path`. |
| `commission_events` | `agreement_id`, `event_type`, `expected_amount`, `invoice_ref`, `status CHECK IN ('expected','invoiced','paid','overdue','waived','disputed')`, `evidence_path`. **No funds custody.** |

### 2.6 Cross-cutting

| Table | Purpose |
| --- | --- |
| `commercial_audit_log` | **New table, not an extension of `compliance_audit_log`.** Identical shape (`actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `before_state`, `after_state`, `reason`, `created_at`) with its own closed `action` vocabulary and its own `prevent_commercial_audit_log_mutation()` trigger modelled on `prevent_compliance_audit_log_mutation()`. Separated because the compliance log's 15-value CHECK is a deliberate regulatory boundary; mixing commercial events into it would dilute an evidentiary record and force that constraint open. **This is now a correction, not a proposal:** migrations 39–44 grew that CHECK from 15 values to 32, including `reservation_created` and `reservation_released`. Seam 7 fixes which events belong where. |
| `document_access_events` | Every read of a controlled document or pack. `subject_type`, `subject_id`, `actor_id`, `actor_org`, `action CHECK IN ('view','download','link_issued','link_expired','revoked')`, `ip_address`, `user_agent`, `created_at`. Supersedes `buyer_pack_download_log` for new work; that table is retained unchanged (it is append-only and live) and backfilled by view, never migrated. |
| `notifications` | `recipient_profile_id`, `kind`, `subject_type`, `subject_id`, `title`, `body`, `read_at`, `emailed_at`. **Body must never contain counterparty identity, price or document content** — see §8. |

---

## 3. State machines

### 3.1 Opportunity (the brief's 13 states)

```
lead → requirement_received → candidate_supply_identified → matched
     → enquiry_active → evidence_resolution → sample_stage
     → commercial_negotiation → conditional_agreement
     → contracted_outside_ddp → won
any non-terminal → lost | cancelled
```

Rules enforced in the DB, not the UI:
- Transitions are **admin-only**. Buyer and farm actions *cause* transitions via their own tables; they never write `opportunities.state`.
- **Forward-only** except explicit backward moves to `evidence_resolution` (from `sample_stage` or `commercial_negotiation`), which is the realistic case of a COA lapsing mid-negotiation.
- `won` requires a `commission_agreements` row. Enforced by trigger, not hoped for.
- `lost` and `cancelled` require a non-empty `lost_reason` — same discipline as `procurement_decisions.reason`, which already enforces this.
- Every transition writes `opportunity_events`. A state change with no event row is a bug the migration should make impossible.

### 3.2 Buyer requirement

`draft → submitted → under_review → open → matched → closed`, with `paused` reachable from `open`/`matched` and returning to the same, and `cancelled` from any non-terminal. Only the owning buyer org may move `draft → submitted`; only DDP may move `submitted → under_review → open`.

### 3.3 Listing

`draft → pending_review → approved → published → suspended → withdrawn`. **`is_approved_buyer_member()` sees only `published`.** `approved` but not `published` is the state where DDP has cleared the listing but is holding it back — a deliberate distinct state, because conflating them means an approval action is also a publication action.

### 3.4 Enquiry

`open → responded → evidence_pending → sample_requested → converted | closed | expired`. `converted` requires a `deal_rooms` row.

### 3.5 Evidence

Extend the existing `EvidenceStatus` union (`src/types.ts:28`) by two members to match the brief:

```
claimed | documented | under_review | reviewed | verified
        | buyer_ready | missing | rejected | expired
```

`under_review` and `buyer_ready` are additions. **`buyer_ready` is a stored state, replacing today's render-time derivation in `deriveBuyerApprovalGate`** — a buyer-facing marketplace needs "may be discussed with a buyer" to be queryable and auditable, not recomputed per render. `deriveBuyerApprovalGate`'s *logic* (blockers ∧ recorded `progress` decision) becomes the guard on the transition **into** `buyer_ready`; its refusal to let absence-of-blockers imply approval is preserved exactly and must be covered by a test that fails if that rule is weakened.

`verified` retains its existing meaning — independently checked by a qualified third party — and **no automated process may ever assign it.** A trigger should reject any `verified` write whose actor is not a `ddp_admin` with a recorded review row.

---

## 4. RLS requirements

Every new table: `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, default-deny, with policies written per-operation (never `FOR ALL`).

New predicate functions, `SECURITY DEFINER`, `search_path = ''`, `EXECUTE` granted only to `authenticated` — matching the hardening already applied by migrations 12/13:

```sql
-- SUPERSEDED by Seam 5: is_approved_buyer_member() and buyer_org_of() are not to be
-- written. public.has_organisation_membership(p_org uuid) already exists (migration 39).
-- A buyer-scoped wrapper that additionally requires verification_state = 'verified' is
-- still needed; name it when it is written.
public.is_deal_room_participant(p_room uuid) returns boolean
public.can_see_listing(p_listing uuid) returns boolean
```

Policy sketch for the two most dangerous tables:

```sql
-- listings: buyers see published listings not explicitly denied to them
CREATE POLICY listings_buyer_select ON public.listings FOR SELECT TO authenticated
USING (
  status = 'published'
  AND EXISTS (SELECT 1 FROM public.buyer_memberships m
              WHERE m.profile_id = auth.uid()
                AND public.is_approved_buyer_member(m.buyer_org_id)
                AND NOT EXISTS (SELECT 1 FROM public.listing_visibility v
                                WHERE v.listing_id = listings.id
                                  AND v.buyer_org_id = m.buyer_org_id
                                  AND v.mode = 'deny'))
);

-- deal_messages: visibility label is enforced in the predicate, not the client
CREATE POLICY deal_messages_participant_select ON public.deal_messages FOR SELECT TO authenticated
USING (
  public.is_deal_room_participant(deal_room_id)
  AND (
    visibility = 'participants'
    OR (visibility = 'farm_only'  AND public.participant_side(deal_room_id) = 'farm')
    OR (visibility = 'buyer_only' AND public.participant_side(deal_room_id) = 'buyer')
  )
);
-- 'internal' is absent from the USING clause by design: only is_ddp_admin() reads it.
```

**Internal-vs-participant separation is a database predicate, never a client filter.** A React component that hides internal notes is a convenience; the policy is the control. Every test in §9 of the test plan must be written to fail if the predicate is removed even while the component still hides the data.

---

## 5. File storage

Extend the existing pattern; do not invent a second mechanism. Current buckets: `farmer-documents`, `farmer-photos`, `evidence-request-files` (the last defined in migration 24, **not yet in production**). Add:

| Bucket | Contents | Read access |
| --- | --- | --- |
| `buyer-documents` | Import authorisations, incorporation | Owning buyer org + admin |
| `deal-room-files` | Documents exchanged in a room | Room participants, filtered by the same `visibility` label as `deal_messages` |
| `buyer-packs` | Rendered, watermarked pack artefacts | Signed URL only; never a bucket-level grant |

All private (`public = false`), verified **by predicate rather than by policy name** — this repository already learned that lesson (`1ebe693 fix: verify storage policies by predicate, not by name`).

**Path convention is a security control:** `{bucket}/{org_type}/{org_id}/{subject_id}/{sha256}.{ext}`. The org id in the path lets the storage policy authorise without a table join, and the content hash gives free deduplication and makes the object name unguessable.

**Buyer pack artefacts are never served from a durable public path.** Access is a short-lived signed URL issued by a serverless function that (a) checks the requester is a participant, (b) writes `document_access_events`, (c) stamps the watermark at issue time. Revocation = refusing to issue new URLs plus letting outstanding ones expire; the architecture must not claim stronger revocation than that, because a downloaded file cannot be recalled.

---

## 6. Progressive identity disclosure

Four layers, because any single one fails.

1. **Storage.** Listings expose `region_label` only. Farm legal name, address, contact and membership rows are simply not selectable by a buyer — no policy grants them.
2. **Projection.** A `listing_public_view` (or an explicit server-side projection) is the only thing buyer code reads. Never `SELECT *` from `farms` in a buyer path.
3. **Content.** Free text and uploaded files can leak what the schema protects. Before a listing publishes or a document reaches a buyer: strip EXIF/XMP/PDF metadata, and run a contact-detail detector (email, phone, LINE ID, URL, company suffixes) over listing text, filenames and extracted PDF text. **A detector hit blocks publication and raises an admin task — it must never silently redact**, because silent redaction teaches operators the check is invisible.
4. **Act.** Disclosure happens once, through `introductions`, authorised by a named admin, and is frozen in `disclosure_snapshots` with a content hash.

**Non-circumvention:** DDP can detect and evidence circumvention; it cannot prevent it. The contract does the preventing. The architecture must not imply otherwise in any UI string, and the launch gates test for that wording.

---

## 7. Buyer Pack generation flow (target)

Preserve every existing control, close the three limitations the audit found.

```
selected evidence (approved only)
  → server recomputes content_hash        [closes limitation 1]
  → verify against client-supplied hash; mismatch ⇒ reject issuance
  → issue_buyer_pack_snapshot RPC (exists; extended)
      · issued_by = auth.uid()            [already authoritative]
      · approved_by resolved to a profile id, not free text  [closes limitation 2]
      · recipient_buyer_org_id  NEW — binds the pack to one buyer
      · expires_at              NEW
  → render artefact, watermark with recipient org + issue timestamp + snapshot id
  → store in buyer-packs bucket
  → every access: signed URL + document_access_events row
```

Limitation 3 (a service-role actor can still alter rows) is **not closable in-application** and must stay documented as a limitation rather than be quietly dropped. The honest claim remains "immutable to application roles, tamper-evident by hash" — never "legally immutable".

`prevent_buyer_pack_mutation` and the `UNIQUE (pack_id, version)` guard are unchanged. Superseding a pack issues a new version; **an issued pack is never silently updated**, which the existing append-only design already guarantees.

---

## 8. Notifications

`notifications` rows are written by database triggers on state transitions, drained by a scheduled function for email. The **content rule is a schema-level constraint, not a convention**: notification `title`/`body` may reference a subject by opaque id and a neutral noun ("A new enquiry needs your response") and may never contain counterparty legal name, price, quantity or document content. A test asserts that the rendered body for a cross-org event contains no field from the counterparty record.

---

## 9. Service boundaries

Preserve the existing shape — domain logic in `src/lib/*.ts` as pure functions, repository interfaces with a Supabase implementation and a fake for tests (`buyerPackSnapshotRepository` / `…Store` / `…SupabaseStore` is the pattern to copy). Serverless functions in `api/` handle anything needing a service-role key or a secret: pack rendering, signed-URL issuance, metadata stripping, malware scanning, email dispatch.

**Routing must change.** Adding buyer portal, catalogue, requirement, deal-room, pipeline and commission surfaces to the 26-member `Page` union in a 1515-line component is not viable, and per-deal-room URLs are a functional requirement (people share links to deals). Introduce a real router in Release 0, migrating the existing union behind it rather than rewriting the pages. This is WP-0.7 and it is a prerequisite, not a nice-to-have.

---

## 10. Reporting

Read models over the append-only logs, not new mutable aggregates: pipeline throughput and stage ageing from `opportunity_events`; evidence queue and expiry from `buyer_documents`/`farmer_documents`/`evidence_requests`; commission ledger from `commission_events`; disclosure and access reporting from `document_access_events` + `disclosure_snapshots`. Materialise only if measurement shows a need — with 27 tables and no known volume problem, premature materialisation would add a correctness risk for no benefit.
