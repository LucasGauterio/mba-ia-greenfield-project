# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (TBD) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Environment & Phase Health

Before planning or implementing a new phase, verify the repository's actual state — not just its planning docs:

- **Environment:** `nestjs-project/scripts/env-check.sh` (or `npm run env:check`) — one command, host-only, checks Docker services, `.env` completeness, and DB readiness. Run it whenever something feels off, and before starting a fresh session's work.
- **Code health:** a quick `npm run lint:ci` pass is part of `implement-phase`'s Preflight (see `plan-pipeline/SKILL.md` → "Repository Health Check") — lightweight and advisory, not a full CI rebuild.
- **Pre-existing debt:** if a check turns up something not caused by the work at hand, it does not silently block you and it does not get silently absorbed into a permanently lenient config either (that's exactly the pattern — `no-explicit-any: 'off'` project-wide — that let phase-03-videos ship 504 untracked lint problems). Track it instead: add a scoped entry to `docs/known-issues.md` naming the exact files/rule and a follow-up, then proceed. See `.claude/rules/typescript-strict.md` for how a rule exception should be scoped.
- **Local, one-command runtime verification:** `nestjs-project/scripts/smoke-test.sh` (or `npm run smoke`) exercises the real running app (register → confirm → login → authenticated call, extendable per phase) — proves a feature works end-to-end, not just under test mocks. Run it after implementing anything with a runtime-observable surface.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint and Prettier are clean for every file you touched: `npm run lint:ci` and `npm run format:check` — checked after each SI/feature as you go, not deferred to one pass at the very end.
5. When the change has a runtime-observable surface, `npm run smoke` (or the subproject's equivalent) passes against the real running app.

If any of these fails, the task is not done — fix the underlying issue before declaring completion. A pre-existing failure unrelated to your change is the one exception: record it in `docs/known-issues.md` (see "Environment & Phase Health" above) instead of either fixing it out-of-scope or silently ignoring it.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change. Commit after each SI/feature once its tests and lint pass — do not batch multiple SIs into one commit, and do not let tested work sit uncommitted across a session boundary.
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`
- **Before branching:** `dev` must be up to date with `main` (fetch and compare — `dev` should always contain everything `main` has). Every `feature/*`/`bugfix/*`/`hotfix/*` branch is created from `dev`'s current tip — never from another feature/bugfix branch, and never from `main` directly.
- **`main` only ever receives a merge from `dev`**, and only once `dev` is stable — never a direct PR from a feature/bugfix branch into `main`. (This is the rule whose violation once required resetting `main` back to its fork point.)

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.
