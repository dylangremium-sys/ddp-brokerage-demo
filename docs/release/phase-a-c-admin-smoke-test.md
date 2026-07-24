# Phase A–C — Admin Smoke Test (manual)

Manual UI verification after the app build is deployed against a DB with
migrations 25 + 26 applied. Perform as a **DDP admin** in the Compliance
Watchtower. None of these steps require production; run against staging.

Legend: ✅ expected pass · ⛔ expected block (a block is a *success* here).

---

## 1. Source Registry — governance fields

- [ ] Open **Watchtower → Source Registry**.
- [ ] The Add/Edit form shows the new fields: **Authority tier**, **Authority
      type**, **Category**, **Monitoring method**, **Priority (1–100)**.
- [ ] The helper note is present: *"Tier 3 (intelligence signal) sources can raise
      an item for human review but never act as a direct authority for an enforced
      rule."*
- [ ] The sources table shows a **Tier** column.
- [ ] ✅ Create a source with Tier 1 / `primary_regulator` / `rss` / priority 5 →
      saves; row shows **Tier 1**.
- [ ] ⛔ Try to save Tier 1 + authority type `aggregator` → **rejected** with a
      clear message (contradictory classification). This is enforced in app **and**
      DB.
- [ ] Edit an existing (legacy) source → fields default to **Tier 3 / aggregator /
      general / manual / 100** if it was never classified.

## 2. Ingestion Runs tab — visibility

- [ ] A new **Ingestion Runs** tab appears between *Source Registry* and *Review
      Queue*.
- [ ] The tab explains it creates candidates in **draft (new)** status only and
      that an unavailable source is a **failed run, never a silent no-change**.
- [ ] The run-history table renders (empty state message if no runs yet).
- [ ] A counter shows how many enabled auto-sources exist.
- [ ] A non-admin (if testable) sees no ingestion data / is blocked from running.

## 3. Trigger run behaviour

- [ ] Ensure at least one **enabled** source has monitoring method `rss`/`atom`
      pointing at a reachable public feed on an allowlisted host.
- [ ] Click **Run ingestion now**.
- [ ] ✅ A result banner summarizes: `N ok, N partial, N failed, N skipped · N new
      candidate(s), N duplicate(s)`.
- [ ] New run rows appear in the history table with per-outcome counters
      (Seen / New / Dup / Unch. / Failed), trigger `manual`, actor `admin`.
- [ ] For a genuinely new feed item, a candidate legal update appears in the
      **Review Queue / Legal Change Monitor** with status **new** (draft) — never
      approved/active.

## 4. Failed-source behaviour (failed ≠ no changes)

- [ ] Temporarily point a source at an unreachable/off-allowlist/non-HTTPS URL (or
      disable its host).
- [ ] Run ingestion.
- [ ] ⛔ The run is recorded with status **failed** (or **partial**) and an explicit
      **failure reason** (e.g. `source_unavailable`, `off_allowlist`, `url_unsafe`,
      `timeout`). It must **not** show as a clean `succeeded`/no-change run.
- [ ] No candidate legal update is created for that source.

## 5. Dedup behaviour

- [ ] Run ingestion twice in a row against an unchanged feed.
- [ ] First run: items counted as **New** (candidates created).
- [ ] Second run: same items counted as **Unchanged** or **Dup** — **no** new
      candidates created (no duplicate legal updates).
- [ ] If the same notice appears under two sources/feeds with identical content,
      only **one** candidate is created; the second is a duplicate.
- [ ] Editing the underlying feed content (real change) on a stable URL **does**
      produce a new candidate on the next run (revisions are allowed).

## 6. Tier-3 authority guard (DB-level expectation)

> This guard is enforced in the database; there is no rule-activation UI in this
> phase, so verify via SQL or defer to Phase D UI.

- [ ] ⛔ Attempt (via SQL, admin) to set a `compliance_rules` row to `approved`/
      `active` when its `source_legal_update_id` traces to a **Tier-3** source →
      **rejected** ("governance violation … Tier 3 … must not be the direct
      authority for an enforced rule").
- [ ] ✅ The same rule becomes enforceable once re-pointed to a **Tier 1/2** source.
- [ ] ✅ A **draft** rule from a Tier-3 source is allowed (human-review path intact).

## Sign-off

- [ ] Governance fields work and reject contradictions.
- [ ] Ingestion runs are visible and triggerable.
- [ ] Failed source → failed run with reason (not silent).
- [ ] Dedup prevents duplicate candidates; real changes still captured.
- [ ] Tier-3 guard blocks enforced-rule authority; drafts unaffected.
- [ ] Candidates are always draft/new and flow into the existing Review Queue.
