# Czech Pilot — Critical-Path Smoke Suite

Minimal, repeatable checks for the 4 pilot flows + 6 safety gates. Run this before each go/no-go. Pass = green in the Result column with the named evidence captured. **No PASS may be recorded for a live-DB gate that was not actually executed.**

Scope: `CZECH_PILOT_CONTRACT.md` flows only. Do not extend into marketplace/watchtower.

---

## A. Automated (local, no DB) — run every time

| ID | Command | Pass criterion | Result |
|----|---------|----------------|--------|
| A1 | `npm test` | All test files pass (baseline: 1740 tests / 80 files) | ☐ |
| A2 | `npm run security:sql` | SQL migration security check passes | ☐ |
| A3 | `tsc -b` | No type errors | ☐ |
| A4 | `npm run lint` | No lint errors | ☐ |
| A5 | `npm run build` | Production build succeeds | ☐ |

> `npm run ci:verify` runs A2→A1→A3→A4→A5 in one shot.

## B. Live staging security suite (SG-1 access, SG-2 audit) — requires staging creds

Runner: `npm run security:staging` (`scripts/run-staging-security-tests.mjs`). Fail-closed, pinned to staging ref `szqocdabwkjrggrddocx`; refuses to run against production.

**Required env** (set in shell or `.env.staging`, never commit):
```
STAGING_SUPABASE_URL=https://szqocdabwkjrggrddocx.supabase.co
STAGING_SUPABASE_ANON_KEY=…
STAGING_ADMIN_EMAIL=…            STAGING_ADMIN_PASSWORD=…
STAGING_FARMER_A_EMAIL=…         STAGING_FARMER_A_PASSWORD=…
STAGING_FARMER_B_EMAIL=…         STAGING_FARMER_B_PASSWORD=…
# optional but recommended for full SG-1/SG-2 coverage:
STAGING_DATABASE_URL=postgres://…      # enables psql catalog RLS/audit facts (group F)
STAGING_ALLOW_AUDIT_INSERT=true        # opt-in audit-insert probe
STAGING_PENDING_EMAIL=…  STAGING_PENDING_PASSWORD=…
```

| ID | Check | Pass criterion | Result |
|----|-------|----------------|--------|
| B1 | Farmer A cannot read Farmer B's farm | Cross-tenant SELECT denied | ☐ |
| B2 | Farmer cannot write batch `status` | INSERT/UPDATE on status denied for farmer role | ☐ |
| B3 | Admin can read/write per policy | Admin ops succeed | ☐ |
| B4 | RLS enabled on pilot tables (psql facts) | Every required `fact=true` | ☐ |
| B5 | Audit log captures key actions (opt-in insert probe) | Audit row appears with actor | ☐ |

## C. Manual UI smoke — the 4 flows (staging app)

### Flow 1 — Farm profile creation
| ID | Step | Pass | Result |
|----|------|------|--------|
| C1.1 | Create farm with all required §2 fields → submit | Status `Submitted to DDP` | ☐ |
| C1.2 | Omit a required field | Blocked, field named | ☐ |
| C1.3 | Farm create appears in audit trail | Actor + timestamp row | ☐ |

### Flow 2 — Evidence upload
| ID | Step | Pass | Result |
|----|------|------|--------|
| C2.1 | Upload licence + GACP/GAP + COA (PDF ≤10MB) | Files stored; signed URL opens | ☐ |
| C2.2 | Upload non-PDF | Rejected, clear error | ☐ |
| C2.3 | Upload >10MB | Rejected, clear error | ☐ |
| C2.4 | Simulate upload failure (kill network) | Explicit error, no silent success | ☐ |

### Flow 3 — Compliance review + status
| ID | Step | Pass | Result |
|----|------|------|--------|
| C3.1 | Reviewer moves farm Under Review → Approved/Rejected | Status + history recorded | ☐ |
| C3.2 | Reviewer flags Missing Document + gaps | Gap list shown to client view | ☐ |
| C3.3 | Status change audit-logged with actor | Old→new + actor + time | ☐ |
| C3.4 | AI draft with claim wording ("compliant"/"approved") | Blocked by `aiComplianceGuard` | ☐ |

### Flow 4 — Client report export
| ID | Step | Pass | Result |
|----|------|------|--------|
| C4.1 | Attempt export with no approved decision | Export disabled (fails closed) | ☐ |
| C4.2 | Record named-approver `progress` decision → export | Print→PDF + summary copy produce §5 fields | ☐ |
| C4.3 | Snapshot recorded with SHA-256 hash | `contentHash` present | ☐ |

## D. Safety-gate evidence (SG-3…SG-6)
| ID | Gate | Pass | Result |
|----|------|------|--------|
| D1 | SG-3 Upload smoke (C2.1–C2.4 all green) | 4/4 | ☐ |
| D2 | SG-4 Backup taken + restore rehearsed on staging | Drill doc attached | ☐ |
| D3 | SG-5 Incident runbook exists + dry-run once | Runbook + note | ☐ |
| D4 | SG-6 Human-approval fail-closed (C4.1 green) | Confirmed | ☐ |

---

## Run log
| Date | Runner | A pass? | B pass? | C pass? | D pass? | Overall |
|------|--------|---------|---------|---------|---------|---------|
| 2026-07-24 | OP | ✅ A1–A5 (`ci:verify` exit 0: 1740 tests, security:sql, tsc, lint, build) | NOT RUN — no staging creds | NOT RUN — needs staging app | NOT RUN — needs staging | A green; B/C/D pending staging |
