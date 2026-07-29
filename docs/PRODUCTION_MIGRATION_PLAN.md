# State-Aware Production Migration Plan

Last updated: **2026-07-25**
Target: production `iihxjrfx…`
Source of truth: `main` @ `3c51627b58fc0b3890e06b33d74a43a86b3be091`
Companion: [`MIGRATION_RUNTIME_REGISTER.md`](./MIGRATION_RUNTIME_REGISTER.md)

> **This is not "run all the SQL".** Production already has migrations 25 and 26
> applied — staging does not. Replaying the full corpus would be wrong and, for
> the destructive-rollback files, dangerous. The delta must be measured, not
> assumed.

---

## Stage 0 — Preconditions (all must hold before Stage 1)

| # | Precondition | Owner | Status today |
|---|---|---|---|
| 0.1 | Production Postgres URL or service-role key available to the operator | DDP | **MISSING** |
| 0.2 | PR #57 (migration-23 VERIFY fix) merged to `main` | DDP | open, CI clean |
| 0.3 | PR #43 (collision guard) merged | DDP | open |
| 0.4 | PR #44 (migration 27) merged **or** explicitly deferred | DDP | open |
| 0.5 | Verified backup + **restore drill** completed (Stage 2) | DDP | **NOT DONE** |
| 0.6 | Named approver identified and available for the apply window | DDP | — |

Stage 0.1 alone blocks every later stage. Nothing in Stages 1–6 can begin
without it.

---

## Stage 1 — Inspect production (read-only, no changes)

Run the probe in `MIGRATION_RUNTIME_REGISTER.md` §5.3 verbatim.

- Run in a **read-only session**.
- Capture raw stdout and stderr to `evidence/<date>/prod-inspect/`.
- Record a SHA-256 of each output file.
- If any query errors on permissions or a missing object, **record the exact
  error text and stop** — do not widen scope to work around it.

**Exit criterion:** every `unknown` row in the register §1 is replaced with a
measured value. Do not proceed on a partial inspection.

---

## Stage 2 — Determine the delta, then prove restore

### 2.1 Compute the delta

From Stage 1 results, the apply set is:

```
apply_set = { migrations required by main } − { migrations measured present in production }
```

Known now, before Stage 1:

| Migration | Decision |
|---|---|
| 10, 17, 25, 26 | **exclude** — measured present in production |
| 24 | **include** — measured absent (`PGRST205`) |
| 19, 20, 21, 22, 23 | **decide from Stage 1** |
| 27 | include only if PR #44 merged; else defer |

### 2.2 Restore readiness (blocking)

A backup that has never been restored is not a backup.

1. Take a fresh production backup; record its identifier and timestamp.
2. Restore it into a **scratch project**.
3. Run `16_PRODUCTION_SAFETY_VERIFY.sql` against the restored copy → must exit 0.
4. Record restore duration — this is the real RTO for the rollback path.
5. Destroy the scratch project.

**Do not proceed if the restore drill fails or was skipped.**

---

## Stage 3 — Ordering and safety rules

### 3.1 Order

Apply strictly in **ascending migration number**. Within one migration, the
order is:

```
HARDENING  →  (STORAGE, if the migration has one)  →  VERIFY
```

Migration 24 has four stages; its storage stage runs **after** the hardening
stage — this is the order the disposable-PG harness certifies (`apply HARDENING`
→ `apply STORAGE` → `VERIFY 18/18 A–R`).

### 3.2 Safety rules

1. **One migration per transaction.** Never batch two numbers into one
   transaction — a failure mid-batch leaves an unrecordable state.
2. **Never run a `*_ROLLBACK.sql` as part of a forward apply.** Several are
   destructive and are gated behind explicit opt-in GUCs precisely to stop this.
3. **Never run VERIFY Section B against production.** Section B builds fixtures.
   It is `BEGIN … ROLLBACK` and leaves no residue, but it writes inside the
   transaction and asserts absence of fixed test IDs; production is not the place.
   Section A is read-only and is the production gate.
4. **Stop on first failure.** `ON_ERROR_STOP=1`. Do not continue to the next
   migration after any non-zero exit.
5. **No schema edits outside a numbered migration.** The loose unnumbered `.sql`
   files at repository root are historical and must never be applied to production.

### 3.3 Rollback considerations

| Migration | Rollback available | Character |
|---|---|---|
| 24 | `24_..._ROLLBACK.sql` | Destructive — drops evidence objects. Harness-proven: refuses without an explicit opt-in, succeeds with it, and leaves the bootstrap substrate intact. |
| 27 | `27_..._ROLLBACK.sql` | Removes exactly the actor trigger + function. **Re-opens the audit-provenance forgery it closes** — only for a failed deployment of 27 itself. |
| 19–23 | present | Reviewed by `npm run security:sql` for overreach; each is scoped to its own migration. |

Preferred rollback for a failed apply is **restore from the Stage 2 backup**,
not a rollback script, unless the failure is isolated to one migration whose
rollback is known-scoped.

---

## Stage 4 — Apply

For each migration in `apply_set`, in ascending order:

```bash
export PROD_DATABASE_URL='...'
M=24   # example

psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f ${M}_*_HARDENING.sql        2>&1 | tee evidence/<date>/apply/${M}_hardening.log
# storage stage only where the migration defines one (24)
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f ${M}_*_STORAGE.sql          2>&1 | tee evidence/<date>/apply/${M}_storage.log
```

After each migration, immediately run Stage 5 for that migration before starting
the next.

**Approval required:** a named approver must confirm in writing, per migration,
before the apply command is issued. Record the approver and UTC timestamp.

---

## Stage 5 — Post-apply VERIFY

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f ${M}_*_VERIFY.sql           2>&1 | tee evidence/<date>/verify/${M}_verify.log
```

- Migration 24's VERIFY reports **18 sections, A–R**. Anything other than
  `VERIFY 18/18` is a failure, including a pass with fewer sections — a reduced
  section count means the VERIFY did not run in full.
- For migrations whose VERIFY has a Section B, run **Section A only** here.

**Then re-run the full Stage 1 probe** and diff against the Stage 1 baseline.
The only differences must be the objects the applied migration introduces.

---

## Stage 6 — Record evidence

Capture, per migration, into `evidence/<date>/`:

| Artifact | Content |
|---|---|
| `inspect-before.log` / `inspect-after.log` | Stage 1 probe, pre and post |
| `apply/<n>_*.log` | raw apply output |
| `verify/<n>_verify.log` | raw VERIFY output including the `18/18` line for 24 |
| `approval.md` | approver name, UTC timestamp, migration number, decision |
| `backup.md` | backup id, timestamp, restore-drill result, measured restore duration |
| `checksums.txt` | SHA-256 of every artifact above |
| `main-sha.txt` | the exact `main` SHA the apply set was derived from |

Then update `MIGRATION_RUNTIME_REGISTER.md` §1 production column from `unknown`
to the measured state, citing the artifact path. **The register is only
authoritative if it is updated in the same change as the apply.**

---

## Stage 7 — Abort conditions

Stop immediately, restore from backup, and re-plan if any of these occur:

- Any VERIFY exits non-zero.
- Migration 24 VERIFY reports fewer than 18 sections.
- The Stage 5 diff shows an object change not attributable to the applied migration.
- Row counts change on `compliance_audit_log`, `buyer_pack_snapshots`, or
  `procurement_decisions` during a forward apply — these are append-only and no
  forward migration should write to them.
