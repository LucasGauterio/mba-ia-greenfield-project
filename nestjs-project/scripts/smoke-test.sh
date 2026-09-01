#!/usr/bin/env bash
# One-command smoke test: proves the app works as a *running system*, not
# just under mocks. Exercises a real register -> confirm-email (via Mailpit's
# API) -> login -> authenticated-request flow against the live containers.
# Rationale: docs/decisions/technical-decisions-workflow-hardening-guardrails.md -> TD-04
#
# HOST-ONLY (like `curl http://localhost:3000` — see CLAUDE.md "Host-only
# commands"): run from nestjs-project/ on the host.
#
#   bash scripts/smoke-test.sh
#   npm run smoke               # same thing, via package.json
#
# This is deliberately generic (health check + auth round-trip) so it stays
# valid across phases. When a phase ships a new server-connected capability
# (e.g. video upload), add a scenario for it in the "Phase-specific
# scenarios" section at the bottom instead of writing a new script.

set -u
status=0
API="http://localhost:3000"
MAILPIT="http://localhost:8025"

ok()   { printf '[ OK ] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1"; status=1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "== nestjs-project smoke test =="

# 0. Make sure the stack is up before hitting it.
if ! docker compose ps --format '{{.State}}' nestjs-api 2>/dev/null | grep -qx running; then
  echo "nestjs-api not running — starting the stack..."
  docker compose up -d
fi

# Wait up to 15s for the API to answer as-is (dev server may already be running).
attempts=0
until curl -sf -o /dev/null "$API/" || [ "$attempts" -ge 15 ]; do
  sleep 1
  attempts=$((attempts + 1))
done

# The nestjs-api container idles on `tail -f /dev/null` by default (per CLAUDE.md —
# `docker compose up -d` intentionally does not start the app server). Running this
# script IS the explicit ask to run the app, so start it in the background if the
# quick check above found nothing answering yet.
if ! curl -sf -o /dev/null "$API/"; then
  echo "API not responding — starting the dev server in the container (first compile can take a couple minutes on a slow bind mount)..."
  docker compose exec -d nestjs-api npm run start:dev
  attempts=0
  until curl -sf -o /dev/null "$API/" || [ "$attempts" -ge 150 ]; do
    sleep 2
    attempts=$((attempts + 2))
  done
fi

# 1. Health check.
if curl -sf -o /dev/null "$API/"; then
  ok "GET / responds."
else
  fail "GET / never responded (checked for ~15s as-is, then tried starting the dev server and waited longer) — is the stack up? (docker compose up -d) Check: docker compose logs nestjs-api"
  echo "== $( [ "$status" -eq 0 ] && echo PASS || echo FAIL ) =="
  exit "$status"
fi

# 2. Register a throwaway user.
email="smoke-$(date +%s)@example.com"
password="SmokeTest123!"
curl -s "$MAILPIT/api/v1/messages" -X DELETE >/dev/null 2>&1 || true

register_status=$(curl -s -o /tmp/smoke-register.json -w '%{http_code}' \
  -X POST "$API/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}")

if [ "$register_status" = "201" ]; then
  ok "POST /auth/register -> 201"
else
  fail "POST /auth/register -> $register_status (expected 201)"
fi

# 3. Fetch the confirmation email from Mailpit and extract the token.
token=""
attempts=0
while [ -z "$token" ] && [ "$attempts" -lt 10 ]; do
  msg_id=$(curl -s "$MAILPIT/api/v1/messages" | grep -o "\"ID\":\"[^\"]*\"" | head -1 | cut -d'"' -f4)
  if [ -n "$msg_id" ]; then
    token=$(curl -s "$MAILPIT/api/v1/message/$msg_id" | grep -oE 'token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
  fi
  [ -z "$token" ] && sleep 1
  attempts=$((attempts + 1))
done

if [ -n "$token" ]; then
  ok "Confirmation email received and token extracted."
else
  fail "No confirmation email / token found in Mailpit after 10s."
fi

# 4. Confirm the email.
if [ -n "$token" ]; then
  confirm_status=$(curl -s -o /dev/null -w '%{http_code}' "$API/auth/confirm-email?token=$token")
  if [ "$confirm_status" = "204" ]; then
    ok "GET /auth/confirm-email -> 204"
  else
    fail "GET /auth/confirm-email -> $confirm_status (expected 204)"
  fi
fi

# 5. Log in and grab the access token.
login_status=$(curl -s -o /tmp/smoke-login.json -w '%{http_code}' \
  -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}")

access_token=""
if [ "$login_status" = "200" ]; then
  access_token=$(grep -oE '"access_token":"[^"]+"' /tmp/smoke-login.json | cut -d'"' -f4)
  ok "POST /auth/login -> 200"
else
  fail "POST /auth/login -> $login_status (expected 200)"
fi

# 6. Call an authenticated endpoint with the token.
if [ -n "$access_token" ]; then
  me_status=$(curl -s -o /dev/null -w '%{http_code}' "$API/auth/me" \
    -H "Authorization: Bearer $access_token")
  if [ "$me_status" = "200" ]; then
    ok "GET /auth/me (authenticated) -> 200"
  else
    fail "GET /auth/me -> $me_status (expected 200)"
  fi
fi

rm -f /tmp/smoke-register.json /tmp/smoke-login.json

# --- Phase-specific scenarios: add new checks below as features ship -------

# Phase 03 — video upload -> processing -> read.
# Needs the video-worker container consuming the queue.
if [ -n "$access_token" ]; then
  echo "-- phase 03: video upload & processing --"
  docker compose up -d video-worker >/dev/null 2>&1 || true
  # Clear any stale job backlog from prior test runs so this run's job is not
  # stuck behind hundreds of failed retries (see phase-03 library-refs.md).
  docker compose exec -T db psql -U streamtube -qc \
    "DELETE FROM pgboss.job WHERE name = 'video-processing'" >/dev/null 2>&1 || true

  # Build a tiny real MP4 inside the container (ffmpeg-static ships the binary).
  # Every in-container path stays inside a single-quoted `sh -c` so Git Bash on
  # Windows does not rewrite `/tmp/...` into a host path.
  docker compose exec -T nestjs-api sh -c \
    'F=$(node -p "require(\"ffmpeg-static\")"); "$F" -f lavfi -i "testsrc=duration=1:size=320x240:rate=10" -pix_fmt yuv420p -y /tmp/smoke.mp4 >/dev/null 2>&1'
  fsize=$(docker compose exec -T nestjs-api sh -c 'wc -c < /tmp/smoke.mp4 2>/dev/null' | tr -d '\r ')

  if [ -z "${fsize:-}" ] || [ "$fsize" = "0" ]; then
    fail "could not create the MP4 fixture in the container (ffmpeg-static)"
  else
    init=$(curl -s -X POST "$API/videos" \
      -H "Authorization: Bearer $access_token" \
      -H 'Content-Type: application/json' \
      -d "{\"fileName\":\"smoke.mp4\",\"fileSize\":$fsize,\"contentType\":\"video/mp4\"}")

    video_id=$(printf '%s' "$init" | grep -oE '"id":"[^"]+"' | head -1 | cut -d'"' -f4)
    video_slug=$(printf '%s' "$init" | grep -oE '"slug":"[^"]+"' | head -1 | cut -d'"' -f4)
    part_url=$(printf '%s' "$init" | grep -oE '"url":"[^"]+"' | head -1 | cut -d'"' -f4)

    if [ -n "$video_id" ] && [ -n "$part_url" ]; then
      ok "POST /videos -> draft $video_slug"
    else
      fail "POST /videos did not return an id/slug/part url: $init"
    fi

    # PUT the part straight to storage — must run inside the compose network
    # (the presigned URL's host is the `minio` service name).
    etag=$(docker compose exec -T nestjs-api sh -c \
      "curl -s -D - -o /dev/null -X PUT '$part_url' --data-binary @/tmp/smoke.mp4" \
      | grep -i '^etag:' | head -1 | tr -d '\r"' | awk '{print $2}')

    if [ -n "$etag" ]; then
      ok "PUT part -> ETag $etag"
    else
      fail "PUT of the video part returned no ETag"
    fi

    complete_status=$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST "$API/videos/$video_id/complete-upload" \
      -H "Authorization: Bearer $access_token" \
      -H 'Content-Type: application/json' \
      -d "{\"parts\":[{\"partNumber\":1,\"eTag\":\"$etag\"}]}")

    if [ "$complete_status" = "200" ]; then
      ok "POST /videos/:id/complete-upload -> 200 (processing)"
    else
      fail "POST /videos/:id/complete-upload -> $complete_status (expected 200)"
    fi

    # Poll until the worker marks it ready (or error).
    vstatus=""
    vbody=""
    attempts=0
    while [ "$attempts" -lt 120 ]; do
      vbody=$(curl -s "$API/videos/$video_slug" \
        -H "Authorization: Bearer $access_token")
      vstatus=$(printf '%s' "$vbody" | grep -oE '"status":"[^"]+"' | head -1 | cut -d'"' -f4)
      [ "$vstatus" = "ready" ] || [ "$vstatus" = "error" ] && break
      sleep 3
      attempts=$((attempts + 3))
    done

    if [ "$vstatus" = "ready" ]; then
      ok "GET /videos/:slug -> ready (worker processed it in ~${attempts}s)"
    else
      fail "video never reached 'ready' (last status: '${vstatus:-none}', body: ${vbody:-<empty>}) — check: docker compose logs video-worker"
    fi

    stream_status=$(curl -s -o /dev/null -w '%{http_code}' \
      "$API/videos/$video_slug/stream" -H "Authorization: Bearer $access_token")
    if [ "$stream_status" = "302" ]; then
      ok "GET /videos/:slug/stream -> 302"
    else
      fail "GET /videos/:slug/stream -> $stream_status (expected 302)"
    fi

    dl_location=$(curl -s -D - -o /dev/null \
      "$API/videos/$video_slug/download" -H "Authorization: Bearer $access_token" \
      | grep -i '^location:' | tr -d '\r')
    if printf '%s' "$dl_location" | grep -q 'response-content-disposition='; then
      ok "GET /videos/:slug/download -> 302 with attachment disposition"
    else
      fail "GET /videos/:slug/download did not redirect with response-content-disposition ($dl_location)"
    fi

    docker compose exec -T nestjs-api sh -c 'rm -f /tmp/smoke.mp4' >/dev/null 2>&1 || true
  fi
fi
# -----------------------------------------------------------------------------

echo "== $( [ "$status" -eq 0 ] && echo PASS || echo FAIL ) =="
exit "$status"
