---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-25
scope_description: "Background job queue technology, direct-to-storage large-file upload strategy, video processing worker toolchain (metadata + thumbnail via ffmpeg), object storage organization, unique video URL, streaming/download delivery, and video status lifecycle for Phase 03 (Upload e Processamento de Vídeos)."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that receives every new Phase 03 capability: object storage integration, queue producer, the video-processing worker (queue consumer), the `videos` migration/entity, and the REST endpoints for upload lifecycle, streaming and download.
- `next-frontend/` — Frontend explicitly out of scope for this phase per the challenge brief ("Há um frontend no repositório, mas a interface de vídeo não faz parte do escopo desta fase"). No open decision in this document.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` marks the Message Queue container as `"TBD"` — this is the phase's primary open stack decision. Video processing (ffprobe metadata extraction + ffmpeg thumbnail generation) is CPU/IO-heavy and must run outside the HTTP request/response cycle so uploads never block the API. The queue also carries the retry/backoff policy that TD-08 (status lifecycle) depends on.

**Options:**

### Option A: BullMQ + Redis
- Redis-backed job queue with an official first-party NestJS integration (`@nestjs/bullmq`). Producers call `Queue.add()`, a `@Processor` class consumes jobs. Built-in delayed jobs, priorities, per-job `attempts` + exponential `backoff`, and a free inspection UI (Bull Board).
- **Pros:** Official NestJS module, actively maintained, largest ecosystem for Node job queues. Native retry/backoff maps directly onto TD-08's failure-handling model. Bull Board gives immediate visual job/failure inspection during development and grading. Redis is a well-understood, single-purpose addition to `compose.yaml`.
- **Cons:** Adds a new infrastructure dependency (Redis) that nothing else in the stack currently needs. In-memory broker — job data is not part of the durable PostgreSQL transaction boundary (acceptable here since jobs only carry a video id + storage key, not the file itself).

### Option B: RabbitMQ (`amqplib` / `@golevelup/nestjs-rabbitmq`)
- AMQP 0-9-1 message broker. NestJS integrates via a community module (`@golevelup/nestjs-rabbitmq`) or the built-in `@nestjs/microservices` RMQ transport. Exchanges/queues/bindings model routing explicitly.
- **Pros:** Mature, battle-tested broker; strong at cross-language/multi-service topologies and complex routing. Durable queues with acknowledgment semantics.
- **Cons:** Heaviest operational model of the three (exchange/queue/binding topology, a full broker to run and monitor) for what is here a single producer (API) and single consumer (worker) — no polyglot or multi-service fan-out to justify the complexity. No official first-party NestJS module (community-maintained integration).

### Option C: pg-boss (PostgreSQL-native queue)
- Implements a job queue on top of PostgreSQL using `SKIP LOCKED` for safe concurrent job pickup, with ACID guarantees since jobs live in the same database as the rest of the domain data.
- **Pros:** No new infrastructure — reuses the PostgreSQL instance already in the stack. Jobs are transactionally consistent with domain writes. Simple operational model (one dependency less than A or B).
- **Cons:** Mixes high-churn job-queue writes into the same database and connection pool as core domain data. Smaller ecosystem than BullMQ — no equivalent to Bull Board, thinner retry/backoff configuration surface, less NestJS-specific documentation.

**Recommendation:** **Option A (BullMQ + Redis)** — the project already needs to introduce new containers this phase (object storage, worker) regardless, so Option C's "no new infra" advantage is diluted, while BullMQ's official NestJS integration and native retry/backoff give TD-08's failure-handling model a direct, well-documented implementation path with the least custom code. RabbitMQ's topology flexibility solves a multi-service/polyglot problem this phase doesn't have.

**Decision:** Option C: pg-boss (PostgreSQL-native queue)

**Libraries:** pg-boss

---

## TD-02: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Files up to 10GB must not hold an API request/connection for the duration of the transfer, and per `docs/project-plan.md` §4 ("Pontos de Atenção"), the upload must be resumable after a connection failure. A single presigned `PUT` to S3-compatible storage caps at 5GB and offers no mid-transfer resume, so it cannot satisfy the 10GB requirement on its own and is excluded outright as a candidate.

**Options:**

### Option A: S3-compatible Multipart Upload with per-part presigned URLs
- API creates the multipart upload (`CreateMultipartUpload`) against the object storage and issues one presigned `UploadPart` URL per part (typical part size 5-25MB); the client uploads each part directly to storage, then calls the API to `CompleteMultipartUpload` once all parts succeed. Failed/interrupted parts are simply re-requested and re-uploaded against the same `uploadId`.
- **Pros:** Uses the storage that's already fixed (S3-compatible MinIO) with no extra server component. Resumability falls out naturally — only failed parts are retried, not the whole file. Matches the target architecture's intent that bulk data bypasses the API.
- **Cons:** Client is responsible for orchestrating part upload order/retries and tracking `ETag`s per part to submit at completion — real but well-documented complexity, typically handled by a small client-side upload manager.

### Option B: tus resumable-upload protocol
- Standing up a `tusd` server (or an equivalent Node tus server) configured with an S3 storage backend; the client speaks the tus protocol (`PATCH` with byte offsets) to `tusd`, which internally performs its own multipart upload to the S3-compatible backend.
- **Pros:** Purpose-built, well-specified resumable-upload protocol with mature client libraries (Uppy, tus-js-client). Resume semantics are protocol-level, not custom code.
- **Cons:** Introduces an entire additional server component (`tusd`) whose only job is to bridge to the same S3-compatible backend Option A talks to directly — redundant infrastructure for no capability gain, since MinIO/S3 already provide native multipart resumability.

### Option C: Proxied upload through the NestJS API _(excluded — recorded for context)_
- Client uploads the full file to the API (`multer` streaming to disk or memory), which then relays it to storage.
- **Pros:** Simplest code path, no client-side multipart orchestration.
- **Cons:** This is the exact anti-pattern the phase explicitly prohibits ("passar o arquivo inteiro pela API é o caminho errado" — automatic failure per the challenge's acceptance criteria). A 10GB relay ties up an API request/connection and process memory/disk for the full transfer duration, defeating "sem impacto na performance."

**Recommendation:** **Option A (S3-compatible Multipart Upload, direct client-to-storage)** — it needs no new server component beyond what's already fixed (object storage), resumability is a native multipart-upload property, and it keeps the API on the control plane (authorizing, issuing presigned part URLs, confirming completion) rather than the data plane. Option B provides equivalent resumability but at the cost of operating a second server whose only purpose is to re-implement what the storage backend already does natively.

**Note:** `docs/diagrams/software-arch.mermaid` currently shows `Rel(api, storage, "Uploads")`, a simplified pre-Phase-03 relation. This decision refines the actual data path to client→storage direct upload (the API only issues presigned URLs and confirms completion) — the diagram should be updated to reflect this once the decision is confirmed.

**Decision:** Option A: S3-compatible Multipart Upload with per-part presigned URLs

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Upload Completion Detection & Processing Trigger

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** TD-02 moves the file bytes directly from client to storage, bypassing the API. The system still needs a reliable signal that the upload finished so it can flip the video's status out of `draft` and enqueue the processing job (TD-01). Depends on TD-02 (upload strategy).

**Options:**

### Option A: Client-confirmed completion endpoint
- After all parts succeed, the client calls an authenticated endpoint (e.g. `POST /videos/:id/complete-upload`) with the part ETags. The API calls `CompleteMultipartUpload`, then verifies the object really exists (`HeadObject`/size check) before flipping status to `processing` and enqueueing the job.
- **Pros:** Simplest to implement and to exercise end-to-end in tests (a single new endpoint against the real MinIO container per project testing conventions). Server-side `HeadObject` verification closes the "client lies about completion" gap without extra infrastructure.
- **Cons:** Still nominally trusts a client-initiated call as the trigger, even though the API independently verifies the object before acting on it.

### Option B: Storage event notification (MinIO bucket notification webhook)
- MinIO is configured (via `mc event add` or bucket notification config) to POST to a dedicated internal API endpoint whenever an object completes in the videos prefix; that endpoint flips status and enqueues the job — fully independent of client behavior.
- **Pros:** True event-driven pattern, matches how S3 Event Notifications work in production AWS; removes any reliance on the client calling back at all.
- **Cons:** Requires extra moving parts for this phase: MinIO notification configuration at container bootstrap, and an internal endpoint reachable from the MinIO container (network/auth considerations for a machine-to-machine call inside Compose).

### Option C: Polling worker
- A background job periodically lists the bucket (or in-progress multipart uploads) looking for newly completed objects not yet marked processed.
- **Pros:** No client trust, no storage-side webhook configuration.
- **Cons:** Adds latency proportional to the poll interval and constant background load for no benefit over A or B.

**Recommendation:** **Option A (client-confirmed completion endpoint with server-side verification)** — for this phase's scope (functional correctness exercised by integration/e2e tests against real Compose infrastructure, not hardening against adversarial clients), a single new endpoint that itself verifies the object via `HeadObject` before acting is the least infrastructure for a correct result. Option B is the architecturally "purer" event-driven approach and is worth adopting later if untrusted third-party clients become a real threat model — the MinIO notification wiring is straightforward to add on top of Option A's data model without a status-model change.

**Decision:** Option A (client-confirmed completion endpoint with server-side verification)

---

## TD-04: Object Storage Bucket & Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The object storage technology itself is fixed (S3-compatible; MinIO locally, swappable for real S3 in production per `docs/project-plan.md`/CLAUDE.md). What's open is how buckets and keys are organized for the two asset types (original video files and generated thumbnails).

**Options:**

### Option A: Single bucket, prefixed keys per video id
- One bucket (e.g. `streamtube`), keyed as `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** Single bucket to provision (one Compose/MinIO-client bootstrap step). Both assets for a video share a stable prefix — trivial to enumerate or delete together when a video is removed. Presigned URL logic doesn't need to branch on asset type.
- **Cons:** A single bucket-level policy (lifecycle rules, access policy) applies to both asset types if one is ever needed — not a constraint Phase 03 has yet.

### Option B: Two buckets, one per asset type
- `videos` bucket keyed `{videoId}.<ext>`, `thumbnails` bucket keyed `{videoId}.jpg`.
- **Pros:** Independent lifecycle/access policies per asset type from day one (e.g., if thumbnails ever become publicly cacheable while videos stay presigned-only).
- **Cons:** Two buckets to provision and reference throughout the codebase. No current requirement (public thumbnails, differing retention) justifies the split yet.

**Recommendation:** **Option A (single bucket, prefixed keys)** — nothing in Phase 03's capabilities requires differentiated bucket-level policy between videos and thumbnails yet, and a shared `videos/{videoId}/...` prefix keeps both assets discoverable and deletable as a unit. Splitting into per-type buckets is a low-cost migration later if a real policy difference emerges (e.g., in Phase 04/05 visibility work).

**Decision:** Option A (single bucket, prefixed keys)

---

## TD-05: Video Processing Worker Toolchain

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture names the Video Worker container as "FFmpeg"-based. The worker needs to run `ffprobe` (metadata: duration, codec, resolution) and `ffmpeg` (thumbnail: single frame extraction) as part of its job handler. The formerly ubiquitous `fluent-ffmpeg` wrapper was archived in May 2025 and no longer works reliably with recent ffmpeg versions — it is excluded despite still appearing in most existing tutorials/training material.

**Options:**

### Option A: Direct `ffmpeg`/`ffprobe` CLI invocation via `child_process`
- Spawn the `ffmpeg`/`ffprobe` binaries directly (via Node's `child_process.execFile`/`spawn`, or the `execa` convenience wrapper for cleaner promise/stream ergonomics), with binaries provisioned by `ffmpeg-static`/`ffprobe-static` npm packages or installed via `apt` in the worker's Dockerfile.
- **Pros:** No wrapper-library maintenance risk — talks to the CLI directly. Both operations needed here are simple, well-documented one-shot commands (`ffprobe -print_format json -show_format -show_streams`; `ffmpeg -ss <t> -i <in> -frames:v 1 <out.jpg>`) that don't benefit from a fluent builder API. Minimal dependency surface.
- **Cons:** No built-in progress-event abstraction (not needed here — jobs are one-shot extract operations, not multi-stage transcodes with progress reporting).

### Option B: `mediaforge` (modern TypeScript ffmpeg wrapper)
- A 2026-era, fully-typed TypeScript wrapper around the system ffmpeg binary, positioned as `fluent-ffmpeg`'s spiritual successor — zero native bindings, fluent builder API.
- **Pros:** Modern TypeScript-first API, actively positioned as the direct replacement for the abandoned `fluent-ffmpeg`.
- **Cons:** Very young library (first releases in 2026) with minimal adoption/track record — a maintenance-risk concentration in a component the entire processing pipeline depends on, for a fluent-builder convenience this phase's simple one-shot commands don't need.

**Recommendation:** **Option A (direct CLI invocation via `child_process`/`execa`)** — the two operations Phase 03 needs (metadata extraction, single-frame thumbnail) are simple one-shot CLI calls, not multi-stage pipelines that would benefit from a fluent builder. Avoiding both the dead `fluent-ffmpeg` and the unproven `mediaforge` keeps the worker's core dependency surface to the ffmpeg/ffprobe binaries themselves. Binary provisioning (`ffmpeg-static`/`ffprobe-static` packages vs. `apt`-installed in the worker's own Dockerfile) is an implementation detail for `implement`, not a strategic fork.

**Decision:** Option A (direct CLI invocation via `child_process`/`execa`)

**Libraries:** execa, ffmpeg-static, ffprobe-static

---

## TD-06: Unique Video URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a unique, conflict-free public identifier. Every existing entity in the project (`users`, `channels`) is keyed by a `uuid_generate_v4()` primary key referenced directly, with no vanity-slug layer.

**Options:**

### Option A: Use the video entity's UUID primary key directly as the URL segment
- Public video URL is `/videos/{uuid}`, where `{uuid}` is the same `id` column used internally.
- **Pros:** Uniqueness is already guaranteed by the PostgreSQL primary key — zero additional code, no collision-retry logic, no new dependency. Consistent with the convention already established for `users` and `channels`.
- **Cons:** UUIDs are long and not human-friendly in a shared link — a cosmetic concern only.

### Option B: Separate short slug (e.g., `nanoid`) as the public identifier
- Generate a short random slug (e.g., 8-10 chars via `nanoid`) at video creation, stored in a unique-indexed column, exposed as the URL segment instead of the raw UUID.
- **Pros:** Shorter, marginally friendlier URLs.
- **Cons:** Needs a new dependency, a uniqueness constraint, and (in principle) collision-retry logic on generation. No stated Phase 03 requirement for short/human-readable URLs.

**Recommendation:** **Option A (UUID primary key directly)** — reuses the exact convention already in place for every other entity in the project, with uniqueness enforced by the database for free. Introducing a slug generator only pays for itself against an explicit "short URL" product requirement, which Phase 03 does not state.

**Decision:** Option B: Separate short slug (e.g., `nanoid`) as the public identifier

**Libraries:** nanoid

---

## TD-07: Streaming & Download Delivery Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Both playback (streaming, with `Range`/`206 Partial Content` support) and full download need to serve the video's bytes from object storage to the requester. `docs/diagrams/software-arch.mermaid` already shows `Rel(frontend, storage, "Streams", "HTTPS")` — the frontend streaming directly from storage, not through the API.

**Options:**

### Option A: API proxy
- The API streams bytes to the client itself: it forwards the incoming `Range` header to storage's `GetObject` (same `Range` param), then pipes the resulting stream through its own response, setting `206 Partial Content` and `Content-Range` itself (e.g., via `StreamableFile`).
- **Pros:** Single choke point for authorization/access checks on every byte range served. No presigned-URL expiry semantics to reason about.
- **Cons:** Every second of every video watched doubles bandwidth and holds an open connection through the API process, for no behavior MinIO/S3 doesn't already implement correctly.

### Option B: Presigned GET redirect
- The API authorizes the request and issues a short-lived presigned `GetObject` URL, then redirects (or returns the URL for the client's `<video>`/download UI to use directly). The client/browser fetches bytes directly from storage, which natively serves `Range` requests and `206` responses.
- **Pros:** Matches the architecture already drawn in the diagram (`frontend → storage`, direct). The API only does authorization + URL issuance — no byte relay, no proxy load. The same presigned-GET mechanism covers both streaming (ranged GETs from a video element) and download (a `response-content-disposition=attachment` override param on the same presigned URL).
- **Cons:** Presigned URL expiry window must be chosen sensibly (long enough for a full-length viewing session or download, short enough to bound URL-leak exposure).

**Recommendation:** **Option B (Presigned GET redirect)** — this is the relation the project's own architecture diagram already commits to. Proxying (Option A) reintroduces exactly the bandwidth/connection cost the direct-upload decision (TD-02) was designed to avoid on the write path, on the read path instead, for zero functional gain since Range/206 is already correctly implemented by S3-compatible storage.

**Decision:** Option B (Presigned GET redirect)

**Libraries:** @aws-sdk/s3-request-presigner

---

## TD-08: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The phase brief itself names the intended cycle (`rascunho → processando → pronto/erro`); what's genuinely open is the failure-handling policy around it — what happens when the worker's processing job (TD-05) fails. Depends on TD-01 (queue technology, which supplies the retry/backoff mechanism).

**Options:**

### Option A: Fixed 4-state enum with queue-native retry/backoff
- `draft → processing → ready | error`. Transient failures are absorbed by the queue's own retry configuration (e.g., BullMQ `attempts: 3` + exponential `backoff`). Only after attempts are exhausted does the job mark the video `error`, storing an error message/reason on the row. No automatic retry after that — reprocessing (if ever added) is a manual/future action.
- **Pros:** A small number of automatic retries absorbs transient failures (a brief storage hiccup, a killed ffmpeg process on container restart) without any additional infrastructure beyond what TD-01 already provides. Matches the phase brief's stated cycle exactly.
- **Cons:** No operator tooling to inspect/replay failed jobs beyond what the queue's own dashboard (e.g., Bull Board) provides.

### Option B: Same states, zero automatic retry
- Same 4-state enum, but the first processing failure immediately marks the video `error` — no retry attempts.
- **Pros:** Simplest possible failure handling.
- **Cons:** Any transient failure (not just a genuinely broken file) becomes a permanent, user-visible failure requiring a full re-upload to recover.

### Option C: Same states plus a dead-letter queue and manual reprocess tooling
- Adds a dedicated failed-job queue and an operator-facing endpoint/mechanism to re-enqueue a failed video for reprocessing.
- **Pros:** Full operational visibility and recovery path for failed jobs.
- **Cons:** Disproportionate for the project's current scale — not required by any stated Phase 03 capability, and can be layered on top of Option A later without a status-model change.

**Recommendation:** **Option A (fixed 4-state enum with queue-native retry/backoff)** — it directly reuses the retry/backoff mechanism the queue technology (TD-01) already provides, requires no additional infrastructure, and lands exactly on the state cycle the phase brief specifies. Option C's operational tooling is worth adding later if operational failure volume warrants it, without changing the status model established here.

**Decision:** Option A (fixed 4-state enum with queue-native retry/backoff)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | A (BullMQ + Redis) | C (pg-boss) |
| TD-02 | Backend | Large File Upload Strategy | A (S3-compatible Multipart Upload, direct client-to-storage) | A (S3-compatible Multipart Upload, direct client-to-storage) |
| TD-03 | Backend | Upload Completion Detection & Processing Trigger | A (Client-confirmed completion endpoint, server-verified) | A (Client-confirmed completion endpoint, server-verified) |
| TD-04 | Backend | Object Storage Bucket & Key Organization | A (Single bucket, prefixed keys) | A (Single bucket, prefixed keys)  |
| TD-05 | Backend | Video Processing Worker Toolchain | A (Direct CLI invocation via child_process/execa) | A (Direct CLI invocation via child_process/execa) |
| TD-06 | Backend | Unique Video URL Strategy | A (UUID primary key directly) | B: Separate short slug (e.g., `nanoid`) as the public identifier |
| TD-07 | Backend | Streaming & Download Delivery Strategy | B (Presigned GET redirect) | B (Presigned GET redirect) |
| TD-08 | Backend | Video Status Lifecycle & Failure Handling | A (4-state enum, queue-native retry/backoff) | A (4-state enum, queue-native retry/backoff) |
