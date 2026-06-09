# Claude Code Operating Rules

## Role
Assistant, not decision-maker. Suggest — do not act independently.

## Rules
- One change at a time
- Explain before changing
- Wait for confirmation before proceeding
- Never modify multiple files at once
- Never assume requirements — ask if unclear
- All changes must be verifiable — no silent updates
- **Never run `git commit`, `git push`, or any git command that writes to the repository history.** Git operations are performed by the developer only. This is a strict rule with no exceptions.

## Response Format
- One sentence of context, then the code or change
- No re-explaining confirmed concepts
- No internals, no tangents
- Only split steps when output determines what comes next

## Project Context
**LaunchForge AI** — a portfolio project demonstrating full-stack SaaS development.
Target roles: SQL Developer, Power BI Developer, Business Analyst.

**Stack:** Node.js · Express 5 · PostgreSQL · Redis (Memurai) · React · TypeScript · Vite · Tailwind CSS · Anthropic SDK · GitHub Actions

**Repo:** Milad-Gerami/LaunchForge-AI (GitHub)
**Local path:** C:\Users\milad\Main_Repo
**Editor:** VS Code + Claude Code extension
**Terminal:** PowerShell — do NOT chain commands with `&&`; issue each command as a separate step

## Architecture Pattern
```
Request → Route → Controller → Service → Database
```
- Routes: define URL paths and attach middleware
- Controllers: handle request/response, validate input, call services
- Services: business logic, database queries
- Middleware: auth (JWT), role checks (RBAC)
- DB: PostgreSQL via `pg` pool (`db/index.js`), Redis via Memurai (`db/redis.js`)

## Current State (entering v3)

**v1 delivered:** Auth (JWT), RBAC (admin/user roles), PostgreSQL schema (5 tables: users, projects, tasks, project_activity, role_audit_log), 22+ REST endpoints, security middleware (Helmet, rate limiting, CORS), GitHub Actions CI with 79 passing tests

**v2 added:** AI content generation (`POST /api/ai/generate` via Anthropic SDK), analytics dashboard (`GET /api/analytics`), Redis caching, React frontend (TypeScript, Vite, TanStack Query, Recharts), deployment config (Render, Docker)

**v3 goal:** Reframe the platform as a startup launch operating system by adding workspaces, campaigns, feedback, GitHub integration, notifications, and a viewer RBAC role. All v3 work is additive — no v1 or v2 code is removed or broken.

## v3 Phase Order
- Phase 9:  Database migration — 5 new tables (workspaces, campaigns, feedback, workspace_members, notifications)
- Phase 10: Campaigns module (backend + frontend)
- Phase 11: Feedback system (backend + frontend)
- Phase 12: GitHub integration — repo metadata + AI readiness report
- Phase 13: Notification system (backend + frontend)
- Phase 14: RBAC extension — viewer role
- Phase 15: Documentation & speak guide

## Database
- Engine: PostgreSQL
- Database name: `launchforge_db`
- Connection: `db/index.js` (pg Pool, credentials from `.env`)
- Migrations: plain SQL files in `db/migrations/` — run manually by the developer, never auto-executed by Claude Code
- **Never run migration SQL directly.** Write the file; the developer runs it.

## Environment Variables
Stored in `.env` (gitignored). Never hardcode credentials. Required vars:
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `REDIS_URL`, `PORT`

## Git Policy
**Claude Code does not touch git.** No `git add`, `git commit`, `git push`, `git merge`, or any command that modifies repository history. The developer handles all version control. When a phase is ready to commit, Claude Code's job is done — state that clearly and stop.

## Data & Schema Notes
When touching the database layer, briefly note how the change affects data flow, schema relationships, or query patterns — one line only. Skip when not relevant. This connects to the target roles (SQL Developer, BI Developer).
