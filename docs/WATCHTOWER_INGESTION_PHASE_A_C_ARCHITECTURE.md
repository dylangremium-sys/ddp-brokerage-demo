# Compliance Watchtower — Ingestion & Provenance Foundation (Phases A–C)

**Status:** implemented, not yet applied to any live database.
**Scope:** ingestion and provenance foundation only. No AI, no review decisions, no
rule activation, no impact analysis, no alert propagation. Those are Phase D+.

This document explains what Phases A–C add, why the design is fail-conservative,
and where the trust boundaries sit. It is a companion to the migrations
(`25_*`, `26_*`) and the domain modules under `src/lib/watchtower*` and
`src/lib/complianceSource*`.

---

## 1. What this foundation does

```
enabled sources ──▶ scheduled/triggered run ──▶ retrieve (existing connector)
      │                                                   │
      │                                          normalize + SHA-256 hash
      │                                                   │
      ▼                                          dedup vs known records
 governance/tiering                                       │
 (Tier 1/2/3)                              create candidate legal_update (status: new)
      │                                                   │
      └───────────────▶ full provenance + ingestion evidence (runs + items)
```

Every retrieval produces **evidence**: a `watchtower_ingestion_runs` row and one
`watchtower_ingestion_items` row per entry seen. A candidate legal update is
created only for a genuinely new, deduplicated item, always in `status = 'new'`,
and it still passes through the same human Review Queue as a manually pasted one.

---

## 2. Phase A — provenance & dedup schema (`migration 25`)

New tables:

| Table | Purpose |
|---|---|
| `watchtower_ingestion_runs` | One row per source-check execution: snapshots of the source, connector kind, trigger/actor, status, failure reason + detail, timestamps, per-outcome counters. |
| `watchtower_ingestion_items` | One row per entry seen in a run: normalized metadata, checksum, dedup decision, matched/created `legal_update` id, failure reason. |

New columns on `legal_updates` (all **nullable**, no default — manual pastes are
untouched): `content_hash`, `canonical_url`, `external_document_id`,
`source_tier`, `ingestion_run_id`, `ingestion_item_key`.

**Dedup indexes** (all partial — machine-ingested rows only):

- `uniq_legal_updates_content_hash` — global unique on content hash. The same
  notice mirrored on two sites becomes **one** record.
- `uniq_legal_updates_source_external_document_id` — unique per source; different
  authorities may reuse the same document numbering.
- `idx_legal_updates_canonical_url` — deliberately **non-unique**: a stable URL is
  re-seen every time its content changes, and each change is a new record.

**Fail-conservative status algebra (DB-enforced CHECKs):** a run can be
`'succeeded'` only when it is finished, carries no failure reason, and had zero
failed items. Every non-clean terminal state (`partial`/`failed`/`skipped`) must
be finished **and** name a reason. Counters must balance
(`seen = new + duplicate + unchanged + failed`). This is what makes *"source
unavailable ⇒ monitoring failed, never no changes"* structurally impossible to
violate at the storage layer.

**Immutability:** items are append-only (trigger). A run may be closed exactly
once; a terminal run can never be reopened or re-characterised, and no run can be
deleted (trigger + no DELETE grant/policy). Ingestion evidence therefore cannot
be rewritten to make a failed check look successful.

**Access:** admin-only RLS via `public.is_ddp_admin()`. `DELETE`/`TRUNCATE`
granted to nobody (including `service_role`).

## 3. Phase B — source governance & tiering (`migration 26`)

Adds to `regulatory_sources`: `tier` (1 primary / 2 secondary / 3 signal),
`authority_type`, `category`, `monitoring_method`, `priority` — all with
allowed-value CHECK constraints mirrored in
`src/lib/complianceSourceGovernance.ts`.

Legacy rows are backfilled to the **least authoritative** shape (Tier 3
aggregator) before columns become `NOT NULL` and defaulted — nothing silently
gains authority on upgrade. The `NULLABLE → backfill → default → NOT NULL`
sequence avoids a table rewrite against a volatile default.

**The Tier-3 authority boundary** is the governance guarantee of this phase.
`source_can_act_as_authority()` returns true only for Tier 1/2 (unknown fails
closed). A DB trigger (`guard_rule_source_authority`) refuses to let a
`compliance_rule` reach an **enforced** status (`approved`/`active`) when it
traces to a Tier-3 source. A Tier-3 finding can still become a *draft* rule and
go through human review; it simply cannot be the direct authority for an enforced
rule. Re-point the rule at a corroborating Tier-1/2 update to enforce it. This
guard is minimal and forbids only the one forbidden state — it does **not**
implement rule lifecycle (Phase D).

## 4. Phase C — the ingestion runner

Two layers, both dependency-injected and unit-tested with in-memory fakes:

- **`watchtowerIngestionRun.ts` (pure):** classifies each `(feed item,
  monitoring decision)` into an item outcome, deduplicates against known records
  and within-run identities, and **derives** the run status. `summarizeRun()`
  cannot return `'succeeded'` if any item failed; the caller does not choose the
  status at all.
- **`watchtowerIngestionService.ts` (orchestration):** opens a run, retrieves via
  the **existing** `executeRssConnector` + browser fetch adapter (no new
  transport), persists candidate drafts + item evidence, closes the run with the
  computed status. A connector failure becomes a `failed` run with an explicit
  reason. One source failing never aborts a batch. Sources are processed
  most-authoritative-first (Tier 1→3, then priority) with a shared known-identity
  index so cross-source dedup holds within one batch.

The runner has **no** rule/alert/entity-status sink in its dependency surface, so
it structurally cannot enforce a rule or mutate a business record. The only
non-evidence rows it writes are draft `legal_updates` with `status = 'new'`.

## 5. Trust boundaries & security posture

- **Admin-only:** every new table is RLS-gated by `is_ddp_admin()`; no public
  exposure of compliance intelligence.
- **No AI, no keys:** nothing in this phase imports a provider SDK, endpoint, or
  credential.
- **Transport safety reused:** HTTPS-only, deny-by-default host allowlist, and
  the SSRF guard (private/link-local/metadata, non-standard ports) all come from
  the existing `complianceSourceConnectorRuntime` / `complianceRssConnector`
  layers. Redirects are never followed.
- **Bounded inputs:** item metadata is length-checked at both the app layer and
  the DB CHECKs; content hashes must match `^[0-9a-f]{64}$`; error detail ≤ 2000
  chars. A hostile or malformed feed cannot write unbounded values.
- **Never silently drops errors:** every failure is either persisted as a typed
  run/item state or surfaced to the admin UI.

## 6. Two independent guarantees for the same rule

The fail-conservative rule ("unavailable ⇒ failed, never silent success") and the
Tier-3 authority rule are each enforced **twice**: once in application code (pure,
unit-tested) and once by database CHECKs/triggers. Neither layer is trusted
alone. If the app is bypassed, the DB still refuses the forbidden state; if the
DB constraint were dropped, the app still computes the conservative outcome.

## 7. Deliberately out of scope (Phase D+)

AI triage, AI summaries, review-queue decisions, rule lifecycle enforcement,
impact analysis, alert generation. The candidate `legal_updates` this foundation
produces are the *input* to that human/AI workflow, never a substitute for it.
