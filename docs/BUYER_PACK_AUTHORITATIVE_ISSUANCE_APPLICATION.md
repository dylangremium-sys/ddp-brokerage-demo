# Buyer Pack server-authoritative issuance — application runbook

Migration **23** makes `public.issue_buyer_pack_snapshot()` derive release status
from the server-authoritative procurement decision trail instead of trusting the
client-supplied `p_procurement_decision`. A Buyer Pack snapshot can now be issued
**only** when the database itself proves the *current* decision for the same pack
is a human `progress` decision.

**These files are reviewed repository artifacts. This change runs no SQL against any
database — an operator applies it manually.**

## What changes (and what does not)

- **Changed:** the RPC body. It now looks up `procurement_decisions_current` by
  `batch_id = p_pack_id`, requires `decision = 'progress'` (with a non-null actor
  and non-blank reason), **ignores** the client `p_procurement_decision`, and stores
  the **server** decision in the snapshot.
- **Unchanged:** the RPC signature (so the TypeScript caller is not broken); the
  `ddp_admin` gate; the named-approver gate; advisory-lock version serialisation;
  the append-only `UNIQUE(pack_id, version)` guard and `prevent_buyer_pack_mutation`
  triggers; audit logging; server-captured `issued_by`; all RLS/ACL. Migrations 10
  and 17 are **not** edited.
- **Out of scope (documented follow-up):** server-side `content_hash` parity. The
  client canonicalisation (`JSON.stringify(sortKeysDeep(...))`) cannot be reproduced
  byte-for-byte against a normalised `jsonb` in Postgres, so no server recompute is
  attempted here. The stored hash remains client-supplied and **is not claimed to be
  server-authoritative**.

## Files

| File | Role |
|------|------|
| `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql` | Forward migration (idempotent `CREATE OR REPLACE`) |
| `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_VERIFY.sql` | Section A = read-only object-state (prod-safe); Section B = behavioural proof (non-prod only) |
| `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE_ROLLBACK.sql` | Restores migration 10's client-trusting definition (re-opens the defect) |

## Preconditions & apply order

Depends on **migration 10** (the RPC + `buyer_pack_snapshots`) and **migration 17**
(the `procurement_decisions` trail + `procurement_decisions_current` view). Apply
order: **10 → 17 → 23**. (Migration numbers 21/22 are reserved by an unrelated open
PR; 23 is independent of them.)

1. Confirm migrations 10 and 17 are applied on the target (the RPC and
   `procurement_decisions_current` must exist).
2. In the Supabase SQL Editor (postgres role) on the target project, paste and run
   the **entire** contents of `23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql`
   verbatim. It runs inside its own `begin … commit` and is idempotent.

## Verification

- **Object state (safe on Production):** run **Section A** of the VERIFY file →
  expect `VERIFY A PASSED` (reads the trail, same-pack join, gates on the server
  decision, ignores the client value, re-asserts actor + reason, still admin-gated).
- **Behaviour (NON-PRODUCTION only):** run **Section B** on a non-prod project that
  has 10 + 17 + 23 applied. It is one `BEGIN … ROLLBACK` (no `COMMIT`) and proves:
  progress permits issuance and stores the server decision; a conflicting client
  value is ignored; no-decision / hold / reject / stale-progress-then-hold /
  stale-progress-then-reject / another-batch all block; null/blank pack id blocks;
  versioning increments; snapshot UPDATE/DELETE remain blocked; an audit row is
  written; and the trail rejects blank-reason / null-actor decisions. It asserts
  zero residue after rollback. **Do not run Section B on Production.**

## Rollback

Run `23_..._ROLLBACK.sql` to restore migration 10's definition.

> ⚠️ **Rollback re-opens the defect:** the restored function trusts the client
> `p_procurement_decision` and does not read the trail, so a fabricated `'progress'`
> can again authorise issuance. Re-apply migration 23 promptly.

## CI assurance

`npm run security:sql` and `scripts/buyer-pack-authoritative-gate.test.mjs`
(`npm test`) statically lock the gate: the RPC must read
`procurement_decisions_current`, match the same pack, block non-progress/no-decision,
ignore and not store the client value, and keep the admin/pack/reason/actor checks —
and the TypeScript caller must always send `p_pack_id`. These fail CI if the gate is
weakened.
