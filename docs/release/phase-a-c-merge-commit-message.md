# Merge Commit Message — Watchtower Phases A–C (for maintainer)

Use when squash/merging `feature/watchtower-phase-a-c` → `main`.

---

## Title

```
feat(watchtower): ship ingestion and provenance foundation (Phases A-C)
```

## Body

```
- Adds Phase A-C Watchtower foundation only:
  - provenance and dedup schema hardening
  - source governance and tiering controls
  - ingestion runner foundation and admin ingestion visibility
- Preserves authority boundary:
  - no AI triage/summaries
  - no review decision automation
  - no rule lifecycle enforcement changes
  - no impact engine or alert-generation rollout in this merge
- Includes migration/verify/rollback SQL for 25 and 26.
- Includes release docs:
  - PR packet
  - staging checklist
  - admin smoke test
  - reviewer scope-lock comment
- Notes:
  - pre-existing local-path test failures tracked separately
  - unrelated evidence-workflow changes intentionally excluded
```
