# TEST_PLAN.md — Video pipeline (Phase 03)

This plan is **executable**. One script brings up the stack, prepares it, and
asserts the whole flow against a real media file:

```bash
bash nestjs-project/scripts/test-video-pipeline.sh <video-file>
```

```bash
# examples
bash nestjs-project/scripts/test-video-pipeline.sh ~/clips/demo.mp4
API_URL=http://localhost:3000 bash nestjs-project/scripts/test-video-pipeline.sh ./sample.mov
```

Exit code: `0` all checks passed · `1` a check failed · `2` bad usage / setup error.

Every request is echoed with all parameters before it runs (dimmed, prefixed
`$`), so the run doubles as a copy-pasteable log. It ends by printing the
`curl` commands to fetch the video it just created.

---

## Endpoints under test

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /videos` | Inicia o upload (cria `draft`, retorna `uploadId` + `parts[]` pré-assinadas) |
| `POST /videos/:id/complete-upload` | Confirma o upload, verifica o objeto e enfileira o processamento |
| `GET /videos/:slug` | Metadados públicos do vídeo (auth opcional) |
| `GET /videos/:slug/stream` | `302` para a URL pré-assinada de streaming |
| `GET /videos/:slug/download` | `302` para a URL pré-assinada com `Content-Disposition: attachment` |

Auth is exercised too (`POST /auth/register` → confirm via Mailpit → `POST /auth/login`),
because every write route needs a Bearer token and the caller needs a channel.

---

## What the script does

**0. Bring up + prepare the environment**

- `docker compose up -d` — db, MinIO (+ bucket bootstrap), Mailpit, `video-worker`,
  and the idle `nestjs-api` container.
- Waits for Postgres (`pg_isready`) and MinIO (`/minio/health/live`).
- **Installs dependencies inside the container** if the check fails — `node_modules`
  is bind-mounted, and a host `npm install` leaves the Linux-native binaries
  missing (e.g. `@css-inline/css-inline-linux-x64-gnu`, pulled by
  `@nestjs-modules/mailer`).
- Runs `npm run migration:run` (idempotent).
- Starts **one** `npm run start:dev` (the container idles on `tail -f /dev/null`);
  kills any stacked watchers first, waits up to 7 min for the first compile, and
  retries once through an `npm install` if it dies with a missing native module.
- Clears the `pgboss.job` backlog so this run's job isn't stuck behind old failed
  retries.
- Copies `<video-file>` into the container (the presigned `PUT`s run on the
  compose network, where the `minio` hostname resolves).

**1. Auth** — registers users **A** and **B**, pulls each confirmation token from
the Mailpit API, confirms, logs in. `GET /auth/me` sanity check.

**2. Happy path** (as user A)

- `POST /videos` → `201`, `status: draft`, N presigned part URLs.
- Splits the file into 64 MiB parts and `PUT`s each straight to MinIO, collecting ETags.
- `POST /videos/:id/complete-upload` → `200`, `status: processing`.
- Waits for the `video-worker` (polls the DB, not the API — avoids the rate limit)
  until `status = ready`.

**3. Read endpoints**

- `GET /videos/:slug` as owner → `200`, body carries `channel.nickname`.
- `GET /videos/:slug` anonymous (ready video) → `200`.
- `GET /videos/:slug/stream` → `302`; follows the presigned URL and checks the
  streamed byte count equals the source file.
- `GET /videos/:slug/download` → `302` with `response-content-disposition=attachment`.

**4. Negative cases**

| Route | Case | Expected |
|---|---|---|
| `POST /videos` | no token | `401` |
| `POST /videos` | empty body | `400` |
| `POST /videos` | `fileName` without extension | `400` |
| `POST /videos` | `fileSize` > 10 GiB | `400` `VIDEO_FILE_TOO_LARGE` |
| `POST /videos/:id/complete-upload` | non-UUID `:id` | `400` |
| `POST /videos/:id/complete-upload` | unknown UUID | `404` `VIDEO_NOT_FOUND` |
| `POST /videos/:id/complete-upload` | already completed | `409` `VIDEO_UPLOAD_ALREADY_COMPLETED` |
| `POST /videos/:id/complete-upload` | as a non-owner (user B) | `403` `VIDEO_NOT_OWNED` |
| `GET /videos/:slug` | unknown slug | `404` |
| `GET /videos/:slug` | draft, anonymous | `404` (no existence leak) |
| `GET /videos/:slug` | draft, owner | `200` |
| `GET /videos/:slug/stream` | draft (no object yet) | `404` |

---

## Prerequisites

- **Docker Desktop** running, with `docker compose` v2.
- **Bash** + **curl** on the host (Git Bash on Windows is fine — the script keeps
  container paths inside `sh -c` and sets `MSYS_NO_PATHCONV=1`).
- A real video file (`.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv`, `.avi`). A dummy /
  text file makes the worker fail the job and the video ends `status: "error"`.

No manual `docker compose up`, `npm install`, `migration:run`, or `start:dev` —
the script does all of it.

Need a clip? Generate a 3-second one with the worker's bundled ffmpeg:

```bash
cd nestjs-project
docker compose up -d video-worker
docker compose exec -T video-worker node -e "\
const ffmpeg=require('ffmpeg-static'); \
require('child_process').execFileSync(ffmpeg,\
['-f','lavfi','-i','testsrc=duration=3:size=640x360:rate=24','-pix_fmt','yuv420p','-y',\
'/home/node/app/sample.mp4'],{stdio:'inherit'});"
# -> nestjs-project/sample.mp4
```

## Configuration (env overrides)

| Var | Default |
|---|---|
| `API_URL` | `http://localhost:3000` |
| `MAILPIT_URL` | `http://localhost:8025` |

---

## Opening `/stream` or `/download` (the `minio` host caveat)

`GET /videos/:slug/stream` and `/download` return a **`302`** to a presigned
object-storage URL whose host is `http://minio:9000` — the Compose **service
name** (`STORAGE_ENDPOINT`), because the API talks to MinIO over the Docker
network. That hostname does **not** resolve from your host or browser, and the
presigned signature is bound to the `Host: minio:9000` header, so you can't just
rewrite the URL to `localhost:9000` (→ `403 SignatureDoesNotMatch`).

- **From the CLI** — keep the `Host` header, redirect the connection:
  ```bash
  curl -L --resolve minio:9000:127.0.0.1 http://localhost:3000/videos/<slug>/stream -o video.mp4
  ```
- **From a browser** — add a hosts entry (MinIO's `:9000` is already published):
  ```
  127.0.0.1  minio
  ```
  `/etc/hosts` (macOS/Linux) or `C:\Windows\System32\drivers\etc\hosts` (Windows,
  admin required). Then `http://localhost:3000/videos/<slug>/stream` plays in the
  browser. Remove the line to undo. The `thumbnailUrl` in `GET /videos/:slug`
  needs the same entry.

`GET /videos/:slug` itself (the metadata JSON) always works from the host — only
the redirect targets need this.

---

## Troubleshooting

### Environment / startup

| Symptom | Cause / fix |
|---|---|
| `curl http://localhost:3000` → `000`, nothing in `docker compose logs nestjs-api` | The API server isn't running. `start:dev` output goes to the terminal that ran `docker compose exec`, **not** to `docker logs`. The script starts it for you; if running by hand, `docker compose exec nestjs-api npm run start:dev` and watch that terminal. |
| `localhost:3000` dead **and** `docker compose exec nestjs-api ps aux` shows 2+ `nest start --watch` | Multiple `start:dev` instances fighting for the port — none binds it. `docker compose exec nestjs-api pkill -f 'nest start'` then start exactly one (or `docker compose restart nestjs-api`). The script kills stacked watchers automatically. |
| API crashes at boot: `Error: Cannot find module '@css-inline/css-inline-linux-x64-gnu'` (or any `...-linux-x64-gnu` / `.node` / `MODULE_NOT_FOUND` for a platform package) | `node_modules` was installed on the host (Windows/macOS) and bind-mounted in; the Linux-native binaries are missing. Fix: `docker compose exec nestjs-api npm install`. The script detects this and retries once. |
| `start:dev` prints nothing for 1–3 min | Normal — first `tsc` watch compile over the bind mount. Wait for `Found 0 errors` then `Nest application successfully started`. Don't re-run the command. |
| `start:dev` → `EADDRINUSE :3000` | A previous API process is still up. `docker compose restart nestjs-api`, then start one. |
| `migration:run` slow (~1–2 min) | `ts-node` compiling the data-source + migrations over the bind mount. It's idempotent; safe to let it finish. |

### Request-time

| Symptom | Cause / fix |
|---|---|
| `curl: (6) Could not resolve host: minio` / browser `ERR_NAME_NOT_RESOLVED` on `/stream` or `/download` | The `302` points at `http://minio:9000` (Compose service name). See **"Opening `/stream` or `/download`"** above — `--resolve minio:9000:127.0.0.1` for CLI, or a `127.0.0.1 minio` hosts entry for the browser. |
| `403 SignatureDoesNotMatch` from MinIO | The signed `Host` header was altered — you rewrote the presigned URL's host to `localhost`. Keep it `minio:9000` and use `--resolve` or the hosts entry instead. |
| `429 Too Many Requests` | Rate limit is 10 req/min per (route, IP). The script stays under it per route and retries once after the window; a manual re-run within the same minute can still trip it. |
| Video stuck `processing` → `error` | Worker couldn't probe the file — pass a real video. `docker compose logs video-worker`. |
| `complete-upload` → `502 VIDEO_UPLOAD_VERIFICATION_FAILED` | The `PUT` to MinIO didn't land (expired part URL, or the upload step was skipped). |
| `login` → `403 EMAIL_NOT_CONFIRMED` | Confirmation step didn't run, or the token expired (1 h TTL). `POST /auth/resend-confirmation`. |
| `GET /videos/:slug` → `404` for your own non-ready video | Called without the `Authorization` header — a non-`ready` video is owner-only. |
