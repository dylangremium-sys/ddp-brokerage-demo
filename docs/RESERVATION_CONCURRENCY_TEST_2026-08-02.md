# DDP — reservation oversell guard: two-session concurrency test

**Result: PASS.** The oversell guard holds under real concurrency. No oversell occurred in
any configuration tested, and the `FOR UPDATE` lock was shown to be the thing preventing it.

Run 2026-08-02 against staging `szqocdabwkjrggrddocx` (PostgreSQL 17.6), schema at 48 tables
/ 112 policies, repo `d10a3b8`. This closes item 1 of `DDP_HANDOVER_PROMPT_2026-08-02.md`.

## What was under test

`public.fn_enforce_reservation_availability()` — a `BEFORE INSERT` trigger on
`public.reservations` created by `44_RESERVATION_LEDGER_HARDENING.sql`. It takes
`SELECT … FOR UPDATE` on the `inventory_batches` row, then compares
`batch_reserved_kg_unchecked(batch, now())  +  NEW.quantity_kg` against `quantity_kg`.

Both `40_LICENCES_AND_PERMITS_VERIFY.sql` and `44_RESERVATION_LEDGER_VERIFY.sql` explicitly
state they do **not** prove this. Nothing else did either. It is now proven.

## Measured results

| # | Test | Setup | Expected | Measured |
|---|---|---|---|---|
| T0 | Guard fires at all | 600 then 600, one session, 1000 kg batch | 2nd rejected | rejected ✓ |
| T1 | **Deterministic interleave** | A holds uncommitted 600; B inserts 600 | exactly 1 wins | A committed, B blocked 8 s then rejected ✓ |
| T2 | **Counterfactual** | B reads availability, unlocked, while A uncommitted | — | B saw `reserved = 0`, i.e. 1000 kg "available" |
| T3 | Positive control | A holds 400; B inserts 400 | both win | both committed, 800 kg total ✓ |
| T4 | Simultaneous race ×10 | 4 sessions × 300 kg on 1000 kg | 3 win | 3 winners, 900 kg, **10/10 rounds** ✓ |
| T5 | Exact-fill boundary ×6 | 8 sessions × 250 kg on 1000 kg | 4 win | 4 winners, **exactly 1000.000 kg**, 6/6 ✓ |

Across all 20 batches: **17,600 kg reserved, 0 batches oversold.**

### T1 — the lock was observed, not assumed

A third session sampled `pg_stat_activity` while B was mid-insert:

```
   pid   | state  | wait_event_type |  wait_event   | blocked_by
 2080067 | active | Lock            | transactionid | {2080065}
```

B was genuinely waiting on A's transaction. It waited the full 8 s A held the row, then
failed with the guard's own message:

```
ERROR: batch …002 has 400.000 kg available (quantity 1000 kg, 600.000 kg already reserved)
       and cannot absorb a 600.000 kg reservation
```

### T2 — why the lock is load-bearing

This is the test that makes T1 mean something. While A held an **uncommitted** 600 kg
reservation, a session that did *not* take the row lock measured:

```
 isolation      | reserved_kg_seen_by_B | would_believe_available
 read committed |                     0 |                    1000
```

Under READ COMMITTED, A's row is invisible to B. A trigger without `FOR UPDATE` would
therefore compute 1000 kg available and admit a second 600 kg — **1200 kg reserved against a
1000 kg batch.** The lock is the only thing standing between the current code and that.

### Independent cross-check

`commercial_audit_log` held exactly **59** rows — matching the 59 successful reservations
(1+1+1+2+30+24) exactly. Every winner was audited; nothing extra was written.

## Scope — what this does NOT prove

- **Staging only.** Migration 44 is *not applied to production*. This proves the code is
  correct, not that production is protected. Production is still unprotected because the
  migration is not there.
- Tested through `postgres`, not through RLS as `authenticated`. The guard is `SECURITY
  DEFINER` and runs identically, but the end-to-end path a real buyer takes is not covered.
- Expiry and `reservation_releases` were not exercised; every reservation was live.
- Max concurrency tested was 8 simultaneous sessions on one batch.

## Staging left clean

All fixtures removed: reservations, batches, organisations, farm, profile and both audit
logs are back to **0 rows**; schema still 48 tables / 112 policies. Cleanup required
disabling the append-only triggers (`reservations` blocks DELETE by design) — all **52**
user triggers in `public` were confirmed re-enabled afterwards (`tgenabled = 'O'`).

## Notes for the next session

- `~/.pgpass` covers both staging and prod on the session pooler (port 5432). Session mode
  is required — the transaction pooler on 6543 cannot hold an interactive transaction open
  and this test is impossible through it.
- **zsh does not word-split unquoted variables**, so `PSQL="psql -h …"; $PSQL -f x.sql`
  fails with `command not found`. Use a shell function.
- `\echo` in psql runs regardless of whether the preceding statement errored, so a script's
  own "success" banner is not evidence. Count rows.
