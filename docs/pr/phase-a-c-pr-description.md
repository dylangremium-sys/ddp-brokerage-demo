# PR: Watchtower ingestion & provenance foundation (Phases A–C)

**Branch:** `feature/watchtower-ingestion-phase-a-c` → `main`
**Commit:** `5c5e32f0a67e57eb2790a6767e262d8ee05b0b05`

---

## PR Title (copy-paste)

```
feat(watchtower): ingestion & provenance foundation (Phases A–C, internal-only, no AI)
```

---

## PR Body (copy-paste)

### Summary

Adds the **ingestion and provenance foundation** of the Compliance Watchtower —
Phases A, B and C only. This is production-safe, internal-only regulatory
ingestion infrastructure: authoritative source registry governance → scheduled/
triggerable source ingestion → normalization & deduplication → candidate legal
update persistence with full provenance → failure-safe operational telemetry.

**No AI, no review-queue decisions, no rule activation, no impact analysis, no
alert propagation.** Candidate legal updates are created in `status = 'new'` only
and still pass through the existing human Review Queue.

### What was built

- **Phase A — provenance & dedup schema** (`migration 25`): two admin-only
  evidence tables (`watchtower_ingestion_runs`, `watchtower_ingestion_items`) and
  6 nullable provenance columns on `legal_updates` (content hash, canonical URL,
  external document id, source tier, ingestion run/item refs). Partial dedup
  indexes: content-hash global-unique, external-id unique-per-source, canonical
  URL non-unique (revisions still record). Fail-conservative run-status algebra +
  append-only/immutability triggers, all DB-enforced.
- **Phase B — source governance & tiering** (`migration 26`): tier (1 primary /
  2 secondary / 3 signal), authority type, category, monitoring method, priority
  on `regulatory_sources`, with allowed-value CHECKs mirrored in app code. Legacy
  rows backfilled to the least-authoritative Tier-3 shape. **Tier-3 authority
  guard**: a DB trigger refuses an *enforced* compliance rule that traces to a
  Tier-3 source (drafts still allowed).
- **Phase C — ingestion runner**: pure orchestration core
  (`watchtowerIngestionRun.ts`) + dependency-injected service
  (`watchtowerIngestionService.ts`) that reuses the existing connector
  (`executeRssConnector` + browser fetch — no new transport), deduplicates,
  creates draft candidates, and records run/item evidence. Minimal admin UI:
  governance fields on the Source Registry + a new **Ingestion Runs** tab.

### Files changed (19)

**Migrations (6):**
`25_WATCHTOWER_INGESTION_PROVENANCE_{HARDENING,VERIFY,ROLLBACK}.sql`,
`26_WATCHTOWER_SOURCE_GOVERNANCE_{HARDENING,VERIFY,ROLLBACK}.sql`

**Domain / persistence (new):** `src/lib/complianceSourceGovernance.ts`,
`src/lib/watchtowerIngestionRun.ts`, `src/lib/watchtowerIngestionService.ts`
**Domain / persistence (modified):** `src/lib/complianceRepository.ts`,
`src/lib/complianceSourceRegistry.ts`, `src/types.ts`

**UI:** `src/components/admin/WatchtowerIngestionPanel.tsx` (new),
`src/pages/admin/DDPComplianceWatchtower.tsx` (modified)

**Tests (new):** `src/lib/complianceSourceGovernance.test.ts`,
`src/lib/watchtowerIngestionRun.test.ts`,
`src/lib/watchtowerIngestionService.test.ts`

**Docs (new):** `docs/WATCHTOWER_INGESTION_PHASE_A_C_ARCHITECTURE.md`,
`docs/WATCHTOWER_INGESTION_RUNBOOK.md`

### Migration order

```
25_..._HARDENING → 25_..._VERIFY → 26_..._HARDENING → 26_..._VERIFY
```

Migration 26 requires 25 (reads `legal_updates.source_tier`). Apply with a role
owning the `public` schema, `-v ON_ERROR_STOP=1`. Deploy the app build only after
the migrations are applied.

### Verification evidence

Executed against a disposable PostgreSQL 18 instance (throwaway DB; VERIFY scripts
run in one transaction ending in ROLLBACK):

| Gate | Result |
|---|---|
| `25_..._VERIFY.sql` | **A–H PASSED** (8/8) |
| `26_..._VERIFY.sql` | **A–F PASSED** (6/6) |
| Both migrations apply on a fresh DB | clean, idempotent |
| Rollbacks | 25 refuses without opt-in, reverses with it; 26 clean + re-backfill |
| `tsc -b` | ✅ pass |
| `eslint .` | ✅ pass |
| `vitest run` | ✅ **1920 passed** (3 failures are **pre-existing**, see below) |
| `node scripts/check-security-migrations.mjs` | ✅ PASS |
| `vite build` | ✅ pass |

**Pre-existing failures (not introduced by this PR):**
`scripts/sensitive-storage-registry.test.mjs` and `scripts/deploy-workflow.test.mjs`
(3 tests). Verified: this commit touches neither test file, adds no `ddp_`
localStorage key, and both fail identically on the parent commit `4fb72f7`.

### Rollback plan

Reverse order (**26 before 25**; 26's guard reads a column 25 owns).

- **`26_..._ROLLBACK.sql`** — drops governance classification only (no evidence
  loss); re-applying re-backfills to Tier 3. ⚠️ Removes the Tier-3 guard.
- **`25_..._ROLLBACK.sql`** — **refuses** while ingestion evidence exists unless
  `SET watchtower.rollback_destructive='true'`. `legal_updates` rows survive;
  only provenance columns drop. Capture a `pg_dump` of the evidence tables first.

Full procedure: `docs/WATCHTOWER_INGESTION_RUNBOOK.md` §6.

### Security posture

Admin-only RLS (`is_ddp_admin()`); no public exposure. No AI provider SDK,
endpoint, or credential anywhere in this phase. Transport safety reused from the
existing connector (HTTPS-only, deny-by-default host allowlist, SSRF guard,
no redirect-follow). Bounded/validated inputs at both app and DB layers.
`DELETE`/`TRUNCATE` on evidence tables granted to nobody (incl. service_role).

### Known residual risks (before Phase D)

1. **Triggerable, not yet scheduled.** A cron/Vercel scheduled trigger is a thin
   adapter over `runIngestionBatch()`, deferred — needs its own admin-scoped auth;
   no service-role ingestion path exists by design.
2. **Only RSS/Atom auto-fetched today.** `html`/`pdf`/`government_api` sources
   surface as `unsupported_connector` failed runs (fail-closed) until built.
3. **Allowlist derived from registered source hosts** (SSRF-guarded); a curated
   allowlist is a Phase-D hardening.
4. **`ingestion_item_key` stored but not uniquely indexed** — content-hash /
   external-id are the enforced dedup keys; item-key is provenance only.
5. **Tier-3 guard covers the one downstream state that exists today** (enforced
   rules). Each new Phase-D sink must add its own guard / call `guardTier3Authority()`.

### Explicitly OUT OF SCOPE (this PR)

- ❌ AI triage / AI summary generation
- ❌ AI compliance-language guard extensions
- ❌ human review-queue action workflows
- ❌ rule lifecycle enforcement
- ❌ impact engine
- ❌ compliance alert generation from rules

---

## How to open the PR

This description is prepared for you to paste; no PR was opened automatically.

- Web: https://github.com/dylangremium-sys/ddp-brokerage-demo/pull/new/feature/watchtower-ingestion-phase-a-c
- CLI:
  ```bash
  gh pr create --base main --head feature/watchtower-ingestion-phase-a-c \
    --title "feat(watchtower): ingestion & provenance foundation (Phases A–C, internal-only, no AI)" \
    --body-file docs/pr/phase-a-c-pr-description.md
  ```
