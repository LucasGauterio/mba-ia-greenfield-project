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

_None._

<!--
### KI-N — <short title>
- **Origin phase:** phase-NN-{slug} | task-{slug}
- **Files/rule:** <glob or explicit file list> / <eslint rule id or tsc flag>
- **Reason it wasn't fixed inline:** <why — e.g. "pre-existing, unrelated to this phase's scope">
- **Follow-up:** <task/phase slug that will close it, or "none yet — needs one">
- **Opened:** <YYYY-MM-DD>
-->

## RESOLVED

### KI-3 — Flaky `beforeAll` hook timeout in `test/auth.e2e-spec.ts` — RESOLVED

- **Resolved by:** task-nestjs-lint-strictness (final verification fix-loop) — both `beforeAll` hooks in `test/auth.e2e-spec.ts` (the `Auth (e2e)` and `Rate Limiting (e2e)` describe blocks, both compiling the full `AppModule` via `Test.createTestingModule`) were given an explicit 15000ms timeout (`}, 15000);`), up from Jest's default 5000ms. Root cause confirmed via `git stash` comparison to be environmental (module-bootstrap timing racing a fixed timeout under load), not caused by this task's typing changes — observed failing on 4 of 6 runs before the fix, passing cleanly (45/45) on the run immediately after.
- **Resolved on:** 2026-09-01

### KI-1 — Pre-existing `no-unsafe-*` lint errors in phase 01–02 test files — RESOLVED

- **Resolved by:** task-nestjs-lint-strictness (SI-1 through SI-7) — retyped Jest mocks with `createMock<T>()` from `@golevelup/ts-jest` (`auth.service.spec.ts`, `channels.service.spec.ts`, `mail.service.integration-spec.ts`'s helper typing, both exception filter specs); typed the `postgres-error.ts` guard into `channels.service.ts`; matched `test/videos.e2e-spec.ts`'s local-interface + direct-cast convention in `test/auth.e2e-spec.ts`. `npm run lint:ci` is zero errors/warnings project-wide as of this resolution — including several non-`no-unsafe-*` errors (`unbound-method`, `require-await`, `no-unused-vars`) discovered in the same files, since KI-1's per-file counts turned out to be raw totals, not filtered to the 5 named rules.
- **Resolved on:** 2026-09-01

### KI-2 — Pre-existing `npm run format:check` (Prettier) failures across phase 01–02 files — RESOLVED

- **Resolved by:** task-nestjs-lint-strictness (SI-8) — added `*.ts text eol=lf` to `.gitattributes`, force-renormalized all 143 tracked `.ts` files repo-wide (required deleting + re-checking-out each file; `git add --renormalize .` and `git checkout-index --force --all` alone were insufficient — `core.autocrlf`'s CRLF↔LF round-trip made git report no diff even though on-disk bytes stayed CRLF), and added `"endOfLine": "auto"` to `nestjs-project/.prettierrc`. `npm run format:check` is zero-diff project-wide as of this resolution.
- **Resolved on:** 2026-09-01

<!--
### KI-N — <short title> — RESOLVED
- **Resolved by:** <commit sha or PR link>
- **Resolved on:** <YYYY-MM-DD>
-->
