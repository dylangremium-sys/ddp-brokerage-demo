# Reviewer Ping (GitHub mentions) — Watchtower Phases A–C

Short one-paragraph ping to post in the PR thread or a channel. Replace the team
handles with your real ones.

---

## Full ping

> @backend @security @ops — review please on the **Watchtower ingestion &
> provenance foundation** (`feature/watchtower-phase-a-c`). **Scope is
> locked to Phases A–C only** — provenance/dedup schema, source governance &
> tiering, and a *triggerable* ingestion runner that produces **draft** candidate
> legal updates; **no AI, no review decisions, no rule enforcement, no impact
> engine, no alerts** in this PR. **@security / @backend:** please focus on
> migration safety (additive + idempotent, `25 → 26`, reverse-order rollback),
> the admin-only RLS posture on the new evidence tables, and the fail-conservative
> guarantee (source unavailable ⇒ *failed* run, enforced in both code and DB CHECKs).
> **@ops:** the staging checklist + admin smoke test are in the PR body. Heads-up:
> 3 test failures are **pre-existing** (a `%20` path bug that only triggers on a
> repo path with a space — green in CI) and are tracked in a separate issue, not
> part of this change. 🙏

## Per-team one-liners (if you'd rather ping separately)

- **@security** — Please sanity-check RLS/grants on `watchtower_ingestion_runs` /
  `_items` (admin-only, no DELETE/TRUNCATE anywhere) and the Tier-3 authority
  guard trigger. No AI/keys introduced.
- **@backend** — Migration safety review: additive nullable columns, partial dedup
  indexes, `NULLABLE→backfill→NOT NULL` on migration 26, idempotency, and the
  dependency-injected runner (`watchtowerIngestionService.ts`).
- **@ops** — Rollout uses `docs/release/phase-a-c-staging-checklist.md` then
  `phase-a-c-admin-smoke-test.md`. Rollback is reverse-order with an evidence-
  protection opt-in on migration 25.
