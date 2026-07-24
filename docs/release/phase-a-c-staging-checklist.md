# Phase A–C — Staging Execution Checklist

For applying `migration 25` + `migration 26` to **staging** (never production from
this doc). Apply with a role owning the `public` schema and `-v ON_ERROR_STOP=1`.

> **Do not run production SQL from this checklist.** Production apply is a separate,
> human-approved step and is intentionally out of scope here.

---

## 0. Pre-flight

- [ ] Target is a **staging** connection string (double-check the host/DB name).
- [ ] Preconditions present on the target:
  - `public.is_ddp_admin()` (AUTH_RLS_SCHEMA)
  - `public.regulatory_sources`, `public.legal_updates` (migration 9)
  - `pgcrypto` extension
- [ ] A recent staging backup / snapshot exists (or staging is disposable).
- [ ] Branch `feature/watchtower-phase-a-c` checked out at its tip
      (code commit `3f8af9b`; later commits on the branch are release docs only —
      no SQL/code change, so any branch-tip checkout applies the same migrations).

```bash
STAGING="postgresql://…"   # staging only
```

## 1. Exact execution order

Run **in this order**. Each VERIFY runs inside one transaction ending in ROLLBACK,
so it creates no lasting rows.

```bash
# ── Phase A ──────────────────────────────────────────────
psql "$STAGING" -v ON_ERROR_STOP=1 -f 25_WATCHTOWER_INGESTION_PROVENANCE_HARDENING.sql
psql "$STAGING" -v ON_ERROR_STOP=1 -f 25_WATCHTOWER_INGESTION_PROVENANCE_VERIFY.sql

# ── Phase B ── (requires Phase A: reads legal_updates.source_tier) ─
psql "$STAGING" -v ON_ERROR_STOP=1 -f 26_WATCHTOWER_SOURCE_GOVERNANCE_HARDENING.sql
psql "$STAGING" -v ON_ERROR_STOP=1 -f 26_WATCHTOWER_SOURCE_GOVERNANCE_VERIFY.sql
```

## 2. Expected verification outcomes

- [ ] `25_..._VERIFY.sql` prints **VERIFY A–H PASSED** (8 PASS lines) and ends with
      `ALL SECTIONS PASSED (A-H)` then `ROLLBACK`.
- [ ] `26_..._VERIFY.sql` prints **VERIFY A–F PASSED** (6 PASS lines) and ends with
      `ALL SECTIONS PASSED (A-F)` then `ROLLBACK`.
- [ ] HARDENING scripts print only benign `NOTICE ... already exists, skipping`
      lines on a re-run (both are idempotent). **No `ERROR`.**

_Reference: the same scripts pass A–H (8/8) and A–F (6/6) on a disposable
PostgreSQL 18 instance._

## 3. Abort criteria — stop immediately if any of these occur

- [ ] Any `ERROR` from a HARDENING script (transaction auto-rolls back; investigate
      before retrying — do not force past it).
- [ ] A VERIFY script raises `VERIFY x FAILED` — the DB does not enforce a required
      invariant on this target; **do not proceed to app deploy**.
- [ ] The precondition block raises "missing required object(s)" — a prerequisite
      migration is absent; apply it first.
- [ ] Migration 26 precondition complains about `legal_updates.source_tier` — Phase
      A was not applied; go back to step 1.

## 4. Rollback decision tree

```
Did a HARDENING script ERROR?
├─ Yes → it already rolled back (BEGIN/COMMIT). Nothing to undo. Fix cause, retry.
└─ No, but VERIFY failed or app smoke failed →
     Need to remove the schema?
     ├─ Only governance (Phase B) is wrong →
     │     psql "$STAGING" -f 26_WATCHTOWER_SOURCE_GOVERNANCE_ROLLBACK.sql
     │     (drops classification only; re-apply re-backfills to Tier 3)
     └─ Need to remove provenance/evidence too →
           1) roll back 26 FIRST (its guard reads a column 25 owns)
           2) pg_dump the evidence tables if any runs exist:
              pg_dump "$STAGING" -t watchtower_ingestion_runs -t watchtower_ingestion_items > evidence.sql
           3) psql "$STAGING" -c "SET watchtower.rollback_destructive='true';" \
                  -f 25_WATCHTOWER_INGESTION_PROVENANCE_ROLLBACK.sql
           (25 rollback REFUSES without the opt-in while evidence exists — by design)
```

## 5. Post-apply smoke checks (staging DB)

Run as an admin session (or with `SET ddp.is_admin`-equivalent on the test harness):

- [ ] Tables exist and are RLS-enabled:
  ```sql
  SELECT relname, relrowsecurity FROM pg_class
  WHERE relname IN ('watchtower_ingestion_runs','watchtower_ingestion_items');
  ```
- [ ] Existing sources backfilled to a tier (Tier 3 unless already promoted):
  ```sql
  SELECT tier, count(*) FROM regulatory_sources GROUP BY tier ORDER BY tier;
  ```
- [ ] Fail-conservative CHECK is live (this must ERROR):
  ```sql
  INSERT INTO watchtower_ingestion_runs (connector_kind, status, finished_at)
  VALUES ('rss','failed', now());   -- expect: check_violation (no failure_reason)
  ```
- [ ] Tier-3 guard is live (insert a Tier-3-sourced enforced rule → must ERROR).
- [ ] Non-admin session sees zero rows in the ingestion tables.
- [ ] App: promote real authorities off Tier 3, then run **Ingestion Runs → Run
      ingestion now** (see `phase-a-c-admin-smoke-test.md`).

## 6. Sign-off

- [ ] All VERIFY sections passed on staging.
- [ ] Smoke checks passed.
- [ ] Rollback path confirmed available.
- [ ] Ready to request **human approval** for the production apply (separate step).
