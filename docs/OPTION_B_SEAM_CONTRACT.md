# Option B seam contract

**Status: binding on all marketplace work from 2026-08-02.**
Owner decision: build **Option B** (marketplace and verification layer, no physical custody) now,
in a shape that lets **Option A** (DDP as principal, with custody) plug in later without a rewrite.

**Amended 2026-08-02 with Seams 5–7**, which resolve four contradictions found between this
document and the MC-01..MC-20 gap analysis. Where the two disagree, **this document wins and the
architecture document is amended to match**; evidence for each resolution is in
`~/Desktop/DDP_PLAN_RECONCILIATION_2026-08-02.md`. Seams 5 and 6 are settled. **Seam 7 is
mostly done** — `commercial_audit_log` landed in PR #115 (`ae057bb`); five organisation events have
not moved yet.

This document exists because the expensive part of adding custody later is not the warehouse code.
It is the schema decisions made now that quietly assume custody will never exist. Three of those
decisions are load-bearing. They are cheap to honour today and expensive to reverse.

---

## Why not build Option A in parallel

Rejected, deliberately. An unused custody layer has no user until a warehouse physically exists,
and it decays while it waits: Thai cannabis regulation changed materially three times in four years,
so speculative code encoding today's rules is wrong by the time anything runs against it. The
technology plan's own §11.1 makes the same point from the other side — the binding constraint on
this build is regulatory clarity, not engineering capacity, and adding engineers to an unclear
specification mainly produces more code that has to be rewritten.

What has already been bought is the **option**, not the implementation. Migrations 39–43
(organisations, licences and permits, effective-dated rulesets, the export gate, MFA) are
direction-independent: every one of them is required under A and under B. That is why they were
built first, before the custody question was settled.

---

## Seam 1 — a consignment is not a custody concept. Build it under B.

Both options need an order and a shipment. Only A needs the goods to be in DDP's hands.

The plug points already exist and are marked in the schema as free text with a comment saying what
they become:

| Column | Today | Under A |
|---|---|---|
| `permit_drawdowns.consignment_ref` | `text NOT NULL` | FK to the consignment |
| `export_eligibility_evaluations.consignment_ref` | `text NOT NULL` | FK to the consignment |
| `export_eligibility_evaluations.inventory_batch_id` | nullable FK to `inventory_batches` | FK to a lot |

**Rule:** when the consignment entity lands, it lands as a first-class table under B, and those two
`consignment_ref` columns become foreign keys. Do not defer the entity to A. A consignment describes
a commercial shipment, not who is holding it.

---

## Seam 2 — quantity is a ledger, never a column. This is the one that will bite.

Option A introduces lots with splits and merges: one lot becomes two, and identity changes. If
marketplace code decrements a `quantity_kg` column on `inventory_batches`, then on the day a lot
splits every reservation pointing at the old identity is wrong, and there is no record of how it got
that way.

**Rule:** availability is a computed `SUM` over an append-only ledger, exactly as
`permit_drawdowns` / `permit_headroom_kg()` already work in migration 40. Specifically:

- A reservation is a **row**. Releasing one is **another row**, never an `UPDATE` or `DELETE`.
- Available quantity is `batch quantity − SUM(active reservations)`, evaluated when asked.
- Over-reservation is prevented by a trigger holding `SELECT … FOR UPDATE` on the batch, because two
  concurrent reservations would otherwise both read availability before either wrote. A `CHECK`
  constraint cannot express a cross-row sum; this is the correct mechanism and it is already proven
  in migration 40.

**Corollary — `inventory_batches.stock_status` is NOT reservation state.** It is a farmer-facing
workflow flag (`draft`/`submitted`/`client_visible`/`reserved`/`sold`) that predates all of this.
Treating it as the truth would create a second source of truth that goes stale the moment a
reservation expires, and this repository has **no scheduler** to keep it fresh — `vercel.json`
declares zero crons. The ledger is authoritative. Nothing in the marketplace path may write
`stock_status` to mean "reserved".

---

## Seam 3 — expiry is computed, never stored

Same reasoning as licence expiry in migration 40, and the same absent scheduler. A reservation has
an `expires_at`; whether it is still active is derived at read time. There is deliberately no
`expired` state to write and no sweeper to write it.

**Rule:** a reservation is active when no release row references it **and** `expires_at > now()`.
Reservation hold is **7 days** (owner decision, 2026-07-30). A sweeper may later be added for
housekeeping, but nothing may depend on it having run.

---

## Seam 4 — the double-blind rule is bidirectional, and reservations name both sides

A reservation row links a buyer organisation to a farm's batch. It is therefore the single most
direct double-blind leak surface in the marketplace, and worse than an evaluation row because
buyers see it.

**Rules:**

- A **buyer** may read their own reservations, and must not be able to resolve the farm behind the
  batch — not by joining, not by a denormalised name, not through a photo.
- A **farmer** must not read reservation rows at all. They get a **quantity**, through
  `public.batch_reserved_kg()` / `public.batch_available_kg()`, never a counterparty.
- Only `ddp_admin` sees both sides of a reservation.

Every migration touching this must prove it behaviourally under `SET ROLE authenticated`, not by
reading the policy back to itself. See `docs/DISPOSABLE_PG_HARNESS.md`.

---

## Seam 5 — organisation identity is `organisations`, not a parallel buyer hierarchy

The gap analysis proposed `buyer_organisations` + `buyer_memberships` as structures parallel to
`farms` + `farm_memberships`, and explicitly forbade a generic supertype on the grounds that one
"would require migrating `farms`, `farm_memberships` and every policy that references them."

**That objection does not describe what migration 39 built.** It migrates nothing. It adds
`public.organisations` alongside `farms`, with a nullable `farm_id` FK and
`CHECK (farm_id IS NULL OR org_type = 'farm')`. The `farms` subsystem — the one part of this
platform that is fully proven — is untouched, so the risk being avoided was never taken.

**Rule:** `public.organisations` is the single counterparty identity table, with
`org_type IN ('farm','buyer','laboratory','carrier','broker','internal')`. Membership is
`public.organisation_memberships`. The authorisation primitive is
`public.has_organisation_membership(org)`. **Do not create `buyer_organisations`,
`buyer_memberships`, `is_approved_buyer_member()` or `buyer_org_of()`** — they are superseded
names for things that already exist on `main`.

**Carried across from the superseded proposal, because it was right:** approval must be a gate,
not a flag, and suspension must remove access immediately without touching a grant row.
`organisations.verification_state` currently admits only `unverified | verified | rejected`.
**Add `suspended`**, and make every buyer-side read predicate return true only for `verified`. A
buyer whose organisation is suspended loses catalogue and reservation read access at once, with no
row deleted and no grant revoked.

**Corollary — laboratories, carriers and brokers are identities, not features.** `org_type` admits
four classes the gap analysis does not model at all. Recording them is free and correct; building
anything *for* them is out of scope under B.

---

## Seam 6 — a reservation names a batch today, and a listing when one exists

Migration 44 references `inventory_batches(id)` directly. The architecture proposes a `listings`
table as the buyer-visible projection, so buyers never read a batch row: the batch carries internal
farmer-owned fields (`fn_protect_farm_admin_fields` exists precisely because that separation is
delicate), the commercial terms are DDP's presentation rather than the farm's data, and a listing
must be independently revocable without mutating the batch.

Left unresolved this becomes the exact failure Seam 2 exists to prevent — a row pointing at an
identity that is about to change.

**Rule:** `reservations` gains a nullable `listing_id`, carrying a comment saying what it becomes,
using the same plug-point convention already applied to `consignment_ref` in migrations 40 and 42.
While `listings` does not exist, `inventory_batch_id` is authoritative and `listing_id` is null.
When `listings` lands, new reservations set both, `listing_id` becomes the buyer-facing reference,
and `inventory_batch_id` remains the supply-side link.

**No buyer-side read path may select from `inventory_batches` directly**, whichever column is
populated. Availability reaches a buyer only through `public.batch_available_kg()` or its
listing-scoped successor.

---

## Seam 7 — commercial events do not go in `compliance_audit_log`

**Mostly done. `commercial_audit_log` exists on `main` (PR #115, `ae057bb`); five events have not
moved yet — see "What is left" below.**

`compliance_audit_log.action` was a closed 15-value regulatory vocabulary, and its closedness was
the point: it is an evidentiary record, and an evidentiary record that absorbs operational noise is
worth less. Migrations 39–44 grow it to **32 values**, including `reservation_created` and
`reservation_released`.

A reservation is a commercial act. It is not a regulatory one.

**Rule — the line, stated so it can be applied to events that do not exist yet.** An action belongs
in `compliance_audit_log` if a regulator, auditor or buyer's counsel could reasonably ask to see it
as evidence about *compliance status*. It belongs in `commercial_audit_log` if it is evidence about
*a commercial relationship*. Applied to what migrations 39–44 added:

| Stays in `compliance_audit_log` | Moves to `commercial_audit_log` |
|---|---|
| `licence_recorded`, `licence_state_changed` | `organisation_created`, `organisation_updated` |
| `permit_recorded`, `permit_state_changed` | `organisation_membership_granted` |
| `permit_drawn_down`, `permit_drawdown_reversed` | `organisation_membership_revoked` |
| `export_eligibility_evaluated` | `reservation_created`, `reservation_released` |
| `export_gate_overridden`, `export_gate_override_reviewed` | |
| `screening_recorded` | |
| `organisation_verification_changed` | |

`organisation_verification_changed` stays: whether a counterparty is verified is a compliance fact.
Creation and membership events are administrative, and move.

`commercial_audit_log` has the same shape as the compliance log (`actor_type`, `actor_id`,
`action`, `entity_type`, `entity_id`, `before_state`, `after_state`, `reason`, `created_at`), its
own closed vocabulary, and its own `prevent_commercial_audit_log_mutation()` trigger modelled on
`prevent_compliance_audit_log_mutation()`.

### How it was actually corrected

PR **#115** (`ae057bb`) made the split by **amending migrations 39–44 in place**, rather than
correcting forward in a new migration 45. `public.commercial_audit_log` is created inside migration
44 and currently carries `reservation_created` and `reservation_released`, with actor types
`admin | buyer | farmer | system`.

This document previously specified the opposite — correct forward in 45, do not edit merged files,
because rewriting them invalidates the fixture runs that justified them. **The in-place amendment is
the approach that landed, and on these facts it was the better one:** nothing is applied to any
database, so there is no history to preserve and no data to migrate, and editing 44 avoids an
add-then-move sequence that would have left the final schema carrying a scar for no benefit. The
fixture run was re-executed as part of #115 rather than inherited.

**That licence expires the moment anything is applied.** Once these migrations exist in a database,
in-place amendment stops being safe and forward correction becomes the only option — because an
applied migration is history, not a draft. Do not read #115 as a precedent for editing applied SQL.

### What is left

Five events specified above as moving are **still in `compliance_audit_log` on `main`**:

`organisation_created`, `organisation_updated`, `organisation_verification_changed`,
`organisation_membership_granted`, `organisation_membership_revoked`

Under the rule stated above, four of those five move to `commercial_audit_log` and
`organisation_verification_changed` stays — whether a counterparty is verified is a compliance fact.
Completing that is the remaining Seam 7 work. It is smaller than the reservation split and carries
the same deadline: it is cheap while nothing is applied and expensive afterwards.

**The window matters.** Once these rows exist in a database, "the regulatory log contains only
regulatory events" stops being true, and no later migration makes it true again.

---

## What must NOT be built under B

Building these speculatively is waste, and a stub is a claim:

- environmental monitoring, sensor ingest, the warehouse edge gateway
- WMS core: locations, bins, putaway, picking, cycle counting
- offline handheld / scanner applications
- any custody-event ledger

**And the claims that go with them.** Under B, DDP never takes physical custody, so the product may
not claim climate-controlled storage, in-house QA, or chain of custody. Shipping A later does not
retroactively make a B-era claim true; it just means the claim was wrong until then.

---

## The thing that is not a schema problem

Option B's double-blind promise **collapses at the first physical shipment**, and no seam here
fixes it. Export permits, commercial invoices, packing lists and airway bills all name an exporter
of record and a consignee, so at the first shipment the farm learns the buyer and the buyer learns
the farm — at exactly the transaction the rule exists to protect.

Of the three available structures, only **DDP as contractual counterparty and exporter of record on
both sides** preserves it, and that requires an export licence, working capital and taking title.
That is Option A as a *legal* posture, not a logistics one — which means the eventual reason to move
to A may have nothing to do with wanting a warehouse.

**Owner and legal decision. Trigger: the first order that physically ships. Do not re-raise before
then.**

Safe to build meanwhile: buyer accounts, vetting, listings, search, reservations, evidence extracts,
invoicing. Must wait: order fulfilment, shipping documents, anything that names a counterparty to
the other side.

---

## A limitation recorded rather than fixed

`24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql:473` defines
`CHECK (actor_role IN ('ddp_admin','farmer'))` on its evidence-request actor column. Migration 39
widens `profiles.role` to admit `buyer`, but that is a different constraint on a different table
and is not widened. Migration 24 is unapplied, so nothing is broken today.

**Under Option B, buyers do not act on evidence requests** — evidence reaches a buyer as an
extract, not as a workflow they participate in. Migration 24 is therefore applied **as written and
as reviewed**, not edited retroactively. The day buyer-side evidence participation is built, that
change widens `actor_role` in the same migration, and this section is deleted.

---

## Related

- `docs/runbooks/EXPORT_HUB_FOUNDATION_APPLY.md` — migrations 39–43, none applied anywhere
- `docs/MIGRATION_NUMBER_REGISTER.md` — next free number
- `docs/DISPOSABLE_PG_HARNESS.md` — how to prove an RLS claim behaviourally
