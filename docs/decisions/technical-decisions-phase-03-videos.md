---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-31
scope_description: "Upload and processing of large video files: object storage layout, background job queue, non-blocking 10GB upload, draft pre-registration, automatic metadata/thumbnail processing via a video worker, unique public URL, streaming and download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video module (entity, migration, DTOs, controller, service), the object-storage service, the processing queue, the separate video worker, and the streaming/download endpoints. Also owns the new Compose services (object storage + worker).
- `next-frontend/` — Frontend deferred: the video interface (upload UI, channel panel, player, public page) is explicitly out of scope for Phase 03 (Fase 04/05). No open decision in this document. The upload handshake and streaming/download contracts (TD-02, TD-07) are defined here so a later client — or the extended smoke test — can consume them without reopening the decision.

> **Continuity note.** A prior full execution of this phase closed the same set of decisions (branch `feature/phase-03-videos`, 8 SIs, green suite, `validation.md` clean). Per `PLAN.md` §5.1, where the current research surfaced the same options the `Decision` field is pre-filled with that prior choice; divergences from a research recommendation are marked ⚠️ with the reason. New research (Context7 + web, Aug 2026) found no reason to reopen any of them.

---

## TD-01: Tecnologia da fila de processamento em segundo plano

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` leaves the queue technology explicitly **"TBD"** (see `software-arch.mermaid` → `ContainerQueue(queue, "Message Queue", "TBD")`). This is the primary open stack decision of the phase. The queue carries video-processing jobs (`api → queue → worker`) and must offer at-least-once delivery, retry with back-off, a way to mark permanently-failed jobs, and acceptable operability inside Docker Compose. The current stack is NestJS 11 + PostgreSQL 17; there is **no Redis** and no message broker in `compose.yaml` today (only `nestjs-api`, `db`, `mailpit`).

**Options:**

### Option A: BullMQ + Redis
- Redis-backed job queue with typed jobs, retries/back-off, delayed & repeatable jobs, concurrency limits, and a mature dashboard (Bull Board). Requires adding a `redis` service to Compose.
- **Pros:** Highest throughput ceiling; richest job-queue feature set; best observability tooling in the Node ecosystem; large community and NestJS integration (`@nestjs/bullmq`).
- **Cons:** Adds Redis as a **new infrastructure dependency and failure domain** purely for auth-infrequent/video-processing jobs. Redis persistence must be configured to avoid job loss on restart. Two datastores to run, back up, and reason about in dev and prod.

### Option B: pg-boss (queue on PostgreSQL)
- Job queue implemented on PostgreSQL using `SELECT ... FOR UPDATE SKIP LOCKED` in a dedicated `pgboss` schema on the **same instance** already in the stack. Supports `retryLimit`/`retryDelay`/`retryBackoff`, cron `schedule()`, and (v10) dead-letter queues. v10 requires Node ≥ 20 and PostgreSQL ≥ 13 (both satisfied).
- **Pros:** **Zero new infrastructure** — reuses the existing Postgres container; jobs are transactional with domain writes (ACID, no dual-write between DB and queue); native cron scheduling covers the abandoned-upload sweep (`abandoned-upload-cleanup/TD-01`) without a second tool; simple backup/ops story.
- **Cons:** Throughput ceiling well below a Redis queue under heavy load (irrelevant at this project's scale); observability is "query the `pgboss.job` table" — no off-the-shelf dashboard; v10's transitive chain (`serialize-error` → `non-error`) is ESM-only and needs Jest `transformIgnorePatterns` entries for any suite that boots the real `AppModule` (see `PLAN.md` §11.1).

### Option C: RabbitMQ
- Dedicated AMQP broker with durable queues, acknowledgements, dead-letter exchanges, and delayed delivery (via plugin). NestJS has first-class microservice transport support.
- **Pros:** Purpose-built message broker; strong routing and DLX semantics; battle-tested at scale.
- **Cons:** Heaviest operational footprint of the three (broker to run, tune, and monitor); job-level semantics (progress, per-job retry state, scheduled sweeps) must be built on top; overkill for a single-worker, single-queue workload.

**Recommendation:** **Option B (pg-boss)** — the job volume (one job per upload) never approaches the throughput where Redis pays for itself, and PostgreSQL is already in the stack. pg-boss keeps job enqueue transactional with the `videos` row write, adds no container, and its native `schedule()` covers the orphan-upload sweep with the same dependency. An earlier research pass had recommended BullMQ+Redis on feature-completeness grounds; that recommendation is **not followed** ⚠️ because "avoid a second datastore" outweighs a throughput/observability advantage this workload will not exercise.

**Decision:** B (pg-boss) ⚠️ diverges from the earlier BullMQ recommendation — reason recorded above: no Redis in the stack, transactional enqueue, native cron for the cleanup sweep.
**Libraries:** `pg-boss@^10`

---

## TD-02: Estratégia de upload de vídeos de até 10GB sem travar a API

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file must reach object storage **without ever being buffered or streamed through the NestJS process** — routing it through the API is an automatic-fail per `PLAN.md` §8. The API's role is the control plane: pre-register the draft, hand the client the credentials/URLs to write directly to storage, and confirm completion. Both the uploading client and the API participate in the handshake, so the sequence is decided once here. Object storage itself is **not** open — the project targets S3-compatible storage, i.e. **MinIO in Docker** locally.

**Options:**

### Option A: Single presigned `PUT` (`PutObjectCommand` + `getSignedUrl`)
- API creates the draft and returns one presigned URL; the client `PUT`s the whole file in a single request directly to storage.
- **Pros:** Simplest possible flow — one URL, one request, no part bookkeeping; trivial to test.
- **Cons:** S3 single-`PUT` hard limit is **5GB** — cannot satisfy the 10GB requirement; no resume on connection failure (a dropped 9GB upload restarts from zero), which `project-plan.md` §4 explicitly calls out ("permitir retomar em caso de falha de conexão").

### Option B: Multipart upload with per-part presigned URLs
- API calls `CreateMultipartUpload`, persists the returned `UploadId`, and returns a presigned `UploadPart` URL per part. The client uploads parts directly to storage (in parallel, retrying individual parts), then calls the API's completion endpoint with the `{ partNumber, eTag }` list; the API issues `CompleteMultipartUpload`. Uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.
- **Pros:** Supports objects far beyond 10GB (up to 10,000 parts); a failed part is retried in isolation — effectively resumable; parts upload concurrently; the API still only ever sees small JSON control messages. Standard, well-documented S3 pattern that MinIO implements identically.
- **Cons:** More moving parts — the API must persist `UploadId`, expose an initiate and a complete endpoint, and handle the abandoned-multipart case (covered by `abandoned-upload-cleanup/TD-01`); the client must compute part sizes and collect ETags.

### Option C: API proxies the upload (streaming pass-through)
- Client uploads to a NestJS endpoint that streams the body to storage.
- **Pros:** Single origin for the client; no presigned-URL machinery.
- **Cons:** **Automatic fail** — ties up a Node request/socket for the entire multi-GB transfer, defeating "sem impacto na performance"; backpressure and timeout tuning are fragile; no resume.

### Option D: `tus` resumable upload protocol (`@tus/server`)
- Run a tus server (in the API or standalone) implementing the open resumable-upload protocol; a tus client uploads in resumable chunks.
- **Pros:** Purpose-built resumable protocol with a clean client story; storage-agnostic.
- **Cons:** Either the API proxies bytes again (Option C's problem) or the tus S3 store still uses multipart underneath (Option B with an extra dependency and protocol layer); adds `@tus/*` packages and a non-S3 mental model for marginal benefit over presigned multipart.

**Recommendation:** **Option B (multipart with per-part presigned URLs)** — the only option that clears the 10GB bar while keeping the file entirely off the API and giving per-part retry. Option A's 5GB ceiling disqualifies it; Options C/D reintroduce byte-proxying or extra protocol surface for no gain. Excluded explicitly: single `PUT` (size, no resume) and API proxy (auto-fail).

**Decision:** B (multipart S3 upload with per-part presigned URLs; API on the control plane only — initiate, issue `UploadPart` URLs, confirm via `CompleteMultipartUpload` + `HeadObject`).
**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

---

## TD-03: Detecção de conclusão do upload e gatilho do processamento

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** After the client finishes writing parts (TD-02), something must (a) finalize the object in storage, (b) verify it actually landed, (c) flip the video from `draft` to `processing`, and (d) enqueue the processing job (TD-01). The trigger mechanism is the decision.

**Options:**

### Option A: Client-confirmed completion endpoint + server-side verification
- `POST /videos/:id/complete-upload` with the `{ partNumber, eTag }[]` list → API calls `CompleteMultipartUpload`, then `HeadObject` to confirm size/existence → transitions status to `processing` → enqueues the job in one transaction.
- **Pros:** Deterministic and synchronous from the client's view; the API controls the state transition and the enqueue together; `HeadObject` catches a lying or truncated client; easy to test end-to-end against MinIO.
- **Cons:** Relies on the client remembering to call complete — an abandoned upload needs a separate sweep (`abandoned-upload-cleanup/TD-01`); a rare failure of `HeadObject` *after* a successful `CompleteMultipartUpload` needs its own error branch (`502 VIDEO_UPLOAD_VERIFICATION_FAILED`).

### Option B: Storage bucket notifications (MinIO/S3 events → webhook)
- Configure MinIO to POST an event to the API when an object is created under `videos/*/original.*`; the API reacts by enqueuing.
- **Pros:** No dependency on client cooperation; fires on the real storage event.
- **Cons:** MinIO event config is environment-specific infra (webhook target, auth) that must be wired in Compose and reproduced in prod S3 (EventBridge/SNS) — a different mechanism per environment; multipart completion still has to be triggered by *someone* (the client or the API), so this does not remove the completion call, only the enqueue trigger; harder to test deterministically.

### Option C: Polling job
- A scheduled job scans storage / `draft` rows and promotes any whose object now exists.
- **Pros:** No webhook, no client-trigger coupling.
- **Cons:** Added latency (poll interval) between upload and processing; still needs `CompleteMultipartUpload` from somewhere; wasteful scanning.

**Recommendation:** **Option A** — a client-confirmed endpoint with server-side `HeadObject` verification is the standard S3 multipart completion flow, keeps the state machine inside the API, and is straightforward to exercise in integration/e2e tests against MinIO. MinIO bucket notifications (Option B) are a reasonable **future** optimization but add per-environment infra now.

**Decision:** A (`POST /videos/:id/complete-upload` → `CompleteMultipartUpload` + `HeadObject` → flip to `processing` → enqueue job).

---

## TD-04: Organização de buckets e chaves no object storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** MinIO is a given (TD-02 context). What is decided here is the bucket/key layout for original files and generated thumbnails — it must be consistent between the storage service, the upload endpoints, the worker, and the streaming/download endpoints (a cross-file convention).

**Options:**

### Option A: Single bucket, per-video key prefix
- One bucket `streamtube`; keys `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** One bucket to create (`minio-init` one-shot) and configure; all artifacts of a video colocated under one prefix — trivial lifecycle cleanup (`delete prefix`); mirrors how the worker and endpoints think ("everything for video X").
- **Cons:** Bucket-level policy is shared between originals and thumbnails (fine here — both are served via presigned URLs).

### Option B: Separate buckets for videos and thumbnails
- `streamtube-videos` and `streamtube-thumbnails`.
- **Pros:** Independent lifecycle/policy per artifact type (e.g. public-read thumbnails, private originals).
- **Cons:** Two buckets to provision and keep in sync; per-video cleanup now spans two buckets; no real benefit while both are served through presigned URLs.

### Option C: Bucket per channel
- `channel-{channelId}` bucket holding that channel's videos.
- **Pros:** Natural tenant isolation.
- **Cons:** Dynamic bucket creation on channel creation couples the channels domain to storage; S3 accounts have bucket-count limits; cross-cutting operations (global cleanup, migration) become N-bucket loops. Over-engineered for the phase.

**Recommendation:** **Option A** — a single bucket with a per-video prefix is the simplest layout that keeps every artifact of a video together for cleanup and matches the access pattern of all four consumers. Policy differentiation (Option B) can be revisited if thumbnails ever need public-read.

**Decision:** A (single bucket `streamtube`; keys `videos/{id}/original.<ext>`, `videos/{id}/thumbnail.jpg`).

---

## TD-05: Toolchain e modelo de execução do worker de vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker consumes the queue (TD-01), pulls the original from storage, extracts duration + metadata (**ffprobe**), grabs one frame as a thumbnail (**FFmpeg**), writes the thumbnail back, and updates the row. Decisions: which FFmpeg binding, how FFmpeg binaries are packaged, and how the worker runs. NestJS is CommonJS via ts-jest, which constrains library choice (`PLAN.md` §11.1).

**Options:**

### Option A: Direct `ffmpeg`/`ffprobe` CLI via `execa` + static binaries
- Invoke the CLIs as child processes with `execa`; ship binaries via `ffmpeg-static` / `ffprobe-static` (no system package needed). Worker runs as a **separate Compose service** (`video-worker`) reusing the API image/bind-mount, entrypoint `npm run start:worker` → `src/worker/main.ts`.
- **Pros:** Thin, transparent layer — the exact CLI args are visible and match FFmpeg docs 1:1; `execa` gives clean error/exit-code handling; static binaries keep the image reproducible; a separate service isolates CPU-heavy work from the API and scales independently. `execa@5` is the last CommonJS major and works under Jest.
- **Cons:** `execa@10` and its ~15-package tree are ESM-only with an unshimmable link (`unicorn-magic` has no `require` export) — **must pin `execa@^5.1.1`** and `import execa from 'execa'` (v5 uses `export =`) (`PLAN.md` §11.1, §5.1 ⚠️). Manual arg construction (mitigated: only two commands).

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API over FFmpeg.
- **Pros:** Ergonomic chainable API; no manual arg strings.
- **Cons:** The package was **archived in 2025** — unmaintained; still needs FFmpeg binaries provided separately; abstraction hides the args you need to debug thumbnail extraction. Excluded.

### Option C: `ffmpeg.wasm` (WebAssembly)
- FFmpeg compiled to WASM, runs in-process.
- **Pros:** No native binary, no child process.
- **Cons:** Far slower than native for multi-GB inputs; high memory; single-threaded constraints; wrong tool for a server-side batch worker. Excluded.

### Option D: Hosted transcoding API (Mux, Coconut, AWS MediaConvert)
- Offload probe + thumbnail to a SaaS.
- **Pros:** Zero FFmpeg ops; production-grade output.
- **Cons:** External paid dependency, network egress of 10GB originals, vendor lock-in, offline dev needs mocking — contradicts "infra real, testada" and the self-hosted MinIO direction. Excluded.

**Recommendation:** **Option A** — direct CLI via `execa` + `ffmpeg-static`/`ffprobe-static`, worker as its own container. It is the most transparent and testable approach, adds no system-package step to the image, and isolates heavy processing from the API. Pin `execa@5` (last CJS major); `fluent-ffmpeg` is out (archived), WASM/SaaS are out (fit).

**Decision:** A (CLI via `execa@^5.1.1` + `ffmpeg-static` + `ffprobe-static`; separate `video-worker` Compose service; `handleJob` idempotent, re-throws on failure so pg-boss retry/backoff drives recovery).
**Libraries:** `execa@^5.1.1`, `ffmpeg-static`, `ffprobe-static`

---

## TD-06: Estratégia de URL única por vídeo

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique public identifier that never collides (`project-plan.md` §4: "URL curta e única que nunca conflite"). It appears in the public read/stream/download routes. The `videos` PK is already a UUID.

**Options:**

### Option A: Use the video UUID (PK) directly in the URL
- Route as `/videos/{uuid}`.
- **Pros:** Zero extra column or generation code; uniqueness guaranteed by the PK; no collision handling.
- **Cons:** 36-char, hyphenated, unfriendly public URL; exposes the internal identifier as the public one (couples internal PK format to the public contract); not "curta".

### Option B: Separate short slug via `nanoid`, unique column, retry-on-conflict
- A `slug varchar(10)` unique column populated with `nanoid(10)` on creation; on a `23505` unique violation, regenerate and retry (bounded loop) — mirroring the existing `ChannelsService` nickname pattern (`isPgUniqueViolationOnColumn` + `MAX_RETRIES`).
- **Pros:** Short, opaque, URL-friendly public id decoupled from the PK; collision probability at `nanoid(10)` is negligible and the retry loop makes it a non-issue; reuses a pattern already in the codebase (consistency).
- **Cons:** Extra column + index + generation code; `nanoid@5` is ESM-only (needs a `transformIgnorePatterns` entry, or pin `nanoid@3` for CommonJS) (`PLAN.md` §11.1).

### Option C: ULID
- 26-char lexicographically-sortable identifier (`ulid` package).
- **Pros:** Sortable by creation time; collision-resistant.
- **Cons:** Longer than a nanoid slug; time-ordering leaks creation timing and enables enumeration of "videos created near each other"; still an extra column.

### Option D: Hashids / sqids from an internal counter
- Encode a sequential integer into a short string.
- **Pros:** Short; reversible to the integer.
- **Cons:** Requires a monotonic counter column (not just the UUID PK); reversible → sequential IDs are guessable/enumerable; decode ambiguity edge cases.

**Recommendation:** **Option B** — a dedicated `nanoid` slug gives the short, friendly, non-enumerable public URL the plan asks for, decoupled from the internal UUID, and reuses the retry-on-unique-violation pattern already established for channel nicknames. The earlier research pass had recommended reusing the UUID directly (no extra column); that is **not followed** ⚠️ because "URL curta e amigável" is an explicit requirement and the slug pattern is already idiomatic in this codebase.

**Decision:** B (`slug varchar(10)` unique, `nanoid(10)`, retry-on-`23505` mirroring `ChannelsService`) ⚠️ diverges from the earlier "use the UUID" recommendation — reason: explicit short-URL requirement + existing nickname pattern.
**Libraries:** `nanoid@^5`

---

## TD-07: Estratégia de streaming e download do vídeo

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (`project-plan.md` §4), i.e. HTTP `Range`/`206 Partial Content` must work; a download endpoint must also deliver the file. The decision is whether the API serves the bytes or delegates to storage, and it constrains any client that plays or downloads a video.

**Options:**

### Option A: API proxies the bytes, handling `Range` itself
- Streaming/download endpoints read from storage and pipe to the response, parsing the `Range` header and setting `Accept-Ranges`, `Content-Range`, `Content-Type`, `206`.
- **Pros:** Single origin; API can enforce fine-grained per-request rules; no storage URL ever exposed.
- **Cons:** Every byte of every view transits the Node process — the same "don't move big files through the API" problem TD-02 avoids, now on the read path and at higher aggregate volume; range-parsing and stream-error handling are error-prone; no CDN offload path.

### Option B: `302` redirect to a presigned `GetObject` URL
- Streaming/download endpoints resolve the video (auth per the Authorization Matrix), then `302`-redirect to a short-lived presigned `GetObject` URL. The client's follow-up request goes straight to storage, which serves `Range`/`206` natively. Download adds `response-content-disposition=attachment` to the presigned URL. Uses `@aws-sdk/s3-request-presigner`.
- **Pros:** API stays on the control plane — it does authorization and issues a URL, nothing more; MinIO/S3 handles `Range`, `Content-Range`, partial content correctly out of the box; trivially swappable for a CDN in prod; endpoint is cheap and easy to test (assert `302` + `Location`).
- **Cons:** The presigned URL is briefly bearer-capable (short TTL mitigates); the storage host is visible to the client; per-request byte-level control is lost (acceptable — authorization happens before the redirect).

### Option C: Signed CDN URL (CloudFront-style)
- Put a CDN in front of storage and return signed CDN URLs.
- **Pros:** Best production performance and cache behavior.
- **Cons:** No CDN in the local/Compose environment — would be dev-only mocked infra; premature for this phase. (Option B is forward-compatible with adding this later.)

**Recommendation:** **Option B** — a `302` to a presigned `GetObject` keeps large-file bytes off the API on the read path exactly as TD-02 does on the write path, lets storage serve `Range`/`206` natively (the client's follow-up request negotiates partial content directly), and leaves a clean seam for a CDN in production. API proxying (Option A) is excluded for the same reason routing the upload through the API is.

**Decision:** B (`302` redirect to presigned `GetObject` for both `/stream` and `/download`; `/download` appends `response-content-disposition=attachment`; `Range`/`206` is served by storage on the client's follow-up request — the endpoint neither reads nor forwards the `Range` header).
**Libraries:** `@aws-sdk/s3-request-presigner@^3`

---

## TD-08: Ciclo de status do vídeo e tratamento de falhas de processamento

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The plan requires a status lifecycle (`rascunho → processando → pronto/erro`) reflected in the DB. This decision fixes the state set, the valid transitions, and what happens when processing fails (retry, terminal error, orphan-storage handling). It depends on TD-01 (the queue's retry semantics) and TD-03 (who flips `draft → processing`).

**Options:**

### Option A: 4-state enum + queue-native retry/back-off, terminal `error` with reason
- `status enum(draft | processing | ready | error)`, default `draft`. Transitions: `draft → processing` (TD-03 completion), `processing → ready` (worker success), `processing → error` (retries exhausted). Transient failures are absorbed by pg-boss retry (`retryLimit: 3`, `retryDelay: 5`, `retryBackoff: true`); when the worker sees `retryCount >= retryLimit` it sets `status = error` + `error_reason`, then re-throws so the queue records the final failure. No manual reprocessing surface this phase.
- **Pros:** Minimal, matches the plan's wording exactly; retry/back-off is delegated to the queue rather than hand-rolled; `error_reason` gives an operator a diagnosis; the `error` state plus the abandoned-upload sweep (`abandoned-upload-cleanup/TD-01`) covers every stuck-row case.
- **Cons:** No user-facing retry button (out of scope — Fase 04); orphan thumbnail/original cleanup on terminal error is a follow-up rather than automatic.

### Option B: Option A + explicit dead-letter queue and manual reprocess endpoint
- Failed jobs land in a DLQ; an admin endpoint re-enqueues them.
- **Pros:** Operator can recover a batch after fixing a worker bug; DLQ depth is an alerting signal.
- **Cons:** Adds an endpoint, an authz rule, and DLQ plumbing not asked for in Phase 03; pg-boss v10 has DLQ support that can be adopted later without a schema change. Premature.

### Option C: Fine-grained states (`uploading`, `uploaded`, `probing`, `thumbnailing`, `ready`, `failed`)
- One state per processing sub-step.
- **Pros:** Precise progress reporting.
- **Cons:** More transitions to enforce and test; the sub-steps run in one worker job with no consumer for the intermediate states in this phase; churn when the pipeline changes. Over-modeled.

**Recommendation:** **Option A** — a 4-state enum with `error_reason`, leaning on pg-boss's retry/back-off for transient failures and a terminal `error` state for exhausted ones, is exactly what the capability asks for and nothing more. DLQ/manual reprocess (Option B) is a clean future addition on pg-boss v10; fine-grained states (Option C) model progress no one consumes yet.

**Decision:** A (`draft → processing → ready | error`; transient failures → pg-boss retry `retryLimit: 3` / `retryDelay: 5` / `retryBackoff: true`; exhausted → `status = error` + `error_reason`; no DLQ/manual reprocess this phase).

---

## TD-09: Autorização e visibilidade das rotas públicas de leitura do vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Phase 02 registered a **global `JwtAuthGuard`** as `APP_GUARD` — every route is authenticated by default, with a binary `@Public()` opt-out (fully open or `401`, nothing between). Phase 03 adds read routes (`GET /videos/:slug`, `.../stream`, `.../download`) that must satisfy two requirements the global guard cannot express together: (1) `project-plan.md` §1 — "usuários anônimos podem assistir livremente", so a `ready` video must be reachable with no token; (2) the owner of a `draft`/`processing`/`error` video needs to reach their own not-yet-`ready` video (preview, retry-check, download) while nobody else can even learn it exists. The response code for a hidden video (`403` vs `404`) is a security-posture choice with cross-component reach — it must be identical across the guard, the service lookup, and all three controller routes, and it feeds the plan's **Authorization Matrix** and **Error Catalog**. `phase-02-auth/TD-07` (inherited) fixes only the error *envelope*, not who may read or what a non-owner sees. Depends on TD-06 (slug is the public key) and TD-08 (the `status` enum defines "not `ready`").

**Options:**

### Option A: `@Public()` + `ready`-only reads, no owner exception
- The three read routes are marked `@Public()` (fully anonymous). The service returns a video only when `status = ready`; any other status → `404` for everyone, including the owner. Owners learn their video's progress from the `POST /videos` / `complete-upload` responses or a separate authenticated status route.
- **Pros:** No new guard artifact; no user context needed on reads; anti-enumeration is automatic (every non-`ready` slug is `404` for all callers); smallest surface.
- **Cons:** The owner cannot stream/download/inspect their own video until processing finishes; "is my upload done?" needs an extra authenticated endpoint (more routes, not fewer); diverges from the prior execution's shipped behavior (`PLAN.md` §5.1/§11.5).

### Option B: New `OptionalJwtAuthGuard` + owner-aware visibility + `404` (never `403`) for hidden
- A new guard (`src/auth/guards/optional-jwt-auth.guard.ts`) mirrors `JwtAuthGuard` but: decodes the Bearer token **if present**, attaches `request.user`, and **always returns `true`** (no token → still allowed, `request.user` undefined). Applied together with `@Public()` on the three read routes. A single private `getVisibleVideoBySlug(slug, userId?)` in `VideosService` returns the video when `status = ready` **or** `userId` owns its channel; otherwise throws the domain `VIDEO_NOT_FOUND` → `404`. Non-owners and anonymice are indistinguishable from "slug never existed".
- **Pros:** Satisfies both requirements at once — anonymous watches `ready` videos, owner reaches their own in-progress videos, and the `404`-always rule closes the enumeration vector; one chokepoint keeps the rule consistent across the three routes; fits the codebase's existing hand-rolled-guard style (`JwtAuthGuard` is custom, not Passport); matches the prior execution's shipped, test-green design.
- **Cons:** One new guard + its unit tests; the guard must be added explicitly alongside `@Public()` on each read route (the global guard's model has no "optional" slot); `getVisibleVideoBySlug` must be the sole read path or the rule can drift.

### Option C: Keep auth required on reads + `403` for non-owners on non-`ready`
- Read routes stay under the global guard (valid JWT required). A `ready` video is returned to any authenticated user; a non-`ready` video returns `403` to non-owners, `200` to the owner.
- **Pros:** No optional-auth machinery; reuses the global guard unchanged.
- **Cons:** **Breaks the core product principle** — anonymous users cannot watch anything (`project-plan.md` §1); `403` on a non-`ready` video *confirms the video exists*, handing an enumeration oracle to any logged-in user; wrong posture for a public video platform and inconsistent with the anonymous-watch capabilities in Fase 05.

**Recommendation:** **Option B** — it is the only option that delivers anonymous playback of `ready` videos *and* owner access to in-progress videos while returning an indistinguishable `404` to everyone else. The `OptionalJwtAuthGuard` is a small, self-contained artifact consistent with the project's existing custom-guard approach, and centralising the rule in `getVisibleVideoBySlug` keeps the three routes from diverging. Option A is a viable fallback if the team wants zero new guards and accepts a separate owner-status endpoint; Option C is rejected on the product principle.

**Decision:** B (`OptionalJwtAuthGuard` — decode-if-present, never `401`, always allow — used with `@Public()` on the three read routes; `VideosService.getVisibleVideoBySlug(slug, userId?)` is the single read path: returns the video iff `status = ready` **or** the caller owns the channel, else `VIDEO_NOT_FOUND` → `404`; a non-owner never receives `403` for a non-`ready` video. `POST /videos` and `POST /videos/:id/complete-upload` still require the authenticated channel owner.)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia da fila | pg-boss ⚠️ (over earlier BullMQ+Redis rec.) | B (pg-boss) |
| TD-02 | Cross-layer | Upload de até 10GB sem travar a API | Multipart S3 + per-part presigned URLs | B (multipart presigned) |
| TD-03 | Backend | Detecção de conclusão + gatilho de processamento | Completion endpoint + `HeadObject` verify | A (client-confirmed + server verify) |
| TD-04 | Backend | Organização de buckets/chaves | Bucket único, prefixo por vídeo | A (single bucket `streamtube`) |
| TD-05 | Backend | Toolchain e execução do worker | CLI `ffmpeg`/`ffprobe` via `execa@5` + static binaries, container próprio | A (execa CLI + static binaries) |
| TD-06 | Backend | Estratégia de URL única | Slug `nanoid` + retry-on-conflict ⚠️ (over earlier "use UUID" rec.) | B (nanoid slug) |
| TD-07 | Cross-layer | Streaming e download | `302` redirect para presigned `GetObject` | B (302 redirect) |
| TD-08 | Backend | Ciclo de status e falhas | Enum de 4 estados + retry/backoff da fila | A (4-state enum + queue retry) |
| TD-09 | Backend | Autorização/visibilidade das rotas de leitura | `OptionalJwtAuthGuard` + `getVisibleVideoBySlug`, `404` anti-enumeração | B (optional-auth + 404-never-403) |

---

## Notes for the planning pipeline

- **Object storage is not a TD** — MinIO (S3-compatible) is a given from `project-plan.md` / `software-arch.mermaid`. `compose.yaml` gains `minio` + a one-shot `minio-init` (bucket create) alongside the `video-worker` service; the queue is pg-boss on the **same** Postgres instance (schema `pgboss`), no dedicated container.
- **New env namespaces** expected: storage (`STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`) and queue (connection string derived from the existing `DB_*` vars). `.env` / `.env.example` stay shell-safe.
- **Events/Messages** (required in `plan-build` because of the queue): one job type — video processing — published by the completion endpoint (TD-03), consumed by the worker (TD-05); plus the pg-boss `schedule()` cron for the abandoned-upload sweep (see the companion ad-hoc doc).
- **`plan-validate` will raise `MD-1`** (no TD covers an upload that is started but never completed — draft stuck forever + orphan multipart consuming storage). That is closed by the companion ad-hoc decision doc **`technical-decisions-abandoned-upload-cleanup.md`** (`related_phases: [3]`), not by widening TD-08.
- **ESM/Jest constraint** (`PLAN.md` §11.1) touches three of these decisions — pg-boss (TD-01), `execa` (TD-05), `nanoid` (TD-06). `plan-resolve` / `library-refs.md` must pin: `pg-boss`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `execa@^5.1.1`, `ffmpeg-static`, `ffprobe-static`, `nanoid` — and record the `transformIgnorePatterns` / version-pin implications.
- **Data Model** (`videos` table, channel-owned) is finalized in `plan-build`; TD-06 fixes the `slug` column, TD-08 fixes the `status` enum + `error_reason`, TD-02/TD-03 imply a persisted `upload_id`.
- **Authorization Matrix + Error Catalog** (`plan-build` Technical Specs): TD-09 fixes the read-route model — `POST` routes require the authenticated channel owner; the three read routes use `OptionalJwtAuthGuard` + `@Public()`; a video visible to a caller iff `status = ready` OR caller owns the channel, else `404` (`VIDEO_NOT_FOUND`), never `403`. New guard: `src/auth/guards/optional-jwt-auth.guard.ts`. TD-09 was added to close the `MD-1` (video-read authorization) that `plan-validate` raised on the first pass over this phase's `context.md`.
