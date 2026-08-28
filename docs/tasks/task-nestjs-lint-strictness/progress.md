# task-nestjs-lint-strictness — Progress

**Status:** in_progress
**SIs:** 4/9 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-6 — Retipar specs de vídeo e workers com createMock
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-7 — Retipar specs de auth, channels e mail com createMock
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-8 — Retipar specs de filters, config, users e helper de test data
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-9 — Finalização: script lint:ci, hook de pre-push e verificação completa
- **Status:** pending
- **Tests:** —
- **Observations:** none
