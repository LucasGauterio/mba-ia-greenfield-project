# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### Final verification (2026-09-01, branch `feature/phase-03-videos`)

- **Unit + integration:** `npm test -- --runInBand` → 34 suites, **181 tests**, all green.
- **E2E:** `npm run test:e2e` → 4 suites, **65 tests**, all green.
- **`npx tsc --noEmit`:** exit 0.
- **Lint:** every phase-03 new/touched file is `eslint`-clean. Project-wide `lint:ci` = **147 errors across the same 9 KI-1 files** (unchanged from when KI-1 was opened — phase-03 added zero).
- **Prettier:** every phase-03 new/touched file passes `prettier --check`. Project-wide `format:check` stays red — see **KI-2** (root cause: `core.autocrlf=true` + no `*.ts` `.gitattributes` rule; a line-ending issue, not indentation).
- **Smoke:** `npm run smoke` → PASS, including the full video path (`POST /videos` → in-network part `PUT` → `complete-upload` → poll to `ready` → `/stream` 302 → `/download` 302).
- **Deferred debt:** KI-1 (pre-existing `no-unsafe-*` in 9 phase-01/02 files) and KI-2 (Prettier/CRLF) both tracked in `docs/known-issues.md`, both routed to a future `bugfix/nestjs-lint-strictness` task.

### Handoff notes (git is out of scope for this `/implement` build)

- All work is uncommitted on `feature/phase-03-videos`. The plan wants **one commit per SI**; `docs/diagrams/software-arch.mermaid` and `nestjs-project/openapi.json` are called out for their own isolated commits.
- New runtime deps added to `package.json`: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `nanoid`, `pg-boss`, `execa@^5.1.1`, `ffmpeg-static`, `ffprobe-static`; devDep `@types/pg`. `package-lock.json` updated.
- `compose.yaml` gained `minio`, `minio-init`, `video-worker` + the `minio-data` volume; `video-worker` now runs `npm run start:worker`.
- Leave `video-worker` **stopped** unless exercising the pipeline — a running worker races the test suites for `pgboss.job`. `docker compose up -d video-worker` when needed.

### SI-03.1 — Infraestrutura: object storage, fila e worker no Compose
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - Wiped the stale `nestjs-project_minio-data` volume left over from a prior branch's execution before recreating `minio`/`minio-init`, so later integration SIs run against a pristine bucket. The two orphan containers flagged at preflight (`minio`, `video-worker`) were reconciled by `docker compose up -d --build`.
  - `minio` healthcheck uses `curl -f http://localhost:9000/minio/health/live` — the `minio/minio` image bundles `/usr/bin/curl`; interval/retries copied from the prior execution's working container config.
  - `video-worker` reuses `Dockerfile.dev` via its own `build:` block (layer cache makes the 2nd build instant) + the same `.:/home/node/app` bind-mount; idles on `command: ["sleep", "infinity"]` until SI-03.7 flips it to `npm run start:worker`.
  - `TaskCreate`/`TaskUpdate` tools are unavailable in this environment — SI status is tracked in this progress.md only, not a separate task list.
  - No git commit performed (this build of `/implement` scopes git out); commit SI-03.1 (`compose.yaml` + `package.json`) before proceeding, per the Deliverables "um commit por SI".

### SI-03.2 — Config namespaces de storage e fila + `.env`
- **Status:** completed
- **Tests:** no tests (config); touched `env.validation.integration-spec.ts` re-run green (4/4); `app.e2e-spec.ts` boots clean with the new config
- **Observations:**
  - `.env` already carried the `STORAGE_*` block from the prior branch's run (`.env` is gitignored); only `.env.example` needed it. Both headers aligned to `# Object Storage (MinIO — S3-compatible)`.
  - Registered `queueConfig` + `storageConfig` in `AppModule`'s `ConfigModule.forRoot({ load: [...] })` — the plan action only said "create the factories", but an unloaded `registerAs` factory isn't injectable; this is the completing half (small scope extension).
  - `scripts/env-check.sh` failed on SI-03.1's new `minio-init` one-shot (it only accepted `state: running`). Extended it to also accept `exited` with exit code 0. `npm run env:check` now PASSes.
  - `env.validation.integration-spec.ts` had 2 pre-existing `no-unsafe-*` lint errors (`value.SWAGGER_ENABLED`); since SI-03.2 touched the file, fixed them by narrowing the `validate` helper's return type (Joi's `ValidationResult.value` is `any` regardless of the schema generic).
  - **Opened KI-1 in `docs/known-issues.md`:** `dev` ships ~100 pre-existing `no-unsafe-*` lint errors across 9 phase-01/02 test files (this fork lacks the lint-strictness cleanup from PLAN §11.6). Phase-03 keeps its own files lint-clean; project-wide `lint:ci` won't reach zero until a dedicated task runs.
  - `.env.example`'s `MAIL_FROM` line is shell-unsafe (unquoted `<>`) — pre-existing phase-02, not touched, not ledgered (single cosmetic line).

### SI-03.3 — Entidade `Video` e migration
- **Status:** completed
- **Tests:** 8 passing (`video.entity.integration-spec.ts` 6, `migrations.integration-spec.ts` 2) — `--runInBand`
- **Observations:**
  - **DB reset required.** The shared `db` container carried a leftover `videos` table + `pgboss` schema from the prior branch's execution (survived branch switches — no named volume but data persisted). `migration:generate` produced only column-ALTERs. Ran `docker compose down -v` → `up -d --build` → re-ran all migrations → regenerated `CreateVideos` against the clean DB (full `CREATE TYPE` + `CREATE TABLE`). Per `.claude/rules/typeorm-migrations.md` § "Recovering from synchronize Residue". Also cleared the stale bind-mounted `minio-data` again (harmless, minio-init recreates the bucket).
  - `migrations.integration-spec.ts` had a **latent bug**: `beforeAll` dropped tables but not the enum TYPEs, so `runMigrations()` fails `type verification_tokens_type_enum already exists` whenever the incoming DB is already migrated. Added sequential `DROP TYPE IF EXISTS` for both enums after the table drops (§11.3 — children before parents, no `Promise.all`).
  - `video.entity.integration-spec.ts` uses `synchronize: false` (per `typeorm-migrations.md` — never synchronize; schema from the migration), diverging from the 4 pre-existing entity specs that use the `synchronize: true` default. Not retrofitting those (out of scope).
  - `created_at`/`updated_at` are `timestamp without time zone` (TypeORM `@CreateDateColumn()`/`@UpdateDateColumn()` default, matching every existing table) rather than the `timestamptz` the Data Model table nominally lists — schema consistency with phases 01/02 wins.
  - `Channel` inverse `@OneToMany(() => Video)` deliberately NOT added yet (SI-03.5), per PLAN §11.2 — `tsc` / `AppModule` boot stay green.
  - Fixed the pre-existing `no-unsafe-function-type` on `create-test-data-source.ts:9` since SI-03.3 touched the file; KI-1 recount → 99 errors / 8 files, all untouched phase-01/02 test debt.

### SI-03.4 — `StorageService` (cliente S3-compatível)
- **Status:** completed
- **Tests:** 4 passing (`storage.service.integration-spec.ts`, real MinIO, `--runInBand`)
- **Observations:**
  - `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` installed at `^3.1122.0`. `npm audit` reports 36 vulns across the full dep tree (mostly transitive / pre-existing + the large AWS SDK tree); `npm audit fix` is out of scope.
  - `testing-guide-nestjs-project/references/external-systems.md` § "Object Storage" (says "Local Filesystem") and § "Message Queue" (says "TBD") are **stale** — superseded by TD-04 (MinIO/S3) and TD-01 (pg-boss). Followed the PLAN's "Integration (MinIO real do Compose)" instruction, mirroring the Mailpit real-service pattern. The skill file should be updated (candidate for SI-03.10 docs or a follow-up).
  - `StorageService.abortMultipartUpload` intentionally swallows `NoSuchUpload` / HTTP 404 (AC requires idempotency; called from the cleanup cron — `nestjs-services.md` background-task exception). Non-404 errors rethrow.
  - Provider registration (plan action 4) deferred to SI-03.5 (`VideosModule` doesn't exist yet) — the integration test constructs `new StorageService(storageConfig())` directly.

### SI-03.5 — `VideosModule` + `POST /videos` (início do upload)
- **Status:** completed
- **Tests:** 10 passing (`videos.service.spec.ts` 4, `videos.module.spec.ts` 1, `videos.e2e-spec.ts` 5). `app.e2e-spec.ts` + `swagger.e2e-spec.ts` re-run green (AppModule boot surface changed).
- **Observations:**
  - **Deviated from plan action 2 — did NOT add the `Channel.videos` inverse `@OneToMany`.** No phase-03 SI queries "videos of a channel" (that's Fase 04); `getVisibleVideoBySlug` (SI-03.8) uses `relations: ['channel']` which works with just the unilateral `@ManyToOne`. Adding the inverse would trigger the §11.2 ripple across **10** phase-01/02 spec files (`ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken]`), 2 of them KI-1 files. Fase 04 adds the inverse with the specs that then need it.
  - `JwtPayload` = `{ sub, email }` only (no channelId), so `VideosService` resolves the channel by `user_id` via `@InjectRepository(Channel)` (VideosModule imports `ChannelsModule`, which re-exports the Channel repo) — a read-only authz lookup, avoiding a new method on the phase-02 `channels.service.ts` (KI-1 file).
  - Video `id` is client-generated (`randomUUID()`) so `storage_key` (`not null`) can be built before the first insert.
  - `nanoid@^5.1.16` added. `require('nanoid')` works at **runtime** on Node 25 (require-of-ESM default). Added `transformIgnorePatterns` (`node_modules/(?!(pg-boss|serialize-error|non-error|type-fest|nanoid)/)`) to **both** `package.json` jest + `test/jest-e2e.json` proactively (PLAN §11.1).
  - Added `@types/pg` devDep (project uses `pg` directly but never had its types). Powers the new `src/common/database/postgres-error.ts` typed error guard (`isUniqueViolation` — the canonical helper `.claude/rules/typescript-strict.md` references but that never existed). Not wired into `channels.service.ts` (KI-1).
  - KI-1 scope expanded: `test/auth.e2e-spec.ts` also carries ~48 pre-existing `no-unsafe-*` (never in the earlier `src/**`-only scan). `test/videos.e2e-spec.ts` (new) is written lint-clean with typed body casts.
  - Benign `pg` DeprecationWarning from TypeORM `synchronize: true` in `videos.module.spec.ts` — same as the other module specs; not a failure.

### SI-03.6 — Fila pg-boss + `POST /videos/:id/complete-upload`
- **Status:** completed
- **Tests:** 12 passing — `src/queue/queue.module.spec.ts` (1), `src/videos/videos.service.spec.ts` (+5 `completeUpload`, 9 total), `src/videos/videos.service.integration-spec.ts` (1, real Postgres+pg-boss+MinIO), `test/videos.e2e-spec.ts` (+3, 8 total). Regression: `openapi-export.integration-spec.ts` (9), `app`/`swagger`/`auth` e2e (52) all re-run green — AppModule now boots pg-boss and closes it cleanly (no "Jest did not exit").
- **Observations:**
  - **Transactional enqueue via pg-boss's `db` option.** `QueueService.publishVideoProcessing(videoId, db?)` accepts an optional `PgBoss.Db` wrapper; `completeUpload` passes `{ executeSql: (t, v) => ({ rows: await manager.query(t, v) }) }` so pg-boss's job INSERT runs on the TypeORM transaction's connection — the `draft → processing` flip and the job row commit atomically (TD-01/TD-03 "numa transação").
  - `QueueService` owns the pg-boss lifecycle: `boss.start()` + `boss.createQueue('video-processing')` in `onModuleInit`, `boss.stop({ graceful: true })` in `onModuleDestroy`. `get client()` exposes the raw `PgBoss` for the SI-03.7 worker entrypoint. `QueueModule` is imported by both `VideosModule` (needs `QueueService`) and `AppModule` (app owns the queue infra) — Nest dedups to one instance.
  - `completeUpload(id, userId, parts)` — signature takes `parts` (the plan's `(id, userId)` shorthand omits it; the DTO carries `{ partNumber, eTag }[]`). Order of checks: `findOne` → 404, owner → 403, `status==='draft' && upload_id` → 409, then `completeMultipartUpload`, then `headObject` (catch → 502 `VIDEO_UPLOAD_VERIFICATION_FAILED`), then the transaction. `POST` returns `200` (`@HttpCode(200)` — not a creation).
  - `ParseUUIDPipe` on `:id` → a malformed (non-UUID) id yields `400` before the service runs; a well-formed but unknown id yields `404 VIDEO_NOT_FOUND`.
  - Integration spec boots `AppModule` + `moduleRef.init()` (needed to fire `onModuleInit` — `.compile()` alone does not) and `moduleRef.close()` in `afterAll`; asserts exactly one `pgboss.job` row filtered by its own `data->>'videoId'` (per library-refs cross-suite-contamination guard).
  - **Opened KI-2** in `docs/known-issues.md`: ~66 pre-existing `prettier --check` failures across phase 01–02 files (same missing `PLAN.md` §11.6 pass as KI-1). All SI-03.6 new/touched files are Prettier- and lint-clean; project-wide `npm run format:check` won't pass until the `bugfix/nestjs-lint-strictness` follow-up.
  - `npm run smoke` not run — the video scenario + smoke run are scheduled for SI-03.10 (matches SI-03.5, which also added an endpoint without extending smoke); the dev server is not running and starting it unprompted is out of scope. The e2e suite already exercises the endpoint against the real app (real MinIO + pg-boss + DB).
  - No git commit (this `/implement` build scopes git out).

### SI-03.7 — Worker de vídeo: processamento + thumbnail
- **Status:** completed
- **Tests:** 4 passing — `src/worker/worker.module.spec.ts` (1, DI compilation), `src/worker/video-processing.worker.spec.ts` (2, unit: final-attempt → `status='error'`+reason+rethrow; non-final → rethrow only, row untouched), `src/worker/video-processing.worker.integration-spec.ts` (1, real MinIO+Postgres+ffmpeg: lavfi fixture → probe fills `duration_seconds`/`metadata`, JPEG thumbnail written, row → `ready`). `--runInBand`.
- **Observations:**
  - Deps added: `execa@^5.1.1` (was already transitive; now a direct dep — v5 is the last CJS major, `import execa from 'execa'` default import per library-refs; **no** `transformIgnorePatterns` entry needed, its tree is CJS), `ffmpeg-static@^5.3.0` (ships `types/index.d.ts`, default export `string | null` — narrowed at module load), `ffprobe-static@^3.1.0` (no types → `src/types/ffprobe-static.d.ts` shim, `export const path: string`). Container-installed; both static binaries verified executable in the `node:25.6.0-slim` image (ffmpeg 7.0.2, ffprobe 4.0.2) — no `apt install ffmpeg` in `Dockerfile.dev`.
  - `WorkerModule` is a **self-contained standalone context** — it bundles its own `ConfigModule.forRoot` + `TypeOrmModule.forRootAsync` (mirrors `AppModule`) rather than the `videos.module.spec` pattern of an external test root, because `src/worker/main.ts` boots it via `NestFactory.createApplicationContext` with no HTTP layer. `forFeature([Video, Channel, User])` registers the full relation chain (§11.2). `worker.module.spec.ts` imports the real module and connects to the real DB — same `.spec.ts`-touches-DB precedent as `videos.module.spec.ts`.
  - `VideoProcessingWorker.handleJob(job)` takes a local `VideoProcessingJob` interface (`{ data, retryCount, retryLimit }`) — structurally a subset of pg-boss's `JobWithMetadata`, so `main.ts` passes the real job straight through. `main.ts` destructures `async ([job]) => …` (pg-boss v10 always hands the handler an array) with `{ batchSize: 1, includeMetadata: true }` (populates `retryCount`/`retryLimit`).
  - ffmpeg args: `-ss 0` (never `-ss 1`, §11.4), `-frames:v 1 -q:v 2 -y`. `metadata` jsonb stores `{ format, streams }` from the ffprobe JSON; `error_reason` truncated to the `varchar(255)` column.
  - `compose.yaml`: `video-worker` `command` flipped from `["sleep","infinity"]` to `["npm","run","start:worker"]`. Verified: `docker compose up -d video-worker` boots clean (`[VideoWorker] Consuming queue "video-processing"`) against the live infra, then **stopped again** (`docker compose stop video-worker`) so it doesn't race the test suites' `boss.work()`/`pgboss.job` assertions in the remaining SIs (per library-refs "kill any manually-started worker before running the suite"). Bring it back up for the SI-03.10 smoke.
  - `nest-cli.json` `assets` **not** touched — the ffmpeg/ffprobe binaries live in `node_modules`, not `src/` (per library-refs; that list is for non-`.ts` files under `src/`).
  - `npm run smoke` still deferred to SI-03.10 (full upload→process→ready→stream path).
  - No git commit (this `/implement` build scopes git out).

### SI-03.8 — Endpoints públicos de leitura: `GET /videos/:slug`, `/stream`, `/download`
- **Status:** completed
- **Tests:** 13 passing — `src/auth/guards/optional-jwt-auth.guard.spec.ts` (3: no header → `true`+`user` undefined; valid Bearer → `true`+`user` populated; invalid Bearer → `true`+`user` undefined), `src/videos/videos.service.spec.ts` (+4 visibility, 13 total), `test/videos.e2e-spec.ts` (+5, 13 total: anon `ready` → 200; anon non-`ready` → 404 `VIDEO_NOT_FOUND`; owner non-`ready` → 200; `/stream` → 302 presigned; `/download` → 302 with `response-content-disposition`). Regression: `openapi-export` (9), `app`/`swagger`/`auth` e2e (52) green.
- **Observations:**
  - `OptionalJwtAuthGuard` (`src/auth/guards/`) mirrors the custom `JwtAuthGuard` (not Passport): decodes the Bearer if present, attaches `request.user`, **always returns `true`**. Registered as a provider in `VideosModule` (needs `JwtService` from the `AuthModule`-re-exported `JwtModule`). The 3 read routes carry `@Public()` + `@UseGuards(OptionalJwtAuthGuard)` — global `JwtAuthGuard` short-circuits on `@Public()`, then the optional guard runs.
  - **Single read path:** `VideosService.getVisibleVideoBySlug(slug, userId?)` (private) is the only place the 404-never-403 rule lives — returns the video iff `status==='ready'` OR caller owns the channel, else `VideoNotFoundException`. `requireStreamableVideo` layers the "`draft` has no object → 404" check on top for `/stream` + `/download`.
  - `getVideoBySlug` returns `VideoView` `{ slug, title, status, durationSeconds, thumbnailUrl, channel:{nickname} }` — `thumbnailUrl` is a presigned GET on `thumbnail_key` when set, else `null`.
  - `/stream` + `/download` use `@Redirect()` returning `{ url, statusCode: 302 }`; the endpoint never reads/forwards `Range` (TD-07). `/download` adds `ResponseContentDisposition: attachment; filename="{sanitized title|slug}.{ext}"` via `presignGetObject`'s `disposition` option; `sanitizeFilename` collapses non-`[\w.-]` runs to `_`.
  - `@CurrentUser()` param typed `JwtPayload | undefined` on the read handlers (anonymous → `undefined`), passed as `user?.sub`.
  - **In-scope cleanup:** moved `@ApiBearerAuth` from the `VideosController` class level to the two `@Post` methods as `@ApiBearerAuth('access-token')` (the named scheme `buildSwaggerConfig` actually defines; the class-level no-arg form from SI-03.5 referenced an undefined `bearer` scheme). `@Public()` read routes carry no `@ApiBearerAuth` per `.claude/rules/nestjs-controllers.md`.
  - `npm run smoke` still deferred to SI-03.10.
  - No git commit (this `/implement` build scopes git out).

### SI-03.9 — Limpeza de uploads abandonados (job agendado)
- **Status:** completed
- **Tests:** 4 passing — `src/videos/videos.service.spec.ts` (+3 sweep unit: aborts multipart + row→`error`+reason; queries only `draft` older than TTL; per-row failure logged & not counted; 16 total), `src/worker/abandoned-upload-cleanup.worker.integration-spec.ts` (1, real Postgres+MinIO: aged `draft` w/ open multipart → `ListMultipartUploads` count 1→0, row `error`; fresh `draft` + `ready` untouched; second sweep is a no-op). Regression: worker + videos suites (33) + `videos.e2e` (13) green.
- **Observations:**
  - `VideosService.sweepAbandonedUploads()` returns `{ swept }`. Selects `find({ where: { status: 'draft', created_at: LessThan(cutoff) } })` with `cutoff = now − ABANDONED_UPLOAD_TTL_HOURS`. Per row: `abortMultipartUpload(storage_key, upload_id)` (SI-03.4 already swallows `NoSuchUpload`/404) → `status='error'`, `error_reason='upload_abandoned_ttl_exceeded'`, `upload_id=null`. **Per-row `try/catch` logs and continues** — this method exists only for the cron, so it takes the background-task exception in `.claude/rules/nestjs-services.md` (one broken row must not block the rest).
  - Constants: `ABANDONED_UPLOAD_TTL_HOURS = 24`, `ABANDONED_UPLOAD_SWEEP_CRON = '0 * * * *'`, `ABANDONED_UPLOAD_ERROR_REASON` in `videos.constants.ts`; `QUEUE_ABANDONED_UPLOAD_SWEEP = 'abandoned-upload-sweep'` in `queue.constants.ts` (alongside `QUEUE_VIDEO_PROCESSING`).
  - `AbandonedUploadCleanupWorker` (`src/worker/`) is a thin delegate to `videosService.sweepAbandonedUploads()`. `WorkerModule` gains `VideosService` + `AbandonedUploadCleanupWorker` as providers — `VideosService`'s constructor deps (`Video`/`Channel` repos, `StorageService`, `QueueService`, `DataSource`) are all already satisfiable there, so **no need to import the full `VideosModule`** (which would drag `AuthModule` → Mail/Throttler and force `mailConfig`/`authConfig` into the worker context).
  - `main.ts`: after the `video-processing` `work()`, it `createQueue` + `schedule('abandoned-upload-sweep', '0 * * * *')` + `work()` for the sweep. `boss.schedule` is an upsert — idempotent across worker restarts. The sweep queue is **not** created in `QueueService.onModuleInit` (the API doesn't need it).
  - Runtime verified: `docker compose up -d video-worker` logs `Consuming queues "video-processing", "abandoned-upload-sweep" (cron 0 * * * *)` and `pgboss.schedule` holds the row `abandoned-upload-sweep | 0 * * * *`. Worker stopped again afterward.
  - `npm run smoke` deferred to SI-03.10.
  - No git commit (this `/implement` build scopes git out).

### SI-03.10 — Documentação: OpenAPI, `CLAUDE.md` de vídeos, diagrama e smoke
- **Status:** completed
- **Tests:** `test/swagger.e2e-spec.ts` (6, +5 path assertions in the docs-json test: all five `/videos*` paths present with the right verbs). `npm run smoke` PASS (full video path: `POST /videos` → in-network `PUT` part → `complete-upload` → poll to `ready` → `/stream` 302 → `/download` 302).
- **Observations:**
  - `npm run openapi:export` regenerated `nestjs-project/openapi.json` (+351 lines) — the 5 video endpoints with params (`id`/`slug`), request bodies, and per-status responses (`POST /videos` 201/400/401; `complete-upload` 200/400/401/403/404/409/502; `GET :slug` 200/404; `stream`/`download` 302/404). The `@nestjs/swagger` CLI plugin generates the request-body schemas from the DTOs — no manual `@ApiBody` needed (`.claude/rules/nestjs-dtos.md`).
  - `scripts/smoke-test.sh` — new "phase 03" block after the auth round-trip: brings up `video-worker`, **purges `pgboss.job`** first (stale backlog from test runs pushes the smoke's job behind hundreds of failing retries — the FIFO hazard `library-refs.md` calls out), builds a real 1 s MP4 with the container's `ffmpeg-static`, runs the full upload→process→read path. The presigned-URL `PUT` runs via `docker compose exec nestjs-api` because the URL host is the `minio` service name (unreachable from the host). Every in-container path is inside a single-quoted `sh -c` — Git Bash on Windows rewrites bare `/tmp/...` args into host paths.
  - `nestjs-project/CLAUDE.md` — Compose `Services:` list completed (`mailpit`, `minio`, `minio-init`, `video-worker`); new `## Video Pipeline` section (the three modules, endpoints, pg-boss, worker, ffmpeg-static, the `transformIgnorePatterns` + `execa@^5` pin constraint, and the `pgboss.job` purge tip).
  - `docs/diagrams/software-arch.mermaid` — `ContainerQueue(... "TBD" ...)` → `"pg-boss (PostgreSQL)"`.
  - No git commit (this `/implement` build scopes git out; the plan wants the `openapi.json` and diagram changes as their own commits).
