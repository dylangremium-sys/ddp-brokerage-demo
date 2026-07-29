/**
 * Archival refs — snapshots preserved for recovery, not lines of development.
 *
 * WHY THIS EXISTS
 *   On 2026-07-29 a stale local clone was found holding 36 commits that existed
 *   on no remote. Rather than lose them, they were pushed to origin as 18
 *   `rescue/2026-07-29/*` branches — deliberate preservation, described in §11
 *   of that day's session handover.
 *
 *   That immediately broke AUDIT-001 for the entire repository. The collision
 *   check scans EVERY remote ref, and those snapshots are old pre-rebase states
 *   that legitimately numbered migrations 20, 21 and 25 differently from the way
 *   `main` eventually numbered them. The check reported three collisions, went
 *   red on `main` itself, and blocked every pull request in the repo — including
 *   ones that touched no SQL at all.
 *
 *   The report was not wrong about the facts; it was wrong about the question.
 *   AUDIT-001 exists to stop two branches MERGING two different migration 20s.
 *   An archival snapshot is never going to be merged — that is what makes it
 *   archival — so it cannot cause the ambiguity the check defends against.
 *
 * SCOPE — deliberately narrow
 *   Only the `rescue/` prefix is excluded, and only under `origin/`. Every
 *   ordinary branch, including every long-lived `audit-*`, `feature/*` and
 *   `fix/*` line, is still compared exactly as before. Widening this list makes
 *   the gate blinder, so it should be treated as a security-relevant change and
 *   justified in the same terms.
 *
 *   If a rescued branch is ever promoted to real work, it must be renamed off
 *   the `rescue/` prefix — at which point this check starts guarding it again,
 *   which is the correct behaviour.
 */

/**
 * Ref-name prefixes treated as archival. Full refnames
 * (`refs/remotes/origin/...`), matching what `git for-each-ref --format=%(refname)`
 * emits — the short form would also match a LOCAL branch named `rescue/...`,
 * which is not what this excludes.
 */
export const ARCHIVAL_REF_PREFIXES = Object.freeze([
  'refs/remotes/origin/rescue/',
])

/**
 * True when `ref` is an archival snapshot that must not gate merges.
 *
 * Matches on the prefix INCLUDING its trailing slash, so a genuine branch named
 * `rescue-plan` or `rescuer/foo` is NOT excluded — only refs actually inside the
 * `rescue/` namespace.
 */
export function isArchivalRef(ref) {
  return ARCHIVAL_REF_PREFIXES.some((prefix) => ref.startsWith(prefix))
}
