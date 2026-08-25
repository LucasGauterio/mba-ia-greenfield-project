---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-19T18:32:40-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-25T19:34:19-03:00"
  docs/decisions/technical-decisions-abandoned-upload-cleanup.md: "2026-08-25T19:34:24-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-19T18:32:40-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-19T18:32:39-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-25T20:21:33-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

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

**Out of scope:** Não especificado explicitamente no project-plan.md além do frontend (ver Deferred subprojects). Interface de vídeo no `next-frontend` está fora do escopo desta fase per o brief do desafio.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` — recebe todas as capacidades desta fase (object storage, fila, worker de processamento, migration/entidade de vídeos, endpoints de upload/streaming/download).

**Deferred subprojects:** `next-frontend/` — interface de vídeo não faz parte do escopo desta fase (per `docs/decisions/technical-decisions-phase-03-videos.md` "Subprojects in scope").

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (dependência: Fase 01).
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (dependência: Fase 02, Fase 03).

## Decisions Index

_(from decisions-reader — one row per TD across phase-scope + ad-hoc docs)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Job Queue Technology | decided | C (pg-boss) | pg-boss |
| phase-03-videos/TD-02 | phase | Backend | Large File Upload Strategy (up to 10GB) | decided | A (S3 Multipart Upload, presigned parts) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Upload Completion Detection & Processing Trigger | decided | A (client-confirmed completion endpoint) | — |
| phase-03-videos/TD-04 | phase | Backend | Object Storage Bucket & Key Organization | decided | A (single bucket, prefixed keys) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Processing Worker Toolchain | decided | A (CLI via child_process/execa) | execa, ffmpeg-static, ffprobe-static |
| phase-03-videos/TD-06 | phase | Backend | Unique Video URL Strategy | decided | B (short slug via nanoid) | nanoid |
| phase-03-videos/TD-07 | phase | Backend | Streaming & Download Delivery Strategy | decided | B (Presigned GET redirect) | @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-08 | phase | Backend | Video Status Lifecycle & Failure Handling | decided | A (4-state enum, queue-native retry/backoff) | — |
| abandoned-upload-cleanup/TD-01 | ad-hoc | Backend | Abandoned/Never-Completed Upload Cleanup Mechanism | decided | A (scheduled sweep + AbortMultipartUpload) | pg-boss, @aws-sdk/client-s3 |
|   └─ Last revision: 2026-08-25 — Clarified this TD (not phase-03-videos/TD-08) owns abandoned/never-completed upload handling. | | | | | | |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])
- abandoned-upload-cleanup — `docs/decisions/technical-decisions-abandoned-upload-cleanup.md` (scope_type: ad-hoc, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-04 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

_Note: `abandoned-upload-cleanup/TD-01` does not appear in this table — it was authored with a `**Trigger:**` field (not `**Capability:**`) despite `related_phases: [3]` being non-empty, so it isn't cross-referenceable against a literal capability bullet by this mechanism. It is a real gap-closing decision (closes plan-validate's MD-1) but not itself a phase capability; flagged for the user, not auto-fixed by this stage._

## Decisions Detail

_(current-phase TDs only — from decisions-detail-reader)_

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
- 2026-08-25 — Clarified this TD (not phase-03-videos/TD-08) owns abandoned/never-completed upload handling. Rationale: user initially asked to extend TD-08 for this concern; /decide triage confirmed TD-01 here (created via /research to close plan-validate's MD-1) is the correct owner — TD-08's status lifecycle stays scoped to post-upload processing failures only, avoiding duplicate/conflicting decisions across two TDs.

> **Note:** TD-01 and TD-06 (`phase-03-videos`) `**Decision:**` diverge from the `**Recommendation:**` prose above (user's explicit call: pg-boss over BullMQ+Redis on TD-01; nanoid slug over UUID-in-URL on TD-06). This is a valid, deliberate outcome — the Recommendation field is left as-authored by `research`; `plan-build` reads the `**Decision:**` field, not the Recommendation, when generating Technical Specifications.

## Inherited Decisions Detail

_(inherited TDs from prior phases + user-confirmed correlated ad-hoc docs, dedupe applied)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Libraries:** `@nestjs/jwt@^11.0.0`
**Revisions:**
- Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Libraries:** `@nestjs/jwt@^11.0.0`
**Revisions:**
- Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) Defense in depth on the cookie content — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. (2) Single cookie to manage simplifies logout and avoids the orphan-cookie failure mode. (3) Room to carry minimal user metadata lets `app/layout.tsx` RSC render authenticated chrome without a per-render `/auth/me` round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight refresh detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Client-driven and pre-emptive-timer alternatives are rejected for added complexity/failure modes without replacing the server-side refresh requirement.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) Decoupled from TD-05 — works with Route Handlers OR Server Actions. (2) Aligned with shadcn's canonical form primitive. (3) Zod-first developer ergonomics match the rest of the FE foundation.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) Strict-BFF alignment — every mutation stays visible under `app/api/**`. (2) Test scaffold already exists for Route-Handlers-as-functions. (3) Single mutation surface sets the precedent for Phases 03–07.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) No first-render flicker, no round-trip — session delivered in the same response as the page HTML. (2) No new BFF endpoint — the cookie is the source of truth.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) First-paint-correct. (2) Single integration pattern across both confirmation and reset flows. (3) Email-prefetch behavior solved at the backend's idempotent-confirmation level.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` + CLI plugin. The only option that preserves the already-decided `class-validator`/`class-transformer` stack (phase-02-auth/TD-06) without a re-platform; the CLI plugin's `classValidatorShim: true` infers schemas from existing decorators, keeping boilerplate low.
**Libraries:** @nestjs/swagger
**Revisions:**
- Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`) — parte do escopo da Option A escolhida, não trabalho adicional fora do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** Runtime UI + `openapi.json` exportado (ambos). O custo marginal sobre runtime-only é um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Apenas em dev/staging via env flag. Alinha com a postura defensiva já estabelecida na fase 02 (rate limiting) e não compromete consumidores legítimos — o `openapi.json` commitado (TD-02) cumpre o papel de spec consultável fora da UI.
**Libraries:** —

## Inherited Conventions

_(from phases-reader — sourced from prior phases)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | Logout button lives inside authenticated chrome (typically Phase 04). Phase 02 already implements `POST /api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships sending the e-mail; the reset-password destination screen is absent from Figma — link destination remains a 404 until a later phase delivers the screen. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | The umbrella bullet's full coverage requires the confirmação and reset-password destination screens, both deferred per rows above; the 3 ship-this-phase telas are covered by their own verbs. |

_None of these are relevant to phase-03-videos (all are frontend/auth screens); listed for completeness per the shared convention._

## Non-UI / Deferred Capabilities

_(empty on first assembly — plan-resolve appends rows as the user marks capabilities out of scope)_

_None._

## Testing Requirements

_(from testing-guide-nestjs-project — Feature Implementation Checklist, applied to the video module's artifact set)_

### nestjs-project

| Artifact type | Required layers |
|---|---|
| Entity (`video.entity.ts`) | Integration: constraints, defaults, `select: false` fields |
| Service with branching + DB (e.g. video lifecycle/status service) | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only, no branching | Integration: DB contract |
| Service with side-effect dep — object storage client (presigned URLs, multipart, HeadObject, AbortMultipartUpload) | Integration: real capture/local adapter (against the real MinIO Compose service — do not mock what Compose can run for real) |
| Service with side-effect dep — queue producer (job enqueue, scheduled sweep job per `abandoned-upload-cleanup/TD-01`) | Integration: real queue backend via Compose (per the guide's principle of not mocking configured libs/infra that Compose already provides) |
| Queue consumer / worker job handler (ffprobe/ffmpeg invocation, status transitions, abandoned-upload sweep) | Integration: real ffmpeg/ffprobe binaries + real storage + real queue, per the same "test the DB/system contract, not a mock" principle — no dedicated guide row exists for "queue processor" as an artifact type; treat as a Service with side-effect dependencies |
| Module with configured imports (queue module, storage module) | Unit: compilation test |
| Controller (upload lifecycle, complete-upload, stream/download redirect) | E2E only — do NOT write unit tests |
| DTO (upload init, complete-upload) | E2E: one validation wiring test per endpoint |
| Guard (ownership check — video belongs to requester's channel) | E2E + Unit if internal logic is non-trivial |

_No testing guide dedicated row exists for "external storage client" or "queue processor" as first-class artifact types in this project yet — the mapping above extrapolates from the guide's `Service with side-effect dep` row and its "test real infra via Compose, not mocks" principle (§1, §5). `/plan-build` and `/implement` should confirm this mapping holds once the concrete SI structure is drafted; if the pattern recurs heavily, consider proposing dedicated guide rows as a follow-up task (out of scope for this phase)._
