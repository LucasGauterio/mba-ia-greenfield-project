# task-nestjs-lint-strictness — Progress

**Status:** completed
**SIs:** 8/8 completed

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
- **Status:** completed
- **Tests:** 5 passing
- **Observations:**
  - This file uses no Jest mocks at all (real `MailModule` + real Mailpit HTTP calls) — TD-01/`createMock` doesn't apply. All 16 violations traced to `src/test/mailpit.ts`'s `getMailpitMessages()`/`getMailpitMessage()` returning `Promise<any[]>`/`Promise<any>`, propagating `any` through every `.To`/`.Subject`/`.ID`/`.HTML`/`.From` access in the consuming spec. Fixed at the root: added `MailpitAddress`/`MailpitMessageSummary`/`MailpitMessageDetail` interfaces to `mailpit.ts` (outside this SI's originally-named file list, but the actual untyped boundary — same reasoning as SI-3's `postgres-error.ts` swap). Confirmed only 2 consumers repo-wide (this file + `auth.service.integration-spec.ts`, which only calls the untyped-return-unaffected `clearMailpitMessages()`) before touching the shared helper.

### SI-5 — Retipar test doubles dos exception filters
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - `mockHost`'s manual `ArgumentsHost` stub (`getArgs`/`getArgByIndex`/`switchToRpc: () => ({}) as any`/`switchToWs: () => ({}) as any`/`getType`) replaced with `createMock<ArgumentsHost>({ switchToHttp: () => ({...}) })` — matches `@golevelup/ts-jest`'s own documented `ExecutionContext` example almost verbatim; auto-fills every unused branch instead of hand-stubbing them.
  - Confirmed `expect.any(X)` specifically (not `expect.stringMatching`/`expect.objectContaining`) is the trigger for `no-unsafe-assignment` when nested inside an object-literal property value passed to `toHaveBeenCalledWith` — same finding as SI-2's `qbMock.set` fix. Fixed the 5 occurrences the same way: `expect.any(String) as unknown as string`.

### SI-6 — Retipar test double do módulo users
- **Status:** completed
- **Tests:** 7 passing
- **Observations:** KI-1's single counted violation for this file was `@typescript-eslint/no-unused-vars` (unused `TestingModule` import) — not `no-unsafe-*` and not TD-01-related at all. File uses real repositories/services throughout, no Jest mocks to retype.

### SI-7 — Retipar leitura de response bodies em `auth.e2e-spec.ts`
- **Status:** completed
- **Tests:** 45 passing (latest run)
- **Observations:**
  - Retyped per TD-04 exactly matching `test/videos.e2e-spec.ts`'s convention: 4 local interfaces (`ErrorBody`, `RegisterResponseBody`, `AuthTokensBody`, `MeResponseBody`), `expect((res.body as ErrorBody).error)` for single-field reads, hoisted `const body = res.body as X` for multi-field reads. Also fixed the same `mailServiceInstance` private-field-access and `async`-with-no-`await` patterns already fixed in SI-2's `auth.service.integration-spec.ts` (same two helper functions exist in both files). Clean on the first lint/tsc pass — no remaining violations after the rewrite.
  - **Flaky `beforeAll` investigated at SI-7 time, fixed during Final Verification:** first two test runs failed 43/45 with "Exceeded timeout of 5000 ms for a hook" on the first describe block's `beforeAll` (`Test.createTestingModule` compiling `AppModule`, unrelated to this SI's edits — the block is byte-identical to the original). Isolated via `git stash`: the pre-edit file passed cleanly once; a 3rd run of the post-edit file also passed cleanly. Conclusion at the time: environmental flakiness, out of SI-7's scope to fix. It recurred during Final Verification (see below) and was fixed there — see KI-3 in `docs/known-issues.md` (RESOLVED).

### SI-8 — Normalização repo-wide de line endings (`.gitattributes` + Prettier)
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - `git add --renormalize .` alone did NOT rewrite working-tree bytes: `core.autocrlf=true` round-trips CRLF→LF on add, so the staged/index content already matched HEAD's (LF) blobs and git reported nothing to normalize — but the actual on-disk files stayed CRLF. `git checkout-index --force --all` also silently no-op'd on already-present files. The actual fix required deleting all 143 tracked `.ts` files first, then `git checkout-index --force --all` to force a genuine re-smudge honoring the new `eol=lf` attribute. Verified via raw byte inspection (`od -c`), not just `git status`/`git diff`, since those compare normalized content and don't surface this class of drift.
  - Discovered mid-SI: unexpected commits (`si-3`, `si-6`, `si-7`, authored by the real configured git user, exactly matching this session's SI boundaries) already exist on this branch and are pushed to `origin/bugfix/nestjs-lint-strictness`. No commit/push hook is configured in `.claude/settings*.json` — concluded this is the user committing progress from another window (consistent with the IDE-file-open reminders seen earlier this session), not an automated or conflicting process. Not a blocker; noted for the record.
  - `npm run format:check` and `npx tsc --noEmit` both pass repo-wide after normalization. The 143 modified files are pure EOL changes (no content diff) and are left unstaged, per TD-03's note that this must land as its own isolated commit separate from any functional change.

## Final Verification

- **`npx tsc --noEmit`:** clean, exit 0.
- **`npm run lint:ci`:** clean, 0 errors / 0 warnings project-wide.
- **`npm run format:check`:** clean, 0 diffs project-wide.
- **`npm test -- --runInBand`** (unit + integration): 181/181 passing, 34/34 suites.
- **`npm run test:e2e`:** `swagger.e2e-spec.ts`, `videos.e2e-spec.ts`, `app.e2e-spec.ts` — all pass. `auth.e2e-spec.ts` failed its first 2 runs (43/45) on the pre-existing flaky `beforeAll` timeout (see KI-3) — fixed by raising both describe blocks' `beforeAll` timeout to 15000ms; final run: 45/45 passing.
- **`docs/known-issues.md`:** KI-1 and KI-2 moved to `## RESOLVED`. KI-3 (the flaky `beforeAll`, discovered during this verification) opened and resolved within the same session.
