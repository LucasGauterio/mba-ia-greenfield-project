---
libs:
  "pg-boss":
    version: "^10"
    context7_id: "n/a — no direct Context7 entry; primary source github.com/timgit/pg-boss (v10 release notes) + /ludicroushq/pg-bossman wrapper docs"
    fetched_at: "2026-08-31T17:44:16-03:00"
  "@aws-sdk/client-s3":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-31T17:44:16-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-31T17:44:16-03:00"
  "execa":
    version: "^5.1.1"
    context7_id: "/sindresorhus/execa"
    fetched_at: "2026-08-31T17:44:16-03:00"
  "ffmpeg-static":
    version: "^5"
    context7_id: "n/a — no Context7 entry; source github.com/eugeneware/ffmpeg-static"
    fetched_at: "2026-08-31T17:44:16-03:00"
  "ffprobe-static":
    version: "^3"
    context7_id: "n/a — no Context7 entry; source github.com/joshwnj/ffprobe-static"
    fetched_at: "2026-08-31T17:44:16-03:00"
  "nanoid":
    version: "^5"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-08-31T17:44:16-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T17:09:47-03:00"
  docs/decisions/technical-decisions-abandoned-upload-cleanup.md: "2026-08-31T17:09:52-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries newly introduced in phase 03, scoped to the surfaces the TDs actually use. Fetched via Context7 (`/aws/aws-sdk-js-v3`, `/sindresorhus/execa`, `/ai/nanoid`) plus primary sources for the packages Context7 does not index (`pg-boss`, `ffmpeg-static`, `ffprobe-static`).

> ⚠️ **Three of these packages are ESM-only or ESM-shifted and the backend runs ts-jest / CommonJS.** See the **CommonJS / Jest compatibility** section at the end — it is load-bearing for `plan-build` (SI slicing) and `implement` (`package.json` jest config).

---

## pg-boss (`^10`) — `phase-03-videos/TD-01`, `phase-03-videos/TD-08`, `abandoned-upload-cleanup/TD-01`

PostgreSQL-backed job queue using `SELECT … FOR UPDATE SKIP LOCKED`. Runs against the **same** Postgres instance already in the stack, in a dedicated `pgboss` schema. No Context7 index — distilled from the v10.0.0 release notes and the API docs (`timgit.github.io/pg-boss`).

### v10 breaking changes that matter here

- **Node ≥ 20, PostgreSQL ≥ 13** required (both satisfied — Postgres 17 in `compose.yaml`).
- **Queues must be created explicitly** before `send`/`work`: `await boss.createQueue(name)`.
- **`work()` handlers always receive an array of jobs**, even with `batchSize: 1` — iterate, don't treat the arg as a single job.
- **Retries are opt-out**: default `retryLimit` is now `2`. The TDs pin `retryLimit: 3` explicitly, so this default is overridden.
- **Dead-letter queues** replace completion jobs for exhausted retries (not used this phase — TD-08 says no DLQ).
- `complete()` / `fail()` / `cancel()` / `getJobById()` now require the queue name as first arg.
- Job table columns are **snake_case** (`retry_limit`, `retry_count`, …) — relevant only if querying `pgboss.job` directly (the abandoned-upload sweep in `abandoned-upload-cleanup/TD-01` queries `videos`, not `pgboss.job`, so this doesn't bite).
- No auto-migration from v9 (greenfield here — non-issue).

### Core API (as used by the TDs)

```ts
import PgBoss from 'pg-boss';

// connection string derived from DB_* env (see src/config/queue.config.ts per the decisions doc)
const boss = new PgBoss({ connectionString, schema: 'pgboss' });
await boss.start();

// TD-03: enqueue the processing job on upload completion
await boss.createQueue('video-processing');
await boss.send('video-processing', { videoId }, {
  retryLimit: 3,        // TD-08
  retryDelay: 5,        // seconds
  retryBackoff: true,   // exponential; with retryBackoff:true an unset retryDelay defaults to 1
});

// TD-05: worker consumes the queue
await boss.work(
  'video-processing',
  { batchSize: 1, includeMetadata: true },   // includeMetadata → job.retryCount / job.retryLimit populated
  async ([job]) => {                          // NOTE: always an array
    const { videoId } = job.data;
    const isLastAttempt = job.retryCount >= job.retryLimit;   // TD-08 / PLAN §11.4
    try {
      await processVideo(videoId);
    } catch (err) {
      if (isLastAttempt) await markVideoError(videoId, String(err));
      throw err;   // ALWAYS re-throw so pg-boss records the failure and drives retry/backoff
    }
  },
);

// abandoned-upload-cleanup/TD-01: hourly sweep, native cron (no external scheduler)
await boss.createQueue('abandoned-upload-sweep');
await boss.schedule('abandoned-upload-sweep', '0 * * * *');   // cron, optional tz arg
await boss.work('abandoned-upload-sweep', async () => { await sweepAbandonedUploads(); });

// graceful shutdown (worker entrypoint)
await boss.stop({ graceful: true });
```

### Testing notes (see `context.md` → Testing Requirements)

- Integration/e2e share one Postgres → run `--runInBand`; the `pgboss` schema is shared across suites.
- Guard the worker integration test against cross-suite job contamination: assert only on the job carrying **this test's own `videoId`**.
- Close the whole `TestingModule` in `afterAll` (not just `dataSource.destroy()`) — an open pg-boss pool triggers "Jest did not exit".
- Purge `pgboss.job` between local sessions if backlog builds up (FIFO order can push the test's job behind stale ones and blow the timeout).
- Kill any manually-started `npm run start:worker` before running the suite — it races the test's `boss.work()` for jobs.

---

## @aws-sdk/client-s3 (`^3`) — `phase-03-videos/TD-02`, `TD-03`, `TD-04`, `abandoned-upload-cleanup/TD-01`

S3 client, used against **MinIO** locally (S3-compatible). Context7: `/aws/aws-sdk-js-v3`.

### Client setup for MinIO

```ts
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: config.storageEndpoint,        // http://minio:9000  (Compose service name, not localhost)
  region: config.storageRegion,            // us-east-1
  credentials: {
    accessKeyId: config.storageAccessKeyId,
    secretAccessKey: config.storageSecretAccessKey,
  },
  forcePathStyle: true,                     // REQUIRED for MinIO (no vhost-style buckets)
});
```

### Multipart upload — control-plane commands (TD-02 / TD-03)

```ts
import {
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  HeadObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';

// 1. initiate — persist UploadId on the videos row (TD-02 → upload_id column)
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
  Bucket: 'streamtube', Key: `videos/${id}/original.${ext}`, ContentType: contentType,
}));

// 2. per-part presigned URLs are generated with s3-request-presigner (see below)

// 3. complete — client sends back [{ PartNumber, ETag }]
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts /* CompletedPart[]: { ETag, PartNumber } */ },
}));

// 4. verify it actually landed (TD-03) — a HeadObject failure AFTER a successful
//    CompleteMultipartUpload is the 502 VIDEO_UPLOAD_VERIFICATION_FAILED branch
await s3.send(new HeadObjectCommand({ Bucket, Key }));

// abandoned-upload-cleanup/TD-01: release an incomplete multipart
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));  // idempotent-tolerant: catch NoSuchUpload
```

### Worker object I/O (TD-05)

- **`uploadObject` (thumbnail) MUST pass an explicit `ContentLength`** — the SDK does not infer it from a raw `fs.createReadStream`, and omitting it fails with a cryptic header error (PLAN §11.4). Use `(await fs.promises.stat(path)).size`, or pass a `Buffer`.
- Worker never streams the original through the API: it `GetObject`s the original to a temp file, runs ffprobe/ffmpeg locally, `PutObject`s the thumbnail, cleans the tempdir.

---

## @aws-sdk/s3-request-presigner (`^3`) — `phase-03-videos/TD-02`, `TD-07`

`getSignedUrl(client, command, options)` — turns any S3 command into a time-limited URL the client uses directly against storage. Context7: `/aws/aws-sdk-js-v3`.

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// TD-02: one presigned URL per part — client PUTs each part straight to MinIO
const partUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: n }),
  { expiresIn: 3600 },
);

// TD-07: streaming — 302 redirect to a presigned GET; storage serves Range/206 on the follow-up
const streamUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 900 });

// TD-07: download — same, plus force an attachment filename
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: `attachment; filename="${safeName}"` }),
  { expiresIn: 900 },
);
```

- The endpoint returns `302` with `Location: <presigned url>`; it never reads or forwards the client's `Range` header (TD-07). Range negotiation happens between the client and MinIO on the redirected request.
- `x-amz-*` headers that must be signed (e.g. checksums) go in `getSignedUrl`'s `unhoistableHeaders: new Set([...])` — not needed for the plain part/GET flow above.

---

## execa (`^5.1.1`) — `phase-03-videos/TD-05`

⚠️ **The TD pins v5 deliberately — it is the last CommonJS major.** Context7 (`/sindresorhus/execa`) documents **v9**, whose API differs. Use the v5 API below, not the Context7 snippets.

### v5 API (what to actually write)

```ts
import execa from 'execa';   // v5: DEFAULT import (v9 is `import { execa } from 'execa'`)

// run a binary with an args array — NO shell, NO tagged-template (that's v9)
const { stdout } = await execa(ffprobePath, [
  '-v', 'error', '-show_format', '-show_streams', '-of', 'json', inputPath,
]);
const meta = JSON.parse(stdout);

await execa(ffmpegPath, [
  '-ss', '0',                // PLAN §11.4: use -ss 0, not -ss 1 (silently no-ops on sub-1s videos)
  '-i', inputPath,
  '-frames:v', '1', '-q:v', '2',
  thumbnailPath,
]);
```

### v5 error shape (on non-zero exit, the promise rejects)

```ts
try {
  await execa(bin, args);
} catch (err) {
  // v5 error object (no ExecaError class — that's v9)
  err.exitCode;      // number
  err.stderr;        // captured
  err.stdout;
  err.timedOut;      // boolean (with { timeout: ms } option)
  err.command;       // the command string
  err.shortMessage;  // message + command
  err.failed;        // true
}
```

- `{ timeout: 30000 }` option → `err.timedOut === true` on expiry (concept unchanged from v9 docs).
- `{ reject: false }` → resolve instead of throw; inspect `result.exitCode` (concept unchanged).
- Do **not** add `transformIgnorePatterns` entries for execa — v5's dependency tree is CommonJS. (v10's tree includes `unicorn-magic` with no `require` export, which is unshimmable — that is exactly why the TD pinned v5.)

---

## ffmpeg-static (`^5`) / ffprobe-static (`^3`) — `phase-03-videos/TD-05`

Bundled static binaries so the worker image needs no `apt-get install ffmpeg`. No Context7 index — trivial packages.

```ts
import ffmpegPath from 'ffmpeg-static';        // default export: absolute path string to the ffmpeg binary
import ffprobeStatic from 'ffprobe-static';    // { path: string, version: string }
const ffprobePath = ffprobeStatic.path;
```

- `ffprobe-static` ships no TypeScript types → add `src/types/ffprobe-static.d.ts` (`declare module 'ffprobe-static' { export const path: string; export const version: string; }`) (PLAN §5.1).
- **Docker/arch caveat:** the binary downloaded at `npm install` is for the install host's platform+arch. In this project everything installs and runs **inside the container**, so the container's arch is what matters — the `video-worker` service reuses the API image / bind-mount, so `npm install` inside that image produces the right binary. If `node_modules` were ever bind-mounted from a different-arch host, the binary would be wrong (`ENOEXEC` / `exec format error`).
- These are `node_modules` binaries, not `src/` runtime assets → **not** declared in `nest-cli.json` `assets` (that list is for non-`.ts` files under `src/`).

---

## nanoid (`^5`) — `phase-03-videos/TD-06`

URL-safe unique-ID generator. Context7: `/ai/nanoid`.

```ts
import { nanoid } from 'nanoid';
const slug = nanoid(10);   // TD-06: varchar(10) unique column on videos

// if a restricted alphabet is ever wanted (not required by TD-06):
import { customAlphabet } from 'nanoid';
const gen = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);
```

- TD-06 pairs this with a **retry-on-`23505`** loop mirroring `ChannelsService` (`isPgUniqueViolationOnColumn` + `MAX_RETRIES`) — collision probability at `nanoid(10)` is negligible but the loop makes it a non-issue.

### ⚠️ Version / CommonJS discrepancy — decide before `implement`

Context7's changelog is explicit: **nanoid removed CommonJS in v4; `3.x` is the last branch with CJS support.** So `nanoid@^5` (the TD's pin) is **ESM-only**. The backend is ts-jest / CommonJS, so `nanoid@^5` requires a `transformIgnorePatterns` entry in **both** `package.json` (jest) and `test/jest-e2e.json` — matching what PLAN §11.1 records the previous execution having done (final value: `"transformIgnorePatterns": ["node_modules/(?!(pg-boss|serialize-error|non-error|type-fest|nanoid)/)"]`).

Two viable paths for `plan-build` / `implement` to choose from:
1. **Keep `nanoid@^5`** (matches the TD verbatim) → add it to the `transformIgnorePatterns` allowlist alongside the pg-boss chain.
2. **Pin `nanoid@^3`** (last CJS major) → no Jest config change for nanoid at all; smaller blast radius. The TD names the library, not a hard version ceiling, and its rationale (short friendly slug + retry pattern) is version-agnostic.

Flagging per the "flag the discrepancy before proceeding" rule — this is not a blocker, but the choice belongs in the plan, not silently in implementation.

---

## CommonJS / Jest compatibility — consolidated (load-bearing for `plan-build` + `implement`)

The backend transpiles tests with **ts-jest (CommonJS)**. Three of this phase's new deps clash with that:

| Package | Status | Fix |
|---|---|---|
| `pg-boss@^10` | dependency chain `pg-boss → serialize-error → non-error` (and `type-fest`) is ESM-only | `transformIgnorePatterns` entry in `package.json` **and** `test/jest-e2e.json`. Latent until the first suite that boots the real `AppModule` (`openapi-export.integration-spec.ts`, e2e). |
| `nanoid@^5` | ESM-only since v4 | same `transformIgnorePatterns` list (add proactively) — **or** pin `nanoid@^3` to avoid it (see nanoid section). |
| `execa@^5.1.1` | **CommonJS — no fix needed.** Pinned to v5 precisely to avoid v10's unshimmable ESM chain (`unicorn-magic`). | none. Import as `import execa from 'execa'` (default export). |
| `@aws-sdk/*@^3` | CommonJS | none. |
| `ffmpeg-static` / `ffprobe-static` | CommonJS | none. |

Reference `transformIgnorePatterns` value the previous execution landed on:
`"transformIgnorePatterns": ["node_modules/(?!(pg-boss|serialize-error|non-error|type-fest|nanoid)/)"]`
