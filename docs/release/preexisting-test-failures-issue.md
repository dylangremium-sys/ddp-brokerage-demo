# Issue draft — pre-existing test failures (path with space `%20`)

Paste as a new GitHub issue and link it from the Phase A–C PR so the failures are
tracked separately and not conflated with that PR.

---

## Title

```
Two test suites fail when the repo path contains a space (%20 path decoding)
```

## Labels (suggested)

`bug`, `tests`, `ci-hygiene`, `good-first-issue`

## Body

### Summary

Three tests across two suites fail when the working copy lives in a directory
whose path contains a **space**. The failures are **environmental**, not code
defects in the tested source, and are **unrelated to the Watchtower Phase A–C
work** — they reproduce on commit `4fb72f7` (the parent of that branch).

### Affected tests

- `scripts/sensitive-storage-registry.test.mjs`
  - `registry is not empty (guards against a broken parse silently passing)`
  - `every ddp_* key used in src/ is cleared on sign-out`
  - `the registry lists no key that src/ does not use (no dead entries)`
- `scripts/deploy-workflow.test.mjs` (suite fails to load)

### Root cause

These scripts derive filesystem paths from `import.meta.url` (a `file://` URL). On
a checkout under a path with a space (here `/Users/mac/DDP AUDIT/…`), the URL
encodes the space as `%20`, and the raw URL path is passed to `fs` without being
decoded back to a space. Observed errors:

```
ENOENT: no such file or directory, open  '…/DDP%20AUDIT/…/src/lib/browserPersistence.ts'
ENOENT: no such file or directory, scandir '…/DDP%20AUDIT/…/src'
ENOENT: no such file or directory, open  '…/DDP%20AUDIT/…/.github/workflows/security-ci.yml'
```

The `%20` is the tell: the path is used as-is instead of being converted from a
URL to a filesystem path.

### Why it does not affect CI or the Phase A–C PR

- CI checks out into a space-free path, so the encoding never appears — these
  suites pass there.
- The Phase A–C branch touches **neither** test file and adds no `ddp_`
  localStorage key; the failures reproduce on the parent commit `4fb72f7`.

### Fix (suggested)

In each affected script, convert the module URL to a path with `fileURLToPath`
rather than using the URL's `.pathname` (or string-slicing `import.meta.url`)
directly:

```js
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))   // decodes %20 → space
// …then join(__dirname, '..', 'src', …) instead of building a string from import.meta.url
```

`fileURLToPath` performs the percent-decoding and platform-correct conversion.
`scripts/check-security-migrations.mjs` already uses this pattern and is unaffected
— it can serve as the reference.

### Acceptance criteria

- [ ] `scripts/sensitive-storage-registry.test.mjs` and
      `scripts/deploy-workflow.test.mjs` pass when the repo path contains a space.
- [ ] No behavior change for space-free paths (CI stays green).
- [ ] Optionally: a lightweight guard/test asserting these scripts resolve paths
      via `fileURLToPath`.

### Notes

Out of scope for the Watchtower Phase A–C PR — filed separately to keep that PR's
review focused on migration safety, RLS posture, and fail-conservative behavior.
