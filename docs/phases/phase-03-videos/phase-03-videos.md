---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-31T17:45:43-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-31T17:45:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T17:09:47-03:00"
  docs/decisions/technical-decisions-abandoned-upload-cleanup.md: "2026-08-31T17:09:52-03:00"
  docs/decisions/technical-decisions-workflow-hardening-guardrails.md: "2026-08-31T16:13:32-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-19T18:32:40-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver end-to-end large-video upload and processing for StreamTube: an object-storage service (MinIO/S3) and a PostgreSQL-backed processing queue (pg-boss) with a dedicated FFmpeg worker container; non-blocking uploads of files up to 10GB via S3 multipart presigned URLs with automatic draft pre-registration; automatic post-upload extraction of duration/metadata and single-frame thumbnail generation; a short unique public URL per video; and streaming playback (no full download) plus direct download — all backed by a channel-owned `videos` table with a `draft → processing → ready | error` lifecycle and an hourly sweep that reclaims abandoned uploads.

---

## Step Implementations

### SI-03.1 — Infraestrutura: object storage, fila e worker no Compose

**Description:** Sobe MinIO (object storage S3-compatível), o worker de vídeo e a criação do bucket como serviços do `docker compose` junto com a stack do backend; a fila é pg-boss na mesma instância Postgres, sem container próprio.

**Technical actions:**

1. Adicionar serviço `minio` em `nestjs-project/compose.yaml` — imagem `minio/minio`, portas `9000`/`9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD=streamtube`, `command: server /data --console-address ":9001"`, healthcheck em `/minio/health/live`, volume nomeado `minio-data` (per `phase-03-videos/TD-04`).
2. Adicionar serviço one-shot `minio-init` — imagem `minio/mc`, `depends_on: minio (condition: service_healthy)`, entrypoint que faz `mc alias set` + `mc mb --ignore-existing local/streamtube` (bucket único, per `phase-03-videos/TD-04`).
3. Adicionar serviço `video-worker` — mesmo `Dockerfile.dev` e bind-mount do `nestjs-api`, `depends_on: db (service_healthy)` + `minio (service_healthy)`, `command` provisório `sleep infinity` (o entrypoint real vira `npm run start:worker` na SI-03.7).
4. Adicionar script `start:worker` em `nestjs-project/package.json` apontando para `src/worker/main.ts` (per `phase-03-videos/TD-05`).
5. Corrigir o script `test:e2e` em `package.json` para incluir `--runInBand` (integração e e2e compartilham um único Postgres de teste + a instância pg-boss, per PLAN §11.3).

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `nestjs-api`, `db`, `mailpit`, `minio` e `video-worker` em estado `running` e `minio-init` em `exited (0)`.
- `GET http://localhost:9000/minio/health/live` retorna `200`.
- Um `HeadBucket`/list contra o endpoint do MinIO confirma que o bucket `streamtube` existe após o `up`.
- `npm run test:e2e` (dentro do container) roda a suíte e2e com `--runInBand`.

---

### SI-03.2 — Config namespaces de storage e fila + `.env`

**Description:** Cria os config factories `@nestjs/config` para o object storage e para a fila e adiciona as chaves ao schema de validação Joi e aos arquivos `.env`, seguindo a convenção namespaced herdada da Fase 01.

**Technical actions:**

1. Criar `nestjs-project/src/config/storage.config.ts` — `registerAs('storage', () => ({ endpoint, region, bucket, accessKeyId, secretAccessKey }))` lendo `STORAGE_*` (per `## Inherited Conventions` — phase 01; `phase-03-videos/TD-04`).
2. Criar `nestjs-project/src/config/queue.config.ts` — `registerAs('queue', () => ({ connectionString, schema: 'pgboss' }))`, com a `connectionString` derivada das `DB_*` já existentes (per `phase-03-videos/TD-01`).
3. Adicionar as chaves novas ao schema Joi em `src/config/env.validation.ts` (`STORAGE_ENDPOINT` uri, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` — todas `required`).
4. Adicionar bloco `# Object Storage (MinIO — S3-compatible)` em `.env` e `.env.example` — `STORAGE_ENDPOINT=http://minio:9000` (nome de serviço do Compose, nunca `localhost`), `STORAGE_REGION=us-east-1`, `STORAGE_BUCKET=streamtube`, `STORAGE_ACCESS_KEY_ID=streamtube`, `STORAGE_SECRET_ACCESS_KEY=streamtube` — valores shell-safe (per `nestjs-project/CLAUDE.md` → Environment File Conventions).

**Tests:** _(empty — config factories sem lógica de branch; cobertos pela validação Joi no boot e pelo teste de compilação de módulo da SI-03.4/SI-03.5)_

**Dependencies:** none

**Acceptance criteria:**

- Subir o app sem `STORAGE_BUCKET` no `.env` falha no boot com erro de validação Joi nomeando a chave ausente.
- Com o `.env` completo, `npm run env:check` passa (todas as chaves de `.env.example` presentes em `.env`).
- `ConfigType<typeof storageConfig>` e `ConfigType<typeof queueConfig>` são injetáveis via `@Inject(xxxConfig.KEY)` (compila sob `tsc --noEmit`).

---

### SI-03.3 — Entidade `Video` e migration

**Description:** Cria a entidade `Video` ligada ao canal e a migration versionada que cria a tabela `videos` e o enum `videos_status_enum`, sem quebrar o boot do `AppModule`.

**Technical actions:**

1. Criar `nestjs-project/src/videos/entities/video.entity.ts` — entidade `Video` com todos os campos do `### Data Model` (`id`, `channel_id`, `slug`, `title`, `status`, `error_reason`, `storage_key`, `thumbnail_key`, `upload_id`, `duration_seconds`, `metadata`, `created_at`, `updated_at`); relação `@ManyToOne(() => Channel)` **unilateral** (sem inversa em `Channel` ainda — per PLAN §11.2); `@Index` em `channel_id` e `status`, `@Column({ unique: true })` no `slug`.
2. Gerar a migration `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` (per `## Inherited Conventions` — phase 01) — cria `videos_status_enum`, a tabela e os índices.
3. Rodar `npm run migration:run` e conferir o schema aplicado.
4. Adicionar `Video` às listas isoladas de entidades dos integration/module specs pré-existentes que fazem `TypeOrmModule.forRoot`/`forFeature` explícito, quando o `tsc`/suite acusar erro de resolução de relação (per PLAN §11.2).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `slug` unique, `channel_id` not-null + FK para `channels`, `status` default `draft`, enum aceita só os 4 valores, `created_at`/`updated_at` preenchidos | `nestjs-project/src/videos/entities/video.entity.integration-spec.ts` |
| `migrations` | Integration: `migration:run` aplica `CreateVideos` limpo e `migration:revert` desfaz (cleanup sequenciado — filhos antes de pais, sem paralelizar `DROP TYPE`/`DROP TABLE CASCADE`, per PLAN §11.3) | `nestjs-project/src/database/migrations.integration-spec.ts` (estende o existente) |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com o enum `videos_status_enum(draft, processing, ready, error)` e os índices `unique(slug)`, `index(channel_id)`, `index(status)`.
- Inserir uma segunda `videos` row com `slug` repetido falha com violação de unicidade (`23505`).
- Inserir `videos` sem `channel_id` falha com violação de not-null/FK.
- Uma `videos` row nova sem `status` explícito é persistida com `status = 'draft'`.
- `npx tsc --noEmit` sai com código 0 com a entidade `Video` no projeto (boot do `AppModule` intacto — sem `@OneToMany` inversa ainda).

---

### SI-03.4 — `StorageService` (cliente S3-compatível)

**Description:** Implementa o serviço de object storage sobre o AWS SDK v3 apontando para o MinIO — control-plane de multipart, URLs pré-assinadas e I/O de objeto usado pelo worker — sem nunca bufferizar arquivo de vídeo.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (`^3`, per `library-refs.md`).
2. Criar `nestjs-project/src/videos/videos.constants.ts` — builders de chave (`videos/{id}/original.<ext>`, `videos/{id}/thumbnail.jpg`, per `phase-03-videos/TD-04`), limite `MAX_UPLOAD_BYTES = 10 * 1024 ** 3`, TTLs de presign.
3. Criar `nestjs-project/src/videos/storage.service.ts` — `S3Client` com `endpoint`, `region`, `forcePathStyle: true`, `credentials` do `storageConfig`; métodos `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `presignGetObject(key, { disposition? })`, `downloadObject(key, destPath)`, `uploadObject(key, srcPath, contentType)` — este último passa `ContentLength` explícito via `fs.stat` (per PLAN §11.4; `phase-03-videos/TD-02`, `TD-07`, `abandoned-upload-cleanup/TD-01`).
4. Registrar `StorageService` como provider exportado no `VideosModule` (criado na SI-03.5) — placeholder de provider até lá; o teste de integração instancia o serviço com `storageConfig` real.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real do Compose): `createMultipartUpload` → `presignUploadPart` → `PUT` da parte na URL → `completeMultipartUpload` → `headObject` OK; `abortMultipartUpload` descarta multipart aberto; `uploadObject`/`downloadObject` round-trip preserva bytes; `presignGetObject` com `disposition` produz URL com `response-content-disposition` | `nestjs-project/src/videos/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — precisa do `storageConfig`.

**Acceptance criteria:**

- Um multipart criado via `StorageService`, com uma parte enviada pela URL pré-assinada e finalizado, resulta num objeto que `headObject` encontra com o tamanho correto.
- `abortMultipartUpload` sobre um `uploadId` já finalizado ou inexistente não lança (tolera `NoSuchUpload`).
- `uploadObject` de um arquivo local grava no MinIO um objeto com `Content-Length` igual ao tamanho do arquivo.
- A URL de `presignGetObject(key, { disposition: 'attachment; filename="x.mp4"' })` inclui `response-content-disposition` e, ao ser seguida, retorna o objeto.

---

### SI-03.5 — `VideosModule` + `POST /videos` (início do upload)

**Description:** Monta o módulo de vídeos e o endpoint que pré-cadastra o vídeo como rascunho no canal do usuário autenticado, gera o slug único e devolve as URLs pré-assinadas de multipart — sem passar o arquivo pela API.

**Technical actions:**

1. Instalar `nanoid` (`^5`, per `library-refs.md`) e adicionar `pg-boss|serialize-error|non-error|type-fest|nanoid` ao `transformIgnorePatterns` em `package.json` (jest) **e** `test/jest-e2e.json`, proativamente (per PLAN §11.1 / `library-refs.md` → CommonJS/Jest).
2. Criar `nestjs-project/src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, providers `StorageService` + `VideosService`, controller `VideosController`, `imports: [AuthModule]` (reusa o `JwtModule` exportado — puxa `Mail`/`Throttler` transitivamente, per PLAN §11.2); registrar em `AppModule`; restaurar a inversa `@OneToMany(() => Video, v => v.channel)` em `Channel` (per PLAN §11.2).
3. Criar `nestjs-project/src/videos/dto/create-video.dto.ts` — `fileName` (string, não-vazio, com extensão), `fileSize` (int, `> 0`), `contentType` (string não-vazio), `title?` (string, `max 255`) com `class-validator` (per `### API Contracts → POST /videos → Validation Rules`).
4. Criar `nestjs-project/src/videos/videos.service.ts` — `initiateUpload(channelId, dto)`: valida `fileSize <= MAX_UPLOAD_BYTES` (senão `VIDEO_FILE_TOO_LARGE`), gera `slug` com `nanoid(10)` e retry-on-`23505` espelhando `ChannelsService` (per `phase-03-videos/TD-06`), persiste a `Video` `draft`, chama `createMultipartUpload`, salva `upload_id`, calcula as partes a partir de `fileSize` e devolve `{ id, slug, status, uploadId, parts[] }` (per `phase-03-videos/TD-02`).
5. Criar `nestjs-project/src/videos/videos.controller.ts` — `POST /videos` (guard JWT global, dono via `channelId` do `request.user`), `@ApiTags('videos')` + `@ApiOperation`/`@ApiResponse`/`@ApiBody` (per `openapi-docs-nestjs/TD-01`); adicionar `VIDEO_FILE_TOO_LARGE` ao catálogo de exceções de domínio.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilação do módulo (DI wiring, incl. `AuthModule`/config transitivos) | `nestjs-project/src/videos/videos.module.spec.ts` |
| `VideosService` | Unit (repo + `StorageService` mockados): `fileSize` acima do limite lança `VIDEO_FILE_TOO_LARGE`; colisão de `slug` re-tenta e sucede; `initiateUpload` persiste `status='draft'` e `upload_id` | `nestjs-project/src/videos/videos.service.spec.ts` |
| `CreateVideoDto` + `POST /videos` | E2E (`supertest`): `201` com `{ id, slug, status:'draft', uploadId, parts[] }`; `400 VIDEO_FILE_TOO_LARGE` acima de 10GB; `400` validação de body; `401` sem Bearer | `nestjs-project/test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.3 (entidade/migration), SI-03.4 (`StorageService`).

**Acceptance criteria:**

- `POST /videos` com body válido e Bearer de um usuário retorna `201` com `slug` de 10 caracteres, `status: "draft"`, um `uploadId` e um array `parts` de URLs pré-assinadas.
- `POST /videos` com `fileSize` acima de `10 * 1024³` retorna `400` com `error: "VIDEO_FILE_TOO_LARGE"`.
- `POST /videos` sem `Authorization` retorna `401`.
- Após um `POST /videos` bem-sucedido, existe uma `videos` row `status='draft'` com `channel_id` do canal do chamador e `upload_id` preenchido.
- `npm test` roda os specs que dão boot no `AppModule` sem erro de ESM (pg-boss/nanoid no `transformIgnorePatterns`).

---

### SI-03.6 — Fila pg-boss + `POST /videos/:id/complete-upload`

**Description:** Adiciona o módulo da fila (pg-boss na instância Postgres existente) e o endpoint de confirmação de upload, que verifica o objeto no storage, muda o status para `processing` e publica o job de processamento.

**Technical actions:**

1. Instalar `pg-boss` (`^10`, per `library-refs.md`); criar `nestjs-project/src/queue/queue.module.ts` + `src/queue/queue.constants.ts` — provider `PgBoss` a partir da `connectionString` do `queueConfig` (schema `pgboss`), `boss.start()` + `boss.createQueue('video-processing')` no `onModuleInit`, `boss.stop({ graceful: true })` no `onModuleDestroy`; constante `QUEUE_VIDEO_PROCESSING = 'video-processing'` (per `phase-03-videos/TD-01`).
2. Criar `nestjs-project/src/videos/dto/complete-upload.dto.ts` — `parts: { partNumber: int ≥ 1, eTag: string não-vazio }[]`, não-vazio (per `### API Contracts → POST /videos/:id/complete-upload`).
3. Estender `VideosService` — `completeUpload(id, userId)`: carrega a `Video` (`404 VIDEO_NOT_FOUND`), exige dono do canal (`403 VIDEO_NOT_OWNED`), exige `status='draft'` (`409 VIDEO_UPLOAD_ALREADY_COMPLETED`); `completeMultipartUpload` + `headObject` (falha do head após complete → `502 VIDEO_UPLOAD_VERIFICATION_FAILED`); numa transação: `status → processing`, limpa `upload_id`, `boss.send(QUEUE_VIDEO_PROCESSING, { videoId })` com `retryLimit:3`/`retryDelay:5`/`retryBackoff:true` (per `phase-03-videos/TD-03`, `TD-08`).
4. Estender `VideosController` — `POST /videos/:id/complete-upload` (guard JWT global) + decoradores OpenAPI; registrar `QueueModule` em `VideosModule` e `AppModule`.
5. Adicionar `VIDEO_NOT_FOUND`, `VIDEO_NOT_OWNED`, `VIDEO_UPLOAD_ALREADY_COMPLETED`, `VIDEO_UPLOAD_VERIFICATION_FAILED` ao catálogo de exceções de domínio (envelope herdado de `phase-02-auth/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilação do módulo | `nestjs-project/src/queue/queue.module.spec.ts` |
| `VideosService.completeUpload` | Unit (mocks): dono OK vs não-dono (`403`); status não-`draft` (`409`); `headObject` falha após `completeMultipartUpload` OK (`502`, cobertura só unit per PLAN §11.5) | `nestjs-project/src/videos/videos.service.spec.ts` (estende) |
| `VideosService` + pg-boss | Integration (Postgres + pg-boss reais): `completeUpload` bem-sucedido enfileira exatamente um job `video-processing` com o `videoId` próprio; fecha o `TestingModule` inteiro no `afterAll` (per PLAN §11.3) | `nestjs-project/src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:id/complete-upload` | E2E: `200` `{ id, status:'processing' }` no caminho feliz; `403` para não-dono; `409` se já não é `draft` | `nestjs-project/test/videos.e2e-spec.ts` (estende) |

**Dependencies:** SI-03.5.

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` pelo dono, com as `parts` corretas, retorna `200` `{ id, status: "processing" }`, a `videos` row fica `status='processing'` com `upload_id` nulo, e um job `video-processing` com `{ videoId }` aparece em `pgboss.job`.
- `POST /videos/:id/complete-upload` por quem não é dono do canal retorna `403` com `error: "VIDEO_NOT_OWNED"`.
- `POST /videos/:id/complete-upload` sobre um vídeo que não está `draft` retorna `409` com `error: "VIDEO_UPLOAD_ALREADY_COMPLETED"`.
- Falha de `HeadObject` após `CompleteMultipartUpload` bem-sucedido retorna `502` com `error: "VIDEO_UPLOAD_VERIFICATION_FAILED"` (verificado por unit test).
- A suíte completa (`npm test` + `npm run test:e2e`) fecha sem warning "Jest did not exit" (conexão pg-boss encerrada nos `afterAll`).

---

### SI-03.7 — Worker de vídeo: processamento + thumbnail

**Description:** Implementa o worker em container separado que consome a fila, extrai duração/metadados com `ffprobe`, gera o thumbnail com `ffmpeg` e finaliza o vídeo como `ready` — ou `error` quando o retry se esgota.

**Technical actions:**

1. Instalar `execa@^5.1.1`, `ffmpeg-static`, `ffprobe-static` (per `library-refs.md`); criar `nestjs-project/src/types/ffprobe-static.d.ts` (shim de tipos).
2. Criar `nestjs-project/src/worker/worker.module.ts` — `TypeOrmModule.forFeature([Video, Channel, User])` (cadeia `Video → Channel → User`, per PLAN §11.2), `StorageService`, config de storage/queue.
3. Criar `nestjs-project/src/worker/video-processing.worker.ts` — `handleJob(job)` com `{ includeMetadata: true }`: `downloadObject` do original para tempdir → `execa(ffprobePath, ['-v','error','-show_format','-show_streams','-of','json', file])` → `execa(ffmpegPath, ['-ss','0','-i',file,'-frames:v','1','-q:v','2', thumb])` (`-ss 0`, nunca `-ss 1`, per PLAN §11.4) → `uploadObject(thumbnailKey, thumb, 'image/jpeg')` → atualiza `duration_seconds`/`metadata`/`thumbnail_key` e `status → ready` → limpa o tempdir; em falha, se `job.retryCount >= job.retryLimit` seta `status='error'` + `error_reason`, e **sempre** re-lança (per `phase-03-videos/TD-05`, `TD-08`).
4. Criar `nestjs-project/src/worker/main.ts` — bootstrap do contexto Nest standalone, obtém o `PgBoss` e registra `boss.work(QUEUE_VIDEO_PROCESSING, { batchSize: 1, includeMetadata: true }, handler)`.
5. Trocar o `command` do serviço `video-worker` no `compose.yaml` para `npm run start:worker`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação do módulo (`forFeature` de `Video`/`Channel`/`User`) | `nestjs-project/src/worker/worker.module.spec.ts` |
| `VideoProcessingWorker` | Unit (mocks de `StorageService`/repo/execa): na última tentativa (`retryCount >= retryLimit`) seta `status='error'` + `error_reason` e re-lança; em tentativa não-final apenas re-lança | `nestjs-project/src/worker/video-processing.worker.spec.ts` |
| `VideoProcessingWorker` | Integration (MinIO + Postgres + ffmpeg reais): dado um `.mp4` de fixture no storage e uma `Video` `processing`, `handleJob` preenche `duration_seconds`/`metadata`, grava `thumbnail.jpg` no storage e move para `ready`; resolve só no job com o próprio `videoId` (per PLAN §11.3) | `nestjs-project/src/worker/video-processing.worker.integration-spec.ts` |

**Dependencies:** SI-03.6 (fila + enqueue), SI-03.4 (`StorageService` download/upload).

**Acceptance criteria:**

- Enfileirar um job `video-processing` para uma `Video` `processing` cujo original está no storage resulta, em segundos, numa `videos` row `status='ready'` com `duration_seconds` e `metadata` preenchidos e `thumbnail_key` = `videos/{id}/thumbnail.jpg`.
- O objeto `videos/{id}/thumbnail.jpg` existe no MinIO e é um JPEG válido.
- Se o processamento falha em todas as tentativas do pg-boss, a `videos` row termina `status='error'` com `error_reason` não-nulo.
- `docker compose exec video-worker npm run start:worker` sobe limpo contra a infra real e passa a consumir a fila.

---

### SI-03.8 — Endpoints públicos de leitura: `GET /videos/:slug`, `/stream`, `/download`

**Description:** Expõe a leitura de metadados, o streaming e o download do vídeo com autenticação opcional e a regra de visibilidade anti-enumeração (`404`, nunca `403`) para não-donos.

**Technical actions:**

1. Criar `nestjs-project/src/auth/guards/optional-jwt-auth.guard.ts` — decodifica o Bearer se presente e anexa `request.user`, mas **sempre** retorna `true` (per `phase-03-videos/TD-09`, PLAN §11.5).
2. Estender `VideosService` — `getVisibleVideoBySlug(slug, userId?)` privado (retorna o vídeo sse `status='ready'` **ou** o chamador é dono do canal, senão lança `VIDEO_NOT_FOUND`); `getStreamRedirectUrl(slug, userId?)` e `getDownloadRedirectUrl(slug, userId?)` (usam `getVisibleVideoBySlug`, exigem objeto existente — `404` para `draft` — e devolvem `presignGetObject`, com `response-content-disposition=attachment` no download) (per `phase-03-videos/TD-07`, `TD-09`).
3. Estender `VideosController` — `GET /videos/:slug` (`200` com `{ slug, title, status, durationSeconds, thumbnailUrl, channel:{nickname} }`), `@Public()` + `@UseGuards(OptionalJwtAuthGuard)` + OpenAPI.
4. Estender `VideosController` — `GET /videos/:slug/stream` e `GET /videos/:slug/download` (`302` com `Location` presigned; o endpoint não lê nem repassa `Range`), `@Public()` + `@UseGuards(OptionalJwtAuthGuard)` + OpenAPI (per `phase-03-videos/TD-07`).
5. Preencher a `### Authorization Matrix` em código: `POST` segue o guard global; as 3 leituras usam o guard opcional; centralizar a regra `404`-nunca-`403` no `getVisibleVideoBySlug`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `OptionalJwtAuthGuard` | Unit: sem header → `true` e `request.user` indefinido; Bearer válido → `true` e `request.user` populado; Bearer inválido → `true` e `request.user` indefinido | `nestjs-project/src/auth/guards/optional-jwt-auth.guard.spec.ts` |
| `VideosService` visibilidade | Unit: `ready` visível a anônimo; não-`ready` invisível a anônimo e a autenticado não-dono (`VIDEO_NOT_FOUND`); não-`ready` visível ao dono | `nestjs-project/src/videos/videos.service.spec.ts` (estende) |
| Rotas de leitura | E2E: `GET /videos/:slug` anônimo → `200` se `ready`, `404` se não; dono vê não-`ready`; `GET /stream` e `/download` → `302` com `Location`; `/download` acrescenta `response-content-disposition` | `nestjs-project/test/videos.e2e-spec.ts` (estende) |

**Dependencies:** SI-03.5 (`VideosModule`/service/controller), SI-03.4 (`presignGetObject`).

**Acceptance criteria:**

- `GET /videos/:slug` sem token, para um vídeo `ready`, retorna `200` com os metadados públicos; para um vídeo `draft`/`processing`/`error` retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- `GET /videos/:slug` com o Bearer do dono retorna `200` mesmo para um vídeo não-`ready`.
- `GET /videos/:slug/stream` para um vídeo visível retorna `302` com um `Location` de URL pré-assinada; seguir esse `Location` com um header `Range` devolve `206 Partial Content` servido pelo storage.
- `GET /videos/:slug/download` retorna `302` cujo `Location` carrega `response-content-disposition=attachment`.
- Um não-dono nunca recebe `403` numa rota de leitura (só `404` ou `200`).

---

### SI-03.9 — Limpeza de uploads abandonados (job agendado)

**Description:** Adiciona o sweep horário que reclama vídeos presos em `draft` (upload iniciado e nunca concluído) — aborta o multipart órfão e marca a row como `error` — fechando o gap `MD-1`.

**Technical actions:**

1. Estender `VideosService` — `sweepAbandonedUploads()`: seleciona `videos WHERE status='draft' AND created_at < now() - interval '24 hours'`; para cada, `abortMultipartUpload(storage_key, upload_id)` (tolera multipart já fechado) e `status → error`, `error_reason = 'upload_abandoned_ttl_exceeded'` (per `abandoned-upload-cleanup/TD-01`).
2. Adicionar `ABANDONED_UPLOAD_TTL_HOURS = 24` e `ABANDONED_UPLOAD_SWEEP_CRON = '0 * * * *'` a `videos.constants.ts` (constantes nomeadas).
3. Criar `nestjs-project/src/worker/abandoned-upload-cleanup.worker.ts` — handler que chama `sweepAbandonedUploads()`.
4. Em `src/worker/main.ts`: `boss.createQueue('abandoned-upload-sweep')`, `boss.schedule('abandoned-upload-sweep', ABANDONED_UPLOAD_SWEEP_CRON)` e `boss.work('abandoned-upload-sweep', handler)` (per `abandoned-upload-cleanup/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.sweepAbandonedUploads` | Unit (mocks): só rows `draft` com `created_at` além do TTL são varridas; `abortMultipartUpload` é chamado com o `upload_id` salvo; row vai para `error` com `error_reason='upload_abandoned_ttl_exceeded'` | `nestjs-project/src/videos/videos.service.spec.ts` (estende) |
| `AbandonedUploadCleanupWorker` | Integration (Postgres + MinIO reais): seed de um `draft` antigo com multipart aberto → rodar o handler → multipart abortado e row `error`; um `draft` recente e um vídeo `ready` ficam intactos | `nestjs-project/src/worker/abandoned-upload-cleanup.worker.integration-spec.ts` |

**Dependencies:** SI-03.7 (infra do worker), SI-03.4 (`abortMultipartUpload`).

**Acceptance criteria:**

- Um `draft` com `created_at` de mais de 24h é movido para `status='error'` com `error_reason='upload_abandoned_ttl_exceeded'` na próxima execução do sweep, e o multipart correspondente deixa de aparecer em `ListMultipartUploads`.
- Um `draft` criado há menos de 24h e um vídeo `ready` não são tocados pelo sweep.
- O sweep roda de novo sobre a mesma base sem efeito adicional (idempotente — a row já não está `draft`).
- O `video-worker` registra a schedule `0 * * * *` para `abandoned-upload-sweep` no boot.

---

### SI-03.10 — Documentação: OpenAPI, `CLAUDE.md` de vídeos, diagrama e smoke

**Description:** Fecha a fase alinhando a documentação ao código real — exporta o spec OpenAPI, adiciona a seção de vídeos ao `CLAUDE.md`, troca o `"TBD"` da fila no diagrama e estende o smoke test para o fluxo de vídeo.

**Technical actions:**

1. Revisar `videos.controller.ts` — garantir `@ApiOperation`/`@ApiResponse`/`@ApiBody`/`@ApiParam` em todos os 5 endpoints (per `openapi-docs-nestjs/TD-01` revisão); rodar `npm run openapi:export` e commitar o `openapi.json` atualizado.
2. Estender `nestjs-project/scripts/smoke-test.sh` — cenário de vídeo: `POST /videos` → `PUT` das partes nas URLs pré-assinadas → `POST /:id/complete-upload` → poll de `GET /videos/:slug` até `ready` → `GET /:slug/stream` (espera `302`) → `GET /:slug/download` (espera `302`) (per `workflow-hardening-guardrails/TD-04`).
3. Atualizar `nestjs-project/CLAUDE.md` (e a raiz se necessário) — seção de vídeos: módulo `videos/`, `queue/`, `worker/`, endpoints, fila pg-boss, serviços novos do Compose (`minio`, `minio-init`, `video-worker`), script `start:worker`, `transformIgnorePatterns`.
4. Atualizar `docs/diagrams/software-arch.mermaid` — trocar `ContainerQueue(queue, "Message Queue", "TBD")` por `"pg-boss (PostgreSQL)"` (mudança de doc isolada, commit próprio).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Swagger | E2E: `GET /api/docs-json` (ou equivalente) responde e inclui os 5 paths de `videos` com os schemas dos DTOs | `nestjs-project/test/swagger.e2e-spec.ts` (estende, se ele afirma contagem/paths) |

**Dependencies:** SI-03.8, SI-03.9.

**Acceptance criteria:**

- `npm run openapi:export` regenera `openapi.json` e o diff mostra os 5 endpoints de vídeo com parâmetros, bodies e respostas por status.
- `npm run smoke` (contra o app real rodando) completa o fluxo de vídeo até `GET /:slug/stream` retornar `302`.
- `nestjs-project/CLAUDE.md` descreve o módulo de vídeos, a fila, o worker e os serviços novos do Compose — sem citar arquivos ou comandos inexistentes.
- `docs/diagrams/software-arch.mermaid` não contém mais `"TBD"` para a fila.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → `channels(id)`, not null |
| slug | varchar(10) | unique, not null — `nanoid(10)` public URL identifier (per `phase-03-videos/TD-06`) |
| title | varchar(255) | nullable |
| status | enum(`draft`, `processing`, `ready`, `error`) | not null, default `draft` (per `phase-03-videos/TD-08`) |
| error_reason | varchar(255) | nullable — set on the terminal `error` transition (per `phase-03-videos/TD-08`, `abandoned-upload-cleanup/TD-01`) |
| storage_key | varchar(512) | not null — `videos/{id}/original.<ext>` (per `phase-03-videos/TD-04`) |
| thumbnail_key | varchar(512) | nullable — `videos/{id}/thumbnail.jpg`, set by the worker (per `phase-03-videos/TD-04`, `TD-05`) |
| upload_id | varchar(255) | nullable — S3 `UploadId` from `CreateMultipartUpload`; cleared after completion or abort (per `phase-03-videos/TD-02`, `abandoned-upload-cleanup/TD-01`) |
| duration_seconds | integer | nullable — from `ffprobe` (per `phase-03-videos/TD-05`) |
| metadata | jsonb | nullable — raw `ffprobe` format/streams JSON (per `phase-03-videos/TD-05`) |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), on update now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (`@ManyToOne`, `channel_id` not null). Per PLAN §11.2: add `Video.channel` as a **unilateral `@ManyToOne`** in the migration SI; restore the inverse `@OneToMany` on `Channel` **only** in the `VideosModule` SI (adding the inverse earlier breaks `AppModule` boot before any module registers `Video` via `TypeOrmModule.forFeature`). Pre-existing module/integration specs (`auth.module.spec.ts`, `channels.module.spec.ts`, `users.module.spec.ts`, and isolated integration specs) that build their own entity lists must add `Video` when the inverse relation lands (same relation-resolution bug class).

**Indexes:** unique on `slug`; index on `channel_id`; index on `status` (drives the abandoned-upload sweep query in `abandoned-upload-cleanup/TD-01`).

**Migration:** `nestjs-project/src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` (per `## Inherited Conventions` — phase 01). Introduces a second enum type `videos_status_enum`; per PLAN §11.3, sequence any test cleanup that drops it (children before parents) — do not parallelize `DROP TYPE` / `DROP TABLE ... CASCADE` across pooled connections.

### API Contracts

All endpoints are under the `nestjs-project` API. The error envelope is inherited from `phase-02-auth/TD-07` (`{ statusCode, error, message }`, global domain exception filter). SI cross-refs below are Phase A forward references; Phase B finalizes the slicing.

#### POST /videos (SI-03.5)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access token} — required (any authenticated user; the video is created on the caller's own channel) (per `phase-03-videos/TD-09`)

**Request body:**
- fileName: string, required — original file name; its extension sets `storage_key` = `videos/{id}/original.<ext>` (per `phase-03-videos/TD-04`)
- fileSize: integer, required — total bytes; drives the multipart part count and the 10 GB limit check
- contentType: string, required — MIME type, passed as `ContentType` to `CreateMultipartUpload`
- title: string, optional — max 255

**Response 201:**
- id: string (uuid)
- slug: string — `nanoid(10)` (per `phase-03-videos/TD-06`)
- status: string — always `draft` (per `phase-03-videos/TD-08`)
- uploadId: string — S3 `UploadId`, persisted as `upload_id` (per `phase-03-videos/TD-02`)
- parts: array of `{ partNumber: integer, url: string }` — one presigned `UploadPart` URL per part; the client PUTs each part directly to storage (per `phase-03-videos/TD-02`)

**Behavior:** pre-registers the `Video` row as `draft` on the caller's channel, generates the `slug` (retry-on-`23505` mirroring `ChannelsService`, per `phase-03-videos/TD-06`), calls `CreateMultipartUpload`, persists `upload_id`, and returns the presigned part URLs. The file never touches the API (per `phase-03-videos/TD-02`).

**Error responses:**
- 400 VIDEO_FILE_TOO_LARGE: `fileSize` above the 10 GB limit
- 400 validation error: body fails schema validation
- 401: no valid Bearer token

---

#### POST /videos/:id/complete-upload (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access token} — required (owner of the video's channel) (per `phase-03-videos/TD-09`)

**Request body:**
- parts: array of `{ partNumber: integer, eTag: string }`, required — the `ETag` storage returned for each uploaded part, in part-number order (per `phase-03-videos/TD-03`)

**Response 200:**
- id: string (uuid)
- status: string — `processing` (per `phase-03-videos/TD-03`, `TD-08`)

**Behavior:** issues `CompleteMultipartUpload` with the supplied `{ PartNumber, ETag }` list, then `HeadObject` to verify the object landed; on success transitions `draft → processing`, clears `upload_id`, and enqueues the `video-processing` job — all in one transaction (per `phase-03-videos/TD-03`).

**Error responses:**
- 403 VIDEO_NOT_OWNED: caller does not own the video's channel
- 404 VIDEO_NOT_FOUND: no video with `:id`
- 409 VIDEO_UPLOAD_ALREADY_COMPLETED: video is not in `draft` status
- 502 VIDEO_UPLOAD_VERIFICATION_FAILED: `HeadObject` fails **after** a successful `CompleteMultipartUpload` (per `phase-03-videos/TD-03`; covered by unit test only per PLAN §11.5)
- 400 validation error: `parts` missing/malformed
- 401: no valid Bearer token

---

#### GET /videos/:slug (SI-03.8)

**Request headers:**
- Authorization: Bearer {access token} — optional (`OptionalJwtAuthGuard` + `@Public()`) (per `phase-03-videos/TD-09`)

**Response 200:**
- slug: string
- title: string | null
- status: string — `draft` | `processing` | `ready` | `error`
- durationSeconds: integer | null
- thumbnailUrl: string | null — presigned `GetObject` URL for `thumbnail_key` when set
- channel: `{ nickname: string }`

**Authorization:** returned iff `status = ready` **or** the caller owns the channel; otherwise `404 VIDEO_NOT_FOUND` (anti-enumeration — never `403`) (per `phase-03-videos/TD-09`). Resolved by the single private `VideosService.getVisibleVideoBySlug(slug, userId?)` — the only read path (per PLAN §11.5).

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug unknown, or video not visible to the caller

---

#### GET /videos/:slug/stream (SI-03.8)

**Request headers:**
- Authorization: Bearer {access token} — optional (per `phase-03-videos/TD-09`)

**Response 302:** redirect — `Location` is a short-lived presigned `GetObject` URL for `storage_key` (per `phase-03-videos/TD-07`). No body. `Range`/`206` is negotiated between the client and storage on the follow-up request; this endpoint neither reads nor forwards the `Range` header.

**Authorization:** resolved via `getVisibleVideoBySlug`. A `ready` video redirects for any visible caller; the owner may also stream a `processing` or `error` video (the original object exists). A `draft` video → `404` (no object yet). Non-owner on a non-`ready` video → `404` (per `phase-03-videos/TD-09`).

**Error responses:**
- 404 VIDEO_NOT_FOUND: not visible to the caller, or `draft` (no object)

---

#### GET /videos/:slug/download (SI-03.8)

**Request headers:**
- Authorization: Bearer {access token} — optional (per `phase-03-videos/TD-09`)

**Response 302:** redirect — same as `/stream`, but the presigned URL carries `ResponseContentDisposition` = `attachment; filename="{sanitized title or slug}.<ext>"` so the browser saves the file (per `phase-03-videos/TD-07`).

**Authorization:** identical to `GET /videos/:slug/stream`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: not visible to the caller, or `draft` (no object)

---

#### Validation Rules — videos

- `fileName`: required, non-empty string, must contain a file extension.
- `fileSize`: required, integer, `> 0`, `≤ 10 GB` (`10 * 1024³` bytes) — over the limit raises `VIDEO_FILE_TOO_LARGE` (not a generic validation error).
- `contentType`: required, non-empty string.
- `title`: optional, string, max 255.
- `parts` (`complete-upload`): required, non-empty array; each item `{ partNumber: integer ≥ 1, eTag: non-empty string }`.

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ (creates on caller's own channel) | ✓ |
| POST /videos/:id/complete-upload | ✗ (401) | ✗ (403 VIDEO_NOT_OWNED) | ✓ |
| GET /videos/:slug | ✓ if `ready` — else 404 | ✓ if `ready` — else 404 | ✓ (any status) |
| GET /videos/:slug/stream | ✓ if `ready` — else 404 | ✓ if `ready` — else 404 | ✓ if `ready`/`processing`/`error`; 404 if `draft` |
| GET /videos/:slug/download | ✓ if `ready` — else 404 | ✓ if `ready` — else 404 | ✓ if `ready`/`processing`/`error`; 404 if `draft` |

New guard: `OptionalJwtAuthGuard` (`src/auth/guards/optional-jwt-auth.guard.ts`) — decodes a Bearer token if present, attaches `request.user`, **always returns `true`** — used together with `@Public()` on the three read routes (per `phase-03-videos/TD-09`, PLAN §11.5). The global `JwtAuthGuard` still protects `POST /videos` and `POST /videos/:id/complete-upload`. A non-owner never receives `403` on a read route (anti-enumeration); `403 VIDEO_NOT_OWNED` is used only on `complete-upload` (id-addressed, authenticated).

---

### Error Catalog

Envelope inherited from `phase-02-auth/TD-07`: `{ statusCode, error, message }` via the global domain exception filter. The machine-readable field is `error` (verbatim from the inherited convention — not `errorCode`). New domain codes:

| error | HTTP | Trigger |
|-------|------|---------|
| VIDEO_FILE_TOO_LARGE | 400 | `POST /videos` with `fileSize` above the 10 GB limit |
| VIDEO_NOT_FOUND | 404 | Video slug/id unknown, or the video is not visible to the caller (non-`ready` + non-owner) — anti-enumeration (per `phase-03-videos/TD-09`) |
| VIDEO_NOT_OWNED | 403 | `POST /videos/:id/complete-upload` by a caller who does not own the video's channel |
| VIDEO_UPLOAD_ALREADY_COMPLETED | 409 | `POST /videos/:id/complete-upload` when the video is not in `draft` status |
| VIDEO_UPLOAD_VERIFICATION_FAILED | 502 | `HeadObject` fails after a successful `CompleteMultipartUpload` (per `phase-03-videos/TD-03`) |

Internal (not a client-facing catalog entry): the worker's terminal-failure path writes `error_reason` on the `Video` row — `error_reason = 'upload_abandoned_ttl_exceeded'` for the sweep (per `abandoned-upload-cleanup/TD-01`), or a processing-failure reason from the worker (per `phase-03-videos/TD-08`).

---

### Events/Messages

#### video-processing

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-03`) — `boss.send('video-processing', { videoId })` inside the `POST /videos/:id/complete-upload` transaction, immediately after the `draft → processing` transition.
**Consumer:** `VideoProcessingWorker` in the separate `video-worker` container — `src/worker/` (per `phase-03-videos/TD-05`).
**Trigger:** a client confirms a completed multipart upload and server-side `HeadObject` verification passes.
**Processing:** worker `GetObject`s the original to a temp file → `ffprobe` (fills `duration_seconds` + `metadata`) → `ffmpeg -ss 0 -frames:v 1` for the thumbnail (`-ss 0`, never `-ss 1` — silently no-ops on sub-1s clips, per PLAN §11.4) → `PutObject` the thumbnail with explicit `ContentLength` (per PLAN §11.4) → update the row (`duration_seconds`, `metadata`, `thumbnail_key`) → transition `processing → ready` → clean the tempdir. On failure the handler re-throws so pg-boss drives retry/backoff; when `job.retryCount >= job.retryLimit` (requires `{ includeMetadata: true }` on `boss.work`) it first sets `status = error` + `error_reason`.
**Delivery semantics:** at-least-once — pg-boss on the existing PostgreSQL instance, schema `pgboss`, no dedicated container (per `phase-03-videos/TD-01`). Retry policy `retryLimit: 3`, `retryDelay: 5`, `retryBackoff: true` (per `phase-03-videos/TD-08`). Handler must be idempotent (per `phase-03-videos/TD-05`). No DLQ / manual reprocess this phase (per `phase-03-videos/TD-08`).

---

#### abandoned-upload-sweep

**Payload:** none — scheduled job, no data.

**Producer:** pg-boss cron schedule `0 * * * *` (hourly), registered at `video-worker` boot via `boss.schedule('abandoned-upload-sweep', '0 * * * *')` (per `abandoned-upload-cleanup/TD-01`).
**Consumer:** `AbandonedUploadCleanupWorker` in the `video-worker` container (per `abandoned-upload-cleanup/TD-01`).
**Trigger:** hourly tick.
**Processing:** selects `videos WHERE status = 'draft' AND created_at < now() - interval '24 hours'`; for each row calls `AbortMultipartUpload(bucket, storage_key, upload_id)` (tolerating an already-closed multipart — catch `NoSuchUpload`), then sets `status = 'error'`, `error_reason = 'upload_abandoned_ttl_exceeded'`. TTL (24h) and cron cadence are named constants.
**Delivery semantics:** at-least-once — pg-boss `schedule()` (per `abandoned-upload-cleanup/TD-01`). Idempotent: an already-swept or already-completed row no longer matches the `status = 'draft'` filter.

---

## Dependency Map

```
SI-03.1 (root) — infra no Compose: MinIO + minio-init + video-worker; pg-boss usa o Postgres existente.
                 Todo integration/e2e spec das SIs abaixo precisa desta infra no ar.

SI-03.2 (root) — config namespaces (storage, queue) + .env
└── SI-03.4 — depends on SI-03.2 (StorageService precisa do storageConfig)

SI-03.3 (root) — entidade Video + migration (Channel já existe da Fase 02)

SI-03.5 — depends on SI-03.3 + SI-03.4 (VideosModule precisa da entidade e do StorageService)
├── SI-03.6 — depends on SI-03.5 (complete-upload estende service/controller; adiciona QueueModule)
│   └── SI-03.7 — depends on SI-03.6 + SI-03.4 (worker consome a fila, usa download/upload do StorageService)
│       └── SI-03.9 — depends on SI-03.7 + SI-03.4 (sweep roda no worker, usa abortMultipartUpload)
└── SI-03.8 — depends on SI-03.5 + SI-03.4 (rotas de leitura estendem o módulo, usam presignGetObject)

SI-03.10 — depends on SI-03.8 + SI-03.9 (OpenAPI export, CLAUDE.md, diagrama e smoke após todos os endpoints e jobs)
```

---

## Deliverables

- [x] SI-03.1 — Infraestrutura: object storage, fila e worker no Compose
- [x] SI-03.2 — Config namespaces de storage e fila + `.env`
- [x] SI-03.3 — Entidade `Video` e migration
- [x] SI-03.4 — `StorageService` (cliente S3-compatível)
- [x] SI-03.5 — `VideosModule` + `POST /videos` (início do upload)
- [x] SI-03.6 — Fila pg-boss + `POST /videos/:id/complete-upload`
- [x] SI-03.7 — Worker de vídeo: processamento + thumbnail
- [x] SI-03.8 — Endpoints públicos de leitura: `GET /videos/:slug`, `/stream`, `/download`
- [x] SI-03.9 — Limpeza de uploads abandonados (job agendado)
- [x] SI-03.10 — Documentação: OpenAPI, `CLAUDE.md` de vídeos, diagrama e smoke

**Feature outcomes:**

- [x] Upload de vídeo de até 10GB sem travar a API (multipart pré-assinado, arquivo nunca passa pela API), com pré-cadastro do vídeo como `draft` ao iniciar.
- [x] Processamento automático após a confirmação do upload: `duration_seconds` + `metadata` (ffprobe) e `thumbnail.jpg` (ffmpeg) gerados pelo worker.
- [x] URL única por vídeo (`slug` de 10 caracteres, `nanoid`, coluna única com retry-on-conflito).
- [x] Streaming via `302` para URL pré-assinada (storage serve `Range`/`206`) e download via `302` com `attachment`.
- [x] Ciclo de status `draft → processing → ready | error` refletido no banco; sweep horário reclama uploads abandonados (`error` + `error_reason`).
- [x] `docker compose up -d` sobe API + Postgres + Mailpit + MinIO + video-worker juntos.

**Full test suites & Definition of Done:**

- [x] Testes unit + integração passam (`docker compose exec nestjs-api npm test -- --runInBand`).
- [x] Testes e2e passam (`docker compose exec nestjs-api npm run test:e2e`).
- [x] `docker compose exec nestjs-api npx tsc --noEmit` sai com código 0.
- [x] `docker compose exec nestjs-api npm run lint:ci` e `npm run format:check` limpos para todo arquivo tocado.
- [x] `docker compose exec nestjs-api npm run smoke` (estendido para o fluxo de vídeo) passa contra o app real rodando.
- [x] Git Flow respeitado: trabalho em `feature/phase-03-videos` a partir de `dev`, um commit por SI, sem commit direto na `main`.
