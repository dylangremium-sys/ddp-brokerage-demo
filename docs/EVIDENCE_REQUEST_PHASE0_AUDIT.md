# Evidence Request Workflow — Phase 0 Repository Audit

Date: 2026-07-20

Contract: `DDP EVIDENCE REQUEST & RESOLUTION WORKFLOW — BINDING IMPLEMENTATION CONTRACT v1.0`

## Frozen implementation base

- Repository: `dylangremium-sys/ddp-brokerage-demo`
- Default branch: `main`
- Frozen base SHA: `12d03a9f394761252c658f380a1999dda9746446`
- Base commit: `Add read-only admin Operations Desk (#34)`
- Integration branch: `feature/evidence-request-workflow`

No evidence-request implementation branch existed before this branch was created.

## Baseline evidence

The merged PR that produced the frozen base reports:

- TypeScript build passed.
- ESLint passed.
- Production build passed.
- 972 tests across 64 files passed.
- `git diff --check` passed.

Authenticated Supabase browser verification was not available in that PR and remains a required later gate.

GitHub's combined status for the frozen base currently reports failing DeepSource JavaScript, SQL, and Secrets contexts. No pull-request-triggered GitHub Actions workflow run is attached to the merge commit. This feature must not claim a clean current-main quality baseline until those external statuses are reconciled or explicitly baselined.

## Current repository architecture

- Application routing is a `Page` union plus state-driven rendering in `src/App.tsx`.
- No routing library is used or required.
- The existing farmer request feature uses a separate two-state `ReviewRequest` model (`open` / `resolved`). It must not be silently reused as the authoritative evidence-request model.
- The Operations Desk is present on the frozen base and is read-only.
- `src/App.tsx`, `src/types.ts`, and `src/lib/db.ts` remain central integration-lead files.
- The project uses Vitest in a Node environment, with tests under `src/**/*.test.ts`.
- The canonical verification command is `npm run ci:verify`.

## Migration audit

The highest numbered migration present on frozen `main` is:

- `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql`

Open PR #22 contains unmerged migrations:

- `21_DDP_CONTROLLED_FARMER_PROVISIONING_*`
- `22_OPERATIONAL_FARMER_ACCESS_RLS_*`

Therefore migration numbers no longer provide a safe standalone ordering guarantee. The evidence-request migration number is deliberately **not allocated** in this phase.

Before Agent A starts, the Integration Lead must resolve one of these paths:

1. Merge or otherwise reconcile PR #22, then allocate the next migration identifier against the resulting repository state; or
2. Version the contract to define an alternative authorization foundation that does not depend on PR #22.

No SQL migration may be created until that decision is recorded.

## Authorization prerequisite audit

Frozen `main` currently defines only these browser roles:

- `ddp_admin`
- `farmer`

It still contains public farmer signup code and does not contain the `pending` role or the operational-farmer access foundation required by the contract. Those changes exist only in open PR #22.

Consequences:

- The contract's pending-user denial tests cannot be implemented faithfully against frozen `main` alone.
- The canonical `can_operationally_access_farm(target_farm_id uuid)` helper must not be implemented by weakening access to generic `authenticated` users.
- Database/RLS work is stopped until the provisioning and operational-access dependency is resolved.

## Existing data-model mapping still required

Before SQL work begins, the Integration Lead must confirm from the authoritative schema and staging database:

- The ownership chain from `farm_profiles` to `farms`.
- The ownership chain from `inventory_batches` to `farms`.
- The current purpose and ownership columns of `farmer_documents`.
- The current purpose and ownership columns of `documents`.
- Whether existing storage object metadata can be safely linked without copying.
- The exact farm-membership active-state semantics.

Code search alone is not sufficient evidence for these security decisions.

## Deployment ordering

Repository history documents that Git-triggered Vercel production deployment from `main` was disabled and that GitHub Actions is the routine production path. The contract's database-first deployment order remains mandatory and must be reverified before merge because deployment configuration can change.

## Phase 0 decision

### Permitted now

- Freeze shared TypeScript domain values.
- Freeze route payload contracts without central route registration.
- Add pure contract tests.
- Continue schema and repository mapping.

### Stopped now

- Migration-number allocation.
- SQL schema, RLS, RPC, or storage policy implementation.
- `src/App.tsx` route wiring.
- Reuse of legacy `ReviewRequest` as the new authoritative model.
- Any implementation that assumes the `pending` role is already on `main`.

## Initial implementation record

The integration branch begins with compile-isolated shared files only:

- `src/domain/evidenceRequests.ts`
- `src/lib/evidenceRequestRoutes.ts`
- `src/domain/evidenceRequests.test.ts`

These files do not alter runtime routing, database behavior, authentication, Operations Desk behavior, Buyer Pack behavior, or Compliance Watchtower behavior.

## Remaining Phase 0 completion evidence

Phase 0 is not fully closed until all of the following are recorded:

- Exact schema ownership map.
- Final migration allocation.
- Resolution of the PR #22 dependency.
- Fresh local or CI execution of `npm run ci:verify` on the integration head.
- Clean external-status baseline or documented accepted baseline.
- Confirmed automatic deployment behavior.
