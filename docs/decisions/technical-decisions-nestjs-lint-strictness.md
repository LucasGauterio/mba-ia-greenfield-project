---
scope_type: ad-hoc
related_phases: []
status: decided
date: 2026-08-28
scope_description: "Remove blanket ESLint/tsconfig suppressions in nestjs-project and refactor every file with type-safety lint issues, without config shortcuts"
---

# Technical Decisions — nestjs-project Lint Strictness & `any` Elimination

_Subprojects in scope:_

- `nestjs-project/` — backend API + its test suites. All runtime code and every `*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts` file. Source of all lint findings.
- Repo-wide tooling — `nestjs-project/eslint.config.mjs`, `nestjs-project/tsconfig.json`, the `lint` npm script, and the (missing) CI lint gate. No other subproject is touched; `next-frontend/` has its own already-decided config baseline (`technical-decisions-next-frontend-config-base.md`).

---

## Current state (measured 2026-08-28, host run, `tsc --noEmit` green)

`npm run lint` **currently fails**: `504 problems (400 errors, 104 warnings)` across **16 files**. The suppression is entirely **config-level** — there are zero `// eslint-disable` / `@ts-ignore` comments in the codebase.

**Active suppressions today:**

| Location | Suppression | Effect |
|---|---|---|
| `eslint.config.mjs` | `@typescript-eslint/no-explicit-any: 'off'` | explicit `any` annotations/casts never flagged |
| `eslint.config.mjs` | `@typescript-eslint/no-floating-promises: 'warn'` | downgraded from error |
| `eslint.config.mjs` | `@typescript-eslint/no-unsafe-argument: 'warn'` | downgraded from error (104 of the warnings) |
| `tsconfig.json` | `noImplicitAny: false` | implicit `any` compiles silently |
| `tsconfig.json` | `strictBindCallApply: false` | loosens `.bind/.call/.apply` typing |
| `tsconfig.json` | `strict` unset (only `strictNullChecks: true`) | `useUnknownInCatchVariables`, `strictFunctionTypes`, `noImplicitThis` all off |

**Findings by rule (from `recommendedTypeChecked`, still firing despite the overrides):**

| Rule | Errors | Warnings | Root cause |
|---|---:|---:|---|
| `@typescript-eslint/no-unsafe-member-access` | 200 | 0 | property access on `any` (mostly `res.body.*` in e2e, `any` mock factories) |
| `@typescript-eslint/no-unsafe-argument` | 0 | 104 | passing `any` mocks into typed constructor params |
| `@typescript-eslint/no-unsafe-assignment` | 102 | 0 | `const x = <any>` from mocks / `res.body` |
| `@typescript-eslint/no-unsafe-call` | 54 | 0 | calling `any`-typed jest mocks |
| `@typescript-eslint/unbound-method` | 22 | 0 | `expect(repo.save)` / method refs in specs |
| `@typescript-eslint/no-unsafe-return` | 14 | 0 | helper returning `res.body` |
| `@typescript-eslint/require-await` | 5 | 0 | `async () => {}` mock impls with no `await` |
| `@typescript-eslint/no-unused-vars` | 2 | 0 | dead bindings |
| `@typescript-eslint/no-unsafe-function-type` | 1 | 0 | bare `Function` type |

**Findings by file (16):**

| File | Err | Warn |
|---|---:|---:|
| `src/videos/videos.service.spec.ts` | 165 | 40 |
| `src/auth/auth.service.spec.ts` | 45 | 32 |
| `test/auth.e2e-spec.ts` | 48 | 0 |
| `src/worker/video-processing.worker.spec.ts` | 30 | 16 |
| `src/worker/abandoned-upload-cleanup.worker.spec.ts` | 24 | 8 |
| `test/videos.e2e-spec.ts` | 25 | 0 |
| `src/channels/channels.service.spec.ts` | 15 | 5 |
| `src/mail/mail.service.integration-spec.ts` | 16 | 2 |
| `src/auth/auth.service.integration-spec.ts` | 7 | 1 |
| `src/common/filters/domain-exception.filter.spec.ts` | 7 | 0 |
| `src/channels/channels.service.ts` | 6 | 0 |
| `src/videos/videos.service.ts` | 6 | 0 |
| `src/common/filters/validation-exception.filter.spec.ts` | 2 | 0 |
| `src/config/env.validation.integration-spec.ts` | 2 | 0 |
| `src/test/create-test-data-source.ts` | 1 | 0 |
| `src/users/users.service.integration-spec.ts` | 1 | 0 |

**Key observation:** only **12 errors live in production code** (`channels.service.ts` + `videos.service.ts`), both the identical `const e = err as any` idiom for reading PostgreSQL driver error fields. The other **492 problems are in test files**, driven by four repeated anti-patterns: (1) `function makeX(): any` mock factories, (2) `new QueryFailedError(...) as any` then mutate, (3) `res.body.*` on supertest's `any`-typed body, (4) `(service as any).privateMember` to reach internals.

> Numbers were produced by a host `eslint` run; re-run inside the `nestjs-api` container (`docker compose exec nestjs-api npx eslint ...`) to confirm before execution — `tsc --noEmit` parity (exit 0 in both) makes host counts trustworthy as a planning baseline.

---

## TD-01: Target ESLint rule set — what "no shortcuts" resolves to

**Scope:** Repo-wide

**Trigger:** The user wants the ignored type-safety rules solved "the right way not by ignoring by configuration", with `no-explicit-any` "followed rigorously". This TD fixes what the target config is.

**Context:** `eslint.config.mjs` extends `tseslint.configs.recommendedTypeChecked` then overrides three rules down. Removing the overrides is necessary but the question is whether to stop at `recommendedTypeChecked` defaults or go further to `strictTypeChecked`, which pulls in ~25 additional type-aware rules (`no-unnecessary-condition`, `no-non-null-assertion`, `prefer-nullish-coalescing`, `no-unnecessary-type-assertion`, …). Context7 (`/typescript-eslint/typescript-eslint`) confirms `strictTypeChecked` sets `no-explicit-any`, `no-unsafe-function-type`, `no-unused-vars` to `error` and is "not stable under SemVer".

**Options:**

### Option A: Restore `recommendedTypeChecked` defaults — delete the 3 overrides only
- Remove `no-explicit-any: 'off'`, `no-floating-promises: 'warn'`, `no-unsafe-argument: 'warn'`. Keep the `prettier/prettier` override. Every `no-unsafe-*` rule and `no-explicit-any` returns to `error`.
- **Pros:** Exactly addresses the stated problem — the 504 findings all come from this tier. Minimal churn scoped to the debt. Stable under SemVer. Nothing to learn beyond what the team already hit.
- **Cons:** Leaves `any`-adjacent gaps `strictTypeChecked` would catch (e.g. `foo!` non-null assertions, redundant conditions). Not the strictest possible bar.

### Option B: Adopt `strictTypeChecked`
- Replace `recommendedTypeChecked` with `strictTypeChecked` in the extends chain.
- **Pros:** Strongest type discipline; `no-explicit-any` + a family of related correctness rules on by default. Signals a permanent quality bar.
- **Cons:** Expands scope well beyond the reported debt — `no-unnecessary-condition` and `prefer-nullish-coalescing` alone typically add dozens of new findings unrelated to `any`. Config churn on every future dependency bump (no SemVer stability). Larger review surface mixed into a cleanup task — violates the repo's "one scope at a time" rule.

### Option C: `recommendedTypeChecked` + hand-picked strict rules
- Option A plus an explicit allowlist: `no-non-null-assertion`, `no-unnecessary-type-assertion`, `no-unsafe-type-assertion` (the ones that directly reinforce "no `any` laundering via casts").
- **Pros:** Closes the cast-laundering loophole (`x as any as T`, `x!`) without the full `strictTypeChecked` blast radius. Every added rule traceable to the `any` goal.
- **Cons:** Bespoke config the team must maintain rationale for. `no-non-null-assertion` will flag existing legitimate `!` uses (e.g. `video.upload_id!`, `etag!`) needing individual review — modest extra work.

**Recommendation:** **Option C.** Option A is the floor and fully clears the reported 504, but the user's emphasis on rigor specifically targets `any` *and its escape hatches* — `as any` casts and `!` assertions are how `any` silently re-enters a "strict" codebase. Adding just the three assertion rules keeps the task honest without importing the unrelated `strictTypeChecked` churn that would violate scope discipline. If the team prefers zero bespoke config, fall back to A.

**Decision:** Option B
**Libraries:** typescript-eslint

---

## TD-02: `tsconfig` compiler strictness

**Scope:** Repo-wide

**Trigger:** "the typescript type rules of not tolerating use of 'any' type must be followed rigorously" — ESLint `no-unsafe-*` only sees `any` that the *compiler* already produced. `noImplicitAny: false` lets the compiler manufacture `any` silently (untyped params, untyped destructuring), which then can't be fully caught downstream.

**Context:** `tsconfig.json` sets `strictNullChecks: true` but explicitly `noImplicitAny: false`, `strictBindCallApply: false`, and never sets `strict: true`. `tsc --noEmit` currently exits 0. `nestjs-project/CLAUDE.md` documents `noImplicitAny off` as an intentional convention — this TD proposes reversing that. The `.claude/rules/typescript-strict.md` rule file already *claims* "the project compiles with `strict` settings" — so the rule and the actual config disagree today.

**Options:**

### Option A: `"strict": true`
- Enables `noImplicitAny`, `strictBindCallApply`, `strictFunctionTypes`, `noImplicitThis`, `alwaysStrict`, `useUnknownInCatchVariables`, `strictPropertyInitialization`.
- **Pros:** `useUnknownInCatchVariables` makes `catch (err)` give `unknown` — directly forces the narrowing work in TD-03 at the compiler level. `strictPropertyInitialization` + `noImplicitThis` catch real NestJS DI/entity bugs. Resolves the rule-vs-config contradiction. One flag, canonical.
- **Cons:** `strictPropertyInitialization` clashes with TypeORM entity fields declared without `!` or initializer — may need `!` on entity columns or `--strictPropertyInitialization false` carve-out. Largest unknown delta (must measure `tsc` after flip).

### Option B: Minimal flip — `noImplicitAny: true` + `strictBindCallApply: true`
- Turn on only the two rules that gate `any`, leave everything else as-is.
- **Pros:** Smallest surface that satisfies "no implicit any". Avoids the TypeORM `strictPropertyInitialization` friction entirely. Predictable delta.
- **Cons:** Leaves `useUnknownInCatchVariables` off — error handling keeps `any` in catch clauses unless ESLint `no-unsafe-*` happens to cover each use. Keeps the codebase in a non-standard "partial strict" state that's easy to regress. `.claude/rules/typescript-strict.md` stays technically inaccurate.

### Option C: Leave tsconfig unchanged
- Rely solely on ESLint `no-unsafe-*` + `no-explicit-any`.
- **Pros:** Zero compiler risk; the lint layer already catches most `any` propagation.
- **Cons:** Implicit `any` from untyped function params isn't reliably caught by `no-unsafe-*` at the definition site. Two layers of "strictness config" that disagree is itself a maintenance trap. Doesn't honor the "rigorously" ask.

**Recommendation:** **Option A**, with `strictPropertyInitialization` explicitly evaluated: if the TypeORM entities need broad `!` changes, either add them (they're accurate — columns are always populated post-load) or set `strictPropertyInitialization: false` as the *single* documented carve-out. `useUnknownInCatchVariables` is the payoff — it makes TD-03's narrowing mandatory rather than optional, and error handling is exactly where this codebase currently launders `any`. Depends on TD-03 for the catch-clause pattern.

**Decision:** Option A

---

## TD-03: Typing third-party / driver boundaries (the production-code fix)

**Scope:** Backend

**Trigger:** The only `any` in production code: `const e = err as any` in `channels.service.ts:12` and `videos.service.ts:36`, both reading PostgreSQL error fields (`.code`, `.detail`). Same shape recurs at other untyped boundaries: `ffprobe` JSON output, pg-boss job payloads, S3 SDK responses, `QueryFailedError` internals in specs.

**Context:** These are genuine "the library doesn't give us a good type" boundaries. The fix pattern chosen here is the template `implement` will apply everywhere an external value enters the code. Cited in ≥2 files → cross-component contract.

**Options:**

### Option A: Local `unknown` + hand-written type guards per call site
- Each site declares `function isPgError(e: unknown): e is { code: string; detail: string } { ... }` inline in its module.
- **Pros:** Zero new dependencies. Fully explicit. Each guard scoped to what that site needs.
- **Cons:** The PG-error guard is already duplicated verbatim in two services — Option A keeps duplicating it. Guard boilerplate multiplies across ffprobe/pg-boss/S3.

### Option B: Shared typed boundary module in `src/common/`
- One `src/common/database/postgres-error.ts` exporting a `PostgresError` interface + `isUniqueViolation(e, column)` / `isPgError(e)` guards. Analogous small modules for other boundaries as they arise.
- **Pros:** Kills the existing duplication (DRY, matches `.claude/rules/nestjs-common-conventions.md` "never duplicate string literals"). One reviewed, tested guard. `.claude/rules/typeorm-queries.md` already references an `isUniqueViolation(err)` helper — this makes that real.
- **Cons:** Slight indirection; a `common/` grab-bag risk if not disciplined.

### Option C: Use the driver's own exported types
- `pg` exports a `DatabaseError` class. `import { DatabaseError } from 'pg'` and `err instanceof DatabaseError` narrows `.code`/`.detail`/`.constraint` with real types. TypeORM wraps the driver error as `QueryFailedError`, whose `.driverError` is the `pg` `DatabaseError`.
- **Pros:** Authoritative types, maintained by the driver. `instanceof` is a runtime-sound narrow. No hand-written guard to keep in sync with PG's error shape.
- **Cons:** Reaches through `QueryFailedError.driverError` (need to check that path is typed — may still need one cast at that seam). Only covers the PG case; ffprobe/pg-boss/S3 still need A or B. `pg` is a transitive dep of `@nestjs/typeorm` but is also a direct dep here (`pg: ^8.20.0`) so importing it is legitimate.

**Recommendation:** **Option C for the PostgreSQL case** (`err instanceof QueryFailedError && err.driverError instanceof DatabaseError`), housed in the **Option B** shared module `src/common/database/postgres-error.ts` so both services and the specs consume one helper. For the remaining boundaries (ffprobe output, pg-boss payloads, S3 responses) use **Option A** guards co-located with each consumer, promoted to a shared module only if a second consumer appears. This is the `useUnknownInCatchVariables` (TD-02) landing pattern.

**Decision:** Option A

---

## TD-04: Test-file lint policy

**Scope:** Repo-wide

**Trigger:** 492 of 504 findings are in test files. "plan refactoring of all files that have lint issues" + "Do not suggest shortcuts" — but `unbound-method` on `expect(mock.method)` is a documented false-positive that typescript-eslint itself says to handle differently for Jest.

**Context:** Whether test files get their own ESLint config block, and if so whether it *loosens* anything (shortcut) or *corrects* a known false-positive (not a shortcut). Context7 tip from `unbound-method.mdx`: "For projects using jest, consider using eslint-plugin-jest's version of this rule … understands when it is acceptable to pass an unbound method to expect calls."

**Options:**

### Option A: Identical rule set for test files — no override block
- Fix all 22 `unbound-method` hits manually (`jest.mocked(x).method`, or assert on a captured reference).
- **Pros:** Zero config divergence. Literally "all files, same bar."
- **Cons:** Fights a rule the tool's own docs say is wrong for Jest `expect()`. Produces awkward test code (`expect(jest.mocked(repo).save)`) purely to satisfy a non-Jest-aware rule. `no-unsafe-*` from mock factories still needs TD-05 regardless.

### Option B: Add `eslint-plugin-jest`; test-file block swaps `unbound-method` → `jest/unbound-method`, keeps everything else at error
- New `files: ['**/*.spec.ts', '**/*.integration-spec.ts', 'test/**/*.ts']` block: `extends: [jestPlugin.configs['flat/recommended']]`, `'@typescript-eslint/unbound-method': 'off'`, `'jest/unbound-method': 'error'`. `no-explicit-any`, `no-unsafe-*`, `require-await` stay at **error**.
- **Pros:** The one rule that's genuinely wrong for Jest gets the mock-aware version — a correction, not a relaxation. `eslint-plugin-jest/flat/recommended` adds real value (`no-disabled-tests`, `no-focused-tests`, `valid-expect`, `no-conditional-expect`). Supports ESLint 9 flat config + typescript-eslint 8 (plugin v28+). Every other type-safety rule still fully enforced in tests.
- **Cons:** One new devDependency. A second config block to understand.

### Option C: Relax `no-unsafe-*` to `warn` for test files
- **Pros:** Instantly drops the error count; tests still "lint".
- **Cons:** This is exactly the shortcut the user forbade — it re-hides the same class of problem one directory over. Rejected on the stated constraint.

**Recommendation:** **Option B.** It's the only option that both honors "no shortcuts" (every `any`/unsafe rule stays at error in tests) and doesn't force provably-pointless code changes to satisfy a rule its own maintainers flag as Jest-incompatible. The extra `eslint-plugin-jest` recommended rules are a net quality gain. Depends on TD-01 (base config shape).

**Decision:** Option B
**Libraries:** eslint-plugin-jest

---

## TD-05: Typed mocking pattern for unit specs

**Scope:** Backend

**Trigger:** `function makeVideoRepository(): any`, `makeStorageService(): any`, `makeBoss(): any` etc. in `videos.service.spec.ts` (and siblings) are the single largest source of `no-unsafe-*` — every `.mockResolvedValue`, every `as StorageService` cast, every assertion on the returned object is unsafe access on `any`.

**Context:** The replacement pattern for `any` mock factories. `.claude/rules/nestjs-testing.md` mandates `Test.createTestingModule()` + `useValue` mocks but doesn't specify how to *type* the mock value. This TD fills that gap.

**Options:**

### Option A: Hand-written typed factories — `jest.Mocked<T>` shape
- `function makeStorageService(): jest.Mocked<Pick<StorageService, 'createMultipartUpload' | ...>> { return { createMultipartUpload: jest.fn(), ... }; }`
- **Pros:** No dependency. Explicit about which methods the test exercises. `jest.Mocked` types are built in.
- **Cons:** Verbose; every method must be listed and re-listed as the service grows. `Pick` lists drift from the real interface. ~6 factories to write across the spec suite.

### Option B: `@golevelup/ts-jest` `createMock<T>()`
- `const storage = createMock<StorageService>();` — returns a deep, fully-typed auto-mock; every method is a typed `jest.Mock` returning a mock proxy.
- **Pros:** De-facto standard in the NestJS ecosystem. Deletes all the `any` factories outright. Fully typed — `storage.createMultipartUpload.mockResolvedValue(...)` type-checks. Handles nested objects (Nest `ExecutionContext`, `Reflector`). Minimal boilerplate.
- **Cons:** One devDependency. Deep auto-mock can hide "method was never stubbed" (returns a proxy, not `undefined`) — mildly less strict about accidental calls.

### Option C: `jest-mock-extended` `mock<T>()`
- Similar to B, framework-agnostic. `const storage = mock<StorageService>();`
- **Pros:** Typed, widely used, `calledWith` matchers. No NestJS coupling.
- **Cons:** Another dependency with the same trade-off as B; less NestJS-idiomatic than `@golevelup/ts-jest`, which also provides `createMock` for Nest-specific abstractions used elsewhere in the suite.

**Recommendation:** **Option B (`@golevelup/ts-jest`).** It removes the `any` factories wholesale rather than replacing them with verbose typed ones, it's the ecosystem-standard companion to `@nestjs/testing`, and `createMock` will also clean up guard/interceptor/`ExecutionContext` mocking in the auth and filter specs. Option A is the no-new-dependency fallback if the team wants to keep the test toolchain minimal — the cost is ongoing factory maintenance. Depends on TD-04 (test-file config block).

**Decision:** Option B
**Libraries:** @golevelup/ts-jest

---

## TD-06: E2E / integration HTTP response-body typing

**Scope:** Backend

**Trigger:** `res.body.access_token`, `res.body.error`, `res.body.parts` — supertest types `Response.body` as `any`, so every assertion in `auth.e2e-spec.ts` (48 errors) and `videos.e2e-spec.ts` (25) is `no-unsafe-member-access`. Plus `(authService as any).mailService` to reach a private field.

**Context:** How e2e specs get typed access to response payloads without `any`. This overlaps the already-decided frontend contract-typing work (`technical-decisions-next-frontend-openapi-typing.md`) — the backend emits an OpenAPI spec (`openapi:export` script exists) that the frontend consumes as generated types. The e2e suite is a potential second consumer.

**Options:**

### Option A: Per-call cast to a locally declared interface
- `interface LoginResponse { access_token: string; refresh_token: string }` in the spec file; `const body = res.body as LoginResponse`.
- **Pros:** Trivial, local, no dependency. Explicit contract per test.
- **Cons:** Response shapes re-declared in every spec that touches an endpoint. Drift from the real controller return type is undetected — a cast is an assertion, not a check.

### Option B: Shared `test/contracts/` module mirroring controller return types
- Import the actual controller/service return types where they're exported (`InitiateUploadResult`, `CompleteUploadResult`, `VideoDetailResult` are already exported from `videos.service.ts`); declare the rest (auth token payloads, error envelope) once in `test/contracts/`.
- **Pros:** Error envelope (`{ error, message, statusCode }` from the exception filters) typed once and reused. Reuses genuine exported types where they exist — cast is checked against the real shape for those. Co-locates test contracts.
- **Cons:** Hand-maintained for endpoints whose return type isn't exported. Still ultimately a cast at `res.body as X`.

### Option C: Consume OpenAPI-generated types
- Wire the `openapi:export` output into a codegen step (`openapi-typescript`) producing `test/generated/api.d.ts`; type `res.body` via `paths['/auth/login']['post']['responses']['201']['content']['application/json']`.
- **Pros:** Single source of truth — types derive from the same decorators that document the API. Zero drift. Same pipeline the frontend already committed to.
- **Cons:** Meaningful setup (codegen script, CI ordering: export spec → generate → lint/test). The OpenAPI decorators must be complete/accurate for generated types to be useful — a prerequisite that isn't fully met today. Heavier than the reported debt warrants on its own.

**Recommendation:** **Option B now**, structured so the `res.body as X` seam is a single helper (`expectBody<T>(res): T`) that Option C can later back with generated types. Reuse the already-exported `videos.service.ts` result interfaces immediately. Treat **Option C as the convergence target** once the frontend's OpenAPI type pipeline is running and the Swagger decorators are audited — at that point the e2e suite becomes its second consumer for free. Separately, replace `(authService as any).mailService` with `app.get(MailService)` (Nest returns the same singleton) — that's a straight bug fix, not a typing choice. Relates-to: `technical-decisions-next-frontend-openapi-typing.md`.

**Decision:** Option B

---

## TD-07: Rollout & regression-prevention strategy

**Scope:** Repo-wide

**Trigger:** "Identify the errors and warnings and plan refactoring of all files" — how the work is sequenced and how it's kept from regressing. The `lint` npm script runs `eslint … --fix`; there is no CI job enforcing lint today (`npm run lint` currently exits 1 and nothing catches it).

**Context:** 16 files, 504 findings, `tsc` already green, no cross-team coordination needed. The DoD in root `CLAUDE.md` already requires a clean full lint pass — it just isn't gated.

**Options:**

### Option A: Single branch, config + all fixes + CI gate in one PR
- One `bugfix/nestjs-lint-strictness` branch: flip TD-01/TD-02 config, add deps (TD-04/TD-05), fix all 16 files, add a CI lint step (`eslint` **without** `--fix`), merge once.
- **Pros:** No intermediate state where the config lies about what passes. Reviewer sees the whole picture. Matches the bounded size (16 files). CI gate lands with the fix so it can't regress.
- **Cons:** One large PR (~16 files + config). Longer review. Merge conflicts if other branches touch these files during the window.

### Option B: Warn-tier ratchet with `--max-warnings`
- Set the re-enabled rules to `warn`, add `eslint --max-warnings <N>` to CI with `N` = current count, drive `N` down file-by-file across several PRs, flip `warn`→`error` when `N` hits 0.
- **Pros:** Small reviewable PRs. Never blocks other work. Standard large-migration technique.
- **Cons:** Massive process overhead for a 16-file cleanup. Weeks in a half-migrated state. `warn` is exactly the "ignore by configuration" the user is objecting to, even if temporary. The ratchet count is itself config that hides the problem.

### Option C: Per-file `files:` overrides re-disabling rules, removed one PR at a time
- Config lists not-yet-fixed files with the rules turned off; each PR removes one file from the list and fixes it.
- **Pros:** `error` everywhere except an explicit, shrinking blocklist. Small PRs.
- **Cons:** The blocklist is a literal "ignore by configuration" list — precisely what's forbidden here. Config noise. Same overhead as B.

**Recommendation:** **Option A.** The scope is bounded (16 files, compiler already clean), there's no external coordination cost, and both incremental options rely on temporary `warn`/disable states that contradict the user's core constraint. Split only if review size becomes unmanageable — and then split by *area* (production code + shared helpers first as PR 1; each spec cluster as follow-ups) with the rules already at `error` and the not-yet-touched specs' failures accepted as a known short-lived branch state, never as committed config. Land the CI lint gate (no `--fix`, `eslint` in a dedicated step or `npm run lint -- --no-fix`) in the same first PR. Consider adding a `lint:ci` script so local `lint` keeps `--fix` while CI doesn't.

**Decision:** Option A

**Revisions:**
- 2026-08-28 — CI lint gate descoped to local enforcement only: a `lint:ci` npm script (`eslint` without `--fix`) plus an optional pre-push hook. Bootstrapping a CI pipeline is out of scope — no `.github/workflows/` exists and CI platform/scope is a broader undecided choice, tracked as a separate task. Rationale: resolves validation issue MD-1 without expanding this cleanup into CI infrastructure.
- 2026-08-28 — Single-PR rollout (Option A) also absorbs the project-wide findings from `strictTypeChecked` (TD-01 decision B) — `no-unnecessary-condition`, `prefer-nullish-coalescing`, etc. — beyond the measured 504-problem / 16-file baseline; the by-area split in Option A is the fallback if review size demands it. Rationale: resolves validation issue IC-1 — TD-01=B reaffirmed, wider lint surface in one PR accepted.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Repo-wide | Target ESLint rule set | `recommendedTypeChecked` (overrides deleted) + `no-non-null-assertion` / `no-unnecessary-type-assertion` / `no-unsafe-type-assertion` | Option B |
| TD-02 | Repo-wide | tsconfig strictness | `"strict": true`, evaluate `strictPropertyInitialization` vs TypeORM entities | Option A |
| TD-03 | Backend | Typing driver/third-party boundaries | `pg` `DatabaseError` via `instanceof` in a shared `common/database/postgres-error.ts`; local `unknown` guards elsewhere | Option A |
| TD-04 | Repo-wide | Test-file lint policy | Add `eslint-plugin-jest`; swap `unbound-method`→`jest/unbound-method` for tests, all other rules stay `error` | Option B |
| TD-05 | Backend | Typed mocking pattern | `@golevelup/ts-jest` `createMock<T>()` (fallback: hand-written `jest.Mocked<T>` factories) | Option B |
| TD-06 | Backend | E2E response-body typing | Shared `test/contracts/` + `expectBody<T>()` helper now; OpenAPI-generated types as convergence target. Fix `(x as any).private` via `app.get()` | Option B |
| TD-07 | Repo-wide | Rollout & regression gate | Single branch: config + all 16 files + CI lint gate (no `--fix`) in one PR | Option A |
