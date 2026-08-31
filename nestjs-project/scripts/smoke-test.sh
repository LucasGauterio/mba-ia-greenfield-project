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
# Example: after a video-upload feature exists, add a block here that
# creates a channel, initiates + finalizes an upload, and polls until the
# worker marks it processed — the same register/login flow above already
# hands you an authenticated $access_token to reuse.
# -----------------------------------------------------------------------------

echo "== $( [ "$status" -eq 0 ] && echo PASS || echo FAIL ) =="
exit "$status"
