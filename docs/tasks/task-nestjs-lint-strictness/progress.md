# task-nestjs-lint-strictness — Progress

**Status:** in_progress
**SIs:** 3/8 completed

### SI-1 — Infra: instalar `@golevelup/ts-jest`
- **Status:** completed
- **Tests:** no tests
- **Observations:** none

### SI-2 — Retipar test doubles do módulo auth (`createMock<T>()`)
- **Status:** completed
- **Tests:** 52 passing (27 unit + 25 integration)
- **Observations:**
  - `auth.service.spec.ts`'s pre-existing `jest.Mocked<T>`-typed vars also carried 19 `@typescript-eslint/unbound-method` errors (bare `expect(mockObj.method)` references) — a separate rule from KI-1's named `no-unsafe-*` list, but still counted in KI-1's per-file "45" tally (confirmed: KI-1's counts are raw per-file error totals, not filtered to the 5 named rules). `createMock<T>()`/`DeepMocked<T>` does NOT fix this (confirmed empirically — the intersection type still exposes the original bound-method signature). Fixed in-scope, no new dependency: rewrote all 19 `expect(x.method).toHaveBeenCalledWith(...)`/`.toHaveBeenCalled()` assertions to the equivalent `x.method.mock.calls` form, which doesn't trigger the rule (confirmed empirically against the file's own pre-existing `.mock.calls[0]` usage, which was never flagged).
  - `auth.service.integration-spec.ts` uses real repositories (no Jest mocks) — TD-01/`createMock` doesn't apply to it at all; its violations (2× private-field `as any` access, 2× `require-await`, 1 unused var, 1× `null` vs `IsNull()`) were a different, unrelated shape. Fixed all in-scope since they're in a file this SI already touches and the task's own Objective is "zero lint errors/warnings," not just zero `no-unsafe-*`. The `IsNull()` fix also corrects a latent bug: `revoked_at: null` in a TypeORM `where` clause is silently dropped (per `.claude/rules/typeorm-queries.md`), so that assertion was previously checking a broader match than intended.
  - First integration-spec run failed 4 tests in the "register (integration)" describe block on a `beforeAll` timeout (cold DB/module bootstrap, unrelated to this SI's edits — confirmed transient on immediate retry, all 25 pass).

### SI-3 — Retipar test double do módulo channels + corrigir guard de erro Postgres
- **Status:** completed
- **Tests:** 5 passing
- **Observations:**
  - `makeUniqueError()` in the spec previously faked a unique-violation by setting `.code`/`.detail` directly on a `QueryFailedError` (matching the OLD local `isPgUniqueViolationOnColumn` helper's shape). The canonical `isUniqueViolation` (from `postgres-error.ts`) checks `err.driverError instanceof DatabaseError` instead — so the fixture had to be rebuilt as a real `pg` `DatabaseError` wrapped as the `QueryFailedError`'s `driverError`, or the "retries on concurrent unique constraint violation" test would have silently stopped exercising the retry path (the error would no longer be recognized as a unique violation, so it would propagate immediately instead of retrying) without failing loudly, since nothing else asserts on the code path taken.
  - `.claude/rules/typeorm-queries.md` (auto-attached while editing this file) surfaces a pre-existing, out-of-scope bug: the retry loop inside `dataSource.transaction()` catches a unique violation and retries without a SAVEPOINT — the rule states a naive retry after a real Postgres constraint violation aborts the whole transaction ("current transaction is aborted, commands ignored..."). The mocked unit test can't catch this (it doesn't simulate real transaction semantics). Not fixed — out of this task's scope (lint/typing only); flagged for the user, not acted on.

### SI-4 — Retipar test double do módulo mail
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-5 — Retipar test doubles dos exception filters
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-6 — Retipar test double do módulo users
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-7 — Retipar leitura de response bodies em `auth.e2e-spec.ts`
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-8 — Normalização repo-wide de line endings (`.gitattributes` + Prettier)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
