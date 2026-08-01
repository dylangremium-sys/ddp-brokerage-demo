# DDP Brokerage Demo — documentation index

Every link here was checked against the tree it ships in. If a link is broken,
the index is wrong and should be fixed rather than worked around.

## Start here

- [`../README.md`](../README.md) — product scope, local/Supabase modes, auth model, the AI summariser and its guards, migration safety, deployment
- [`../AGENTS.md`](../AGENTS.md) — environment setup and verification commands; read before running anything
- [`MASTER_DEVELOPMENT_ROADMAP.md`](MASTER_DEVELOPMENT_ROADMAP.md) — what is built and what is planned

## Shipping

- [`DEPLOYMENT_RUNBOOK.md`](DEPLOYMENT_RUNBOOK.md)
- [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md)
- [`PRODUCTION_CHANGE_FREEZE_2026-07-25.md`](PRODUCTION_CHANGE_FREEZE_2026-07-25.md) — check whether a freeze is in force before touching production
- [`LAUNCH_GO_NO_GO_2026-07-25.md`](LAUNCH_GO_NO_GO_2026-07-25.md)
- [`PILOT_LAUNCH_REHEARSAL.md`](PILOT_LAUNCH_REHEARSAL.md)

## Migrations

Never replay a migration that has already been applied. Repository-recorded
state is not proof of live state — verify against the live catalog first.

- [`MIGRATION_RUNTIME_STATUS.md`](MIGRATION_RUNTIME_STATUS.md) — recorded environment status
- [`MIGRATION_NUMBER_REGISTER.md`](MIGRATION_NUMBER_REGISTER.md) — number allocation, to prevent collisions
- [`MIGRATION_RUNTIME_REGISTER.md`](MIGRATION_RUNTIME_REGISTER.md)
- [`PRODUCTION_MIGRATION_PLAN.md`](PRODUCTION_MIGRATION_PLAN.md)
- [`DISPOSABLE_PG_HARNESS.md`](DISPOSABLE_PG_HARNESS.md) — real-Postgres verification harness (`npm run verify:migration`)

## Compliance Watchtower and AI

- [`WATCHTOWER_INGESTION_PHASE_A_C_ARCHITECTURE.md`](WATCHTOWER_INGESTION_PHASE_A_C_ARCHITECTURE.md)
- [`WATCHTOWER_INGESTION_RUNBOOK.md`](WATCHTOWER_INGESTION_RUNBOOK.md)
- [`CANNAMONITOR_WATCHTOWER_INTEGRATION.md`](CANNAMONITOR_WATCHTOWER_INTEGRATION.md) — source-permission gate
- [`CSP_FEED_RETRIEVAL_DECISION.md`](CSP_FEED_RETRIEVAL_DECISION.md)
- [`DDP_AI_LEGAL_PRODUCTION_READINESS_MASTER_REPORT.md`](DDP_AI_LEGAL_PRODUCTION_READINESS_MASTER_REPORT.md) — AI readiness verdict and the prerequisites for expanding AI
- [`DDP_AI_LEGAL_PRODUCTION_READINESS_REVIEW.md`](DDP_AI_LEGAL_PRODUCTION_READINESS_REVIEW.md)
- [`runbooks/AI_SUMMARISER_REMEDIATION_PLAN.md`](runbooks/AI_SUMMARISER_REMEDIATION_PLAN.md) — open work on the draft summariser

## Buyer Pack

- [`BUYER_PACK_AUTHORITATIVE_ISSUANCE_APPLICATION.md`](BUYER_PACK_AUTHORITATIVE_ISSUANCE_APPLICATION.md)
- [`BUYER_PACK_PHASE_A_SMOKE_TEST.md`](BUYER_PACK_PHASE_A_SMOKE_TEST.md)
- [`BUYER_PACK_PHASE_B_DESIGN.md`](BUYER_PACK_PHASE_B_DESIGN.md)

## Security and audits

- [`SECURITY_TEST_LOG.md`](SECURITY_TEST_LOG.md)
- [`AUDIT_PHASE2_EVIDENCE_REVIEW.md`](AUDIT_PHASE2_EVIDENCE_REVIEW.md)
- [`AUDIT_2026_07_13_MULTI_AGENT_DUE_DILIGENCE.md`](AUDIT_2026_07_13_MULTI_AGENT_DUE_DILIGENCE.md)
- [`MUTATION_TRUTHFULNESS_AUDIT_20260726.md`](MUTATION_TRUTHFULNESS_AUDIT_20260726.md)
- [`PHASE_5_FULL_MUTATION_AUDIT_20260726.md`](PHASE_5_FULL_MUTATION_AUDIT_20260726.md)
- [`PHASE_6_ROLE_SYSTEM_SECURITY_20260726.md`](PHASE_6_ROLE_SYSTEM_SECURITY_20260726.md)
- [`STAGING_SECURITY_ANALYSIS_20260726.md`](STAGING_SECURITY_ANALYSIS_20260726.md)
- [`BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md`](BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md)
- [`FARM_ADMIN_FIELD_GUARD_APPLICATION.md`](FARM_ADMIN_FIELD_GUARD_APPLICATION.md)
- [`audits/`](audits/) — dated audit reports

## Legal and market review

- [`THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md`](THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md)
- [`THAI_NATIVE_SPEAKER_REVIEW.md`](THAI_NATIVE_SPEAKER_REVIEW.md)
- [`PROFESSIONALIZATION_ROADMAP.md`](PROFESSIONALIZATION_ROADMAP.md)

## Operator and demo material

These live at the repository root, not under `docs/`:

- [`../HANDOVER_CHECKLIST.md`](../HANDOVER_CHECKLIST.md)
- [`../DEMO_SCRIPT.md`](../DEMO_SCRIPT.md)
- [`../DEMO_BASELINE.md`](../DEMO_BASELINE.md)
- [`../CURRENT_MVP_WORKING_STATE.md`](../CURRENT_MVP_WORKING_STATE.md)
- [`../RLS_MANUAL_TEST_CHECKLIST.md`](../RLS_MANUAL_TEST_CHECKLIST.md)

## Traceability records

- [`runbooks/`](runbooks/) — operational runbooks and remediation plans
- [`pr/`](pr/), [`release/`](release/), [`releases/`](releases/) — PR and release records

Historical records describe an environment as at a past date. Do not infer
current staging or production state from them without a fresh read-only check.
