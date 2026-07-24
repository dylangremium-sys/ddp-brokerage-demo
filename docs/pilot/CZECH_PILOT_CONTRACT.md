# Czech Pilot — One-Page Product Contract (Phase 0 Freeze)

**Status:** FROZEN for pilot · **Date:** 2026-07-24 · **Owner:** DDP Operator (Controller)
**Mission:** Go live for **ONE Czech client** using **TWO partners** for farm onboarding. Deliver reliable farm onboarding + compliance status/reporting. Everything else deferred.

All values below are grounded in existing code (`src/types.ts`, `SUPABASE_SCHEMA.sql`, `8_COA_UPLOAD_STORAGE_MIGRATION.sql`, `complianceScoring.ts`, `DDPBuyerPreview.tsx`). No new architecture.

---

## 1. In-Scope Flows (ONLY these four)

| # | Flow | Actor | Backing code |
|---|------|-------|--------------|
| 1 | Farm profile creation | Partner (see role note) | `FarmerOnboarding.tsx`, `farms` table |
| 2 | Evidence / document upload | Partner | bucket `farmer-documents`, `inventory_batches.coa_storage_path` |
| 3 | Compliance review + status/gap assignment | DDP reviewer (human) | `DDPFarmReview` / `DDPInventoryReview`, `ProcurementDecision` |
| 4 | Client report export | DDP delivers to client | `DDPBuyerPreview.tsx` Buyer Pack |

### Role mapping (pilot decision — applied)
Only three roles exist in code: `ddp_admin | farmer | pending`. There is **no** dedicated partner or client role.
- **Both partners operate under `ddp_admin` accounts**, separated by **SOP only** (not technical RBAC). *(Ratified default #1.)*
- **Internal reviewer** = `ddp_admin` (a human, distinct person from the onboarding partner per SOP).
- **Czech client** = **no in-app login in pilot**; receives scheduled exported reports out-of-band. *(Ratified default #2.)*
- ⚠ **Risk (P1):** admin-for-partners waives the "partners only see allowed data" boundary and lets a partner technically self-approve. **Mitigation:** SOP segregation of duties — the partner who onboards a farm must not be the reviewer who approves it; approval requires a named human approver recorded on the decision. **Upgrade path (post-pilot):** introduce a `partner` role + RLS.

---

## 2. Required Farm Fields (minimal onboarding set)

Full profile has 50+ fields across 9 optional steps. Pilot **requires only** the following to reach *Submitted to DDP*; all other fields are optional / add-later. This set is **enforced in code** by the onboarding submit floor (`FarmerOnboarding.tsx` `handleFinalSubmit`), which blocks submission and lists any missing field.

| Field (app / DB) | Required | Notes |
|---|---|---|
| `tradingName` | ✅ | Farm/trading display name (used as `farm_name`) |
| `farmType` | ✅ | Operation type |
| `province` | ✅ | Region |
| `primaryContact` | ✅ | Named responsible contact |
| `mobileNumber` | ✅ | Reachable phone |
| `email` | ✅ | Reachable email |
| `legalBusinessName`, `registrationNumber`, `district`, address/GPS, licences, ownership, facility areas, strains, scores, socials | ⬜ Optional | Deferred; "can be added later" per the app's step-9 note |

> **Decision (2026-07-24):** the pilot floor is the 6 fields above (ratified — "keep the implemented floor"). `legalBusinessName` / `registrationNumber` / `≥1 licence` are collected during compliance review (flow 3) rather than gated at submit, to minimise onboarding friction. Revisit if the Czech client requires a licence identifier at intake.

---

## 3. Required Evidence (minimal compliance pack)

Bucket **`farmer-documents`** (private) · **PDF only** · **≤ 10 MB** · signed-URL access only.

| Evidence | Required | Maps to |
|---|---|---|
| Farm licence / business registration document | ✅ | `farm_license` / `farm_identity` |
| GACP **or** GAP certificate | ✅ | `gacp_evidence` |
| COA (Certificate of Analysis) — **per batch offered to client** | ✅ | `coa`, `coa_storage_path` |
| Inventory photos, storage evidence, chain of custody, video | ⬜ Optional | Deferred |

A batch cannot progress to a client report without a **received COA file** (`coa_storage_path` present — `coaAvailable=true` alone is insufficient).

---

## 4. Compliance Status State Machine

### 4a. Farm level — `FarmStatus` (pilot subset)
```
Draft ──(partner submits)──▶ Submitted to DDP
Submitted to DDP ──(reviewer opens)──▶ Under Review
Under Review ──(reviewer)──▶ More Information Required ──(partner resubmits)──▶ Under Review
Under Review ──(reviewer, HUMAN)──▶ Approved
Under Review ──(reviewer, HUMAN)──▶ Rejected
```
Deferred (not used in pilot): `Watchlist`, `Strategic Partner`.

### 4b. Batch/evidence level — `InventoryStatus`
```
Pending Review ──(reviewer)──▶ Approved | Missing Document | Rejected
Missing Document ──(partner uploads)──▶ Pending Review
```
Status writes are **reviewer-only** (DB RLS: only `is_ddp_admin()` may update `status`).

### 4c. Evidence authority ceiling — `EvidenceStatus`
Pilot uses **`claimed → documented → reviewed`** only. **`verified` is NOT used in the pilot** (no independent third-party verification party exists). `missing` / `rejected` / `expired` used as applicable.

### 4d. Reviewer decision — `ProcurementDecision`
Pilot set: `progress | hold | reject | request_documents | request_fresh_coa`.
**Gaps** presented to client = the failing items of the export-readiness checklist (`complianceScoring.ts`): farm profile ≥90%, farm licence present, GACP/GAP present, COA present, COA expiry valid, COA batch matches, potency present, heavy-metals / pesticides / mycotoxins / microbiology tested.

---

## 5. Export Format + Cadence (client report)

- **Format:** DDP **Buyer Pack** — browser **Print → PDF** + plain-text **summary copy**; backed by an **immutable SHA-256 JSON snapshot** recorded at the human decision.
- **Report fields:** Product, Batch, Farm, Location, Available Qty + unit, Price/kg, THC/CBD/Moisture/Water-Activity (with the standing disclaimer "Lab values as documented by the farm from its COA — DDP review required before commercial reliance"), Storage, Compliance pass-count, DDP Status, COA on-file flag.
- **Human-approval gate (already enforced in code, fails closed):** export (Print/Copy/PDF) is blocked unless a **named human approver** recorded a `progress` decision (`canEmitBuyerPackOutput` + `buyerPackSnapshot`). AI may draft text only and is blocked from asserting compliance/approval claims (`aiComplianceGuard`).
- **Cadence:** out-of-band delivery to the Czech client; **daily** during the onboarding push (Phase 3), otherwise per client request. No in-app client login in pilot.

---

## 6. Out of Scope (do not touch)

Multi-buyer workflows · marketplace / buyer-interest / buyer-registration flows · AI COA extraction · country expansion beyond the Czech import pilot · Watchtower / legal-monitoring automation as a pilot dependency · technical partner/client RBAC · the `verified` evidence tier · cosmetic-only UI polish · any architecture rewrite.

---

## 7. Go-Live Safety Gates (ALL must pass before first real farm)

| Gate | Definition of pass | Lane |
|---|---|---|
| **Access control** | On the live/staging DB, RLS is enabled and farmer accounts cannot read other farms; only `is_ddp_admin()` can write `status`. *(Note: partner=admin means the partner-isolation half is SOP-enforced for pilot.)* | Backend |
| **Audit trail** | Farm create, farm/batch status changes, and evidence uploads are captured with actor + timestamp (batch status-history + `compliance_audit_log`). | Backend |
| **Upload smoke** | PDF ≤10MB uploads to `farmer-documents`, signed URL retrieves it; >10MB and non-PDF are rejected with a **clear** error (no silent failure). | Backend/Frontend |
| **Backup/restore proof** | One backup taken (`RESET_A` counts + DB snapshot) and a restore rehearsed once on staging, documented. | Backend/Ops |
| **Incident mini-runbook** | A one-page incident runbook exists and has been dry-run once. | Ops |
| **Human approval** | Buyer Pack export requires a recorded `progress` decision + named approver (fails closed). *(Already enforced in code — confirm live.)* | Backend/QA |

---

## Acceptance
This contract is the frozen Phase-0 scope. Any change to Sections 1–6 requires an explicit unfreeze. Acceptance is tracked in `CZECH_PILOT_ACCEPTANCE_CHECKLIST.md`.
