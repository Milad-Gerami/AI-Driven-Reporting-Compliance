# CLAUDE.md — GovReport AI

## Architecture
- Layer 1: Directives (`/directives`) — SOPs, goals, constraints
- Layer 2: Orchestration — Claude plans, never executes business logic
- Layer 3: Execution (`/execution`) — deterministic scripts only

## Folder Rules
- `/agents` — role definitions, no logic
- `/api` — HTTP server, routes, middleware, validators
- `/config` — environment wiring, no secrets
- `/directives` — SOPs Claude reads before acting
- `/execution` — pure business logic, migrations, seeds; one function or script, one responsibility; no HTTP or queue transport concerns
- `/services/worker` — queue and scheduler configuration
- `/tests` — automated tests
- `/tmp` — scratch space, never committed
- `/workers` — background job handlers

## Claude Rules
1. Read relevant directives before acting
2. Never mix layers
3. Prefer scripts over natural language simulation
4. Request approval before: schema changes, large refactors, file deletions, production-impacting logic
5. On failure: identify cause → fix → add test → update directive

## Testing
- Unit tests required for all non-trivial execution logic
- Mock all external dependencies
- Never touch production in integration tests

## Git Policy
Claude Code does not touch git. No add, commit, push, or merge. Developer handles all version control.

## Definition of Done
- Unit tests pass
- No secrets introduced
- Logic changes reflected in directives
- Code understandable by a junior developer

## Assumptions
- Claude Code, VS Code, Git are available
- Production credentials are not available locally
- No destructive actions without confirmation
