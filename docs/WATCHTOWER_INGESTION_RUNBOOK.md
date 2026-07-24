# Watchtower Ingestion — Operations Runbook (Phases A–C)

Operational guide for deploying, running, and recovering the regulatory
ingestion foundation. Covers migrations `25_*` and `26_*` and the Phase-C runner.

Migration files are named `<n>_WATCHTOWER_..._{HARDENING,VERIFY,ROLLBACK}.sql`.
`HARDENING` = forward migration; `VERIFY` = behavioural check (runs in one
transaction ending in `ROLLBACK`, safe against production); `ROLLBACK` = reverse.

---

## 1. Rollout order

Apply with a role that owns the `public` schema, `-v ON_ERROR_STOP=1`.

```bash
# Preconditions already present: AUTH_RLS_SCHEMA.sql (is_ddp_admin),
# 9_COMPLIANCE_WATCHTOWER_MVP.sql (regulatory_sources, legal_updates).

# 1. Phase A — provenance & dedup. Idempotent; safe to re-run.
psql "$DB" -v ON_ERROR_STOP=1 -f 25_WATCHTOWER_INGESTION_PROVENANCE_HARDENING.sql
psql "$DB" -v ON_ERROR_STOP=1 -f 25_WATCHTOWER_INGESTION_PROVENANCE_VERIFY.sql   # expect: A–H PASSED

# 2. Phase B — governance & tiering. Requires migration 25 (reads source_tier).
psql "$DB" -v ON_ERROR_STOP=1 -f 26_WATCHTOWER_SOURCE_GOVERNANCE_HARDENING.sql
psql "$DB" -v ON_ERROR_STOP=1 -f 26_WATCHTOWER_SOURCE_GOVERNANCE_VERIFY.sql      # expect: A–F PASSED
```

**Do not** deploy the app build ahead of migration 25/26: the repository reads and
writes the new columns. The app degrades gracefully (columns map to `null`), but
the ingestion runner and governance form need the schema present to function.

After migration 26, **every existing source is Tier 3** (backfilled). Promote real
authorities to Tier 1/2 in the Source Registry before relying on the tier guard.

## 2. Running ingestion

Phase C is **triggerable** (an admin clicks **Run ingestion now** on the
Watchtower → *Ingestion Runs* tab). It processes enabled sources whose
`monitoring_method` is an automatic kind (`rss`/`atom`/`html`/`pdf`/
`government_api`); `manual` sources are recorded as `skipped` runs, never
silently ignored.

- The host **allowlist is deny-by-default** and derived from the enabled sources'
  own hostnames. The SSRF guard applies on top independently.
- A scheduled trigger is a thin adapter over `runIngestionBatch()` +
  `createDefaultIngestionDeps()` — the same core the UI calls. Wiring a cron/Vercel
  scheduled function is Phase-D work and must supply its own admin-scoped auth; it
  is intentionally **not** added here (no service-role ingestion path exists).

## 3. Reading run health

`watchtower_ingestion_runs.status`:

| Status | Meaning | Action |
|---|---|---|
| `succeeded` | Finished, zero failures. | None. |
| `partial` | Finished, ≥1 item failed. | Inspect items with `failure_reason` set. |
| `failed` | Source could not be retrieved/processed. | See `failure_reason` below. |
| `skipped` | Deliberately not fetched (manual/disabled). | Expected; informational. |
| `running` | In flight — **or stuck** if old (see §5). | Investigate if not recent. |

Common `failure_reason` values: `source_unavailable` (host down / fetch failed),
`off_allowlist`, `url_unsafe` (SSRF guard / non-HTTPS), `timeout`,
`unsupported_connector`, `malformed_feed`/`not_a_feed`, `source_policy_denied`
(e.g. Cannamonitor), `persistence_failed`, `partial_item_failure`.

Useful queries (admin session):

```sql
-- Recent failures with reasons.
SELECT source_name_snapshot, status, failure_reason, error_detail, started_at
FROM watchtower_ingestion_runs
WHERE status IN ('failed','partial') ORDER BY started_at DESC LIMIT 50;

-- Stale sources: enabled but no successful run in 24h.
SELECT s.name, max(r.started_at) FILTER (WHERE r.status='succeeded') AS last_ok
FROM regulatory_sources s
LEFT JOIN watchtower_ingestion_runs r ON r.source_id = s.id
WHERE s.is_active AND s.monitoring_method <> 'manual'
GROUP BY s.id, s.name
HAVING max(r.started_at) FILTER (WHERE r.status='succeeded') IS NULL
    OR max(r.started_at) FILTER (WHERE r.status='succeeded') < now() - interval '24 hours';
```

The *Ingestion Runs* tab surfaces stale sources automatically.

## 4. Failure handling — what to do

- **A source keeps failing `source_unavailable`/`timeout`:** verify the URL is a
  live public feed; check the host is reachable and on the allowlist. A failing
  source is *recorded*, not hidden — it will not masquerade as "no changes".
- **`off_allowlist`/`url_unsafe`:** the URL is non-HTTPS, points at a private/
  metadata address, or the host was not among the enabled sources. Fix the source
  URL; never widen the SSRF guard.
- **`persistence_failed` on items:** the run is `partial`. The DB rejected a write
  (often a dedup unique race, which the runner already reclassifies as a
  duplicate — a true `persistence_failed` means something else). Inspect
  `error_detail`.
- **A duplicate was expected but a new candidate appeared:** confirm the source's
  content actually changed (a changed `content_hash` is a real change). Canonical
  URL revisions are intentionally allowed to create new records.

## 5. Stuck `running` runs

If `closeIngestionRun` never completed (client crash mid-run), a run stays
`running`. It is visible via `idx_watchtower_ingestion_runs_in_flight`:

```sql
SELECT id, source_name_snapshot, started_at
FROM watchtower_ingestion_runs WHERE status='running' AND started_at < now() - interval '1 hour';
```

These are harmless (they hold no lock and block nothing) but should be closed for
tidiness. A terminal run cannot be reopened, so close a stuck run to `failed`:

```sql
UPDATE watchtower_ingestion_runs
SET status='failed', failure_reason='internal_error',
    error_detail='closed by operator: run left in-flight', finished_at=now()
WHERE id = '<run-id>' AND status='running';
```

(The guard trigger permits this exactly-once transition from `running`.)

## 6. Rollback

Both rollbacks are exact inverses and touch no other migration.

**Migration 26 (governance):** no destructive-data gate — it drops only source
*classification*, not evidence. Re-applying re-backfills to Tier 3.

```bash
psql "$DB" -v ON_ERROR_STOP=1 -f 26_WATCHTOWER_SOURCE_GOVERNANCE_ROLLBACK.sql
```

> ⚠️ After rolling back 26 the Tier-3 authority guard is gone: nothing at the DB
> level then prevents an enforced rule on a signal-source basis. Only roll back 26
> as part of a full Phase-B reversal.

**Migration 25 (provenance/evidence):** **refuses** to run while any ingestion
run/item or provenance-bearing legal update exists, unless explicitly opted in.
This protects retained monitoring evidence.

```bash
# Refuses if live evidence exists:
psql "$DB" -v ON_ERROR_STOP=1 -f 25_WATCHTOWER_INGESTION_PROVENANCE_ROLLBACK.sql

# Deliberate, evidence-destroying rollback (capture a dump first):
pg_dump "$DB" -t watchtower_ingestion_runs -t watchtower_ingestion_items > watchtower_evidence_backup.sql
psql "$DB" -v ON_ERROR_STOP=1 \
  -c "SET watchtower.rollback_destructive='true';" \
  -f 25_WATCHTOWER_INGESTION_PROVENANCE_ROLLBACK.sql
```

Rollback **order**: roll back 26 before 25 (26's guard reads
`legal_updates.source_tier`, which 25 owns). The `legal_updates` rows themselves
survive a 25 rollback — only their provenance columns are dropped, so ingested
records remain as ordinary updates.

## 7. Verification checklist (post-deploy)

- [ ] `25_..._VERIFY.sql` prints **A–H PASSED**, ends in ROLLBACK.
- [ ] `26_..._VERIFY.sql` prints **A–F PASSED**, ends in ROLLBACK.
- [ ] `node scripts/check-security-migrations.mjs` → PASS.
- [ ] `npm test` green (pre-existing unrelated failures aside).
- [ ] Real authorities promoted from the backfilled Tier 3 to Tier 1/2.
- [ ] A manual **Run ingestion now** produces run rows; a deliberately-broken
      source URL yields a `failed` run with an explicit reason (not a silent
      success).
- [ ] Admin-only: a non-admin session sees no ingestion rows.
