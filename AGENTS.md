# AGENTS.md

Read this before running any command in this repository.

## Scope — this repository is DDP only

GeoVault and DDP are developed side by side on the same machine, and context has
leaked between them before. Therefore:

- Never reference GeoVault files, branches, prompts, audits, or deployment state
  from here, and never run a command that touches a GeoVault path.
- Never merge GeoVault and DDP context into one answer.
- If a request arrives with mixed or ambiguous project context, stop and ask for
  explicit confirmation before acting. Unknown scope means no action.

Beware stale copies. Extracted zips named `ddp-brokerage-demo-main` and old
clones exist on this machine; some contain files that never reached `main`.
A directory without its own `.git` is a snapshot, not a working tree — do not
edit it. Confirm `git remote -v` points at `dylangremium-sys/ddp-brokerage-demo`
before starting work.

## You are probably not the only session in this clone

More than one agent works in `~/DDP AUDIT/ddp-brokerage-demo` at the same time.
On 2026-08-02 this produced, in a single afternoon: a working tree switched off
one session's branch three times mid-task, two sessions independently writing the
same migration, and two sessions independently writing the same three sections of
the same document — one of which had to be discarded after the other merged.

None of that was caught by CI, because none of it was pushed.

**1. Work in your own worktree, never in the shared tree.**

```bash
git worktree add -q /tmp/wt-<task> -b <branch> origin/main   # new branch
git worktree add -q /tmp/wt-<task> <existing-branch>          # existing
# ... work, commit, push ...
git worktree remove --force /tmp/wt-<task> && git worktree prune
```

One command each way, and the shared tree can then move under you without
consequence. Do **not** switch to a separate clone instead: worktrees share an
object store, so `git log --all` and `git worktree list` can see another
session's local branches. A second clone cannot, and that visibility is the only
coordination channel this repository has.

**2. Push the branch the moment it exists, even empty.**

```bash
git commit --allow-empty -m "chore: claim <task>" && git push -u origin <branch>
```

A pushed branch is the only claim another session can see. An uncommitted branch
is invisible to CI, to GitHub, and to `git log --all` — which finds only work
that already has a *file*. Claim first, write second; the cost is one round trip
and the alternative is discovering the duplicate at merge time.

**3. Check what is already claimed before you start.**

```bash
git worktree list                      # other sessions' checkouts, incl. unpushed
git fetch origin --prune && git branch -r
gh pr list --state open                # include drafts; they are easy to miss
```

**4. For migrations, claim the number in the register before writing SQL.**
`docs/MIGRATION_NUMBER_REGISTER.md` is the record, and its rules 6 and 7 exist
because of the collision above. `npm run verify:migration-numbers` detects a
collision only once **both** sides have landed, by which point one has to be
renumbered.

**5. Before committing, confirm where you are.** `git rev-parse --abbrev-ref HEAD`.
Another session may have moved the shared tree since your last command.

**6. Never force-push a branch you did not create.** Cherry-pick onto its current
remote head instead. A force-push has already destroyed another session's work
here once.

## Environment setup (do this first)

`node_modules/` is not shipped with this repository and nothing installs it
automatically. Before running, building, linting, or testing anything:

```bash
npm ci
```

Use `npm ci`, never `npm install`, unless the task is explicitly to add or
upgrade a dependency. `npm ci` installs exactly what the committed
`package-lock.json` pins; `npm install` can silently change the dependency tree.

Requires Node.js 20 or newer (Vite 8, React 19, TypeScript 6). Verified on
Node 24.14.0 with npm 11.9.0.

A failure of the form `Cannot find module ...` or `vite: not found` is not a
code defect - it means `npm ci` has not been run.

## Running it

```bash
npm run dev      # http://localhost:5173
```

No configuration is required for a first run. With no Supabase environment
variables the app runs entirely against browser `localStorage` and the navbar
shows "Demo mode: localStorage". Supabase is optional - see the "Supabase
setup" section of `README.md`.

## Verification commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b && vite build` (runs `prebuild` config validation first) |
| `npm run preview` | Serve the built `dist/` |
| `npm run lint` | ESLint |
| `npm test` | `vitest run` |
| `npm run ci:verify` | Full gate: `security:sql`, tests, `tsc -b`, lint, build |

`npm run ci:verify` is the command to run before declaring work finished. The
`prebuild` step (`scripts/validate-hosted-supabase-config.mjs`) will fail the
build if hosted Supabase configuration is present but inconsistent.

Database-related scripts (`verify:migration`, `ci:runtime`) need a disposable
Postgres harness - see `docs/DISPOSABLE_PG_HARNESS.md`. They are not needed for
frontend work.

## The AI evaluation harness

`src/lib/aiSummariserEval.integration.test.ts` runs a fixture corpus through the
real Anthropic API. It is SKIPPED unless `AI_EVAL_API_KEY` is set, so `npm test`
and CI never make a network call or spend anything. Run it deliberately:

```bash
AI_EVAL_API_KEY=sk-ant-... npx vitest run src/lib/aiSummariserEval.integration.test.ts
```

`AI_EVAL_MODEL` (default `claude-opus-5`) and `AI_EVAL_EFFORT` (`low`..`max`,
default `low`) let you sweep without editing code. It measures guardrail health
- parse rate, citation grounding, false wording-guard blocks, injection
resistance, latency - not summary quality. Re-run it after any change to the
system prompt, the model, or the effort level, and diff the printed table.

## Secrets

- `.env.local` is gitignored and must stay that way.
- `SUPABASE_SERVICE_ROLE_KEY` must never carry a `VITE_` prefix and must never
  be referenced from `src/`. `scripts/client-provisioning-boundary.test.mjs`
  fails the build if it is.

## Where the documentation is

- `README.md` - architecture, Supabase setup, environment variables.
- `docs/README.md` - index of the `docs/` directory.
- `docs/MASTER_DEVELOPMENT_ROADMAP.md` - what is built and what is planned.
- `docs/DEPLOYMENT_RUNBOOK.md` / `docs/RELEASE_CHECKLIST.md` - shipping.
- `docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md` - check whether a change freeze
  is still in force before touching production.

## Ground rules

- Fulfilment and chain-of-custody tracking are planned, not implemented. Do not
  assume they exist.
- Never replay a SQL migration that has already been applied. The migration
  register and the files that must never be replayed are documented in
  `README.md` under "Database setup and migration safety".
