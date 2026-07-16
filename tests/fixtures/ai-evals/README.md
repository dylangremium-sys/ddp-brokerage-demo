# AI Evaluation Fixtures — synthetic data only

**Non-runtime test data. Not executable. Not imported by anything.**

Specification: `docs/AI_EVALUATION_PLAN.md`. Findings referenced as `F*` are in the audit report; threats as `T*` are in `docs/AI_THREAT_MODEL.md`.

## Isolation — why this directory is inert

Verified at base commit `b81fa1f`:

| Tool | Scope | Includes this directory? |
|---|---|---|
| vitest | `vitest.config.ts:11` → `src/**/*.test.ts`, `scripts/**/*.test.mjs` | **No** |
| tsc | `tsconfig.app.json` → `src`; `tsconfig.node.json` → `vite.config.ts`; `tsconfig.api.json` → `api` | **No** |
| eslint | `eslint.config.js:11` → `**/*.{ts,tsx}` | **No** — these are `.json` |
| vite build | bundles only what `src` imports | **No** — nothing imports these |

These files are **data**. No harness is added in this increment: a harness must live under `src/**/*.test.ts` to run, which would place it inside `ci:verify`. Several fixtures encode behaviour that **does not exist yet** and would fail today by design — they are the regression gates for the fixes, to be activated by the PR that implements each fix.

## Data policy

- **All data is synthetic.** No real farmer, buyer, regulator, laboratory, batch, or production data.
- Hosts use `example.invalid` (reserved, unroutable) — never a real regulator domain.
- Ids are `synthetic-NNNN`; jurisdiction is `Synthetica` unless a real jurisdiction name is required by the language case.
- Names, addresses and identifiers in `E19` are invented for the privacy case and identify no real person.
- Checksums are `null` or obviously synthetic 64-hex strings.

## Status legend

| Status | Meaning |
|---|---|
| `pins-current-behaviour` | Correct today — the fixture prevents regression |
| `fails-today` | Encodes required behaviour that **does not exist** at `b81fa1f`; gated on the linked finding |

## Index

| Id | Category | Threat | Finding | Status |
|---|---|---|---|---|
| E01 | baseline | — | — | pins-current-behaviour |
| E02 | faithfulness | T15 | — | fails-today |
| E03 | abstention | T17 | — | fails-today |
| E04 | faithfulness | T18 | — | fails-today |
| E05 | security | T1 | F7 | fails-today |
| E06 | security | T1, T4 | F7 | fails-today |
| E07 | security | T1 | — | pins-current-behaviour |
| E08 | false-positive | T7 | F11 | fails-today |
| E09 | abstention | T4, T11 | F6 | fails-today |
| E10 | abstention | T4, T12 | F6 | fails-today |
| E11 | multilingual | T8 | F6 | fails-today |
| E12 | multilingual | T8 | F6 | fails-today |
| E13 | citation | T3 | F3 | fails-today |
| E14 | citation | T6 | F3 | fails-today |
| E15 | robustness | — | — | pins-current-behaviour |
| E16 | robustness | — | — | fails-today |
| E17 | integrity | T16 | F9 | fails-today |
| E18 | integrity | T10 | F2 | fails-today |
| E19 | privacy | T20 | F10 | fails-today |
| E20 | abstention | — | — | pins-current-behaviour |
