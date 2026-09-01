# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube` (also hosts the pg-boss job queue in the `pgboss` schema)
- `mailpit` — SMTP sink + web UI (`1025` / `8025`)
- `minio` — S3-compatible object storage, API `9000`, console `9001`, user/password `streamtube`
- `minio-init` — one-shot: creates the `streamtube` bucket, then exits `0` (expected — not a failure)
- `video-worker` — standalone Nest context (`npm run start:worker`) consuming the video-processing and abandoned-upload-sweep queues; reuses the API image + bind mount

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Video Pipeline

Three modules cooperate on video upload and processing (Phase 03):

- **`src/videos/`** — `VideosModule`, `VideosController`, `VideosService`, `StorageService`, `Video` entity.
  - `POST /videos` — starts a multipart upload: pre-registers a `draft` row on the caller's channel and returns one presigned `UploadPart` URL per 64 MiB part. The file bytes go **client → object storage directly**; they never transit the API. 10 GiB cap.
  - `POST /videos/:id/complete-upload` — owner sends back the part `ETag`s; the service `CompleteMultipartUpload`s, `HeadObject`-verifies, then in one transaction flips `draft → processing`, clears `upload_id`, and enqueues a `video-processing` job.
  - `GET /videos/:slug` — public metadata; `GET /videos/:slug/stream` and `/download` — `302` redirect to a short-lived presigned `GetObject` URL (download adds a `Content-Disposition: attachment`). All three are `@Public()` + `OptionalJwtAuthGuard`: a non-owner sees a video only once it is `ready`, otherwise `404` (never `403` — anti-enumeration). The rule lives in the single private `VideosService.getVisibleVideoBySlug`.
  - `StorageService` wraps `@aws-sdk/client-s3` against MinIO (`forcePathStyle: true`). Object layout: `videos/{id}/original.<ext>` and `videos/{id}/thumbnail.jpg` (single bucket).
- **`src/queue/`** — `QueueModule` / `QueueService` own the **pg-boss** client. pg-boss runs on the existing PostgreSQL instance (`pgboss` schema) — no separate broker. `QueueService.onModuleInit` starts the client and `createQueue`s `video-processing`; `onModuleDestroy` stops it gracefully. Job queue names are in `src/queue/queue.constants.ts`.
- **`src/worker/`** — `WorkerModule` is a standalone Nest context (no HTTP) run by `npm run start:worker` (`src/worker/main.ts`) in the `video-worker` container.
  - `VideoProcessingWorker` consumes `video-processing`: downloads the original to a tempdir, runs `ffprobe` (fills `duration_seconds` + `metadata`) and `ffmpeg -ss 0 -frames:v 1` (thumbnail), uploads the thumbnail, moves the row to `ready`. On failure it re-throws so pg-boss drives retry/backoff (`retryLimit: 3`); on the final attempt it first sets `status = 'error'` + `error_reason`.
  - `AbandonedUploadCleanupWorker` consumes the scheduled `abandoned-upload-sweep` (pg-boss cron `0 * * * *`): reclaims `draft` rows older than 24h — aborts the orphan multipart and sets `status = 'error'`, `error_reason = 'upload_abandoned_ttl_exceeded'`.
  - ffmpeg/ffprobe binaries come from `ffmpeg-static` / `ffprobe-static` (no `apt install`). `ffprobe-static` has no types → `src/types/ffprobe-static.d.ts`.

Config: `src/config/storage.config.ts` (`STORAGE_*` env) and `src/config/queue.config.ts` (derives the pg-boss connection string from `DB_*`).

**Jest + ESM:** `pg-boss` and `nanoid` are ESM-only and break ts-jest unless allow-listed. `transformIgnorePatterns` in **both** `package.json` (jest) and `test/jest-e2e.json` must keep `pg-boss|serialize-error|non-error|type-fest|nanoid`. `execa` is pinned to `^5` (last CommonJS major) — do **not** upgrade it.

**Local end-to-end check:** `npm run smoke` (host) exercises the real running app including the full video path (upload → process → `302` stream). If the worker's job backlog grows across sessions, purge it: `docker compose exec db psql -U streamtube -c "DELETE FROM pgboss.job"`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
