---
libs:
  "pg-boss":
    version: "latest (not installed yet — pin exact version at implementation time via `npm install pg-boss`)"
    context7_id: "/timgit/pg-boss"
    fetched_at: "2026-08-25T20:20:58-03:00"
  "@aws-sdk/client-s3":
    version: "latest (not installed yet — AWS SDK v3, pin exact version at implementation time)"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-25T20:20:58-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "latest (not installed yet — AWS SDK v3, pin exact version at implementation time)"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-25T20:20:58-03:00"
  "execa":
    version: "latest (not installed yet — pin exact version at implementation time)"
    context7_id: "/sindresorhus/execa"
    fetched_at: "2026-08-25T20:20:58-03:00"
  "ffmpeg-static":
    version: "latest (not installed yet — pin exact version at implementation time)"
    context7_id: "/descriptinc/ffmpeg-ffprobe-static"
    fetched_at: "2026-08-25T20:20:58-03:00"
  "ffprobe-static":
    version: "latest (not installed yet — pin exact version at implementation time)"
    context7_id: "/descriptinc/ffmpeg-ffprobe-static"
    fetched_at: "2026-08-25T20:20:58-03:00"
  "nanoid":
    version: "latest (not installed yet — pin exact version at implementation time)"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-08-25T20:20:58-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-25T19:34:19-03:00"
  docs/decisions/technical-decisions-abandoned-upload-cleanup.md: "2026-08-25T19:34:24-03:00"
---

# library-refs — phase-03-videos

Distilled Context7 excerpts scoped to how each library is actually used per the phase's decided TDs. Not exhaustive API docs — see the library's own docs for anything beyond what's listed here.

## pg-boss

_(phase-03-videos/TD-01 — background job queue; abandoned-upload-cleanup/TD-01 — scheduled sweep job)_

Queue creation with retry/backoff config (used by TD-08's status-lifecycle retry model):

```js
await boss.createQueue('video-processing', {
  policy: 'standard',
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,     // exponential backoff
  deadLetter: 'video-processing-dlq',
});
```

Sending a job:

```js
await boss.send({ name: 'video-processing', data: { videoId }, options: { retryLimit: 3 } });
```

Worker (job handler):

```js
await boss.work('video-processing', { batchSize: 1 }, async (jobs) => {
  for (const job of jobs) {
    // extract metadata, generate thumbnail, flip status
  }
});
```

**Cron scheduling** — this is the mechanism `abandoned-upload-cleanup/TD-01` relies on for the sweep job:

```js
// schedule(name, cron, data, options)
await boss.schedule('cleanup-abandoned-uploads', '0 * * * *', null, { tz: 'UTC' });
// a worker on the same queue name picks up the scheduled job each run
```

## @aws-sdk/client-s3

_(phase-03-videos/TD-02 — multipart upload; TD-03 — completion detection via HeadObject; abandoned-upload-cleanup/TD-01 — AbortMultipartUpload)_

Multipart upload lifecycle — the four commands TD-02/TD-03 need:

- `CreateMultipartUploadCommand` — starts the upload, returns an `UploadId`.
- `UploadPartCommand` — used indirectly: the API doesn't call this itself under TD-02 (client uploads parts directly to presigned URLs); the API only needs the `UploadId` to construct presigned part URLs.
- `CompleteMultipartUploadCommand` — called by the API once the client reports all parts uploaded (with their ETags), per TD-03's completion endpoint.
- `HeadObjectCommand` — used by TD-03 to server-side verify the object exists after `CompleteMultipartUploadCommand`, before flipping status.
- `AbortMultipartUploadCommand` — called by `abandoned-upload-cleanup/TD-01`'s sweep job to release storage for uploads that were never completed.

```js
import { S3Client, CreateMultipartUploadCommand, CompleteMultipartUploadCommand, HeadObjectCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ endpoint: process.env.STORAGE_ENDPOINT, forcePathStyle: true, region: "us-east-1" });

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));

// ... after client reports parts done:
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ ETag, PartNumber }, /* ... */] },
}));

await s3.send(new HeadObjectCommand({ Bucket, Key })); // throws if object doesn't exist — TD-03's server-side verification

// abandoned-upload-cleanup/TD-01 sweep:
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

Note (informational, surfaced during research but not a strategic decision — MinIO also supports the same bucket lifecycle feature TD-02's Option B considered and rejected): `AbortIncompleteMultipartUpload` can additionally be configured as a bucket lifecycle rule (`DaysAfterInitiation`) for defense-in-depth alongside the application-level sweep — this is an implementation nuance for `/implement`, not a re-opened TD.

## @aws-sdk/s3-request-presigner

_(phase-03-videos/TD-02 — presigned part URLs for upload; TD-07 — presigned GET for streaming/download)_

```js
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ endpoint: process.env.STORAGE_ENDPOINT, forcePathStyle: true, region: "us-east-1" });

// TD-02 — one presigned URL per part
const uploadPartUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// TD-07 — presigned GET, streaming (Range header passed through automatically by S3/MinIO — no extra config needed;
// the presigner preserves the Range header if the client sets it on the GET, per s3-request-presigner's
// header-preservation behavior) and download (response-content-disposition override for attachment)
const streamUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: "attachment" }),
  { expiresIn: 3600 },
);
```

`expiresIn` defaults to 900s if omitted — TD-07's "sensibly bounded expiry window" concern should set this explicitly per use case (streaming session vs. one-shot download link), a config value for `/implement`, not a re-opened TD.

## execa

_(phase-03-videos/TD-05 — direct ffmpeg/ffprobe CLI invocation)_

```js
import { execa } from 'execa';

// ffprobe metadata extraction
const { stdout } = await execa(ffprobePath, ['-print_format', 'json', '-show_format', '-show_streams', inputPath]);
const metadata = JSON.parse(stdout);

// ffmpeg thumbnail extraction
await execa(ffmpegPath, ['-ss', '1', '-i', inputPath, '-frames:v', '1', outputPath]);
```

Error handling — a non-zero exit surfaces as a rejected promise with `error.exitCode`, `error.stdout`, `error.stderr` populated (per TD-08's failure path, this is what the worker job handler catches to mark a job attempt failed and let pg-boss's retry/backoff take over):

```js
try {
  await execa(ffmpegPath, args);
} catch (error) {
  // error.exitCode, error.stdout, error.stderr, error.timedOut, error.signal
  throw error; // rethrow so pg-boss's work() handler marks the job failed → retry
}
```

## ffmpeg-static / ffprobe-static

_(phase-03-videos/TD-05 — binary provisioning for the worker)_

Both packages are from the same repo/family; each just resolves to the platform-appropriate binary path:

```js
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path; // note: ffprobe-static's own export shape may differ by version — verify at implementation time (bounded to the exact `require(...)` shape, not a strategic decision)
```

Always verify the resolved path exists and is executable before use (platform binary may be missing in a stripped-down Docker base image):

```js
const fs = require('fs');
if (!ffmpegPath) throw new Error('ffmpeg binary not available for this platform');
fs.accessSync(ffmpegPath, fs.constants.X_OK);
```

## nanoid

_(phase-03-videos/TD-06 — short slug as public video URL identifier)_

```js
import { nanoid, customAlphabet } from 'nanoid';

const id = nanoid(); // default 21 chars — longer than TD-06's "8-10 chars" target

// TD-06 specifically wants a short slug — use customAlphabet for a bounded length
const generateVideoSlug = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);
const slug = generateVideoSlug(); // e.g. "k3f8h2m9pq"
```

nanoid IDs are URL-safe by construction — no `encodeURIComponent()` needed when embedding in a route path. Collision handling (unique DB constraint + retry-on-conflict) is an `/implement`-level concern per TD-06's own text, not covered by the library itself.
