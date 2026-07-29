# DDP Agent Guardrails

## Scope
- This repository is DDP only.
- Never reference GeoVault files, branches, prompts, audits, or deployment state.
- If a request includes GeoVault or mixed project context, stop and request a context reset in the GeoVault workspace.

## Hard Stop Rules
- Refuse to run commands that touch GeoVault paths.
- Refuse to summarize or merge context from GeoVault and DDP in one response.
- If project identity is ambiguous, halt and ask for explicit confirmation before proceeding.

## Execution Rules
- Keep all commands, edits, and evidence inside this repository.
- Treat cross-project assumptions as invalid until explicitly re-scoped by the user.
- Prefer safety over speed: unknown scope means no action.
