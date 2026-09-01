# Known Issues Ledger

Tracked, time-boxed exceptions to Definition-of-Done gates (lint, `tsc`, tests,
environment health). This is the **only** sanctioned way to defer a
pre-existing problem when starting new work — see `CLAUDE.md` → "Environment
& Phase Health" and `.claude/rules/typescript-strict.md`.

Why this file exists instead of a config-level rule toggle: [docs/decisions/technical-decisions-workflow-hardening-guardrails.md](decisions/technical-decisions-workflow-hardening-guardrails.md) → TD-02.

**Never** silence a whole rule/category in `eslint.config.mjs` or `tsconfig.json`
to make this ledger unnecessary. Scope the exception to the exact files
listed below, link a follow-up, and remove the entry (moving it to
`## RESOLVED`) the moment it's fixed.

## OPEN

### KI-1 — Pre-existing `no-unsafe-*` lint errors in phase 01–02 test files

- **Origin phase:** phase-01-configuracao-base / phase-02-auth (pre-dates phase-03-videos)
- **Files/rule:** `test/auth.e2e-spec.ts` (48), `src/auth/auth.service.spec.ts` (45), `src/mail/mail.service.integration-spec.ts` (16), `src/channels/channels.service.spec.ts` (15), `src/auth/auth.service.integration-spec.ts` (7), `src/common/filters/domain-exception.filter.spec.ts` (7), `src/channels/channels.service.ts` (6), `src/common/filters/validation-exception.filter.spec.ts` (2), `src/users/users.service.integration-spec.ts` (1) / `@typescript-eslint/no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-call`, `no-unsafe-return`, `no-unsafe-argument` — **~147 errors across 9 files** (measured 2026-08-31, on branch `feature/phase-03-videos` before phase-03 work; `test/auth.e2e-spec.ts` uses `res.body.<field>` on `any` throughout — `@types/supertest` types `Response.body` as `any`).
- **Reason it wasn't fixed inline:** Pre-existing on `dev` (this fork does not contain the lint-strictness cleanup described in `PLAN.md` §11.6). Unrelated to phase-03 scope — almost entirely untyped Jest mock objects. Fixing them is a dedicated cross-cutting task (retype specs with `createMock` from `@golevelup/ts-jest`, typed Postgres-error guard in `channels.service.ts`), not phase-03 work.
- **Follow-up:** none yet — needs a dedicated `bugfix/nestjs-lint-strictness` task (per `PLAN.md` §11.6). Phase-03 keeps its own new/touched files lint-clean (two touched phase-02 files were fixed in passing: `src/config/env.validation.integration-spec.ts`, `src/test/create-test-data-source.ts`); `npm run lint:ci` will not reach zero until the follow-up task runs.
- **Opened:** 2026-08-31

### KI-2 — Pre-existing `npm run format:check` (Prettier) failures across phase 01–02 files

- **Origin phase:** phase-01-configuracao-base / phase-02-auth (pre-dates phase-03-videos)
- **Files/rule:** ~66 `.ts` files under `src/` + `test/` fail `prettier --check` on a Windows checkout (measured 2026-08-31 on `feature/phase-03-videos`). **Root cause: line endings, not indentation.** The repo has `core.autocrlf=true` and `.gitattributes` only pins `*.sh` to `eol=lf`, so every `.ts` file is checked out CRLF while Prettier's default `endOfLine: "lf"` flags all of them. A freshly `prettier --write`'n file passes until the next `git` round-trip re-CRLFs it.
- **Reason it wasn't fixed inline:** The real fix is a repo-wide `.gitattributes` change (`*.ts text eol=lf` + `git add --renormalize .`) — a cross-cutting infra change, not phase-03 scope, and mixing it into a feature commit violates `CLAUDE.md` → "Scope Limits".
- **Follow-up:** fold into the dedicated `bugfix/nestjs-lint-strictness` task alongside KI-1: add `* text=auto eol=lf` (or `*.ts eol=lf`) to `.gitattributes`, renormalize, and add `"endOfLine": "auto"` to `.prettierrc` so Windows checkouts stay green. Phase-03 keeps every new/touched file Prettier-clean on disk (`prettier --check` on each SI's touched set passes at hand-off); the project-wide gate stays red until the follow-up.
- **Opened:** 2026-08-31

<!--
### KI-N — <short title>
- **Origin phase:** phase-NN-{slug} | task-{slug}
- **Files/rule:** <glob or explicit file list> / <eslint rule id or tsc flag>
- **Reason it wasn't fixed inline:** <why — e.g. "pre-existing, unrelated to this phase's scope">
- **Follow-up:** <task/phase slug that will close it, or "none yet — needs one">
- **Opened:** <YYYY-MM-DD>
-->

## RESOLVED

_None yet._

<!--
### KI-N — <short title> — RESOLVED
- **Resolved by:** <commit sha or PR link>
- **Resolved on:** <YYYY-MM-DD>
-->
