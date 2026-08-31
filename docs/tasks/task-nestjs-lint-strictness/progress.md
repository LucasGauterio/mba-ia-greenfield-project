# task-nestjs-lint-strictness — Progress

**Status:** in_progress
**SIs:** 8/9 completed

### SI-1 — Instalar dev dependencies de lint e mocking
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - Installed `eslint-plugin-jest@^29.16.5` (library-refs.md estimated `^28`) and `@golevelup/ts-jest@^3.0.0` — both current, ESLint 9 flat-config compatible. `configs['flat/recommended']` export confirmed present in v29.
  - `npm install` reconciled a stale `package-lock.json`: diff is ~1071 insertions / 88 deletions ("added 52, removed 8, changed 83 packages") well beyond the 2 target deps. `npx tsc --noEmit` still exits 0 in-container afterward; recommend a close look at the SI-9 full-suite run.
  - Docker env was down at task start — brought up via `docker compose up -d` from `nestjs-project/` (db + nestjs-api + minio + mailpit + video-worker; dev server NOT started). Container Node is v25.6.0.
  - Windows: `docker compose exec` needs `MSYS_NO_PATHCONV=1` for `-w /home/node/app` (Git Bash path translation otherwise breaks the cwd).
  - `TaskCreate`/`TaskUpdate` tools unavailable in this environment — progress tracked in this file only.
  - Baseline divergence from plan (built at 504 problems / 16 files): current branch `bugfix/nestjs-lint-strictness` shows **355 / 15**. Worker specs (`video-processing.worker.spec.ts`, `abandoned-upload-cleanup.worker.spec.ts`) already clean; `src/common/exceptions/domain.exception.ts` newly flagged (1 error). SI file lists adapt to reality; TD structure unchanged.

### SI-2 — Reconfigurar ESLint: strictTypeChecked + bloco de testes com eslint-plugin-jest
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - `eslint.config.mjs` rewritten: `recommendedTypeChecked` → `strictTypeChecked`; 3 overrides removed; `eslint-plugin-jest` imported with test-file block (`extends: [jestPlugin.configs['flat/recommended']]`, `unbound-method` → `jest/unbound-method`). `--print-config` verified: `no-explicit-any`/`no-unsafe-argument`/`no-floating-promises`/`no-unnecessary-condition` all `error`; on specs `@typescript-eslint/unbound-method` `off` + `jest/unbound-method` `error`.
  - Lint count after the flip: **517 problems / 34 files** (was 355/15). Expected explosion from strictTypeChecked's project-wide rules.
  - **NEW rule friction not anticipated by the plan/TDs — needs a call before SI-4:**
    - `@typescript-eslint/no-extraneous-class` (7 errors) fired on every NestJS `@Module` class. **RESOLVED (user-approved):** added `['error', { allowWithDecorator: true }]` to `eslint.config.mjs` — framework-correct rule option, not a suppression. Dropped 7 → 1; the remaining 1 is a genuinely non-decorated utility class (fixed as code in its owning SI).
    - `@typescript-eslint/no-non-null-assertion` (63) — the `!` operator on expressions (`video.upload_id!`, `etag!`, etc.). These are real refactor targets (narrowing), folded into SI-4 for production code + SI-6/7/8 for specs.
    - `jest/expect-expect` (21 warnings) — specs asserting via helper functions / `.rejects.toThrow` patterns the rule doesn't recognize by default; will address per-file in SI-6/7/8 (configure `assertFunctionNames` or restructure).
    - `restrict-template-expressions` (10), `no-unnecessary-condition` (12), `no-confusing-void-expression` (2) — standard strict findings, addressed in the relevant SIs.

### SI-3 — Ativar `strict` no tsconfig + definite-assignment assertions nas entities
- **Status:** completed
- **Tests:** no tests (config + TS-syntax change; entity integration specs revalidated at SI-9)
- **Observations:**
  - `tsconfig.json`: `"strict": true` added; `"noImplicitAny": false`, `"strictBindCallApply": false`, and now-redundant `"strictNullChecks": true` removed.
  - `!` (definite-assignment assertion) added to all 46 field declarations across the 5 entity files (`video`, `channel`, `user`, `refresh-token`, `verification-token`) via regex — decorator-internal lines (`type: 'enum'` etc.) untouched.
  - `strict` (`strictPropertyInitialization`) also flagged 10 `class-validator` DTO files + `api-error-envelope.dto.ts` (19× TS2564). Same `!` fix applied — production scope, covered by SI-3 action 4's catch-all. `title?:` / `code?:` optional fields correctly left alone.
  - **5 remaining tsc errors deferred to their owning SIs** — all TS2345 from `mockImplementationOnce((_e: string, _n: string, t: string) => …)` on `sendConfirmationEmail`, now contravariant under `strictFunctionTypes`: `test/auth.e2e-spec.ts` ×2 + `test/videos.e2e-spec.ts` ×1 → **SI-5**; `src/auth/auth.service.integration-spec.ts` ×2 → **SI-7**. Production `tsc --noEmit` is clean; full-tree green after SI-5 + SI-7.
  - `nestjs-project/CLAUDE.md` § Code Conventions + ESLint bullets rewritten (strict on, strict-type-checked, `!` on entities/DTOs, `no-extraneous-class` option, jest test-file block).
  - Out-of-scope follow-ups: (a) `.claude/rules/nestjs-dtos.md` code snippets show `email: string;` without `!` — will no longer compile as-written; cosmetic rule-doc drift. (b) `tsconfig.json` `baseUrl: "./"` is deprecated in TS 6+ (IDE flags it; container's tsc does not error) — pre-existing, unrelated to this task.

### SI-4 — Type guard de erro do Postgres + eliminação de `any` no código de produção
- **Status:** completed
- **Tests:** 25 passing (postgres-error.spec 10, channels.service.spec 5, videos.service.spec 10 — last two behavior-preserved after the guard swap)
- **Observations:**
  - Created `src/common/database/postgres-error.ts` — `isPostgresError(e: unknown)` + `isUniqueViolation(e: unknown, column?)` via structural `unknown` narrowing (TD-03 Option A), checks both the `QueryFailedError` wrapper and `.driverError`. Verified against TypeORM 0.3.28's `ObjectUtils.assign` behavior. + `postgres-error.spec.ts` (10 unit tests).
  - `channels.service.ts` + `videos.service.ts`: local `err as any` helpers deleted, both now call the shared `isUniqueViolation(err, COLUMN)`.
  - `videos.service.ts`: `video.upload_id!` → explicit `if (video.upload_id === null) throw new Error(...)` invariant guard before the S3 call.
  - `auth.config.ts`: `process.env.JWT_SECRET!` / `JWT_REFRESH_SECRET!` → local `required(name)` helper (throws on missing; Joi already validates at boot).
  - `jwt-auth.guard.ts`: `headers` typed `Record<string, string | undefined>`, unnecessary `?.` removed.
  - `domain.exception.ts`: prettier reflow (1 error).
  - **Scope decision:** SI-4 action 4 ("src/**/*.ts non-spec") scoped to `src/` production code **excluding `src/test/` helpers**. `src/test/mailpit.ts` (4 errors) + `src/test/create-test-data-source.ts` (3) moved to SI-8 (test-infra category) — avoids two SIs editing the same files.
  - Lint total after SI-4: **492 (471 errors, 21 warnings)** — remaining errors are ~all in spec files (SI-5/6/7/8). Production `src/` (non-spec, non-`src/test/`) is lint-clean and `tsc`-clean.

### SI-5 — test/contracts + tipagem de response body nos e2e
- **Status:** completed
- **Tests:** e2e suite 62/62 passing on a warm run (behavior preserved)
- **Observations:**
  - Created `test/contracts/index.ts` — response interfaces (`AuthTokens`, `RegisterResponse`, `MeResponse`, `ErrorEnvelope`) + `import type` re-export of `InitiateUploadResult`/`CompleteUploadResult` from `videos.service.ts`. **Design change vs plan:** the planned generic `expectBody<T>(res): T` helper trips strictTypeChecked's `no-unnecessary-type-parameters` (type param used once — the rule's docs explicitly discourage generic cast helpers). Replaced with the direct idiom `(res.body as SomeType)` at each assertion site — lint-clean (nothing in strictTypeChecked flags casting an `any` expression) and equally readable. `contracts/index.ts` is now types-only.
  - `auth.e2e-spec.ts` + `videos.e2e-spec.ts`: `(authService as any).mailService` → `app.get(MailService)` (Nest singleton); `mockImplementationOnce(async (_e,_n,t) => {...})` → `(_email,_name,token) => { captured = token; return Promise.resolve(); }` (fixes the SI-3-deferred TS2345 + `require-await`); all `res.body.X` typed; `revokedRecord!.family` → explicit null-guard throw.
  - `swagger.e2e-spec.ts`: removed one unnecessary `?.`. `app.e2e-spec.ts`: no code change (covered by config).
  - **Config (flagged, like `no-extraneous-class`):** added `jest/expect-expect: ['error', { assertFunctionNames: ['expect', 'request.**.expect'] }]` to the test-file block — teaches the rule that supertest's `.expect()` is an assertion, so HTTP-status-only e2e tests aren't flagged. Standard supertest recipe, not a suppression. Cleared 21 warnings.
  - **SI-3 deferral closed:** the 3 TS2345 in `test/auth.e2e-spec.ts` / `test/videos.e2e-spec.ts` are fixed. Remaining tsc: 2 in `src/auth/auth.service.integration-spec.ts` → SI-7.
  - Lint total after SI-5: **398 (398 errors, 0 warnings)** — all remaining errors are in unit/integration spec files (SI-6/7/8).
  - Out-of-scope: `auth.e2e-spec.ts` `beforeAll` uses the default 5000ms hook timeout and cold-starts the whole app (pg-boss + DB) as the first `--runInBand` suite → flaked once on a cold run, passed on retry. A `beforeAll(async () => {...}, 30000)` would fix it; separate test-robustness task.

### SI-6 — Retipar specs de vídeo e workers com createMock
- **Status:** completed
- **Tests:** videos.service.spec.ts 10/10 passing (behavior preserved through the createMock swap)
- **Observations:**
  - **Plan scope reduced:** `src/worker/` does not exist on this branch — `video-processing.worker.spec.ts` and `abandoned-upload-cleanup.worker.spec.ts` are not in this phase-3 merge. SI-6 = just `videos.service.spec.ts` (167 lint errors, the single biggest file).
  - Rewrote with `createMock<Repository<Video>>()` / `createMock<ChannelsService>()` / `createMock<StorageService>()` / `createMock<PgBoss>()`. All `X as ChannelsService` casts and `channelsService.findByUserId!` non-null assertions gone. `makeUniqueSlugError` now `Object.assign(new QueryFailedError(...), { code, detail })` — typed, no `as any`.
  - `makeVideoRepository` sets `repo.create.mockImplementation((e) => e as Video)` to keep the echo behavior createMock's auto-proxy would otherwise break; `save` mocks return `Promise.resolve(...)` (strict overload wants the Promise).
  - Replaced `expect.objectContaining({ storage_key: expect.stringMatching(...) })` with explicit per-field `expect(createArg.storage_key).toMatch(...)` — `expect.stringMatching()` returns `any` and trips `no-unsafe-assignment`; the explicit form is fully typed.
  - **`restrict-template-expressions` (strictTypeChecked sets `allowNumber: false`):** `` `part-${partNumber}` `` (a `number`) is flagged. Fixed here with `String(partNumber)`. This rule will recur in SI-7/8 and possibly `src/test/`; **flagged for a config decision at the SI-6 pause** — `['error', { allowNumber: true }]` (the recommended-type-checked default) vs. `String()`-wrapping every site.
  - Lint total after SI-6: **231 (231 errors, 0 warnings)** — remaining in auth/channels/mail/filters/config/users specs (SI-7/8).

### SI-7 — Retipar specs de auth, channels e mail com createMock
- **Status:** completed
- **Tests:** 32/32 unit (auth.service.spec + channels.service.spec), 5/5 mail integration, 25/25 auth integration — all behavior-preserved
- **Observations:**
  - `channels.service.spec.ts`: `createMock<DataSource>()` + `createMock<EntityManager>()`; `transaction` mock via `mockImplementation((cb) => cb(manager))`. Dropped the `manager.create` mocks entirely (createMock's default proxy is passed to the mocked `save`, whose return is what the tests assert) — sidesteps the `EntityManager.create` array-overload typing.
  - `auth.service.spec.ts`: dropped `Test.createTestingModule` for direct `new AuthService(...)` with `createMock<T>()` deps + one shared real `new JwtService({...})` (configured-lib, per testing guide). Typed `makeUser` / `makeVerificationToken` / `makeRefreshToken` factories replace `{...} as any` fixtures. Hand-rolled typed `makeQueryBuilder()` + `asQueryBuilder<T>()` (`as unknown as SelectQueryBuilder<T>` at the one boundary) for the fluent `.update().set().where()` chains — createMock doesn't return `this` for cross-type chain steps. `expect.any(Date)` (returns `any`) cast `as unknown` at the one call site.
  - `auth.service.integration-spec.ts`: `findOneBy(...)` → `findOneByOrFail(...)` (11 sites) removes the `!` on must-exist rows; `assertFound<T>()` TS assertion helper for the `.find()` / `.getOne()` cases; `(authService as any).mailService` → `mailServiceOf()` typed helper (`as unknown as { mailService: MailService }`).
  - **Latent bug fixed:** `refreshTokenRepository.findBy({ family, revoked_at: null } as any)` — TypeORM silently drops `field: null` from the `where` (per `.claude/rules/typeorm-queries.md`). Changed to `revoked_at: IsNull()`. The `as any` was masking it. Assertion (`length > 0`) still holds.
  - `mailpit.ts` (moved here from SI-8 — its only consumers are these two SI-7 files): typed `MailpitMessageSummary` / `MailpitMessage` interfaces, removed `any[]` returns and the now-unnecessary `?? []`.
  - **`tsc --noEmit` is now fully clean** — the last 2 SI-3-deferred errors closed.
  - Lint total after SI-7: **41 (41 errors, 0 warnings)** — all in `common/filters/*.spec`, `config/env.validation.integration-spec`, `users.service.integration-spec`, `create-test-data-source.ts`, `domain-exception.filter.spec` (SI-8).
  - Recurring flake (3rd occurrence — also auth.e2e, videos.e2e): `beforeAll` with default 5000ms hook timeout cold-starting the full Nest module + DB. Passes on isolated/warm re-run. One consolidated follow-up: raise hook timeouts + guard `afterAll` teardown against undefined `dataSource`.

### SI-8 — Retipar specs de filters, config, users e helper de test data
- **Status:** completed
- **Tests:** 13/13 unit (2 filter specs + jwt-auth.guard.spec) + 31/31 integration (env-validation, users, channels, videos, openapi-export) — all behavior-preserved
- **Observations:**
  - **Plan scope expanded:** the plan listed 5 files; the current branch had **9** with lint errors. Also fixed `videos.service.integration-spec.ts` (8), `openapi-export.integration-spec.ts` (7), `jwt-auth.guard.spec.ts` (3), `channels.service.integration-spec.ts` (1) — SI-8 is the mop-up SI, so all 9 done.
  - Filter specs: removed `as any` from `switchToRpc`/`switchToWs` stubs (the outer `as unknown as ArgumentsHost` already covers the shape); `expect.any(String)` (returns `any`) → `(expect.any(String) as unknown)`.
  - `videos.service.integration-spec.ts` + `channels.service.integration-spec.ts`: `findOneBy(...)!` → `findOneByOrFail(...)`; added `etagFrom(response)` helper for the 2 `headers.get('etag')!` sites.
  - `users.service.integration-spec.ts`: `result!.x` → `result?.x` (service method returns `User | null`); dropped unused `TestingModule` import.
  - `openapi-export.integration-spec.ts`: the `?.` / `if (!x)` guards on `as Record<string, X>` casts were `no-unnecessary-condition` (Record index is not `| undefined` without `noUncheckedIndexedAccess`). Added `| undefined` to the cast value types so the guards are meaningful.
  - `jwt-auth.guard.spec.ts`: `const STUB_CLASS = class {}` (`no-extraneous-class`) → `@Controller() class StubController {}` (exempted by the `allowWithDecorator` option, and a more realistic stub); dropped unnecessary `?.` after `(request.user as Record<string, unknown>)`.
  - `env.validation.integration-spec.ts`: Joi's `ValidationResult<T>` types `value` as `any` on the error branch of its union — narrowed via `result.value as { SWAGGER_ENABLED: string }` (avoiding `jest/no-conditional-expect` that an `if`-narrow would trip).
  - `create-test-data-source.ts`: `entities: (Function | string | EntitySchema<any>)[]` → `entities: NonNullable<DataSourceOptions['entities']>` (bare `Function` + `<any>` gone).
  - **`npm run lint` = 0 problems. `tsc --noEmit` = 0 errors.** Whole codebase clean under strictTypeChecked + strict, zero suppressions.

### SI-9 — Finalização: script lint:ci, hook de pre-push e verificação completa
- **Status:** pending
- **Tests:** —
- **Observations:** none
