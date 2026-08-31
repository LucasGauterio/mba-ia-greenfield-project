---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-25T20:21:44-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-25T20:21:33-03:00"
  docs/project-plan.md: "2026-08-19T18:32:40-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-25T19:34:19-03:00"
  docs/decisions/technical-decisions-abandoned-upload-cleanup.md: "2026-08-25T19:34:24-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-19T18:32:40-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-19T18:32:40-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-19T18:32:39-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB sem travar a API (multipart direto ao storage), pré-cadastro automático do vídeo como rascunho, processamento automático em segundo plano (extração de duração/metadados e geração de thumbnail), URL única por vídeo, streaming e download — com a infraestrutura nova de object storage e fila de processamento subindo via Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: object storage e worker de vídeo no Compose

**Description:** Provisiona o object storage (MinIO) e o container do worker de vídeo no `compose.yaml`, com o bucket bootstrapado e as libs de storage instaladas.

**Technical actions:**

1. Adicionar serviço `minio` ao `compose.yaml` (object storage S3-compatible) + bootstrap do bucket (`mc mb` via container de init one-shot) — per `phase-03-videos/TD-04`
2. Criar `src/config/storage.config.ts` via padrão `registerAs` (convenção herdada da Fase 01) expondo endpoint, bucket, credenciais
3. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` — per `phase-03-videos/TD-02`
4. Adicionar serviço `video-worker` ao `compose.yaml` (processo/container separado que roda os workers da fila) — per `phase-03-videos/TD-01`, `TD-05`
5. Instalar `execa`, `ffmpeg-static`, `ffprobe-static` no worker — per `phase-03-videos/TD-05`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- O container `minio` sobe saudável via `docker compose up -d` e o bucket configurado existe após o bootstrap
- O container `video-worker` builda e permanece rodando (sem crash loop) após `docker compose up -d`

---

### SI-03.2 — Infra: fila pg-boss

**Description:** Provisiona a fila de processamento (pg-boss, reutilizando o PostgreSQL já existente) e a queue `video-processing` com política de retry/backoff.

**Technical actions:**

1. Instalar `pg-boss` — per `phase-03-videos/TD-01`
2. Criar `src/config/queue.config.ts` via padrão `registerAs`, reutilizando a connection string de `databaseConfig` (convenção herdada da Fase 01)
3. Criar `QueueModule` (global) que instancia e inicia o pg-boss no bootstrap da app, expondo-o para injeção
4. Criar a queue `video-processing` via `createQueue()` com `retryLimit`/`retryBackoff` — per `phase-03-videos/TD-01`, `TD-08`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- A app sobe com sucesso com `QueueModule` registrado e a queue `video-processing` criada no schema do pg-boss
- Reiniciar a app não gera erro ao chamar `createQueue()` novamente (idempotente)

---

### SI-03.3 — Migration: entidade Video

**Description:** Cria a entidade `Video` e a migration correspondente per o Data Model desta fase.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` per `### Data Model → Video`
2. Criar migration `<timestamp>-CreateVideos.ts` — tabela, enum de status, índices
3. Criar o enum `VideoStatus` (`draft` \| `processing` \| `ready` \| `error`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: constraints (FK `channel_id`, unique `slug`), defaults (`status = 'draft'`) | `video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas do Data Model e o índice único em `slug`
- Inserir dois vídeos com o mesmo `slug` viola a constraint de unicidade
- Inserir um vídeo sem `channel_id` viola a constraint not-null

---

### SI-03.4 — Endpoint POST /videos (iniciar upload)

**Description:** Cria o endpoint que pré-cadastra o vídeo como rascunho e inicia o multipart upload, retornando as presigned URLs por parte.

**Technical actions:**

1. Criar `VideosModule`, registrar `TypeOrmModule.forFeature([Video])`
2. Criar `StorageService` (encapsula `@aws-sdk/client-s3` + `s3-request-presigner`) como provider injetável
3. Criar `CreateVideoDto` (`title` opcional; `fileName`, `fileSize`, `contentType` obrigatórios) com `class-validator` — convenção herdada de `phase-02-auth/TD-06`
4. Criar `VideosService.initiateUpload()` — gera `slug` via `nanoid` (per `phase-03-videos/TD-06`), chama `CreateMultipartUploadCommand`, calcula partes e presigned `UploadPart` URLs, persiste o rascunho
5. Criar `VideosController.create()` — `POST /videos`, guard JWT, per `### API Contracts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: branch logic (mock repo + mock storage) — validação de `fileSize`, geração de `slug` | `videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: DB contract — rascunho criado com os campos corretos | `videos.service.integration-spec.ts` |
| `POST /videos` | E2E: validation wiring + auth enforcement | `videos.e2e-spec.ts` |

**Dependencies:** SI-03.1 (storage client) + SI-03.3 (entidade Video)

**Acceptance criteria:**

- `POST /videos` com body válido e JWT válido retorna `201` com `id`, `slug`, `status: draft`, `uploadId` e `parts` (array de presigned URLs)
- `POST /videos` com `fileSize` acima de 10GB retorna `400 VIDEO_FILE_TOO_LARGE`
- `POST /videos` sem JWT retorna `401`
- Chamadas concorrentes a `POST /videos` nunca produzem `slug`s colidentes

---

### SI-03.5 — Endpoint POST /videos/:id/complete-upload

**Description:** Cria o endpoint que finaliza o multipart upload, verifica o objeto no storage e enfileira o processamento.

**Technical actions:**

1. Criar `CompleteUploadDto` (`parts`: array de `{ partNumber, eTag }`) com validação
2. Criar `VideosService.completeUpload()` — checagem de ownership e status (`draft`), `CompleteMultipartUploadCommand`, verificação via `HeadObjectCommand`, flip de status para `processing`, enfileira job `video-processing` — per `phase-03-videos/TD-03`, `TD-01`
3. Criar `VideosController.completeUpload()` — `POST /videos/:id/complete-upload`
4. Mapear falha de verificação para `502 VIDEO_UPLOAD_VERIFICATION_FAILED`, ownership para `403 VIDEO_NOT_OWNED`, status incorreto para `409 VIDEO_UPLOAD_ALREADY_COMPLETED`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branch logic (mock repo, storage, queue) — ownership/status/verificação | `videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: DB contract + MinIO real — `CompleteMultipartUpload` + `HeadObject` | `videos.service.integration-spec.ts` |
| `POST /videos/:id/complete-upload` | E2E: validation + auth + ownership wiring | `videos.e2e-spec.ts` |

**Dependencies:** SI-03.4 (vídeo + storage) + SI-03.2 (queue)

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` pelo owner com parts válidas flipa o status para `processing` e enfileira um job `video-processing`
- `POST /videos/:id/complete-upload` por não-owner retorna `403 VIDEO_NOT_OWNED`
- `POST /videos/:id/complete-upload` em vídeo que não está `draft` retorna `409 VIDEO_UPLOAD_ALREADY_COMPLETED`
- `POST /videos/:id/complete-upload` quando `HeadObject` falha retorna `502 VIDEO_UPLOAD_VERIFICATION_FAILED` sem flipar o status

---

### SI-03.6 — Worker de processamento de vídeo

**Description:** Implementa o handler da fila `video-processing`: extração de metadados, geração de thumbnail e transição de status.

**Technical actions:**

1. Criar o entrypoint do `video-worker` registrando um handler `boss.work('video-processing', ...)`
2. Implementar extração de metadados via `execa(ffprobePath, [...])` — per `phase-03-videos/TD-05`
3. Implementar geração de thumbnail via `execa(ffmpegPath, [...])` + upload do thumbnail ao storage — per `phase-03-videos/TD-05`, `TD-04`
4. Em sucesso, atualizar o `Video`: `duration_seconds`, `metadata`, `thumbnail_key`, `status: ready`
5. Em falha do handler, deixar o retry/backoff do pg-boss atuar; ao esgotar tentativas, setar `status: error` + `error_reason` — per `phase-03-videos/TD-08`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingWorker` handler | Unit: branch logic (mock execa, repo, storage) — caminhos de sucesso/falha | `video-processing.worker.spec.ts` |
| `VideoProcessingWorker` handler | Integration: ffmpeg/ffprobe reais + storage real + fila real (per Testing Requirements — não mockar o que o Compose roda de verdade) | `video-processing.worker.integration-spec.ts` |

**Dependencies:** SI-03.2 (queue) + SI-03.5 (job é enfileirado ali) + SI-03.1 (worker container + storage)

**Acceptance criteria:**

- Um job `video-processing` para um arquivo válido resulta em `status: ready` com `duration_seconds`, `metadata` e `thumbnail_key` preenchidos
- Um job `video-processing` para um arquivo corrompido/inválido esgota as tentativas e resulta em `status: error` com `error_reason` preenchido

---

### SI-03.7 — Endpoints de leitura, streaming e download

**Description:** Cria os endpoints públicos de detalhe, streaming e download do vídeo via presigned GET.

**Technical actions:**

1. Criar `VideosService.findBySlug()` — aplica a regra de visibilidade (ready-ou-owner) per `### Authorization Matrix`
2. Criar `VideosController.getBySlug()` — `GET /videos/:slug`
3. Criar `VideosService.getStreamUrl()` / `getDownloadUrl()` — presigned GET via `@aws-sdk/s3-request-presigner`, com `response-content-disposition=attachment` no download — per `phase-03-videos/TD-07`
4. Criar `VideosController.stream()` / `download()` — `GET /videos/:slug/stream`, `GET /videos/:slug/download`, ambos retornando redirect `302`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findBySlug` | Unit: branch logic — regra de visibilidade (ready vs owner vs anônimo) | `videos.service.spec.ts` |
| `VideosService.getStreamUrl`/`getDownloadUrl` | Integration: MinIO real — presigned URL funcional | `videos.service.integration-spec.ts` |
| `GET /videos/:slug`, `/stream`, `/download` | E2E: auth/visibility wiring + status codes | `videos.e2e-spec.ts` |

**Dependencies:** SI-03.3 (entidade) + SI-03.1 (storage client)

**Acceptance criteria:**

- `GET /videos/:slug` para vídeo `ready` retorna `200` com os campos de detalhe, para anônimo ou qualquer autenticado
- `GET /videos/:slug` para vídeo não-`ready` por não-owner (ou anônimo) retorna `404 VIDEO_NOT_FOUND`
- `GET /videos/:slug/stream` para vídeo `ready` retorna `302` para uma presigned URL que serve o arquivo com suporte a Range
- `GET /videos/:slug/download` para vídeo `ready` retorna `302` para uma presigned URL com `response-content-disposition=attachment`

---

### SI-03.8 — Limpeza de uploads abandonados

**Description:** Implementa o sweep agendado que aborta multipart uploads nunca finalizados e marca os rascunhos correspondentes como `error`.

**Technical actions:**

1. Agendar `cleanup-abandoned-uploads` via `boss.schedule()` (cron horário) — per `abandoned-upload-cleanup/TD-01`
2. Implementar o handler do sweep: consulta vídeos `draft` além do TTL, chama `AbortMultipartUploadCommand` por linha, flipa para `error` com `error_reason: upload_abandoned_ttl_exceeded`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AbandonedUploadCleanupWorker` handler | Integration: DB real + MinIO real — rascunho antigo flipado para error + multipart abortado | `abandoned-upload-cleanup.worker.integration-spec.ts` |

**Dependencies:** SI-03.2 (queue/schedule) + SI-03.4 (rascunhos + `upload_id`) + SI-03.1 (storage client)

**Acceptance criteria:**

- Um vídeo `draft` mais antigo que o TTL é flipado para `error` com `error_reason: upload_abandoned_ttl_exceeded` após o sweep rodar
- O sweep chama `AbortMultipartUpload` para o `upload_id` do vídeo abandonado
- Um vídeo `draft` mais novo que o TTL não é tocado pelo sweep

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK -> channels.id, not null |
| slug | varchar(10) | unique, not null — public URL identifier *(per phase-03-videos/TD-06)* |
| title | varchar(255) | nullable — set at upload init if provided, editable later (Fase 04) |
| status | enum: draft \| processing \| ready \| error | not null, default `draft` *(per phase-03-videos/TD-08)* |
| error_reason | varchar(255) | nullable — set when status = `error` *(per phase-03-videos/TD-08, abandoned-upload-cleanup/TD-01)* |
| storage_key | varchar(512) | not null — `videos/{id}/original.<ext>` *(per phase-03-videos/TD-04)* |
| thumbnail_key | varchar(512) | nullable — `videos/{id}/thumbnail.jpg`, set after processing *(per phase-03-videos/TD-04, TD-05)* |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId`, needed for completion and abort *(per phase-03-videos/TD-02, TD-03, abandoned-upload-cleanup/TD-01)* |
| duration_seconds | integer | nullable — set after ffprobe extraction *(per phase-03-videos/TD-05)* |
| metadata | jsonb | nullable — ffprobe output (codec, resolution, etc.) *(per phase-03-videos/TD-05)* |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), auto-update on write |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel`.
**Indexes:** unique on `slug`; index on `channel_id`; index on `status` (used by `abandoned-upload-cleanup/TD-01`'s sweep query `WHERE status = 'draft' AND created_at < ...`).

### API Contracts

#### POST /videos (SI-03.4)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer JWT — required *(per phase-02-auth JWT convention, inherited)*

**Request body:**
- title: string, optional
- fileName: string, required — used to derive the storage key extension
- fileSize: number, required — bytes; must not exceed 10GB *(per project scope §4 "Pontos de Atenção")*
- contentType: string, required — MIME type

**Response 201:**
- id: string (uuid)
- slug: string
- status: `draft`
- uploadId: string
- parts: array of `{ partNumber: number, uploadUrl: string }` — presigned `UploadPart` URLs *(per phase-03-videos/TD-02)*

**Error responses:**
- 400 VIDEO_FILE_TOO_LARGE: fileSize exceeds the 10GB cap
- 400 validation error: missing/invalid request body fields
- 401 unauthenticated

---

#### POST /videos/:id/complete-upload (SI-03.5)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer JWT — required

**Request body:**
- parts: array of `{ partNumber: number, eTag: string }`, required — per `phase-03-videos/TD-02`'s multipart part tracking

**Response 200:**
- id: string (uuid)
- status: `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: `:id` does not reference an existing video
- 403 VIDEO_NOT_OWNED: authenticated user is not the video's channel owner
- 409 VIDEO_UPLOAD_ALREADY_COMPLETED: video status is not `draft`
- 400 validation error: missing/invalid `parts`
- 502 VIDEO_UPLOAD_VERIFICATION_FAILED: `HeadObject` fails after `CompleteMultipartUpload` *(per phase-03-videos/TD-03's server-side verification)*

---

#### GET /videos/:slug (SI-03.7)

**Request headers:**
- Authorization: Bearer JWT — optional (anonymous allowed for `ready` videos)

**Response 200:**
- id: string (uuid)
- slug: string
- title: string \| null
- status: `draft` \| `processing` \| `ready` \| `error`
- durationSeconds: number \| null
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `:slug` does not reference an existing video, OR references a non-`ready` video and the requester is not its owner *(non-owner requests for non-ready videos return 404, not 403, to avoid leaking existence)*

---

#### GET /videos/:slug/stream (SI-03.7)

**Request headers:**
- Authorization: Bearer JWT — optional (anonymous allowed for `ready` videos)
- Range: bytes=... — optional, passed through to the presigned GET *(per phase-03-videos/TD-07)*

**Response 302:** redirect to a presigned `GetObject` URL *(per phase-03-videos/TD-07)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: same rule as `GET /videos/:slug`

---

#### GET /videos/:slug/download (SI-03.7)

**Request headers:**
- Authorization: Bearer JWT — optional (anonymous allowed for `ready` videos)

**Response 302:** redirect to a presigned `GetObject` URL with `response-content-disposition=attachment` *(per phase-03-videos/TD-07)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: same rule as `GET /videos/:slug`

---

#### Validation Rules — Backend

- `fileSize`: required, positive integer, ≤ 10 * 1024^3 bytes (10GB)
- `fileName`: required, non-empty string
- `contentType`: required, non-empty string
- `parts` (complete-upload): required, non-empty array; each entry requires `partNumber` (positive integer) and `eTag` (non-empty string)

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ | ✓ (creates own) |
| POST /videos/:id/complete-upload | ✗ | ✗ | ✓ |
| GET /videos/:slug (status = ready) | ✓ | ✓ | ✓ |
| GET /videos/:slug (status ≠ ready) | ✗ (404) | ✗ (404) | ✓ |
| GET /videos/:slug/stream (status = ready) | ✓ | ✓ | ✓ |
| GET /videos/:slug/stream (status ≠ ready) | ✗ (404) | ✗ (404) | ✓ |
| GET /videos/:slug/download (status = ready) | ✓ | ✓ | ✓ |
| GET /videos/:slug/download (status ≠ ready) | ✗ (404) | ✗ (404) | ✓ |

Ownership = the requesting user's channel matches `Video.channel_id`. Anonymous read access on `ready` videos follows the project's "Acesso anônimo" principle (`docs/project-plan.md` §1); the public-endpoint bypass of the global JWT guard reuses the existing pattern already established for anonymous-accessible routes in `phase-02-auth` — reuse it, do not re-decide the mechanism.

### Error Catalog

_Envelope shape inherited from `phase-02-auth/TD-07` (Custom Domain Exception Filter, `{ statusCode, error, message }`) — no new format decision this phase._

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_FILE_TOO_LARGE | 400 | `fileSize` on `POST /videos` exceeds the 10GB cap |
| VIDEO_NOT_FOUND | 404 | Referenced `:id`/`:slug` does not exist, or references a non-`ready` video for a non-owner requester |
| VIDEO_NOT_OWNED | 403 | Authenticated non-owner calls `POST /videos/:id/complete-upload` |
| VIDEO_UPLOAD_ALREADY_COMPLETED | 409 | `complete-upload` called on a video whose status is not `draft` |
| VIDEO_UPLOAD_VERIFICATION_FAILED | 502 | `HeadObject` fails after `CompleteMultipartUpload` *(per phase-03-videos/TD-03)* |

### Events/Messages

#### video-processing

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (complete-upload handler) — fires after `CompleteMultipartUpload` + `HeadObject` verification succeed *(per phase-03-videos/TD-03)*
**Consumer:** `VideoProcessingWorker` — extracts duration/metadata via ffprobe, generates thumbnail via ffmpeg, uploads thumbnail to storage, flips status to `ready` or `error` *(per phase-03-videos/TD-05, TD-08)*
**Trigger:** successful `POST /videos/:id/complete-upload`
**Delivery semantics:** at-least-once, `retryLimit`/`retryBackoff`-bounded — queue-native retry per `phase-03-videos/TD-08`; after retries exhaust, the job marks the video `error` with a reason.

---

#### cleanup-abandoned-uploads

**Payload:** none — the sweep queries `Video` directly.

**Producer:** pg-boss `schedule()` cron job, hourly *(per abandoned-upload-cleanup/TD-01)*
**Consumer:** `AbandonedUploadCleanupWorker` — queries `Video` rows `WHERE status = 'draft' AND created_at < now() - TTL`, calls `AbortMultipartUpload` per row using the stored `upload_id`, flips status to `error` with reason `upload_abandoned_ttl_exceeded` *(per abandoned-upload-cleanup/TD-01)*
**Trigger:** hourly cron (TTL and cadence are bounded config values, not a re-opened decision — per `abandoned-upload-cleanup/TD-01`'s own Note)
**Delivery semantics:** best-effort — idempotent by construction (each run re-queries current stale drafts; a missed run just delays the next sweep).

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root) — infra: object storage + worker container
SI-03.2 (root) — infra: fila pg-boss
SI-03.3 (root) — migration: entidade Video
├── SI-03.4 — depends on SI-03.1 + SI-03.3 (storage client + entidade)
│   ├── SI-03.5 — depends on SI-03.4 + SI-03.2 (vídeo criado + queue)
│   │   └── SI-03.6 — depends on SI-03.2 + SI-03.5 + SI-03.1 (job enfileirado + worker/storage)
│   └── SI-03.8 — depends on SI-03.2 + SI-03.4 + SI-03.1 (rascunhos com upload_id + queue + storage)
└── SI-03.7 — depends on SI-03.3 + SI-03.1 (entidade + storage client)
```

---

## Deliverables

- [x] SI-03.1 — Infra: object storage e worker de vídeo no Compose
- [x] SI-03.2 — Infra: fila pg-boss
- [x] SI-03.3 — Migration: entidade Video
- [x] SI-03.4 — Endpoint POST /videos (iniciar upload)
- [x] SI-03.5 — Endpoint POST /videos/:id/complete-upload
- [x] SI-03.6 — Worker de processamento de vídeo
- [x] SI-03.7 — Endpoints de leitura, streaming e download
- [x] SI-03.8 — Limpeza de uploads abandonados

**Full test suites:**

- [x] Testes unit + integration passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passa (`docker compose exec nestjs-api npm run lint`)
