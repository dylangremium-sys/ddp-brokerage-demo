# Buyer Pack Phase B — Durable Evidence System (Design)

**Status:** Design only. No application code, SQL, migrations, env, or deployment
are part of this document. All SQL blocks below are **design sketches**, not
migrations to apply. Phase A (localStorage) remains the shipped implementation
until Phase B is explicitly approved and built.

## 0. Design finding that shapes everything: sync → async

`src/lib/buyerPackSnapshotRepository.ts` today is synchronous (`save(): void`,
`getAll(): BuyerPackSnapshot[]`). A Supabase-backed repo is inherently async.
Three call sites are affected:

- `generateNextBuyerPackSnapshot()` calls `repo.getLatest()`/`repo.save()`
  synchronously → must `await`.
- `DDPBuyerPreview.tsx` reads `snapshotRepo.getLatest(item.id)` in a `useState`
  initializer → must become a `useEffect` async load.
- `DDPBuyerPreview.tsx` reads `getBuyerPackAuditTrail(item.id)` synchronously for
  status → must become async.

**Conclusion:** we convert `BuyerPackSnapshotRepository` to an async
(Promise-returning) interface and keep the localStorage impl as an async
wrapper. This is the *minimal* UI change; "zero change" would require faking sync
over a network call, which is not acceptable.

---

## 1–4. Schema, keys, FKs, indexes (design sketch — not a migration)

```sql
-- DESIGN SKETCH ONLY. Not to be applied. Apply order would be: after
-- AUTH_RLS_SCHEMA.sql (needs public.is_ddp_admin()).

create table public.buyer_pack_snapshots (
  snapshot_id           uuid primary key default gen_random_uuid(),
  pack_id               text not null,               -- = inventory batch id
  version               integer not null check (version >= 1),
  previous_snapshot_id  uuid references public.buyer_pack_snapshots(snapshot_id),
  content_hash          char(64) not null            -- SHA-256 hex, lowercase
                          check (content_hash ~ '^[0-9a-f]{64}$'),
  approval_id           text not null,
  approval_timestamp    timestamptz not null,
  procurement_decision  text not null check (procurement_decision = 'progress'),
  approved_by           text not null check (length(btrim(approved_by)) > 0),
  generated_by          text not null,
  generated_at          timestamptz not null default now(),
  frozen_evidence       jsonb not null,              -- exactly what was hashed (evidence portion)
  batch_id              uuid references public.inventory_batches(id), -- nullable soft link
  unique (pack_id, version)                          -- append-only version guard
);

create index buyer_pack_snapshots_pack_idx        on public.buyer_pack_snapshots (pack_id, version desc);
create index buyer_pack_snapshots_hash_idx         on public.buyer_pack_snapshots (content_hash);
create index buyer_pack_snapshots_prev_idx         on public.buyer_pack_snapshots (previous_snapshot_id);

create table public.buyer_pack_audit_log (
  event_id         uuid primary key default gen_random_uuid(),
  pack_id          text not null,
  snapshot_version integer not null,
  action           text not null check (action in ('pack_generated','pack_viewed','pack_superseded','pack_archived')),
  actor            text not null,
  created_at       timestamptz not null default now()
);
create index buyer_pack_audit_pack_idx on public.buyer_pack_audit_log (pack_id, created_at);

create table public.buyer_pack_download_log (
  download_id       uuid primary key default gen_random_uuid(),
  pack_id           text not null,
  snapshot_version  integer not null,
  actor             text not null,
  format            text not null,                   -- 'summary-copy' | 'print-pdf' | ...
  buyer_organisation text,
  browser           text,
  ip_address        inet,
  device            text,
  reason            text,
  created_at        timestamptz not null default now()
);
create index buyer_pack_download_pack_idx on public.buyer_pack_download_log (pack_id, created_at);
```

- **Primary keys:** UUID surrogate on all three (`snapshot_id`, `event_id`,
  `download_id`) — matches manifest `snapshotId`.
- **Foreign keys:** `previous_snapshot_id` self-reference (version linkage);
  `batch_id → inventory_batches(id)` as a *soft* link only (nullable; `pack_id`
  is the authoritative business key so a snapshot survives even if a batch row
  is later removed). Audit/download logs intentionally **carry no FK to
  snapshots** — they must survive independently and are keyed by `(pack_id,
  snapshot_version)`, mirroring today's localStorage shape.
- **Indexes:** version lookups `(pack_id, version desc)`; hash lookups for
  verification/dedup; per-pack log scans by time.

---

## 5. RLS policies (reuse existing `is_ddp_admin()` convention)

```sql
alter table public.buyer_pack_snapshots  enable row level security;
alter table public.buyer_pack_audit_log  enable row level security;
alter table public.buyer_pack_download_log enable row level security;

-- SELECT + INSERT for admins only. NO update/delete policy exists at all,
-- so update/delete are denied by default even before the trigger fires.
create policy "bps: admin select" on public.buyer_pack_snapshots
  for select using (public.is_ddp_admin());
create policy "bps: admin insert" on public.buyer_pack_snapshots
  for insert with check (public.is_ddp_admin());
-- (identical select/insert pairs for the two log tables)
```

Admin-only, matching the Compliance Watchtower tables. **Deliberately no `FOR
UPDATE`/`FOR DELETE` policy** — absence = denial under RLS. A future buyer role
would get scoped `SELECT` only (out of scope).

---

## 6. Storage strategy

- **Evidence lives in Postgres `jsonb`, not Object Storage.** The frozen
  evidence is small structured data (already `structuredClone`d today); a table
  column is simpler, transactional, and RLS-covered.
- **COA PDFs are referenced, not duplicated.** The snapshot stores
  `coaStoragePath` (a pointer already inside `frozenEvidence.coas`), not the PDF
  bytes. The actual file stays in the existing `farmer-documents` bucket.
- **⚠️ Fidelity caveat (needs human review, see §18/Open Questions):** because
  the PDF bytes are not captured or hashed, the snapshot proves *what the app
  displayed and which file it pointed to*, not that the referenced PDF is
  unchanged. If evidentiary strength requires freezing the PDF itself, add a
  copy-to-immutable-bucket + hash step — a materially larger scope.

---

## 7. SHA-256 content hash storage

- Stored as `char(64)` lowercase-hex with a `check` constraint on shape.
- Hash is computed **client-side exactly as today**
  (`canonicalJsonStringify({frozenEvidence, approvalId, approvalTimestamp,
  procurementDecision, approvedBy})` → `sha256Hex`), deterministic and unchanged
  — so a Phase A hash and a Phase B hash of identical evidence are byte-identical.
  This preserves the existing passing hash tests without modification.
- The server independently re-verifies on insert (see §14).

## 8. Version numbering

- Per `pack_id`, starting at 1, contiguous. Enforced by `unique(pack_id,
  version)`.
- **Race condition:** two concurrent "Issue" clicks could both read
  `max(version)=N`. Two mitigations, use both:
  1. The unique constraint makes the second insert fail (safe, never silent
     corruption).
  2. Compute the version **server-side inside a `SECURITY DEFINER` RPC** (§15) so
     the read-max-and-insert is atomic, avoiding client round-trip races
     entirely.

## 9. Previous-version linkage

- `previous_snapshot_id` FK set to the prior latest snapshot's id at insert time;
  `null` for v1. Gives an explicit chain in addition to `version`. The
  `pack_superseded` audit event for the prior version is still written (matches
  Phase A behavior).

---

## 10–11. Append-only enforcement + UPDATE/DELETE blocking trigger

```sql
-- Reuses the exact pattern proven in 9_COMPLIANCE_WATCHTOWER_MVP.sql
create or replace function public.prevent_buyer_pack_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; % is not allowed', tg_table_name, tg_op;
end; $$;

create trigger trg_bps_no_mutation
  before update or delete on public.buyer_pack_snapshots
  for each row execute function public.prevent_buyer_pack_mutation();
-- identical triggers on buyer_pack_audit_log and buyer_pack_download_log
```

Two independent guarantees: (a) no RLS update/delete policy, (b) a trigger that
raises on any UPDATE/DELETE even for elevated roles. This is exactly how
`compliance_audit_log` is already protected in this codebase — a known-good,
already-live pattern.

## 12. Audit trigger

Two options — **recommend application-level append** (not a DB trigger) for
parity with Phase A and to keep the `actor` semantically correct:

- Keep writing audit rows explicitly from the repo/RPC (`pack_generated`,
  `pack_superseded`), as the UI does today.
- *Optionally* add a DB trigger that auto-writes a `pack_generated` row on
  snapshot insert as a belt-and-suspenders integrity net. If added, the app must
  not double-write. Decision deferred to implementation; default = app-level to
  match current tested behavior.

## 13. Download logging

- `appendBuyerPackDownload` becomes an async insert into
  `buyer_pack_download_log`. Same trigger-source (copy/print) and same `(pack_id,
  snapshot_version, format)` shape as Phase A.
- Optional fields (`ip_address`, `browser`, `device`, `buyer_organisation`)
  remain unpopulated unless a real capture path exists — **and populating
  IP/device introduces privacy-law obligations** (§18). Default: leave null, as
  today.

## 14. Snapshot verification

- **On insert (server):** an RPC/trigger recomputes the canonical hash from the
  submitted `frozen_evidence` + approval fields and rejects the insert if it ≠
  `content_hash`. This prevents a client from storing evidence that doesn't match
  its claimed hash.
  - *Constraint:* the DB must reproduce the exact canonical-JSON + SHA-256 the
    client uses. Postgres can do SHA-256 (`pgcrypto` `digest`), but reproducing
    JS `canonicalJsonStringify` key-ordering in SQL is fiddly. **Recommended:**
    verification RPC written to sort keys identically, with a golden-vector test
    asserting DB-hash == client-hash for a fixture. If parity proves costly, fall
    back to client-verify-before-insert + trust-boundary note (weaker; call it
    out).
- **On read (client):** a `verifySnapshot(snapshot)` helper recomputes the hash
  and compares — detects post-hoc tampering of the stored JSON.

---

## 15. API / repository interface (async variant — the one required change)

```ts
// DESIGN SKETCH. New async contract; localStorage impl becomes an async wrapper.
export interface BuyerPackSnapshotRepository {
  save(snapshot: BuyerPackSnapshot): Promise<void>
  getAll(packId: string): Promise<BuyerPackSnapshot[]>
  getVersion(packId: string, version: number): Promise<BuyerPackSnapshot | null>
  getLatest(packId: string): Promise<BuyerPackSnapshot | null>
}
```

- **Two implementations behind one interface:**
  `createLocalStorageBuyerPackSnapshotRepository()` (existing logic, now `async`)
  and `createSupabaseBuyerPackSnapshotRepository(client)`.
- **Selection:** mirror the app's existing pattern — `repo.isSupabaseConfigured ?
  supabase : localStorage`. Demo mode keeps working unchanged on localStorage.
- **Recommended:** the Supabase `save` calls a `SECURITY DEFINER` RPC
  `issue_buyer_pack_snapshot(...)` that atomically computes next version,
  verifies the hash, inserts the snapshot, and writes the
  `pack_generated`/`pack_superseded` audit rows in one transaction — so the
  append-only + versioning + verification guarantees live server-side, not in the
  client.
- **UI delta (minimal):** `generateNextBuyerPackSnapshot` becomes fully async
  (already awaited); the `useState(() => getLatest())` initializer moves into a
  `useEffect`; the status derivation awaits the audit trail. The **UI contract**
  (button, gate, version/hash/status display) is otherwise unchanged.
- **Human approval gate preserved:** untouched. `prepareBuyerPackSnapshotInput` +
  `createBuyerPackSnapshot`'s `progress`+`approvedBy` checks still run
  client-side; the RPC re-asserts `procurement_decision='progress'` and non-empty
  `approved_by` server-side (defense-in-depth via the column `check`s).

---

## 16. Migration strategy from localStorage

**Recommendation: do NOT auto-migrate localStorage records.** They are
per-browser, per-device, of unverifiable provenance, and were explicitly
documented (Phase A) as non-durable demo data. Auto-importing them would launder
unverifiable local data into the "durable" store.

- New durable snapshots start fresh in Supabase from Phase B onward.
- *Optional*, clearly-labeled one-time admin tool: "Import local snapshots
  (unverified origin)" that re-inserts localStorage snapshots via the normal RPC
  — each recomputed-and-verified, tagged in a `reason`/note as imported. Off by
  default; requires explicit human action.

## 17. Rollback strategy

- **Fully additive & flag-gated.** New tables + RPC + a repo-selection flag;
  nothing existing is altered.
- Rollback = flip the repo selector back to localStorage (instant), then
  optionally `drop table ... cascade` the three new tables (data loss acceptable
  — additive). Mirror the existing `RLS_ROLLBACK.sql` discipline: ship a
  `BUYER_PACK_PHASE_B_ROLLBACK.sql` alongside.
- Because the localStorage impl is retained, the app degrades safely if Supabase
  is unreachable (demo mode path already exists).

---

## 18. Security considerations

- **RLS admin-only** + no update/delete policy + append-only trigger (triple
  guard). Verify with a live `pg_policies` sweep like `docs/SECURITY_TEST_LOG.md`.
- **RPC is `SECURITY DEFINER`** → must set `search_path = public, pg_temp` and
  revoke `public`/`anon` execute (same hardening as
  `3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql`), or it becomes a
  privilege-escalation vector.
- **Service-role key must never reach the browser** — all writes go through the
  anon key + RLS + `SECURITY DEFINER` RPC gated by `is_ddp_admin()`.
- **`approved_by` provenance is weak in demo/no-Supabase mode** (falls back to
  `'DDP Admin'`). For durable evidence, the approver should be the authenticated
  `auth.uid()`/profile, captured server-side in the RPC rather than trusted from
  the client.
- **Privacy law (PDPA Thailand / GDPR):** capturing `ip_address`/`device`/
  `buyer_organisation` in the download log is personal data → triggers
  consent/retention/DSAR obligations. Append-only "never delete" **directly
  conflicts** with erasure rights. **This is a legal question, not an engineering
  one — requires counsel (see Legal Assumptions).**

## 19. Performance considerations

- Volumes are tiny (snapshots per approved batch); `jsonb` + the listed indexes
  are far more than enough.
- Version-race is a correctness concern, not throughput — solved by the atomic
  RPC + unique constraint (§8).
- Server-side hash verification adds one `digest()` per insert — negligible.
- `jsonb` payload per snapshot is small; if evidence ever grows large, TOAST
  handles compression automatically — no action needed now.

## 20. Definition of "immutable" for this project

State these four levels precisely and never conflate them in any material:

- **Tamper-evident** — a SHA-256 content hash lets anyone detect if stored
  evidence was altered. *(Have in Phase A; keep.)*
- **Append-only** — the store rejects UPDATE/DELETE (RLS + trigger); versions
  only accrue. *(New in Phase B, server-enforced.)*
- **Durable** — persisted in Supabase Postgres with the provider's backup/PITR
  tier; survives browser/device loss. *(New in Phase B.)*
- **Immutable within the application** — the application exposes no code path
  that edits or deletes a snapshot after creation, and the database enforces
  this. *(New in Phase B.)*

**Explicitly NOT claimed:** legal/evidentiary immutability, WORM-certified
storage, blockchain/notarized, regulator-recognized, or that a snapshot is
admissible proof. "Immutable within the application" ≠ "immutable in law." A DB
admin with direct Postgres/service-role access can still, at the infrastructure
layer, alter data — append-only is enforced for the *application's* roles, not
against the platform owner.

---

## Legal / compliance assumptions requiring human review

1. Whether referencing `coaStoragePath` (not freezing the PDF bytes) is
   acceptable "evidence," or the actual file must be copied to immutable storage
   and hashed.
2. **Retention vs. erasure conflict:** append-only "never delete" vs PDPA/GDPR
   right-to-erasure — needs a documented, counsel-approved retention/erasure
   policy (e.g. crypto-shredding, or a legally-blessed exception).
3. Whether capturing `approved_by`/download identity meets (or triggers) any
   e-signature, attestation, or personal-data obligation.
4. Whether "immutable"/"tamper-evident" wording, as shown to admins or buyers,
   could be read as a regulatory or evidentiary claim — legal wording review
   (consistent with the existing `aiComplianceGuard` discipline).

---

## Recommended implementation order

1. Async-ify the interface + make the localStorage impl an async wrapper; adjust
   `generateNextBuyerPackSnapshot` and the two UI read sites. Ship this **alone**
   (still localStorage) and confirm all tests + the Phase A smoke test still pass
   — de-risks the refactor from the DB work.
2. Author the schema + RLS + append-only triggers as a reviewable migration
   **file** (not applied); write the `pg_policies`/trigger verification queries.
3. Author the `SECURITY DEFINER` `issue_buyer_pack_snapshot` RPC (atomic version
   + server-side hash verify + audit write) with a golden hash-parity test.
4. Implement `createSupabaseBuyerPackSnapshotRepository` + repo selection flag;
   keep localStorage for demo mode.
5. Wire download/audit inserts to Supabase; verify demo mode unaffected.
6. Apply to a staging Supabase, run live RLS/append-only/verification tests, then
   production — each a separate approved step. Update the Master Roadmap + a
   Phase B smoke-test doc.

## Estimated complexity

**Medium overall.** Step 1 (async refactor) low-but-touches-tested-code; steps
2–3 (RLS/trigger/RPC + hash parity) the hard part (medium — the JS↔SQL
canonical-hash parity is the main technical risk); steps 4–6 low-medium. No new
dependencies.

## Risks

- **Hash parity** between JS `canonicalJsonStringify` and any SQL-side recompute
  (mitigation: golden-vector test; or client-verify fallback).
- **Async refactor regressions** in tested/deployed code (mitigation: ship step 1
  in isolation, keep 100% test parity).
- **Version race** (mitigation: atomic RPC + unique constraint).
- **RLS/`SECURITY DEFINER` misconfig** exposing packs or escalating privilege
  (mitigation: search_path hardening + live policy sweep).
- **PDPA/retention vs append-only** legal conflict (mitigation: counsel sign-off
  before storing any personal data in the download log).
- **Concurrent-session repo churn** in this workspace (observed during
  development) — coordinate so Phase B doesn't collide with parallel work.

## Open questions

1. Freeze the COA **PDF bytes** into immutable storage, or keep the pointer-only
   model?
2. What is the **retention/erasure policy**, and who owns the PDPA/GDPR sign-off?
3. Should `approved_by` be the **authenticated `auth.uid()`** (server-captured)
   rather than a client-passed display name — and what happens in demo mode with
   no auth?
4. Do we want the **DB-trigger auto-audit** (belt-and-suspenders) or keep audit
   strictly application-level?
5. Is a future **buyer read-role** in scope for Phase B's RLS design now, or
   deferred entirely?
6. Should download-log **IP/device capture** be built at all, given the privacy
   cost vs. its evidentiary value?
