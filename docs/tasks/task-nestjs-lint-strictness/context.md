---
kind: task
name: task-nestjs-lint-strictness
sources_mtime:
  docs/decisions/technical-decisions-nestjs-lint-strictness.md: "2026-08-28T13:40:22-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-25T19:34:19-03:00"
  docs/phases/phase-03-videos/context.md: "2026-08-25T20:21:44-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-19T18:32:39-03:00"
  docs/tasks/task-nestjs-lint-strictness/library-refs.md: "2026-08-28T13:42:25-03:00"
---

# task-nestjs-lint-strictness — Context

## Scope

> Remove blanket ESLint/tsconfig suppressions in nestjs-project and refactor every file with type-safety lint issues, without config shortcuts

Concretely (measured 2026-08-28, `tsc --noEmit` green): `npm run lint` fails with **504 problems (400 errors, 104 warnings) across 16 files**. Suppression is 100% config-level (zero `// eslint-disable` / `@ts-ignore` in the tree): three rule overrides in `nestjs-project/eslint.config.mjs` (`no-explicit-any: off`, `no-floating-promises: warn`, `no-unsafe-argument: warn`) plus `nestjs-project/tsconfig.json` laxity (`noImplicitAny: false`, `strictBindCallApply: false`, `strict` unset). 12 errors are in production code (`channels.service.ts`, `videos.service.ts` — the `err as any` PG-error idiom); the other 492 are in test files (four repeated anti-patterns: `any` mock factories, `new QueryFailedError(...) as any`, `res.body.*` on supertest's `any` body, `(service as any).privateMember`).

**Affected subprojects:** `nestjs-project/` (backend source + all spec/integration-spec/e2e-spec suites) and repo-wide tooling (`nestjs-project/eslint.config.mjs`, `nestjs-project/tsconfig.json`, the `lint` npm script, the missing CI lint gate). No frontend surface.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| nestjs-lint-strictness/TD-01 | ad-hoc | Repo-wide | Target ESLint rule set — what "no shortcuts" means | decided | B | typescript-eslint |
| nestjs-lint-strictness/TD-02 | ad-hoc | Repo-wide | tsconfig compiler strictness | decided | A | — |
| nestjs-lint-strictness/TD-03 | ad-hoc | Backend | Typing third-party / driver boundaries (prod-code fix) | decided | A | — |
| nestjs-lint-strictness/TD-04 | ad-hoc | Repo-wide | Test-file lint policy | decided | B | eslint-plugin-jest |
| nestjs-lint-strictness/TD-05 | ad-hoc | Backend | Typed mocking pattern for unit specs | decided | B | @golevelup/ts-jest |
| nestjs-lint-strictness/TD-06 | ad-hoc | Backend | E2E / integration HTTP response-body typing | decided | B | — |
| nestjs-lint-strictness/TD-07 | ad-hoc | Repo-wide | Rollout & regression-prevention strategy | decided | A | — |

_Source files:_

- nestjs-lint-strictness — `docs/decisions/technical-decisions-nestjs-lint-strictness.md` (scope_type: ad-hoc, related_phases: [])

## Decisions Detail

### nestjs-lint-strictness/TD-01

**Recommendation:** **Option C.** Option A is the floor and fully clears the reported 504, but the user's emphasis on rigor specifically targets `any` *and its escape hatches* — `as any` casts and `!` assertions are how `any` silently re-enters a "strict" codebase. Adding just the three assertion rules (`no-non-null-assertion`, `no-unnecessary-type-assertion`, `no-unsafe-type-assertion`) keeps the task honest without importing the unrelated `strictTypeChecked` churn that would violate scope discipline. If the team prefers zero bespoke config, fall back to A.
**Libraries:** typescript-eslint

> **Decision divergence:** `**Decision:**` is **B** (`strictTypeChecked`), not the recommended C. `plan-build` reads the `**Decision:**` field, not the Recommendation, when generating Technical Specifications — the target ESLint config is `tseslint.configs.strictTypeChecked`.

### nestjs-lint-strictness/TD-02

**Recommendation:** **Option A** (`"strict": true`), with `strictPropertyInitialization` explicitly evaluated: if the TypeORM entities need broad `!` changes, either add them (they're accurate — columns are always populated post-load) or set `strictPropertyInitialization: false` as the *single* documented carve-out. `useUnknownInCatchVariables` is the payoff — it makes TD-03's narrowing mandatory rather than optional, and error handling is exactly where this codebase currently launders `any`. Depends on TD-03 for the catch-clause pattern.
**Libraries:** —

### nestjs-lint-strictness/TD-03

**Recommendation:** **Option C for the PostgreSQL case** (`err instanceof QueryFailedError && err.driverError instanceof DatabaseError`), housed in the **Option B** shared module `src/common/database/postgres-error.ts` so both services and the specs consume one helper. For the remaining boundaries (ffprobe output, pg-boss payloads, S3 responses) use **Option A** guards co-located with each consumer, promoted to a shared module only if a second consumer appears. This is the `useUnknownInCatchVariables` (TD-02) landing pattern. `**Decision:**` recorded as **A** — local `unknown` + hand-written type guards as the baseline pattern across all boundaries.
**Libraries:** —

### nestjs-lint-strictness/TD-04

**Recommendation:** **Option B.** It's the only option that both honors "no shortcuts" (every `any`/unsafe rule stays at error in tests) and doesn't force provably-pointless code changes to satisfy a rule its own maintainers flag as Jest-incompatible. Add `eslint-plugin-jest`; the test-file config block swaps `@typescript-eslint/unbound-method` → `jest/unbound-method` and adds `eslint-plugin-jest`'s recommended rules (net quality gain). Depends on TD-01 (base config shape).
**Libraries:** eslint-plugin-jest

### nestjs-lint-strictness/TD-05

**Recommendation:** **Option B (`@golevelup/ts-jest`).** It removes the `any` mock factories wholesale rather than replacing them with verbose typed ones, it's the ecosystem-standard companion to `@nestjs/testing`, and `createMock` will also clean up guard/interceptor/`ExecutionContext` mocking in the auth and filter specs. Option A (hand-written `jest.Mocked<T>` factories) is the no-new-dependency fallback — the cost is ongoing factory maintenance. Depends on TD-04 (test-file config block).
**Libraries:** @golevelup/ts-jest

### nestjs-lint-strictness/TD-06

**Recommendation:** **Option B now**, structured so the `res.body as X` seam is a single helper (`expectBody<T>(res): T`) that Option C can later back with generated types. Reuse the already-exported `videos.service.ts` result interfaces (`InitiateUploadResult`, `CompleteUploadResult`, `VideoDetailResult`) immediately; declare the rest (auth token payloads, error envelope) once in `test/contracts/`. Treat **Option C (OpenAPI-generated types) as the convergence target** once the frontend's OpenAPI type pipeline is running and the Swagger decorators are audited. Separately, replace `(authService as any).mailService` with `app.get(MailService)` (Nest returns the same singleton) — a straight bug fix, not a typing choice. Relates-to: `technical-decisions-next-frontend-openapi-typing.md`, `technical-decisions-openapi-docs-nestjs.md`.
**Libraries:** —

### nestjs-lint-strictness/TD-07

**Recommendation:** **Option A.** The scope is bounded (16 files, compiler already clean), there's no external coordination cost, and both incremental options rely on temporary `warn`/disable states that contradict the user's core constraint. Split only if review size becomes unmanageable — and then split by *area* (production code + shared helpers first as PR 1; each spec cluster as follow-ups), rules already at `error`, not-yet-touched specs' failures accepted as a known short-lived branch state, never as committed config. Land the CI lint gate (no `--fix` — `eslint` in a dedicated step or `npm run lint -- --no-fix`) in the same first PR. Consider a `lint:ci` script so local `lint` keeps `--fix` while CI doesn't.
**Libraries:** —
**Revisions:**
- 2026-08-28 — CI lint gate descoped to local enforcement only (`lint:ci` script + optional pre-push hook); CI pipeline bootstrap is out of scope, tracked separately. Rationale: resolves MD-1.
- 2026-08-28 — Single-PR rollout also absorbs `strictTypeChecked`'s project-wide findings (TD-01=B) beyond the 504/16-file baseline; by-area split is the fallback. Rationale: resolves IC-1, TD-01=B reaffirmed.

## Inherited Decisions Detail

_(from phases-reader — latest completed phase = Phase 03; dedupe applied, no overlap with current-scope refs)_

### phase-03-videos/TD-01

**Recommendation:** the project already needs to introduce new containers this phase (object storage, worker) regardless, so Option C's "no new infra" advantage is diluted, while BullMQ's official NestJS integration and native retry/backoff give TD-08's failure-handling model a direct, well-documented implementation path with the least custom code. RabbitMQ's topology flexibility solves a multi-service/polyglot problem this phase doesn't have.
**Libraries:** pg-boss

### phase-03-videos/TD-02

**Recommendation:** it needs no new server component beyond what's already fixed (object storage), resumability is a native multipart-upload property, and it keeps the API on the control plane (authorizing, issuing presigned part URLs, confirming completion) rather than the data plane. Option B provides equivalent resumability but at the cost of operating a second server whose only purpose is to re-implement what the storage backend already does natively.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** for this phase's scope (functional correctness exercised by integration/e2e tests against real Compose infrastructure, not hardening against adversarial clients), a single new endpoint that itself verifies the object via `HeadObject` before acting is the least infrastructure for a correct result. Option B is the architecturally "purer" event-driven approach and is worth adopting later if untrusted third-party clients become a real threat model — the MinIO notification wiring is straightforward to add on top of Option A's data model without a status-model change.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** nothing in Phase 03's capabilities requires differentiated bucket-level policy between videos and thumbnails yet, and a shared `videos/{videoId}/...` prefix keeps both assets discoverable and deletable as a unit. Splitting into per-type buckets is a low-cost migration later if a real policy difference emerges (e.g., in Phase 04/05 visibility work).
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** the two operations Phase 03 needs (metadata extraction, single-frame thumbnail) are simple one-shot CLI calls, not multi-stage pipelines that would benefit from a fluent builder. Avoiding both the dead `fluent-ffmpeg` and the unproven `mediaforge` keeps the worker's core dependency surface to the ffmpeg/ffprobe binaries themselves. Binary provisioning (`ffmpeg-static`/`ffprobe-static` packages vs. `apt`-installed in the worker's own Dockerfile) is an implementation detail for `implement`, not a strategic fork.
**Libraries:** execa, ffmpeg-static, ffprobe-static

### phase-03-videos/TD-06

**Recommendation:** reuses the exact convention already in place for every other entity in the project, with uniqueness enforced by the database for free. Introducing a slug generator only pays for itself against an explicit "short URL" product requirement, which Phase 03 does not state.
**Libraries:** nanoid

### phase-03-videos/TD-07

**Recommendation:** this is the relation the project's own architecture diagram already commits to. Proxying (Option A) reintroduces exactly the bandwidth/connection cost the direct-upload decision (TD-02) was designed to avoid on the write path, on the read path instead, for zero functional gain since Range/206 is already correctly implemented by S3-compatible storage.
**Libraries:** @aws-sdk/s3-request-presigner

### phase-03-videos/TD-08

**Recommendation:** it directly reuses the retry/backoff mechanism the queue technology (TD-01) already provides, requires no additional infrastructure, and lands exactly on the state cycle the phase brief specifies. Option C's operational tooling is worth adding later if operational failure volume warrants it, without changing the status model established here.
**Libraries:** —

### abandoned-upload-cleanup/TD-01

**Recommendation:** it is the only option that closes both leaks (DB row and storage cost) using infrastructure already decided in this phase (pg-boss scheduling from TD-01, the `error` status from TD-08, the `uploadId` column already needed by TD-03), with no new dependency and a mechanism directly testable against the real Compose stack. Option B alone leaves the DB-side leak open and introduces a silent drift between storage and DB state. Option C is rejected given the project plan's explicit storage-cost concern — closing this gap costs one scheduled job, not a new subsystem.
**Libraries:** pg-boss, @aws-sdk/client-s3
**Revisions:**
- 2026-08-25 — Clarified this TD (not phase-03-videos/TD-08) owns abandoned/never-completed upload handling. Rationale: user initially asked to extend TD-08 for this concern; /decide triage confirmed TD-01 here is the correct owner — TD-08's status lifecycle stays scoped to post-upload processing failures only.

> **Note:** `phase-03-videos` TD-01 and TD-06 `**Decision:**` diverge from the `**Recommendation:**` prose above (user's explicit call: pg-boss over BullMQ+Redis on TD-01; nanoid slug over UUID-in-URL on TD-06). Deliberate outcome — `plan-build` reads the `**Decision:**` field, not the Recommendation.

## Inherited Conventions

_(from phases-reader — sourced from Phase 01, inherited through Phase 03)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — §3 Feature Implementation Checklist. This task modifies two services and adds one pure-function helper module; the bulk of the work re-types existing spec/integration/e2e files without adding new artifacts.)_

| Artifact created / modified | Required tests |
|---|---|
| Entity (`*.entity.ts`) — only if `strictPropertyInitialization` forces `!` additions | Integration: constraints, defaults, `select: false` (existing coverage; verify still green) |
| Service with branching + DB (`channels.service.ts`, `videos.service.ts`) | Unit: branch logic (mock repo) + Integration: DB contract |
| Pure-function helper (`src/common/database/postgres-error.ts`, TD-03) | Unit — guard returns correct boolean for `QueryFailedError` / `DatabaseError` / arbitrary `unknown` inputs |
| Module with configured imports | Unit: compilation test (existing; unaffected) |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to Passport) | E2E only |
| Guard (complex internal logic) | E2E + Unit |
| Exception Filter | Unit + E2E |
| Interceptor | Unit and/or E2E |
| Pipe (custom) | Unit |

**Cross-cutting for this task:** every refactored `*.spec.ts` / `*.integration-spec.ts` / `test/*.e2e-spec.ts` must still pass unchanged after retyping — the refactor changes types, not behavior. Per Definition of Done, run the full suite (`--runInBand` for integration/e2e) plus `npx tsc --noEmit` (exit 0) plus `npm run lint` (must reach 0 problems) before completion.
