# PR Self-Review Checklist (Author) — Watchtower Phases A–C

Tick these before requesting review on
`feature/watchtower-ingestion-phase-a-c`.

- [ ] Scope is locked to Phases A–C only (no AI, no review decisions, no rule
      activation, no impact engine, no alert generation).
- [ ] PR description matches implemented scope and the out-of-scope section is
      explicit.
- [ ] Migration order is documented exactly:
  1. `25_WATCHTOWER_INGESTION_PROVENANCE_HARDENING.sql`
  2. `25_WATCHTOWER_INGESTION_PROVENANCE_VERIFY.sql`
  3. `26_WATCHTOWER_SOURCE_GOVERNANCE_HARDENING.sql`
  4. `26_WATCHTOWER_SOURCE_GOVERNANCE_VERIFY.sql`
- [ ] Rollback order is documented in reverse (26 before 25) and includes risk
      notes.
- [ ] Verify scripts passed in disposable PG 18 and results are attached
      (25: A–H 8/8, 26: A–F 6/6).
- [ ] RLS posture is unchanged or stricter for new objects (admin-only via
      `is_ddp_admin()`; no DELETE/TRUNCATE grants).
- [ ] Fail-conservative behavior is explicit (source unavailable ⇒ failed, never
      no changes).
- [ ] Dedup behavior and provenance fields are documented.
- [ ] Unrelated workspace changes are excluded from the commit and PR.
- [ ] Known pre-existing test failures are tracked in a separate issue and linked.
- [ ] CI signals relevant to this scope are green (or clearly explained if
      pre-existing failures).
- [ ] Staging checklist and admin smoke test docs are linked in the PR body.
