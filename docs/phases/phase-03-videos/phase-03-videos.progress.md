# Phase 03 — Upload e Processamento de Vídeos — Progress

**Status:** in_progress
**SIs:** 6/8 completed

### SI-03.1 — Infra: object storage e worker de vídeo no Compose
- **Status:** completed
- **Tests:** no tests (Infra SI) — acceptance criteria verified manually: `minio` healthy + bucket `streamtube` bootstrapped via `minio-init` (mc mb), `video-worker` container builds and stays running without crash loop
- **Observations:** video-worker reuses the same `Dockerfile.dev`/bind-mount as `nestjs-api` and stays dormant (`tail -f /dev/null`) by default, matching the project's "don't auto-start app processes" dev convention — it will be driven by an explicit `npm run start:worker...` once SI-03.2/03.6 add real queue-consumer code. This is an implementation detail, not a re-opened TD.

### SI-03.2 — Infra: fila pg-boss
- **Status:** completed
- **Tests:** no tests (Infra SI) — acceptance criteria verified manually: app booted twice against real Postgres, `QueueModule dependencies initialized` both times with no error; `pgboss.queue` table confirmed to contain `video-processing` with `retry_limit=3, retry_delay=5, retry_backoff=t` (per TD-08); second boot proved `createQueue` idempotency
- **Observations:** `QueueModule` guards `createQueue` behind a `getQueue` existence check (per pg-boss docs' own recommended safe-repeat pattern) rather than relying on bare `createQueue` idempotency, to positively guarantee the "no error on restart" acceptance criterion.

### SI-03.3 — Migration: entidade Video
- **Status:** completed
- **Tests:** `video.entity.integration-spec.ts` — 5/5 passing (not-null channel_id, FK channel_id, unique slug, default status=draft, ManyToOne relation load). Full suite after fixes: unit+integration 24/24 suites, 150/150 tests; e2e 3/3 suites, 52/52 tests.
- **Observations:**
  - `Channel` does NOT yet get the inverse `@OneToMany(() => Video, ...)` — adding it broke `AppModule` bootstrap because nothing registers `Video` via `TypeOrmModule.forFeature` yet (that's SI-03.4's own first technical action). `Video.channel` is a one-sided `@ManyToOne` for now; add the inverse relation back in SI-03.4 alongside `VideosModule`.
  - `pg-boss` (from SI-03.2) is ESM-only and broke Jest for any suite that boots the real `AppModule` (`openapi-export.integration-spec.ts`, e2e specs) — fixed by adding `transformIgnorePatterns` for the `pg-boss → serialize-error → non-error` ESM chain in both `package.json`'s jest config and `test/jest-e2e.json`. This was latent since SI-03.2 and only surfaced now that a full-suite run happened.
  - Fixed a pre-existing race condition in `migrations.integration-spec.ts`'s `beforeAll` (`DROP TYPE` could run concurrently with, and ahead of, `DROP TABLE ... CASCADE` across pooled connections) — now sequenced as two `Promise.all` batches. Necessary once a second enum type (`videos_status_enum`) was added; the project already followed this must-fix pattern.
  - `npm run lint` reports pre-existing errors in `auth.service.integration-spec.ts`, `auth.service.spec.ts`, and others — confirmed via `git diff` that none of the flagged lines were touched by this phase's changes (this branch started from `HEAD`, the "docs: generate phase 3 plan" commit). Left untouched per Scope Limits; flagged here as a pre-existing follow-up for the user, not fixed.

### SI-03.4 — Endpoint POST /videos (iniciar upload)
- **Status:** completed
- **Tests:** `videos.service.spec.ts` 5/5, `videos.module.spec.ts` 1/1, `videos.service.integration-spec.ts` 2/2 (real DB + real MinIO, including concurrent-slug-uniqueness), `test/videos.e2e-spec.ts` 4/4. Full suite: unit+integration 27/27 suites, 160/160 tests; e2e 4/4 suites, 56/56 tests.
- **Observations:**
  - Restored `Channel`'s inverse `videos` OneToMany relation now that `VideosModule` registers `Video` via `TypeOrmModule.forFeature` (deferred in SI-03.3). Had to add `Video` to several pre-existing modules' isolated test entity lists (`auth.module.spec.ts`, `channels.module.spec.ts`, `users.module.spec.ts`) for the same reason as SI-03.3's integration specs.
  - `nanoid` (used for slug generation, TD-06) is ESM-only like `pg-boss` — added to the same `transformIgnorePatterns` in both jest configs proactively, avoiding another round of the SI-03.3 debugging cycle.
  - Added `ChannelsService.findByUserId()` (small, needed to resolve the requester's channel in `VideosService.initiateUpload`) with its own integration test coverage — a supporting dependency, not scope creep.
  - Slug collision handling mirrors `ChannelsService`'s existing nickname-retry pattern (catch unique-violation, regenerate, retry up to 5 times) — no explicit transaction needed since each `repository.save()` outside a transaction is its own auto-committed attempt, avoiding the SAVEPOINT complexity `typeorm-migrations.md` warns about for in-transaction retries.
  - Found and fixed a real reliability gap unrelated to my own new code: `npm run test:e2e` was missing `--runInBand` despite `CLAUDE.md` documenting it as "already configured" — parallel e2e workers all booting the now-heavier `AppModule` (real pg-boss connection since SI-03.2) simultaneously caused intermittent 5s hook-timeout failures across `app.e2e-spec.ts`/`auth.e2e-spec.ts`/`swagger.e2e-spec.ts`. Fixed the script and bumped those files' `beforeAll` timeouts to 30s.
  - Fixed a second race in `migrations.integration-spec.ts`'s cleanup: concurrent `DROP TABLE ... CASCADE` statements across pooled connections could deadlock. Rewrote the cleanup as fully sequential (children before parents) rather than another `Promise.all` reordering.
  - Lint: `videos.constants.ts` prettier issue and `require-await` warnings in `videos.service.spec.ts` fixed (mechanical). Remaining `no-unsafe-*` errors in `videos.service.ts`/`videos.service.spec.ts` follow the exact same `any`-cast pattern already used untouched in pre-existing `channels.service.ts` (confirmed via `git diff` — not a regression, matches established codebase convention for unique-violation detection and test mocking) — left as-is per SI-03.3's precedent on pre-existing lint debt.

### SI-03.5 — Endpoint POST /videos/:id/complete-upload
- **Status:** completed
- **Tests:** `videos.service.spec.ts` +5 completeUpload branch tests (10/10 total), `videos.module.spec.ts` 1/1, `videos.service.integration-spec.ts` +3 completeUpload tests (5/5 total, real MinIO multipart upload via presigned URLs + real HeadObject verification), `test/videos.e2e-spec.ts` +6 complete-upload tests (10/10 total). Full suite: unit+integration 27/27 suites, 168/168 tests; e2e 4/4 suites, 62/62 tests.
- **Observations:**
  - `VideosService` now injects `PG_BOSS` (global `QueueModule`) and sends a `video-processing` job after the DB flip to `processing` — matching SI-03.6's consumer contract.
  - The 502 `VIDEO_UPLOAD_VERIFICATION_FAILED` branch (HeadObject failing *after* a successful CompleteMultipartUpload) is covered only by the unit test — forcing that exact sequence deterministically against real MinIO isn't practical, and the plan's own Tests table splits "ownership/status/verificação" branch logic to Unit vs. "DB contract + MinIO real" to Integration, so this matches the intended split rather than a coverage gap.
  - A failure from `completeMultipartUpload` itself (e.g., a client lying about ETags) is deliberately left unhandled/propagating as a generic error — the Error Catalog only defines a code for the HeadObject-after-success case (TD-03), so mapping the completion call's own failures to a domain exception would be an undocumented design decision, not something this SI's contract asks for.
  - Response status fixed to `200` (`@HttpCode(HttpStatus.OK)`) per the API contract, overriding Nest's `@Post` default of `201`.
  - Found the same `moduleRef.close()` gap in SI-03.4's own integration test (added when I extended it for completeUpload): it only called `dataSource.destroy()`, never closing the `QueueModule`'s pg-boss connection, causing Jest's "did not exit" warning. Fixed by storing and closing the whole `TestingModule` instead.
  - Lint: fixed two more mechanical `require-await` issues in my own test files. Remaining `no-unsafe-*` errors continue to match the pre-existing convention already used untouched elsewhere in the codebase — left as-is per SI-03.3/SI-03.4 precedent.

### SI-03.6 — Worker de processamento de vídeo
- **Status:** completed
- **Tests:** `video-processing.worker.spec.ts` 7/7 (mocked execa, repo, storage — success/failure/retry-exhaustion branches), `worker.module.spec.ts` 1/1, `video-processing.worker.integration-spec.ts` 2/2 (real ffmpeg/ffprobe against a fixture generated with real ffmpeg + real MinIO round-trip + real pg-boss dispatch through `boss.work`). Full suite: unit+integration 30/30 suites, 178/178 tests; e2e 4/4 suites, 62/62 tests.
- **Observations:**
  - `execa` v10 (installed in SI-03.1) turned out to be ESM-only with a ~15-package-deep ESM dependency chain, including at least one package (`unicorn-magic`) whose `package.json` `exports` map has no `require` condition at all — a hard wall no `transformIgnorePatterns` addition can cross. **Downgraded to `execa@5.1.1`**, the last CommonJS-compatible major (TD-05 names the library, not a version — this is an implementation detail). Reverted the `transformIgnorePatterns` additions this required along the way; only the original pg-boss/nanoid entries remain. Import style changed accordingly: `import execa from 'execa'` (v5 uses `export =`), not the v10 named export.
  - Video bytes never touch the API (per TD-02) — the worker downloads the object from storage first (`StorageService.downloadObject`, new), runs ffprobe/ffmpeg against the local temp copy, uploads the resulting thumbnail (`StorageService.uploadObject`, new), then cleans up the temp dir. `uploadObject` needed an explicit `ContentLength` (via `fs.stat`) — the AWS SDK can't infer it from a raw `fs.createReadStream` and fails with a cryptic header error otherwise.
  - Found and fixed a real correctness bug during integration testing: the initial fixed `-ss 1` (seek 1s) thumbnail command fails *silently* (ffmpeg exits 0, writes no file) for videos shorter than 1 second. Nothing in the AC guarantees a minimum video length, so changed to `-ss 0`, which always has a frame to extract.
  - `handleJob(job)` checks `job.retryCount >= job.retryLimit` (via `{ includeMetadata: true }` on `boss.work`) to decide whether *this* failure is the last allowed attempt before setting `status: error` — always rethrows either way, letting pg-boss's own retry/backoff bookkeeping proceed independently. This is unit-tested directly (fabricated job objects) rather than by waiting out real backoff timers, which would be slow and flaky.
  - `WorkerModule` needed `Channel` and `User` registered via `TypeOrmModule.forFeature` alongside `Video` (not just `Video`) — same class of relation-resolution bug as SI-03.3's `Channel#videos` issue, just one hop further down the relation chain (`Video → Channel → User`).
  - The real-queue integration test guards against **cross-suite contamination**: the `pgboss.job` table is shared and never cleaned between test files, so a leftover job from an earlier suite (e.g. `videos.service.integration-spec.ts`, which does real `boss.send` calls) can be picked up by `boss.work` first. The test only resolves/rejects on the job matching its own `videoId`; anything else runs through `handleJob` without affecting the assertion.
  - Manually verified the actual `video-worker` container entrypoint (`docker compose exec video-worker npm run start:worker`) boots cleanly against real infra before finalizing.

### SI-03.7 — Endpoints de leitura, streaming e download
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.8 — Limpeza de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** —
