#!/usr/bin/env bash
# End-to-end test of the Phase 03 video pipeline against the live stack.
#
#   bash scripts/test-video-pipeline.sh <video-file>
#   bash scripts/test-video-pipeline.sh ~/clips/demo.mp4
#
# Drives the real HTTP surface with a real media file:
#
#   auth:      POST /auth/register -> confirm (Mailpit) -> POST /auth/login
#   happy:     POST /videos
#              PUT  <presigned part URLs>          (direct to MinIO, multipart)
#              POST /videos/:id/complete-upload
#              GET  /videos/:slug                  (owner + anonymous)
#              GET  /videos/:slug/stream           (302 -> presigned GET, byte roundtrip)
#              GET  /videos/:slug/download         (302 -> attachment disposition)
#   negative:  401 / 400 / 403 / 404 / 409 for every route
#
# HOST script (like `curl http://localhost:3000` — see CLAUDE.md). API calls run
# from the host; anything that touches a presigned `minio:9000` URL runs inside
# the nestjs-api container (that hostname only resolves on the compose network).
# The stack must be up (`docker compose up -d`); this script starts the API dev
# server and the video-worker if they are not already running.
#
# Every request is echoed (dimmed, prefixed `$`) with all parameters before it
# runs, so the transcript doubles as a copy-pasteable log for manual replay.
#
# Exit: 0 all checks passed | 1 a check failed | 2 bad usage / setup error.

set -u

# --- args --------------------------------------------------------------------
VIDEO="${1:-}"
if [ -z "$VIDEO" ]; then
  echo "usage: bash scripts/test-video-pipeline.sh <video-file>" >&2
  exit 2
fi
if [ ! -f "$VIDEO" ]; then
  echo "error: no such file: $VIDEO" >&2
  exit 2
fi

FILENAME="$(basename "$VIDEO")"
case "$FILENAME" in
  *.*) : ;;
  *) echo "error: <video-file> needs an extension (the API rejects names without one)" >&2; exit 2 ;;
esac
case "${FILENAME##*.}" in
  mp4|MP4)   CONTENT_TYPE=video/mp4 ;;
  mov|MOV)   CONTENT_TYPE=video/quicktime ;;
  m4v|M4V)   CONTENT_TYPE=video/x-m4v ;;
  webm|WEBM) CONTENT_TYPE=video/webm ;;
  mkv|MKV)   CONTENT_TYPE=video/x-matroska ;;
  avi|AVI)   CONTENT_TYPE=video/x-msvideo ;;
  *)         CONTENT_TYPE=application/octet-stream ;;
esac
FILESIZE="$(wc -c < "$VIDEO" | tr -d ' ')"

# --- config ----------------------------------------------------------------
API="${API_URL:-http://localhost:3000}"
MAILPIT="${MAILPIT_URL:-http://localhost:8025}"
PART_SIZE=67108864                     # 64 MiB — must match MULTIPART_PART_SIZE
MAX_UPLOAD_BYTES=10737418240           # 10 GiB — must match MAX_UPLOAD_BYTES
CONTAINER=nestjs-api

# Git Bash rewrites POSIX paths in argv into Windows paths. That is wanted for
# host paths (curl -o /dev/null -> NUL) but not for container paths. `dexec` wraps
# a container command so a bare `/container/path` arg survives; `sh -c '...'` with
# single-quoted paths is also safe and used where a shell is needed anyway.
dexec() { MSYS_NO_PATHCONV=1 docker compose exec -T "$CONTAINER" "$@"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."                    # -> nestjs-project/ (compose project dir)

WORK="$(mktemp -d)"
RESP="$WORK/resp"
trap 'rm -rf "$WORK"; dexec sh -c "rm -rf /tmp/tvp" >/dev/null 2>&1 || true' EXIT

status=0
pass()    { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail()    { printf '  \033[31mFAIL\033[0m %s\n' "$1"; status=1; }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
die()     { fail "$1"; printf '\n\033[1m== FAIL ==\033[0m\n'; exit 1; }
# assert HTTP code: $1=actual $2=expected $3=label
expect()  { [ "$1" = "$2" ] && pass "$3 -> $1" || fail "$3 -> $1 (expected $2)"; }

# --- request tracing -------------------------------------------------------
# Every curl the script fires is echoed first, fully parameterised, so the run
# doubles as a copy-pasteable log. Trace goes to stderr so `code=$(tcurl ...)`
# still captures only curl's stdout.
_shq() { case $1 in
           ''|*[!A-Za-z0-9_.:/=@%,+-]*)
             printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
           *) printf '%s' "$1" ;;
         esac; }
_echo_cmd() { local a; printf '\033[2m  $'; for a in "$@"; do printf ' '; _shq "$a"; done; printf '\033[0m\n'; }
tcurl()  { _echo_cmd curl "$@" >&2; curl "$@"; }

# curl the API into $RESP; echoes the status code. args: METHOD PATH [TOKEN] [JSON_BODY]
# Retries once after the 60s window on a 429 — the API rate-limits 10 req/min per
# (route, IP). The script stays under that per route, but a re-run within the
# minute or a shared IP can still trip it.
api() {
  local m=$1 p=$2 tok=${3:-} body=${4:-} attempt code
  for attempt in 1 2; do
    local args=(-s -o "$RESP" -w '%{http_code}' -X "$m" "$API$p")
    [ -n "$tok" ]  && args+=(-H "Authorization: Bearer $tok")
    [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
    code=$(tcurl "${args[@]}")
    [ "$code" = "429" ] || break
    echo "  (rate-limited on $m $p — waiting 61s)" >&2
    sleep 61
  done
  echo "$code"
}
# ask Postgres directly for a video's status — no HTTP, no rate limit
db_video_status() { docker compose exec -T db psql -U streamtube -tAc \
  "SELECT status FROM videos WHERE slug = '$1'" 2>/dev/null | tr -d '\r' | head -1; }
# first "key":"value" string match from the last response body
jstr() { grep -oE "\"$1\":\"[^\"]+\"" "$RESP" | head -1 | cut -d'"' -f4; }

# --- 0. bring up + prepare the environment ------------------------------
section "environment"

command -v docker >/dev/null || die "docker is not on PATH"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"

# 0.1 start every service (db, minio + bucket init, mailpit, video-worker, and the
#     idle nestjs-api container). Builds the image on first run.
echo "  docker compose up -d ..."
docker compose up -d >/dev/null 2>&1 || die "docker compose up failed"

# 0.2 wait for the infra to accept connections
tries=0
until docker compose exec -T db pg_isready -U streamtube >/dev/null 2>&1 || [ "$tries" -ge 60 ]; do
  sleep 2; tries=$((tries + 2)); done
docker compose exec -T db pg_isready -U streamtube >/dev/null 2>&1 \
  && pass "postgres accepting connections" || die "postgres never became ready"

tries=0
until dexec sh -c 'curl -sf -o /dev/null http://minio:9000/minio/health/live' 2>/dev/null \
      || [ "$tries" -ge 60 ]; do sleep 2; tries=$((tries + 2)); done
pass "minio reachable on the compose network"

# 0.3 dependencies — node_modules is bind-mounted; if it was populated on the host
#     the Linux-native binaries are missing (e.g. @css-inline/css-inline-*). Install
#     inside the container when the check fails.
if ! dexec sh -c \
      'test -d node_modules && node -e "require(\"@nestjs/core\");require(\"@css-inline/css-inline\")"' >/dev/null 2>&1; then
  echo "  installing dependencies inside the container (one-time, can take a few minutes)..."
  dexec npm install --no-audit --no-fund \
    || die "npm install inside the container failed"
fi
pass "dependencies present for the Linux container"

# 0.4 migrations (idempotent — 'No migrations are pending' when current). ts-node
#     compiles the data-source over the bind mount, so the first run is slow and
#     the `docker compose exec` occasionally drops the connection mid-compile;
#     retry once before giving up.
mig_ok=0; mig_out=""
for attempt in 1 2; do
  if mig_out=$(dexec npm run migration:run 2>&1); then mig_ok=1; break; fi
  [ "$attempt" = 1 ] && { echo "  migration:run hiccuped, retrying..."; sleep 3; }
done
[ "$mig_ok" = 1 ] \
  && pass "database migrations applied" \
  || die "migration:run failed after 2 attempts:
$mig_out"

# 0.5 API dev server. The nestjs-api container idles on `tail -f /dev/null`, so the
#     server must be launched explicitly — and exactly once: stacked
#     `nest start --watch` processes just fight over port 3000 and none binds it.
api_up()    { curl -sf -o /dev/null --max-time 5 "$API/"; }
kill_dev()  { for pat in 'nest start' 'start:dev' 'dist/main'; do
                dexec pkill -f "$pat" >/dev/null 2>&1 || true
              done; }
start_api() { MSYS_NO_PATHCONV=1 docker compose exec -d "$CONTAINER" sh -c 'npm run start:dev > /tmp/tvp-dev.log 2>&1'; }
# poll HTTP only — no `docker compose exec` in the loop (it can hang under load
# on Docker Desktop and freeze the wait)
wait_api()  { local limit=${1:-420} t=0
              while [ "$t" -lt "$limit" ]; do api_up && return 0; sleep 3; t=$((t + 3)); done
              api_up; }

up=0
for _ in 1 2 3 4 5; do api_up && { up=1; break; }; sleep 2; done
if [ "$up" != 1 ]; then
  echo "  API not answering — starting one dev server (first compile can take 1-3 min)..."
  kill_dev; sleep 2
  start_api
  wait_api 420 >/dev/null || true
  if ! api_up && dexec grep -q "Cannot find module" /tmp/tvp-dev.log 2>/dev/null; then
    echo "  API crashed on a missing module — reinstalling deps and retrying once..."
    dexec npm install --no-audit --no-fund || true
    kill_dev; sleep 2
    start_api
    wait_api 420 >/dev/null || true
  fi
fi
api_up \
  && pass "API is up ($API)" \
  || die "API never responded. Last dev-server log:
$(dexec tail -n 30 /tmp/tvp-dev.log 2>/dev/null)"

# 0.6 clear stale queue jobs so our job is not stuck behind old failed retries
docker compose exec -T db psql -U streamtube -qc \
  "DELETE FROM pgboss.job WHERE name = 'video-processing'" >/dev/null 2>&1 || true

# 0.7 stage the media file inside the container for the direct-to-storage PUTs.
#     Piped over stdin, not `docker compose cp` — that would need Git Bash to
#     translate the *source* path but not the `container:/dest` path, and it can't
#     do both.
dexec sh -c 'mkdir -p /tmp/tvp && rm -f /tmp/tvp/*'
dexec sh -c 'cat > /tmp/tvp/input' < "$VIDEO"
staged=$(dexec sh -c 'wc -c < /tmp/tvp/input' | tr -d '\r ')
[ "$staged" = "$FILESIZE" ] \
  && pass "media staged in container ($FILENAME, $FILESIZE bytes, $CONTENT_TYPE)" \
  || die "staged size mismatch: container has ${staged:-0}, source is $FILESIZE"

# --- 1. auth -------------------------------------------------------------
section "auth"

RUN="$(date +%s)-$$"
EMAIL_A="tvp-a-$RUN@example.com"
EMAIL_B="tvp-b-$RUN@example.com"
PASSWORD="password123"

register_and_login() { # $1=email  -> echoes access_token (empty on failure)
  local email=$1 code token msg_id
  code=$(api POST /auth/register '' "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}")
  [ "$code" = "201" ] || { echo ""; return; }
  token=""
  local t=0 msgq="$MAILPIT/api/v1/messages"
  while [ -z "$token" ] && [ "$t" -lt 15 ]; do
    msg_id=$(curl -s "$msgq" | grep -oE '"ID":"[^"]+"' | head -1 | cut -d'"' -f4)
    [ -n "$msg_id" ] && token=$(curl -s "$MAILPIT/api/v1/message/$msg_id" \
                                 | grep -oiE 'token=[a-f0-9]{64}' | head -1 | cut -d= -f2)
    [ -z "$token" ] && sleep 1; t=$((t + 1))
  done
  [ -n "$token" ] || { echo ""; return; }
  _echo_cmd curl "$msgq" >&2                 # (^ how the confirmation token was fetched from Mailpit)
  tcurl -s -o /dev/null "$API/auth/confirm-email?token=$token"
  api POST /auth/login '' "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}" >/dev/null
  grep -oE '"access_token":"[^"]+"' "$RESP" | cut -d'"' -f4
}

TOKEN_A=$(register_and_login "$EMAIL_A")
[ -n "$TOKEN_A" ] && pass "user A: register -> confirm -> login" \
                  || fail "user A: register/confirm/login flow failed"
TOKEN_B=$(register_and_login "$EMAIL_B")
[ -n "$TOKEN_B" ] && pass "user B: register -> confirm -> login" \
                  || fail "user B: register/confirm/login flow failed"

[ -n "$TOKEN_A" ] || die "auth is a hard prerequisite and it failed"

me=$(api GET /auth/me "$TOKEN_A"); expect "$me" 200 "GET /auth/me (A)"

# --- 2. happy path -----------------------------------------------------
section "happy path"

# 2.1 initiate
code=$(api POST /videos "$TOKEN_A" \
  "{\"fileName\":\"$FILENAME\",\"fileSize\":$FILESIZE,\"contentType\":\"$CONTENT_TYPE\",\"title\":\"tvp $RUN\"}")
expect "$code" 201 "POST /videos"
VIDEO_ID=$(jstr id)
SLUG=$(jstr slug)
INIT_STATUS=$(jstr status)
mapfile -t PART_URLS < <(grep -oE '"url":"[^"]+"' "$RESP" | cut -d'"' -f4)
[ "$INIT_STATUS" = "draft" ] && pass "  status == draft" || fail "  status == '$INIT_STATUS' (expected draft)"
[ "${#PART_URLS[@]}" -ge 1 ] && pass "  ${#PART_URLS[@]} presigned part URL(s)" || fail "  no presigned part URLs"

{ [ -n "$VIDEO_ID" ] && [ "${#PART_URLS[@]}" -ge 1 ]; } || die "POST /videos did not return a usable draft"

# 2.2 split into 64 MiB parts and PUT each straight to storage
dexec sh -c \
  "split -b $PART_SIZE -d -a 3 /tmp/tvp/input /tmp/tvp/part_"
mapfile -t CHUNKS < <(dexec sh -c 'ls -1 /tmp/tvp/part_* | sort' | tr -d '\r')

if [ "${#CHUNKS[@]}" != "${#PART_URLS[@]}" ]; then
  fail "  part count mismatch: ${#CHUNKS[@]} chunks vs ${#PART_URLS[@]} URLs"
fi

PARTS_JSON=""
put_ok=1
i=0
while [ "$i" -lt "${#PART_URLS[@]}" ]; do
  n=$((i + 1))
  chunk="${CHUNKS[$i]}"
  url="${PART_URLS[$i]}"
  _echo_cmd docker compose exec "$CONTAINER" \
    curl -X PUT "$url" --data-binary "@$chunk" >&2
  etag=$(dexec sh -c \
          "curl -s -D - -o /dev/null -X PUT '$url' --data-binary @$chunk" \
         | grep -i '^etag:' | head -1 | tr -d '\r"' | awk '{print $2}')
  if [ -n "$etag" ]; then
    [ -n "$PARTS_JSON" ] && PARTS_JSON="$PARTS_JSON,"
    PARTS_JSON="$PARTS_JSON{\"partNumber\":$n,\"eTag\":\"$etag\"}"
  else
    put_ok=0
  fi
  i=$n
done
[ "$put_ok" = 1 ] && pass "PUT ${#PART_URLS[@]} part(s) to MinIO (ETags collected)" \
                  || fail "one or more part PUTs returned no ETag"

# 2.3 complete
code=$(api POST "/videos/$VIDEO_ID/complete-upload" "$TOKEN_A" "{\"parts\":[$PARTS_JSON]}")
expect "$code" 200 "POST /videos/:id/complete-upload"
[ "$(jstr status)" = "processing" ] && pass "  status == processing" \
                                    || fail "  status == '$(jstr status)' (expected processing)"

# 2.4 wait for the worker (poll the DB, not the API — avoids the rate limit)
section "processing (worker)"
vstatus=""; waited=0
while [ "$waited" -lt 300 ]; do
  vstatus=$(db_video_status "$SLUG")
  [ "$vstatus" = "ready" ] || [ "$vstatus" = "error" ] && break
  sleep 3; waited=$((waited + 3))
done
[ "$vstatus" = "ready" ] && pass "worker processed the video in ~${waited}s -> ready" \
  || fail "video never reached 'ready' (last: '${vstatus:-none}') — docker compose logs video-worker"

# --- 3. read endpoints ------------------------------------------------
section "read endpoints"

code=$(api GET "/videos/$SLUG" "$TOKEN_A"); expect "$code" 200 "GET /videos/:slug (owner)"
grep -q '"nickname"' "$RESP" && pass "  body carries channel.nickname" || fail "  body missing channel.nickname"

code=$(api GET "/videos/$SLUG"); expect "$code" 200 "GET /videos/:slug (anonymous, ready video)"

# stream: one request, capture both status and Location, then pull the bytes back
# inside the network and check the roundtrip size
hdr="$WORK/stream.hdr"
code=$(tcurl -s -D "$hdr" -o /dev/null -w '%{http_code}' "$API/videos/$SLUG/stream")
expect "$code" 302 "GET /videos/:slug/stream"
loc=$(grep -i '^location:' "$hdr" | tr -d '\r' | awk '{print $2}')
if [ -n "$loc" ]; then
  _echo_cmd docker compose exec "$CONTAINER" curl -o video "$loc" >&2
  rt_code=$(dexec sh -c "curl -s -o /tmp/tvp/roundtrip -w '%{http_code}' '$loc'" | tr -d '\r\n')
  rt_size=$(dexec sh -c 'wc -c < /tmp/tvp/roundtrip' | tr -d '\r ')
  [ "$rt_code" = "200" ] && pass "  presigned stream URL serves the object (200)" \
                         || fail "  presigned stream URL -> $rt_code"
  [ "$rt_size" = "$FILESIZE" ] && pass "  streamed byte count matches source ($rt_size)" \
                               || fail "  streamed $rt_size bytes, source is $FILESIZE"
else
  fail "  stream 302 had no Location header"
fi

# download: 302 with attachment disposition on the presigned URL
hdr="$WORK/download.hdr"
code=$(tcurl -s -D "$hdr" -o /dev/null -w '%{http_code}' "$API/videos/$SLUG/download")
expect "$code" 302 "GET /videos/:slug/download"
grep -i '^location:' "$hdr" | grep -qi 'response-content-disposition=attachment' \
  && pass "  Location carries response-content-disposition=attachment" \
  || fail "  Location missing attachment disposition ($(grep -i '^location:' "$hdr" | tr -d '\r'))"

# --- 4. negative cases ----------------------------------------------
section "negative cases"

code=$(api POST /videos '' '{"fileName":"x.mp4","fileSize":1,"contentType":"video/mp4"}')
expect "$code" 401 "POST /videos without a token"

code=$(api POST /videos "$TOKEN_A" '{}')
expect "$code" 400 "POST /videos with an empty body"

code=$(api POST /videos "$TOKEN_A" '{"fileName":"noext","fileSize":1,"contentType":"video/mp4"}')
expect "$code" 400 "POST /videos, fileName without extension"

code=$(api POST /videos "$TOKEN_A" \
  "{\"fileName\":\"big.mp4\",\"fileSize\":$((MAX_UPLOAD_BYTES + 1)),\"contentType\":\"video/mp4\"}")
expect "$code" 400 "POST /videos over the 10 GiB cap"
[ "$(jstr error)" = "VIDEO_FILE_TOO_LARGE" ] && pass "  error == VIDEO_FILE_TOO_LARGE" \
                                             || fail "  error == '$(jstr error)'"

code=$(api POST "/videos/not-a-uuid/complete-upload" "$TOKEN_A" '{"parts":[{"partNumber":1,"eTag":"x"}]}')
expect "$code" 400 "POST /videos/<non-uuid>/complete-upload"

code=$(api POST "/videos/00000000-0000-0000-0000-000000000000/complete-upload" "$TOKEN_A" \
  '{"parts":[{"partNumber":1,"eTag":"x"}]}')
expect "$code" 404 "POST /videos/<unknown-uuid>/complete-upload"
[ "$(jstr error)" = "VIDEO_NOT_FOUND" ] && pass "  error == VIDEO_NOT_FOUND" || fail "  error == '$(jstr error)'"

code=$(api POST "/videos/$VIDEO_ID/complete-upload" "$TOKEN_A" "{\"parts\":[$PARTS_JSON]}")
expect "$code" 409 "POST /videos/:id/complete-upload again (already completed)"
[ "$(jstr error)" = "VIDEO_UPLOAD_ALREADY_COMPLETED" ] && pass "  error == VIDEO_UPLOAD_ALREADY_COMPLETED" \
                                                       || fail "  error == '$(jstr error)'"

code=$(api GET "/videos/tvp-missing-$RUN"); expect "$code" 404 "GET /videos/<unknown-slug>"

# a fresh draft: not visible to anonymous, and not completable by a non-owner
api POST /videos "$TOKEN_A" \
  "{\"fileName\":\"$FILENAME\",\"fileSize\":$FILESIZE,\"contentType\":\"$CONTENT_TYPE\"}" >/dev/null
DRAFT_ID=$(jstr id); DRAFT_SLUG=$(jstr slug)

code=$(api GET "/videos/$DRAFT_SLUG"); expect "$code" 404 "GET /videos/:slug (anon, draft — no existence leak)"
code=$(api GET "/videos/$DRAFT_SLUG" "$TOKEN_A"); expect "$code" 200 "GET /videos/:slug (owner, draft)"

if [ -n "$TOKEN_B" ]; then
  code=$(api POST "/videos/$DRAFT_ID/complete-upload" "$TOKEN_B" '{"parts":[{"partNumber":1,"eTag":"x"}]}')
  expect "$code" 403 "POST /videos/:id/complete-upload as a non-owner"
  [ "$(jstr error)" = "VIDEO_NOT_OWNED" ] && pass "  error == VIDEO_NOT_OWNED" || fail "  error == '$(jstr error)'"
fi

# a draft has no object yet -> stream 404
code=$(tcurl -s -o /dev/null -w '%{http_code}' "$API/videos/$DRAFT_SLUG/stream")
expect "$code" 404 "GET /videos/:slug/stream (draft, no object)"

# --- done -----------------------------------------------------------
section "retrieve the video"
cat <<EOF
  id:    $VIDEO_ID
  slug:  $SLUG   (status: ${vstatus:-unknown})

  # metadata (public once ready)
  curl $API/videos/$SLUG

  # stream / download -> 302 to a presigned MinIO URL whose host is the 'minio'
  # compose service (STORAGE_ENDPOINT), which does NOT resolve outside Docker,
  # and the signature is bound to that Host header so you cannot just swap it.
  #
  #   * from the CLI:  add --resolve minio:9000:127.0.0.1 (keeps the Host header)
  curl -L --resolve minio:9000:127.0.0.1 $API/videos/$SLUG/stream -o video.mp4
  curl -L --resolve minio:9000:127.0.0.1 -OJ $API/videos/$SLUG/download
  #
  #   * from a browser: add this line to your hosts file (admin required), then
  #     open $API/videos/$SLUG/stream — MinIO's :9000 is already published:
  #         127.0.0.1  minio
  #     hosts file: /etc/hosts  (mac/linux)  |  C:\\Windows\\System32\\drivers\\etc\\hosts

  # just the redirect target:
  curl -sI $API/videos/$SLUG/stream | grep -i ^location

  # browser: $API/videos/$SLUG      (metadata JSON — always works)
EOF

section "result"
if [ "$status" -eq 0 ]; then
  printf '\033[1;32mPASS\033[0m  video %s is ready; slug=%s\n' "$VIDEO_ID" "$SLUG"
else
  printf '\033[1;31mFAIL\033[0m  one or more checks failed (see above)\n'
fi
exit "$status"
