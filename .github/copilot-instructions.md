# DDP Copilot Scope Guard

## Project Boundary
- This repository is DDP only.
- Never use GeoVault context, files, branches, prompts, or assumptions in this repo.
- If a request mentions GeoVault or mixed context, stop and ask the user to switch to the GeoVault workspace and start a new thread.

## Operating Rules
- Keep all analysis, edits, commands, and outputs scoped to this repository.
- Do not reference paths outside this repository unless the user explicitly asks for an external dependency.
- If scope becomes ambiguous, default to "do not proceed" and request clarification.
