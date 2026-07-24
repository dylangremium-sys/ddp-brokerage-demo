# Czech Pilot — Acceptance Checklist (Phase 0)

Companion to `CZECH_PILOT_CONTRACT.md`. Each item is testable pass/fail, has an owner, and names the evidence artifact required to mark it done.

**Owners:** `P1` = Partner 1 (onboarding) · `P2` = Partner 2 (compliance QA) · `OP` = DDP Operator/Controller (you).
Partners operate under `ddp_admin` accounts, segregated by SOP (ratified default #1).

Legend: ☐ not started · ◐ in progress · ✅ pass · ✗ fail

---

## Flow 1 — Farm profile creation

| # | Testable item | Owner | Pass criterion | Evidence artifact |
|---|---|---|---|---|
| 1.1 | Partner creates a farm with all §2 required fields | P1 | Farm saved; status `Draft` | Farm `id` + screenshot of saved profile |
| 1.2 | Missing a required field is blocked/flagged | P1 | Cannot submit; clear message names the field | Screenshot of validation error |
| 1.3 | Partner submits farm to DDP | P1 | Status → `Submitted to DDP` | Status value + timestamp |
| 1.4 | Farm create is audit-logged | OP | Row with actor + timestamp exists | Audit-log query result |

## Flow 2 — Evidence / document upload

| # | Testable item | Owner | Pass criterion | Evidence artifact |
|---|---|---|---|---|
| 2.1 | Upload licence + GACP/GAP + COA (PDF ≤10MB) | P1 | Files land in `farmer-documents`; retrievable via signed URL | Storage path list + signed-URL open |
| 2.2 | Non-PDF rejected | P1 | Upload blocked with clear error | Screenshot of error |
| 2.3 | >10MB rejected | P1 | Upload blocked with clear error | Screenshot of error |
| 2.4 | Upload failure surfaces (no silent fail) | P2 | Forced failure shows explicit error state | Screenshot / console evidence |
| 2.5 | COA required before client report | P2 | Batch without `coa_storage_path` cannot export | Attempted-export block screenshot |

## Flow 3 — Compliance review + status/gap assignment

| # | Testable item | Owner | Pass criterion | Evidence artifact |
|---|---|---|---|---|
| 3.1 | Reviewer opens submitted farm | P2 | Status → `Under Review` | Status + timestamp |
| 3.2 | Reviewer requests more info | P2 | Status → `More Information Required`; gap list shown | Screenshot of gaps |
| 3.3 | Reviewer sets batch status | P2 | `Approved` / `Missing Document` / `Rejected` recorded | Status-history entry |
| 3.4 | Only reviewer (admin) can write status | OP | Farmer-role write attempt denied by RLS | RLS test output |
| 3.5 | Status change is audit-logged with actor | OP | Row with actor + old→new + timestamp | Audit-log query result |
| 3.6 | Human approval required (AI cannot finalize) | OP | AI draft with claim wording is blocked | Guard test output |

## Flow 4 — Client report export

| # | Testable item | Owner | Pass criterion | Evidence artifact |
|---|---|---|---|---|
| 4.1 | Export blocked without named-approver `progress` decision | OP | Print/Copy/PDF disabled (fails closed) | Screenshot of blocked state |
| 4.2 | After approval, Buyer Pack exports | P2 | Print→PDF + summary copy produce §5 fields | Exported PDF + copied text |
| 4.3 | Snapshot is immutable + hashed | OP | SHA-256 `contentHash` recorded | Snapshot record |
| 4.4 | Report delivered to client out-of-band | OP | Delivery logged (no in-app client login) | Delivery log entry |

---

## Safety gates (must all pass before first REAL farm)

| Gate | Owner | Pass criterion | Evidence |
|---|---|---|---|
| SG-1 Access control | OP | RLS on; farmer cannot read other farms; admin-only status writes | RLS test transcript |
| SG-2 Audit trail | OP | Create/update/status/upload captured w/ actor+time | Audit-log samples |
| SG-3 Upload smoke | P1 | Happy + failure paths pass (2.1–2.4) | Smoke run notes |
| SG-4 Backup/restore | OP | One backup taken + one restore rehearsed on staging | Drill doc |
| SG-5 Incident runbook | OP | One-page runbook exists + dry-run once | Runbook + drill note |
| SG-6 Human approval | OP | Export fails closed w/o named approver (4.1) | Screenshot/test |

---

## Ratified decisions (Phase 0)
1. **Partner role mapping:** both partners under `ddp_admin`, SOP segregation, no technical RBAC yet. *(P1 risk logged in contract §1.)*
2. **Client access:** no in-app client role; scheduled exported reports out-of-band.

## Sign-off
- [ ] Contract §1–6 reviewed and frozen — OP
- [ ] All Flow 1–4 acceptance items pass — P1/P2/OP
- [ ] All safety gates SG-1…SG-6 pass — OP
- [ ] GO for first 3–5 real farms — OP
