# Reviewer request — Watchtower ingestion foundation (Phases A–C)

Paste this as the first comment on the PR to set scope and focus review.

---

👋 Requesting review on the **ingestion & provenance foundation** for the
Compliance Watchtower. Please read with the scope lock below in mind.

### 🔒 Scope lock — what this PR *is*

**Phases A–C only:** source-governance schema, provenance/dedup schema, and a
triggerable ingestion runner that creates **draft (`status = 'new'`) candidate
legal updates** which still flow through the existing human Review Queue.

**Explicitly NOT in this PR** (deferred to Phase D — please don't block on their
absence):
- ❌ AI triage / AI summaries / AI language-guard changes
- ❌ human review-queue action workflows
- ❌ rule lifecycle enforcement
- ❌ impact engine
- ❌ compliance alert generation from rules
- ❌ automated scheduling (the runner is *triggerable*, not yet scheduled)

### 🎯 Please validate these three things specifically

1. **Migration safety** (`25_*`, `26_*`)
   - Additive & backward-compatible: new `legal_updates` columns are nullable;
     dedup indexes are partial (machine-ingested rows only); manual pastes
     untouched.
   - `26` uses `NULLABLE → backfill(Tier 3) → default → NOT NULL` to avoid a table
     rewrite and to ensure nothing silently gains authority on upgrade.
   - Idempotent forward migrations; rollbacks are exact inverses; `25` rollback
     refuses to destroy evidence without an explicit opt-in.
   - Evidence: `25_..._VERIFY` = **A–H PASS (8/8)**, `26_..._VERIFY` = **A–F PASS
     (6/6)** on PostgreSQL 18.

2. **RLS / access posture**
   - New tables are admin-only via `is_ddp_admin()`, matching migration 9.
   - `DELETE`/`TRUNCATE` on evidence tables granted to **nobody** (incl.
     `service_role`); items append-only; runs closable-once and immutable once
     terminal — all trigger-enforced.
   - No AI provider SDK / endpoint / credential anywhere; transport safety
     (HTTPS-only, deny-by-default host allowlist, SSRF guard, no redirect-follow)
     reused from the existing connector.

3. **Fail-conservative behaviour**
   - "Source unavailable ⇒ **failed** run, never a silent no-change." Enforced
     twice: in the pure runner (`summarizeRun()` can't return `succeeded` with any
     failure) **and** by DB CHECK constraints. Please confirm you agree neither
     layer can be bypassed to record a failed check as success.
   - The **Tier-3 authority guard**: a Tier-3 (intelligence-signal) source can
     raise a draft for review but a DB trigger blocks it from sourcing an
     *enforced* rule.

### ✅ Verification already run

`tsc -b` ✅ · `eslint .` ✅ · `vitest` ✅ 1920 passed · SQL security gate ✅ PASS ·
`vite build` ✅ · both migrations apply + verify on a disposable PG 18.

### ⚠️ Known pre-existing test failures (NOT from this PR)

3 tests fail (`sensitive-storage-registry`, `deploy-workflow`). They reproduce on
the parent commit `4fb72f7`, this branch touches neither, and the root cause is an
environment path-encoding artifact (this working copy lives under a directory with
a space). Tracked separately — see the linked issue. **Please don't conflate them
with this PR.**

### 📄 Reference docs in this PR

- Architecture: `docs/WATCHTOWER_INGESTION_PHASE_A_C_ARCHITECTURE.md`
- Ops runbook: `docs/WATCHTOWER_INGESTION_RUNBOOK.md`
- Staging apply: `docs/release/phase-a-c-staging-checklist.md`
- Admin smoke test: `docs/release/phase-a-c-admin-smoke-test.md`

Thanks! Happy to walk through any section.
