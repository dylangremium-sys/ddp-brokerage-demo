# Runbook — applying the export-hub foundation (migrations 39–43)

**Status: NOT APPLIED ANYWHERE.** Written 2026-08-02 on branch
`feature/export-hub-foundation`. Every claim below about behaviour is evidenced by the
disposable-PostgreSQL harness, which is a real PostgreSQL 18.4 but is neither staging nor
production.

---

## 1. What this adds, in one paragraph

DDP's existing gate asks whether the **supplier** is documented. These five migrations add the
machinery to ask whether the **buyer** may lawfully receive: who the counterparty is, what
licences and permits they hold, what the destination market required *on the shipment date*,
whether the permit has quantity left, and whether a named human with a second factor approved
any bypass. Nothing here presumes physical custody — no lots, no warehouse, no sensors — so it
is valid under either the Option A or Option B direction.

## 2. Dependency chain

Apply **in order**. Each HARDENING refuses to run if its predecessor is missing, so a
mis-ordered apply fails loudly rather than half-landing.

```
39 organisations ──▶ 40 licences/permits ──▶ 41 rulesets ──▶ 42 export gate ──▶ 43 MFA
                                    (41 also needs migration 9)
```

| # | Files | Applies to |
|---|---|---|
| 39 | `39_COUNTERPARTY_ORGANISATIONS_{HARDENING,VERIFY,ROLLBACK}.sql` | new tables + `profiles.role` widening |
| 40 | `40_LICENCES_AND_PERMITS_{HARDENING,VERIFY,ROLLBACK}.sql` | new tables only |
| 41 | `41_EFFECTIVE_DATED_RULESETS_{HARDENING,VERIFY,ROLLBACK}.sql` | **alters `compliance_rules`** + new table |
| 42 | `42_EXPORT_ELIGIBILITY_GATE_{HARDENING,VERIFY,ROLLBACK}.sql` | new tables + view |
| 43 | `43_MFA_FOR_GATE_APPROVAL_{HARDENING,VERIFY,ROLLBACK}.sql` | new table + trigger on 42's table |

## 3. Pre-apply checks

1. **Is the production change freeze still in force?** Read
   `docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md`. If it is, stop — this is not an incident fix.
2. **Is the migration backlog still unapplied?** As of the last measurement, 24, 28, 30 and 36
   are applied nowhere. Landing 39–43 on top of a database missing those is untested. Reconcile
   the backlog first, or apply to a database whose applied-set you have **measured**, not assumed.
3. **Run the harness.** `PG_BIN=<pg18 bin dir> npm run ci:runtime` must be green for all
   twelve fixtures, not only the five new ones — 39–43 modify the shared bootstrap substrate.
4. **Run the static gate.** `npm run ci:verify`.

## 4. The three things that touch existing objects

Everything else is purely additive. These are the only places a rollback could hurt.

**`profiles.role` (migration 39).** The CHECK is widened to admit `buyer`. Cumulative — nothing
is removed, so no existing row can be invalidated. The rollback narrows it back and **refuses**
if any `buyer` profile exists rather than failing with PostgreSQL's opaque "violated by some row".

**`compliance_audit_log.action` (migrations 39, 40, 42).** The CHECK is widened three times,
cumulatively. **No rollback narrows it back**, and that is deliberate: the log is append-only
(migration 9) and TRUNCATE-hardened (migration 11), so rows carrying the new actions cannot be
removed, and narrowing the constraint would invalidate history the platform guarantees is
immutable. A widened enumeration is not a vulnerability.

**`compliance_rules` (migration 41).** Gains `effective_from`, `effective_to` and
`effective_from_is_estimated`. Existing rows are backfilled with `effective_from = created_at`
and flagged as estimates. **That backfill is an assumption**: it is correct for a rule captured
as it was published and wrong for one transcribed later from an older instrument, where the real
effective date is earlier and the platform will under-apply the rule to historic shipments. The
flag exists so those can be found and corrected. Plan for someone to do that.

## 5. Apply

Per migration, in order, each in its own transaction:

```sql
BEGIN;
\i 39_COUNTERPARTY_ORGANISATIONS_HARDENING.sql
COMMIT;
```

Then run that migration's VERIFY **on a non-production database**:

```sql
\i 39_COUNTERPARTY_ORGANISATIONS_VERIFY.sql
```

> **VERIFY scripts 39–43 are NOT read-only.** They insert fixtures and are wrapped in
> `BEGIN … ROLLBACK`, so they leave nothing behind — but they must not be run against
> production under the freeze. This differs from migration 37's VERIFY, which is catalog-SELECT
> only and is safe against production whole.

Expected pass counts: **39 → 7/7 · 40 → 8/8 · 41 → 7/7 · 42 → 9/9 · 43 → 7/7.**

## 6. Post-apply: seed before you switch anything on

The gate is fail-closed, so on a freshly-migrated database **every consignment blocks**. That is
correct behaviour, not a fault. Before it is usable somebody must:

1. Create the exporter and buyer `organisations` and verify them (a verified organisation
   requires a named verifier and a timestamp — the constraint enforces it).
2. Record the exporter's **export** licence for each regime it ships.
3. Record each buyer's **import** permit, with its quantity limit and both calendar years.
4. Research and record a `destination_ruleset` per market and regime. **A market with no
   ruleset is treated as unresolved and blocks** — an empty result is not permission.
5. Record a denied-party screening per buyer, with a `valid_until` that will actually expire.

## 7. Enabling MFA (migration 43) — order matters

MFA ships **disabled**. Enabling it before administrators have enrolled a second factor locks
every approver out of the export gate simultaneously.

```sql
-- 1. Confirm enrolment out of band, for every admin who may approve an override.
-- 2. Then, and only then:
UPDATE public.security_settings
   SET enabled = true, changed_by = auth.uid(), changed_at = now(),
       note = 'All N admins enrolled TOTP on <date>; enrolment verified by <name>.'
 WHERE key = 'mfa_required_for_gate_approval';
```

To relieve an outage, set `enabled = false` — **do not** roll migration 43 back. Disabling is
reversible in one statement and records who did it; the rollback removes the mechanism entirely
and the resulting state looks completely normal.

Note the deliberate asymmetry: **a missing settings row means REQUIRED.** Deleting a row must
never be a way to switch off a control.

## 8. Rollback

Each rollback refuses by default while its tables hold rows, and names what would be lost. To
proceed anyway, opt in per transaction:

| Migration | Opt-in setting |
|---|---|
| 39 | `SET LOCAL organisations.rollback_destructive = 'on';` |
| 40 | `SET LOCAL licences.rollback_destructive = 'on';` |
| 41 | `SET LOCAL rulesets.rollback_destructive = 'on';` |
| 42 | `SET LOCAL export_gate.rollback_destructive = 'on';` |
| 43 | `SET LOCAL mfa.rollback_disable_enforcement = 'on';` |

Roll back in **reverse** order (43 → 39).

## 9. What is verified, and what is not

**Verified on real PostgreSQL 18.4**, across 38 assertion sections:

- the double-blind rule, observed under `SET ROLE authenticated` from both sides and from an
  identity-less session — and confirmed non-vacuous by reversing the policy and watching it fail
- the dual-calendar 543 assertion, rejecting a never-converted year and a twice-converted one,
  while still accepting a correct 2026 CE / 2569 BE pair
- expiry computed rather than stored: a licence lapsed by one day reads invalid with its stored
  state untouched
- permit headroom to the gram, including the exact-fit boundary, plus refusal of double,
  partial and cross-permit reversals
- NaN and Infinity rejected on every quantity — confirmed non-vacuous by removing the upper
  bound and watching PostgreSQL admit NaN
- point-in-time rule resolution in both directions, confirmed non-vacuous by substituting a
  naive `status = 'active'` filter and watching it fail
- all seven gate conditions failing against an empty world, a fully-satisfied consignment
  passing, and each condition flipping individually when its own precondition is broken
- override discipline: trivial reasons, blanket waivers and self-review all refused; approver,
  reason and waived conditions immutable
- MFA enforcement off by default, biting once enabled, and defaulting to *required* when the
  settings row is deleted

**NOT verified, and needing attention before any real consignment:**

1. **Concurrency.** `fn_enforce_permit_headroom()` takes a `FOR UPDATE` row lock so two
   simultaneous draws serialise. A single-session VERIFY cannot demonstrate that. **A two-session
   test on staging is required** before a permit is drawn against in anger.
2. **Overlapping historic rulesets.** The one-current-ruleset guarantee is an index and holds
   under concurrency; the closed-range overlap check is a trigger and does not. Closing that
   needs the `btree_gist` extension, which is a deliberate Supabase extension decision.
3. **The hosted JWT→role mapping**, which the harness shim does not reproduce.
4. **`issue_buyer_pack_snapshot` is not MFA-protected.** It is a compliance-gate approval under
   §10's definition. Covering it means redefining that RPC, which belongs in a migration that
   owns it rather than in 43.
5. **No live database has seen any of this.**

## 10. Related

- `docs/MIGRATION_NUMBER_REGISTER.md` — allocations 39–43; next free number is 44
- `docs/DISPOSABLE_PG_HARNESS.md` — the shim boundary records, and the partly-lifted RLS
  limitation that lets 39/40/42 test policies for real
- `src/lib/thaiCalendar.ts` — the client-side half of the dual-calendar rule (25 tests)
