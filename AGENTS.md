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
