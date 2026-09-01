---
kind: task
name: task-nestjs-lint-strictness
sources_mtime:
  docs/decisions/technical-decisions-nestjs-lint-strictness.md: "2026-09-01T14:05:27-03:00"
  docs/decisions/technical-decisions-workflow-hardening-guardrails.md: "2026-08-31T21:46:55-03:00"
  docs/phases/phase-03-videos/context.md: "2026-08-31T21:46:55-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-19T18:32:39-03:00"
---

# task-nestjs-lint-strictness — Context

## Scope

> Close KI-1 (no-unsafe-* lint violations in phase 01-02 test files) and KI-2 (Prettier CRLF failures) from docs/known-issues.md so the backend is fully and correctly typed with zero lint errors/warnings on the affected files

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| nestjs-lint-strictness/TD-01 | task | Backend | Type-safe test-double strategy for NestJS unit/integration specs | decided | `@golevelup/ts-jest` `createMock<T>()` | — |
| nestjs-lint-strictness/TD-02 | task | Backend | Typing strategy for supertest e2e response bodies | superseded-by nestjs-lint-strictness/TD-04 | Reusable `typedBody<T>()` helper in `src/test/` | — |
| nestjs-lint-strictness/TD-03 | task | Repo-wide | Repo-wide line-ending normalization strategy | decided | `.gitattributes` `eol=lf` + renormalize + `.prettierrc` `endOfLine: auto` | — |
| nestjs-lint-strictness/TD-04 | task | Backend | Typing strategy for supertest e2e response bodies (revised) | decided | Match `test/videos.e2e-spec.ts`'s local-interface + direct-cast convention: declare a local `interface` per response shape in each `*.e2e-spec.ts` file, cast directly at each call site (`res.body as ShapeInterface`), no `src/test/` helper | — |

_Source files:_

- nestjs-lint-strictness — `docs/decisions/technical-decisions-nestjs-lint-strictness.md` (scope_type: ad-hoc)

## Decisions Detail

### nestjs-lint-strictness/TD-01

**Recommendation:** `@golevelup/ts-jest` is purpose-built for the DI `useValue` partial-mock pattern this project already standardizes on (`mock-health-rules.md`), giving full type safety without abandoning that convention or forcing every mock to enumerate an entire interface's surface.
**Libraries:** —

### nestjs-lint-strictness/TD-03

**Recommendation:** `.gitattributes` is the mechanism that actually controls checkout line endings (the documented root cause), while Option B only relaxes the symptom-level check and leaves the repo's real line endings inconsistent across contributors and the not-yet-initialized frontend subproject.
**Libraries:** —

### nestjs-lint-strictness/TD-04

**Recommendation:** matching the already-established, already-lint-clean `test/videos.e2e-spec.ts` convention avoids introducing a second competing pattern for the same problem — one convention for the whole e2e suite beats TD-02's shared helper, which would have made the codebase's newest test files diverge from its most recent precedent.
**Libraries:** —

## Inherited Decisions Detail

### workflow-hardening-guardrails/TD-01

**Recommendation:** matches the pipeline's existing read-budget discipline and keeps the check something people actually run every time instead of disabling.
**Libraries:** —

### workflow-hardening-guardrails/TD-02

**Recommendation:** consistent with the project's existing all-state-lives-in-docs/ convention and directly readable by both the health check and the planning pipeline's inheritance mechanism.
**Libraries:** —

### workflow-hardening-guardrails/TD-03

**Recommendation:** directly targets the observed failure mode (pre-app-start setup verification) using tooling already present, with Option B noted as complementary future work, not a substitute.
**Libraries:** —

### workflow-hardening-guardrails/TD-04

**Recommendation:** the entire point is proving the real running system works, which by definition means bypassing the test-module bootstrap layer, not adding another suite inside it.
**Libraries:** —

### workflow-hardening-guardrails/TD-05

**Recommendation:** with Option B noted as a legitimate complementary hardening step outside this document's scope (would need to be a separate task since it touches GitHub repo settings, not this repo's files).
**Libraries:** —

### workflow-hardening-guardrails/TD-06

**Recommendation:** the agent already has the exact information needed (which files this SI touched, that its tests and lint are clean) at the moment it would otherwise just be pausing; committing then is strictly less work than building an external enforcement mechanism.
**Libraries:** —

## Inherited Conventions

- Test suffix conventions: `*.spec.ts` (unit, all mocked, no DB/IO), `*.integration-spec.ts` (real DB/services, colocated beside source), `*.e2e-spec.ts` (HTTP via supertest, in `test/`). Integration + e2e suites run `--runInBand` (shared test DB + shared pg-boss instance). _(from phase 03)_
- Don't mock what real infra can exercise: service-to-external-system contracts (storage uploads, queue publishing) are tested against **real** Compose infra (MinIO/pg-boss/DB), not mocks. _(from phase 03)_
- E2E teardown: reproduce `main.ts` global config (ValidationPipe, exception filter, global guards); always `afterAll(() => app.close())` + full `TestingModule` teardown to avoid leaking pg-boss handles. Cleanup via `dataSource.query('DELETE FROM ...')` / `repository.clear()` — never `repository.delete({})`. _(from phase 03)_
- Fix pre-existing `no-unsafe-*` lint errors by narrowing types at the source rather than casting at each call site — e.g. SI-03.2 fixed 2 errors on `value.SWAGGER_ENABLED` by narrowing the `validate` helper's return type (Joi's `ValidationResult.value` is `any` regardless of schema generic). _(from phase 03)_
- A typed Postgres-error guard helper is expected at `src/common/database/postgres-error.ts` (`isUniqueViolation`) — `.claude/rules/typescript-strict.md` already references this as the canonical helper, but as of phase-03 it existed only for the new `videos` code path and was **not yet wired into** `channels.service.ts` (a KI-1 file). _(from phase 03)_
- `test/auth.e2e-spec.ts` and other KI-1 files rely on `res.body.<field>` typed `any` because `@types/supertest`'s `Response.body` is `any` — this is the concrete supertest-typing problem KI-1 flags for a future fix. _(from phase 03)_
- New e2e specs are already written lint-clean using **typed body casts** on supertest responses — a local `interface` per response shape + direct `res.body as InterfaceName` cast at each call site, no shared helper — see `test/videos.e2e-spec.ts` as the established pattern. _(from phase 03; this is the convention `nestjs-lint-strictness/TD-04` now matches)_
- Entity integration specs generally default to `synchronize: true` (4 pre-existing phase-01/02 specs); `video.entity.integration-spec.ts` deliberately diverges to `synchronize: false` per `.claude/rules/typeorm-migrations.md` (schema must come from migrations) — not retrofitted onto the older specs (noted as out of scope in phase 03). _(from phase 03)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Inherited Known Issues

| Files/rule | Origin phase | Reason not fixed inline | Follow-up |
|-----------|--------------|--------------------------|-----------|
| `test/auth.e2e-spec.ts` (48), `src/auth/auth.service.spec.ts` (45), `src/mail/mail.service.integration-spec.ts` (16), `src/channels/channels.service.spec.ts` (15), `src/auth/auth.service.integration-spec.ts` (7), `src/common/filters/domain-exception.filter.spec.ts` (7), `src/channels/channels.service.ts` (6), `src/common/filters/validation-exception.filter.spec.ts` (2), `src/users/users.service.integration-spec.ts` (1) — `@typescript-eslint/no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-call`, `no-unsafe-return`, `no-unsafe-argument` (~147 errors across 9 files; `test/auth.e2e-spec.ts` uses `res.body.<field>` on `any` throughout since `@types/supertest` types `Response.body` as `any`) | phase-01-configuracao-base / phase-02-auth | Pre-existing on `dev` (this fork lacks the lint-strictness cleanup from `PLAN.md` §11.6); unrelated to phase-03 scope, almost entirely untyped Jest mock objects | This task (`nestjs-lint-strictness`) |
| ~66 `.ts` files under `src/` + `test/` failing `prettier --check` on a Windows checkout — root cause is line endings (CRLF checkout vs. Prettier's default `endOfLine: "lf"`), not indentation; `.gitattributes` only pins `*.sh` to `eol=lf` | phase-01-configuracao-base / phase-02-auth | Real fix is a repo-wide `.gitattributes` change (`*.ts eol=lf` + `git add --renormalize .`) — cross-cutting infra change, not phase-03 scope | This task (`nestjs-lint-strictness`) |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_This task retypes existing test files — it does not create new production artifact types (no new entity/service/controller/etc.), so `testing-guide-nestjs-project`'s §3 Feature Implementation Checklist (which maps new artifacts to required test layers) does not directly apply. The applicable guidance instead comes from the guide's existing conventions, which this task must preserve while retyping:_

| Concern | Requirement | Guide |
|---|---|---|
| Retyped `*.spec.ts` / `*.integration-spec.ts` mocks | Behavior/assertions must stay identical — only the mock's type construction changes (`useValue: {...}` → `createMock<T>({...})`); no test logic rewrite | `references/mock-health-rules.md` |
| Retyped `test/auth.e2e-spec.ts` response reads (TD-04) | Match `test/videos.e2e-spec.ts` exactly: declare a local `interface` per response shape in the spec file, cast directly at each call site (`res.body as ShapeInterface`) — no shared `src/test/` helper | `references/gotchas.md` (#10), `test/videos.e2e-spec.ts`, Inherited Conventions above |
| `src/channels/channels.service.ts` (6 KI-1 errors, no TD — apply directly) | Use the existing `err instanceof`-narrowed guard pattern from `src/common/database/postgres-error.ts`, not a new approach | `.claude/rules/typescript-strict.md` → "Typing External/Driver Boundaries" |
| Full suite health | `npm run lint:ci`, `npm run format:check`, `npx tsc --noEmit`, and the full test suite (`--runInBand` for integration/e2e) must all pass clean after the retype | `CLAUDE.md` → "Definition of Done" |
