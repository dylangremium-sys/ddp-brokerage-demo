# DDP Brokerage — Sequential Controlled Pilot Execution Plan

**Adopted:** 2026-08-10  
**Repository baseline:** `origin/main` at `74a1a2599468c0c15b687cf2fc4eddff20b1d1fd`  
**Authority:** This is the immediate execution programme under `docs/MASTER_DEVELOPMENT_ROADMAP.md`. The Master Development Roadmap remains the product source of truth; this document controls the order, evidence gates, stop conditions, and owner approvals for the first genuine-farm pilot.  
**Mode:** Sequential execution. Only one release gate may be `IN PROGRESS` at a time.

## 1. Objective

Move DDP from a partially proven product to a controlled operational pilot by proving one complete, evidence-backed supplier lifecycle:

> DDP provisions one genuine farm → the farm signs in → submits genuine farm and batch information → uploads photographs and documents → a named administrator requests a correction → the farm responds → the administrator approves → DDP issues one controlled, immutable Buyer Pack containing approved information only.

The programme also establishes recoverability and removes fake production data safely. It does **not** claim that contracts, fulfilment, chain of custody, invoicing, payment processing, margin reporting, regulatory approval, pharmaceutical compliance, or a complete buyer marketplace are implemented.

## 2. Non-negotiable controls

1. Work from current `origin/main` in a dedicated branch/worktree. Never continue implementation from a stale feature branch without re-verifying the defect on current `main`.
2. Preserve unrelated work. Never force-push another contributor's branch.
3. Run the repository's documented verification gate before declaring an engineering release complete.
4. Never edit an applied migration. New database changes are forward-only and must follow the migration-number register.
5. Do not change production data until the production identity, migration state, backup, restoration test, inventory, deletion manifest, and dry run are complete.
6. Production cleanup requires a separate, explicit approval from the release owner after the exact immutable-ID manifest is presented.
7. Never delete by name, display label, broad email pattern, or wildcard.
8. Never weaken RLS, storage privacy, audit attribution, or file validation to make a test pass.
9. Never commit genuine COAs, licences, certificates, credentials, personal data, or original supplier evidence to the public application repository.
10. A photograph is visual evidence only. It does not prove strain, batch, weight, ownership, origin, laboratory result, licence, certification, or legal status.
11. Do not infer evidence associations from filenames. Unproven associations remain `UNASSIGNED`.
12. Do not invite farms two through five until the first genuine farm completes the controlled lifecycle.

## 3. Status model

Each release uses exactly one status:

| Status | Meaning |
|---|---|
| `NOT STARTED` | No work has been accepted for this gate. |
| `IN PROGRESS` | This is the only active release gate. |
| `BLOCKED` | A named dependency, credential, owner decision, or external participant is missing. |
| `AWAITING OWNER APPROVAL` | Evidence is complete and an explicit owner decision is required. |
| `PASSED` | Every acceptance criterion has direct evidence. |
| `FAILED` | Work was attempted but one or more acceptance criteria failed. |

Passing compilation, rendering a screen, adding a migration, or passing unit tests is not sufficient unless the gate specifically requires only that evidence.

## 4. Sequential release register

| Order | Release | Initial status | Completion gate |
|---:|---|---|---|
| 0 | Establish repository and deployment truth | `IN PROGRESS` | Current code, production SHA, migration state, branches, open work, freeze rules, and baseline failures are recorded. |
| 1 | Reconcile and preview the premium public site | `NOT STARTED` | Redesign is rebased/recreated on current `main`, fully verified, pushed, and inspected in a non-production preview on desktop/mobile and EN/TH. |
| 2 | Prove farmer/admin lifecycle and evidence security | `NOT STARTED` | Provision → submit → correction → resubmit → approve succeeds; isolation and malicious-upload tests deny correctly. |
| 3 | Complete COA ingestion and named review | `NOT STARTED` | One genuine COA is validated, stored privately, hashed, reviewed with provenance, and linked to a confirmed batch. |
| 4 | Inventory, back up, restore, and dry-run production cleanup | `NOT STARTED` | Every relevant record is classified; backup restoration reconciles; exact deletion manifest and dry run are produced. |
| 5 | Execute controlled production cleanup | `NOT STARTED` | Owner approves the exact manifest; only approved IDs are removed; preserved systems and counts reconcile. |
| 6 | Onboard the first genuine farm | `NOT STARTED` | The real farm independently completes the correction-and-approval lifecycle and confirms its final record. |
| 7 | Issue and revoke the first controlled Buyer Pack | `NOT STARTED` | Approved-only immutable snapshot is issued, access logged, private files protected, and access successfully revoked. |
| 8 | Reconcile canonical documentation and pilot verdict | `NOT STARTED` | Roadmap and runtime ledger contain measured final truth with `PROVEN`, `PARTIAL`, `PLANNED`, and `BLOCKED` labels. |

No later release may be marked `IN PROGRESS` until the preceding gate is `PASSED`, except that non-mutating evidence inspection may run early when it cannot affect production or create conflicting code changes.

## 5. Release 0 — Repository and deployment truth

### Work

- Confirm repository remote, default branch, current `origin/main`, worktree state, dirty files, open pull requests, and active branch claims.
- Read `AGENTS.md`, the Master Development Roadmap, Migration Runtime Status, migration-number register, production freeze, deployment runbook, and release checklist.
- Determine the exact commit served by production using the live provenance endpoint and deployment evidence.
- Determine actual staging and production migration states using read-only evidence. Do not infer applied state from SQL files existing in Git.
- Record pre-existing failures from the documented verification commands.
- Reconcile the local premium-site work with current `main`; treat commit `7ee9f20` as an unmerged candidate, not shipped truth.
- Locate existing implementation branches for COA, evidence review, storage, backup, and Buyer Packs. Reuse only code still applicable to current `main`.

### Evidence required

- Branch, full SHA, remote comparison, dirty-tree output, worktree list, and open-PR list.
- Production full SHA and how it was measured.
- Staging and production migration ledgers with `APPLIED`, `NOT APPLIED`, `UNKNOWN`, or `CONFLICT`.
- Baseline verification commands and actual results.
- Conflict/overlap register for active branches.

### Pass condition

The starting state is reproducible and no implementation claim depends on an old report, local-only branch, or repository file being mistaken for deployed state.

## 6. Release 1 — Premium public-site preview

### Work

- Compare candidate redesign commit `7ee9f20` with current `main` file by file.
- Recreate or cherry-pick only applicable changes onto a new branch based on current `origin/main`.
- Keep genuine photographs as presentation assets only if publication authority is confirmed. They must not become fabricated product or inventory records.
- Verify English and Thai content, semantic structure, keyboard navigation, focus states, responsive layouts, image handling, metadata, crawl policy, and public routes.
- Run `npm ci` and the documented `npm run ci:verify` gate.
- Push the branch and create a non-production preview.
- Inspect approximately 1440×900 and 390×844, both languages, navigation, console, network, images, and routes.

### Pass condition

The release owner can inspect a real preview; the tested branch and commit are recorded; no production database data was changed; and no invented commercial or compliance claim appears.

## 7. Release 2 — Farmer lifecycle and evidence security

### Required lifecycle

1. Named administrator provisions a controlled farmer.
2. Farmer signs in and completes onboarding.
3. Farmer creates a batch and uploads valid evidence.
4. Farmer submits for review.
5. Named administrator requests a specific correction.
6. Farmer receives and responds to the request.
7. Named administrator approves the corrected submission.
8. Append-only audit history records actor, target, action, time, and state transition.

### Security proofs

- Farmer A cannot read or mutate Farmer B's records.
- Farmer cannot access admin pages, RPCs, or actions.
- Anonymous users cannot retrieve evidence.
- Raw storage paths do not provide public access.
- Authorised review uses short-lived signed URLs.
- Database and storage RLS agree.
- Upload validation checks bytes/magic signatures, not only filenames or client MIME.
- JPEG, PNG, and PDF allowlists and size limits are enforced.
- SVG, HTML, scripts, executables, fake extensions, MIME mismatches, and representative polyglots are rejected.
- Evidence is served with safe content type and disposition behaviour.
- Original digest and uploader identity are retained.

### Pass condition

The lifecycle succeeds in a production-like environment and every allow/deny case has direct test evidence. A local UI demonstration without database/storage enforcement does not pass.

## 8. Release 3 — COA ingestion and named human review

### Required workflow

- Validate actual bytes and enforce limits.
- Preserve the immutable original in private storage.
- Calculate SHA-256 and detect exact duplicates deliberately.
- Extract machine-readable content; route scans and unknown formats to manual review.
- Keep farmer-entered values, extracted values, confidence, corrections, and approvals separate.
- Support at least `UPLOADED`, `EXTRACTED`, `MANUAL_REVIEW_REQUIRED`, `CORRECTED`, `APPROVED`, `INCONSISTENT`, `UNCHECKABLE`, `EXPIRED`, and `REJECTED`.
- Never silently overwrite the farmer's original entry.
- Handle multi-report PDFs explicitly.
- Record named reviewer and append-only review history.
- Link an approved result only after farm, strain/product, batch/lot, and harvest association is confirmed.

### Pass condition

At least one genuine document completes validation, private storage, hashing, extraction/manual routing, named review, provenance retention, and confirmed batch linkage in a production-like environment.

## 9. Pilot evidence register

The source files are private pilot inputs and are **not repository assets**. Hashes below identify the exact files available to the 2026-08-10 working session.

| File | Detected type | SHA-256 | Initial status |
|---|---|---|---|
| `01-WhatsApp-Image-2026-03-28-at-10.14.56.jpeg` | JPEG, 1108×1477 | `ea0379d09601ac19178e3f6152d5ec4e6cade49fde8f9100ad53a21837663a19` | `UNASSIGNED_VISUAL_EVIDENCE` |
| `02-WhatsApp-Image-2026-03-28-at-10.16.46.jpeg` | JPEG, 1108×1477 | `7dbf4769589c207ad3c145e7afb72ba074e7d28fb7f43e8cccddc12c50ea3f88` | `UNASSIGNED_VISUAL_EVIDENCE` |
| `03-WhatsApp-Image-2026-03-28-at-10.16.46-1-.jpeg` | JPEG, 1108×1477 | `a91f92c420f46d94e0e7a7097cebf5c03260142ecf1a0191f4b8c9552971952f` | `UNASSIGNED_VISUAL_EVIDENCE`; `WR` meaning unconfirmed |
| `04-Calli-2026-2-.pdf` | PDF 1.4, 9 pages | `138a5c43cc1d64ac8a75c73a8a17b63c83a215357f40e0cad19bbc40094eb509` | `UNASSIGNED`; exact duplicate group A |
| `05-Calli-2026-1-.pdf` | PDF 1.4, 9 pages | `138a5c43cc1d64ac8a75c73a8a17b63c83a215357f40e0cad19bbc40094eb509` | `UNASSIGNED`; exact duplicate group A |
| `06-coa2.pdf` | PDF 1.4, 9 pages | `138a5c43cc1d64ac8a75c73a8a17b63c83a215357f40e0cad19bbc40094eb509` | `UNASSIGNED`; exact duplicate group A |
| `07-coq3.pdf` | PDF 1.4, 9 pages | `138a5c43cc1d64ac8a75c73a8a17b63c83a215357f40e0cad19bbc40094eb509` | `UNASSIGNED`; exact duplicate group A |
| `08-coa7.pdf` | PDF 1.7, 3 pages | `378f3a41bb6c0db4d51a087a1b0960afc65a62e9bbc33dde0b951f834d42156f` | `UNASSIGNED`; exact duplicate group B |
| `09-coa9.pdf` | PDF 1.7, 3 pages | `24757188faf446cdbd7010beacfb01b224e0e6c4b0ed338a2f52246fa2441a92` | `UNASSIGNED` |
| `10-coa5.pdf` | PDF 1.7, 3 pages | `b73477c735a1830185075e91de1c2a9e828a0986f43483d73bd70581b164db87` | `UNASSIGNED` |
| `11-coa4.pdf` | PDF 1.7, 3 pages | `7d1f6e75f9b32823633590f743f49306d9ebf77885ca294827212616f6c37939` | `UNASSIGNED` |
| `12-COA1.pdf` | PDF 1.7, 3 pages | `5459e135ce5a846cde26739b0ad840829d1829decbffda672dff63453792ca92` | `UNASSIGNED` |
| `13-coa56.pdf` | PDF 1.7, 3 pages | `fbced078378b22e939aad39e2905ece98de51c7963bee62bbfec9d9c1ef64aa4` | `UNASSIGNED` |
| `14-coa8.pdf` | PDF 1.7, 3 pages | `378f3a41bb6c0db4d51a087a1b0960afc65a62e9bbc33dde0b951f834d42156f` | `UNASSIGNED`; exact duplicate group B |

Before any item can be approved, the farm or release owner must confirm its farm, product/strain, batch/lot, harvest, and intended evidence role. Expiry dates and document claims must be read from the source and reviewed; filenames and prior conversations are not sufficient.

## 10. Release 4 — Production inventory, backup, restore, and cleanup dry run

### Inventory

Count and classify authentication users, profiles, administrators, farmers, farms, batches, photographs, documents, COAs, extractions, reviews, correction requests, buyer organisations, Buyer Packs, reservations, audit records, and storage objects.

Every relevant record receives one classification:

- `KEEP_ADMIN`
- `GENUINE_FARM`
- `DELETE_FAKE`
- `PRESERVE_AUDIT`
- `UNCERTAIN_REQUIRES_DECISION`

### Recoverability

- Capture PostgreSQL application data, required auth metadata, storage inventory and private-object copies, counts, deployment identity, migration identity, deletion manifest, and configuration inventory without secret values.
- Restore into an isolated disposable environment.
- Reconcile restored rows and objects to the source inventory.
- Record backup identity, creation time, retention location, restoration procedure, restoration result, and operator.

### Cleanup tooling

- Default to dry run.
- Accept explicit immutable IDs only.
- Require expected affected-row and storage-object counts.
- Abort on any mismatch or unclassified dependency.
- Use transactions where possible and reconcile non-transactional storage separately.
- Preserve or anonymise attribution where deletion would break audit integrity.
- Produce before/after counts and a machine-readable execution record.

### Pass condition

Restoration succeeds, counts reconcile, every relevant record is classified or stopped for decision, and the dry run produces the exact immutable-ID deletion manifest without changing production.

## 11. Mandatory owner approval checkpoint

After Releases 0–4 pass, present:

1. Production and migration identity.
2. Backup identity and restoration proof.
3. Before counts.
4. Exact record IDs and storage objects proposed for deletion.
5. Expected affected counts.
6. Dry-run output.
7. Preserved administrators, audit data, Watchtower data, and genuine evidence.
8. Every uncertain record and required decision.

Then stop. The instruction to adopt or work through this plan is **not** permission to delete production data. Release 5 begins only after the owner explicitly approves the presented manifest.

## 12. Release 5 — Controlled production cleanup

- Reconfirm production SHA, migration state, backup availability, manifest, counts, and absence of unexpected drift immediately before execution.
- Execute only the approved IDs.
- Abort on mismatch.
- Verify database/storage reconciliation and intended object removal.
- Verify genuine administrators, authentication, RLS, uploads, review workflow, Watchtower data, and required audit history remain operational.
- Record authoriser, operator, time, manifest hash, before/after counts, and result.

### Pass condition

No fake commercial record remains within the approved scope; no unapproved record was removed; preserved systems work; and the complete deletion is evidenced and recoverable from the verified backup.

## 13. Release 6 — First genuine farm

The farm—not an agent impersonating it—must:

1. Receive its provisioned account.
2. Sign in independently.
3. Complete genuine profile information.
4. Create or confirm one genuine batch.
5. Associate genuine photographs and documents.
6. Submit for review.
7. Receive a real, specific admin correction request.
8. Respond through the platform.
9. Reach named-admin approval.
10. Confirm the final record is accurate.

DDP records each confusion point and repairs material workflow defects before inviting another farm.

### Pass condition

One genuine farm independently completes the lifecycle, remains isolated from other farms, and confirms its approved record.

## 14. Release 7 — Controlled Buyer Pack

- Select one approved batch.
- Generate an immutable snapshot and cryptographic digest containing approved information only.
- Prevent later source edits from mutating the issued snapshot.
- Grant access to one controlled buyer identity or scope.
- Record issuer, recipient/scope, issue time, view/access events, and revocation.
- Use authorised expiring links for private evidence.
- Prove access can be revoked.
- Do not imply ordering, contracting, payment, fulfilment, or chain-of-custody capabilities that are not implemented.

### Pass condition

One approved-only pack is issued, accessed, audited, and revoked without exposing private evidence permanently.

## 15. Release 8 — Canonical reconciliation and verdict

Update the Master Development Roadmap and Migration Runtime Status with:

- Current repository, deployed, and migration identity.
- Baseline and final counts.
- Backup/restoration and cleanup results.
- First-farm lifecycle result.
- COA workflow result.
- Buyer Pack result.
- Links to commits, pull requests, runbooks, and redacted evidence.
- Every remaining blocker.
- Accurate `PROVEN`, `PARTIAL`, `PLANNED`, and `BLOCKED` labels.

Choose exactly one pilot verdict:

- `READY FOR ONE-FARM CONTROLLED PILOT`
- `CONDITIONALLY READY`
- `BLOCKED`

## 16. Required evidence ledger for every release

For each claimed result record:

- Date/time and environment.
- Repository branch and full commit SHA.
- Deployed full commit SHA where relevant.
- Migration state where relevant.
- Named operator and reviewer.
- Exact command or manual procedure.
- Expected result.
- Actual result.
- Redacted record IDs or evidence references.
- Pass/fail/block verdict.
- Remaining risk.

Test counts must be accompanied by the business behaviour they prove. Secrets, passwords, tokens, private evidence, and unnecessary personal data must never appear in the ledger.

## 17. Ruthless completion rule

Do not declare the programme complete because screens exist, tests pass, files upload, a database looks cleaner, or an administrator can manually edit records.

The programme passes only when:

> One genuine farm independently signs in, supplies genuine information and evidence, receives and answers a named administrator's correction, reaches an approved inventory record, remains unable to see another farm's information, keeps private evidence inaccessible to unauthorised users, and produces one controlled Buyer Pack containing approved information only.

Until that evidence exists, DDP remains a controlled pilot and must not be described as a fully proven live brokerage marketplace.
