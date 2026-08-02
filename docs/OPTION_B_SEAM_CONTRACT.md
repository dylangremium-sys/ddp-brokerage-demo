# Option B seam contract

**Status: binding on all marketplace work from 2026-08-02.**
Owner decision: build **Option B** (marketplace and verification layer, no physical custody) now,
in a shape that lets **Option A** (DDP as principal, with custody) plug in later without a rewrite.

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

## Related

- `docs/runbooks/EXPORT_HUB_FOUNDATION_APPLY.md` — migrations 39–43, none applied anywhere
- `docs/MIGRATION_NUMBER_REGISTER.md` — next free number
- `docs/DISPOSABLE_PG_HARNESS.md` — how to prove an RLS claim behaviourally
