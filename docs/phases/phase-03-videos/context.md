---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-19T18:32:40-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T17:09:47-03:00"
  docs/decisions/technical-decisions-abandoned-upload-cleanup.md: "2026-08-31T17:09:52-03:00"
  docs/decisions/technical-decisions-workflow-hardening-guardrails.md: "2026-08-31T16:13:32-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-19T18:32:40-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-19T18:32:39-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-31T17:45:34-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ (Per `PLAN.md`: video UI in `next-frontend/`, video-info editing, público/unlisted visibility, channel panel and public page (Fase 04), player and watch page (Fase 05), likes/comments/subscriptions (Fase 06).)

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — the entire phase: video module (entity, migration, DTOs, controller, service), object-storage service, processing queue, separate video worker, streaming/download endpoints, new Compose services (object storage + worker).

**Deferred subprojects:** `next-frontend` — video interface is Fase 04/05; no work this phase.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia da fila de processamento em segundo plano | decided | B (pg-boss) | `pg-boss@^10` |
| phase-03-videos/TD-02 | phase | Cross-layer | Estratégia de upload de vídeos de até 10GB sem travar a API | decided | B (multipart presigned) | `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3` |
| phase-03-videos/TD-03 | phase | Backend | Detecção de conclusão do upload e gatilho do processamento | decided | A (client-confirmed + server verify) | — |
| phase-03-videos/TD-04 | phase | Backend | Organização de buckets e chaves no object storage | decided | A (single bucket `streamtube`) | — |
| phase-03-videos/TD-05 | phase | Backend | Toolchain e modelo de execução do worker de vídeo | decided | A (execa CLI + static binaries) | `execa@^5.1.1`, `ffmpeg-static`, `ffprobe-static` |
| phase-03-videos/TD-06 | phase | Backend | Estratégia de URL única por vídeo | decided | B (nanoid slug) | `nanoid@^5` |
| phase-03-videos/TD-07 | phase | Cross-layer | Estratégia de streaming e download do vídeo | decided | B (302 redirect) | `@aws-sdk/s3-request-presigner@^3` |
| phase-03-videos/TD-08 | phase | Backend | Ciclo de status do vídeo e tratamento de falhas de processamento | decided | A (4-state enum + queue retry) | — |
| phase-03-videos/TD-09 | phase | Backend | Autorização e visibilidade das rotas públicas de leitura do vídeo | decided | B (optional-auth + 404-never-403) | — |
| abandoned-upload-cleanup/TD-01 | ad-hoc | Backend | Cleanup strategy for abandoned uploads | decided | A (pg-boss cron sweep) | `pg-boss@^10`, `@aws-sdk/client-s3@^3` |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])
- abandoned-upload-cleanup — `docs/decisions/technical-decisions-abandoned-upload-cleanup.md` (scope_type: ad-hoc, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-04 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08, abandoned-upload-cleanup/TD-01 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-09 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-09 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** the job volume (one job per upload) never approaches the throughput where Redis pays for itself, and PostgreSQL is already in the stack. pg-boss keeps job enqueue transactional with the `videos` row write, adds no container, and its native `schedule()` covers the orphan-upload sweep with the same dependency. An earlier research pass had recommended BullMQ+Redis on feature-completeness grounds; that recommendation is **not followed** ⚠️ because "avoid a second datastore" outweighs a throughput/observability advantage this workload will not exercise.
**Libraries:** `pg-boss@^10`

### phase-03-videos/TD-02

**Recommendation:** the only option that clears the 10GB bar while keeping the file entirely off the API and giving per-part retry. Option A's 5GB ceiling disqualifies it; Options C/D reintroduce byte-proxying or extra protocol surface for no gain. Excluded explicitly: single `PUT` (size, no resume) and API proxy (auto-fail).
**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

### phase-03-videos/TD-03

**Recommendation:** a client-confirmed endpoint with server-side `HeadObject` verification is the standard S3 multipart completion flow, keeps the state machine inside the API, and is straightforward to exercise in integration/e2e tests against MinIO. MinIO bucket notifications (Option B) are a reasonable **future** optimization but add per-environment infra now.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** a single bucket with a per-video prefix is the simplest layout that keeps every artifact of a video together for cleanup and matches the access pattern of all four consumers. Policy differentiation (Option B) can be revisited if thumbnails ever need public-read.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** direct CLI via `execa` + `ffmpeg-static`/`ffprobe-static`, worker as its own container. It is the most transparent and testable approach, adds no system-package step to the image, and isolates heavy processing from the API. Pin `execa@5` (last CJS major); `fluent-ffmpeg` is out (archived), WASM/SaaS are out (fit).
**Libraries:** `execa@^5.1.1`, `ffmpeg-static`, `ffprobe-static`

### phase-03-videos/TD-06

**Recommendation:** a dedicated `nanoid` slug gives the short, friendly, non-enumerable public URL the plan asks for, decoupled from the internal UUID, and reuses the retry-on-unique-violation pattern already established for channel nicknames. The earlier research pass had recommended reusing the UUID directly (no extra column); that is **not followed** ⚠️ because "URL curta e amigável" is an explicit requirement and the slug pattern is already idiomatic in this codebase.
**Libraries:** `nanoid@^5`

### phase-03-videos/TD-07

**Recommendation:** a `302` to a presigned `GetObject` keeps large-file bytes off the API on the read path exactly as TD-02 does on the write path, lets storage serve `Range`/`206` natively (the client's follow-up request negotiates partial content directly), and leaves a clean seam for a CDN in production. API proxying (Option A) is excluded for the same reason routing the upload through the API is.
**Libraries:** `@aws-sdk/s3-request-presigner@^3`

### phase-03-videos/TD-08

**Recommendation:** a 4-state enum with `error_reason`, leaning on pg-boss's retry/back-off for transient failures and a terminal `error` state for exhausted ones, is exactly what the capability asks for and nothing more. DLQ/manual reprocess (Option B) is a clean future addition on pg-boss v10; fine-grained states (Option C) model progress no one consumes yet.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** it is the only option that delivers anonymous playback of `ready` videos *and* owner access to in-progress videos while returning an indistinguishable `404` to everyone else. The `OptionalJwtAuthGuard` is a small, self-contained artifact consistent with the project's existing custom-guard approach, and centralising the rule in `getVisibleVideoBySlug` keeps the three routes from diverging. Option A is a viable fallback if the team wants zero new guards and accepts a separate owner-status endpoint; Option C is rejected on the product principle.
**Libraries:** —

### abandoned-upload-cleanup/TD-01

**Recommendation:** a pg-boss scheduled sweep is the only option that reclaims **both** the DB row and the storage parts, uses infrastructure already chosen for the phase, keeps the TTL policy in one place, and is straightforwardly testable. A storage lifecycle rule (Option B) is a fine belt-and-suspenders addition later but does not close the DB half of `MD-1`.
**Libraries:** `pg-boss@^10`, `@aws-sdk/client-s3@^3`

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** **Argon2id** — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier. **Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate. **Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** (1) Architectural fit — the strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match. (2) Smaller blast radius — a ~50-LOC session helper is grep-friendly and test-friendly. (3) Compatibility with Next.js 16 / React 19 — built-in `next/headers` `cookies()` is the canonical primitive. Option C rejected (`localStorage` for refresh tokens is unsafe).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** (1) Defense in depth on the cookie content — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. (2) Single cookie to manage simplifies logout. (3) Room to carry minimal user metadata (`userId`, `email`, `channelSlug`) lets the RSC layout render authenticated chrome without a per-render `/auth/me` round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace server-side refresh. Option C's pre-emptive timer is rejected (multi-tab / sleep-wake failure modes).
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** (1) Decoupled from TD-05 — works with Route Handlers OR Server Actions. (2) Aligned with shadcn's canonical form primitive (`npx shadcn add form` produces react-hook-form wrappers). (3) Zod-first ergonomics match the rest of the FE foundation.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** (1) Strict-BFF alignment — Route Handlers named as the BFF surface; keeps every mutation visible under `app/api/**`. (2) Test scaffold already exists for Route-Handlers-as-functions. (3) Single mutation surface — uniformity beats per-mutation idiom-picking across Phases 03–07.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** (1) No first-render flicker, no round-trip — the session is delivered in the same response as the page HTML. (2) No new BFF endpoint — the cookie is the source of truth, RSC reads it, the Provider broadcasts it. The `router.refresh()` requirement after mid-session mutations is a small price.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** (1) First-paint-correct — the user sees the right outcome on first paint, no skeleton. (2) Single integration pattern across both flows (confirmation RSC-only; reset RSC + Client form). (3) Email-prefetch behavior solved at the backend's idempotent-confirmation level.
**Libraries:** —

### workflow-hardening-guardrails/TD-01

**Recommendation:** matches the pipeline's existing read-budget discipline and keeps the check something people actually run every time instead of disabling. Decision: A — lightweight, advisory Repository Health Check (`env-check.sh` + `lint:ci`), dispatched at `implement-phase` Preflight only; `plan-context` just reads `docs/known-issues.md`.
**Libraries:** —
**Revisions:**
- 2026-08-31 — Initial implementation attempt used Option B's shape (full test suite, hard abort, dispatched from both `plan-context` and `implement-phase`). Reworked to Option A after review flagged it as too heavy/blocking.

### workflow-hardening-guardrails/TD-02

**Recommendation:** consistent with the project's existing all-state-lives-in-docs/ convention and directly readable by both the health check and the planning pipeline's inheritance mechanism. Decision: A — `docs/known-issues.md` ledger (`## OPEN` / `## RESOLVED`, each entry names exact files/rule, origin phase, reason, follow-up).
**Libraries:** —
**Revisions:**
- 2026-08-31 — Scoped-exception authoring guidance moved from `plan-rule-author` skill to `.claude/rules/typescript-strict.md` (the file auto-attached when editing `nestjs-project/src/**/*.ts`).

### workflow-hardening-guardrails/TD-03

**Recommendation:** directly targets the observed failure mode (pre-app-start setup verification) using tooling already present, with a NestJS health-check module noted as complementary future work, not a substitute. Decision: A — `scripts/env-check.sh`, host-only, wraps existing documented checks (Docker daemon, `.env` completeness vs `.env.example`, Compose services running, `db` accepting connections, pending-migrations info). Wrapped as `npm run env:check`.
**Libraries:** —

### workflow-hardening-guardrails/TD-04

**Recommendation:** the entire point is proving the real running system works, which by definition means bypassing the test-module bootstrap layer, not adding another suite inside it. Decision: A — `scripts/smoke-test.sh`, host-run, exercises the real running containers via `curl` (register → confirm via Mailpit API → login → authenticated call), extensible per phase. Wrapped as `npm run smoke`.
**Libraries:** —

### workflow-hardening-guardrails/TD-05

**Recommendation:** Option A, with GitHub branch protection noted as a legitimate complementary hardening step outside this document's scope. Decision: A — `implement-phase` Preflight runs `git fetch` then `git merge-base --is-ancestor origin/main origin/dev` and checks the current branch's fork point against `dev`'s tip; read-only (never mutates branches). `CLAUDE.md` Git Conventions states the same rules in prose.
**Libraries:** —

### workflow-hardening-guardrails/TD-06

**Recommendation:** the agent already has the exact information needed (which files this SI touched, that its tests and lint are clean) at the moment it would otherwise just be pausing; committing then is strictly less work than building an external enforcement mechanism. Decision: A — `implement-phase` step 6 auto-commits per SI (code + tests + progress-file update together), local-only; push/PR remain out of scope.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em phase-02-auth/TD-06) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status, contratos de erro e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`) — parte da Option A escolhida, não trabalho fora de escopo.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre runtime-only é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Decision: C — Swagger UI runtime (`api/docs`) + `openapi.json` exportado via `npm run openapi:export`.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado cumpre o papel de "spec consultável fora da UI"). Decision: B — Swagger UI apenas em dev/staging, desabilitada em prod via env flag; `/api/docs` retorna 404 em produção.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 1)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: ... })`. _(from phase 1)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for the TypeORM CLI. _(from phase 1)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 1)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 1)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options. _(from phase 1)_

_Phase 2 (`phase-02-auth`, `phase-02-auth-frontend`): no `Conventions to Match` section in either slice._

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout`. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both deferred. The 3 ship-this-phase telas (signup, login, forgot-password) are covered. |

## Inherited Known Issues

_No inherited known issues._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

From `testing-guide-nestjs-project` → §3 Feature Implementation Checklist (artifact → required layers):

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache, queue client) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue publish) | Integration: real capture service (Mailpit / MinIO / real queue) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller (`*.controller.ts`) | E2E only — do NOT write unit tests |
| DTO (`*.dto.ts`) | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport/framework) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter (`*.filter.ts`) | Unit + E2E |
| Middleware (`*.middleware.ts`) | E2E |

Phase-relevant notes from the guide: test service-to-external-system contracts (storage uploads, queue publishing) with **real** infra from Compose — do not mock what MinIO/pg-boss/DB can exercise; test race conditions (concurrent uploads, slug-collision retry); reproduce `main.ts` global config (ValidationPipe, exception filter, global guards) in E2E; `afterAll(() => app.close())` and full `TestingModule` teardown to avoid open pg-boss handles; use `dataSource.query('DELETE FROM ...')` / `repository.clear()` for cleanup, never `repository.delete({})`. Suffixes: `*.spec.ts` (unit, all mocked, no DB/IO), `*.integration-spec.ts` (real DB/services, beside source), `*.e2e-spec.ts` (HTTP via supertest, in `test/`). Integration + e2e run `--runInBand` (shared test DB + shared pg-boss instance). TD-09's new `OptionalJwtAuthGuard` is a guard with internal token-decode logic → Unit + E2E (per the "Guard delegates to service / complex internal logic" rows).

### next-frontend

_Deferred subproject — no work this phase; testing requirements will be defined when video UI is planned (Fase 04+)._
