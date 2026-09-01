#!/usr/bin/env bash
# One-command environment health check for nestjs-project.
# Rationale: docs/decisions/technical-decisions-workflow-hardening-guardrails.md -> TD-03
#
# HOST-ONLY (like `docker compose ps` / `curl` — see CLAUDE.md "Host-only commands"):
# run this from the repo's nestjs-project/ directory on the host machine, not
# inside the nestjs-api container (it shells out to the `docker` CLI, which is
# not available in-container).
#
#   bash scripts/env-check.sh
#   npm run env:check          # same thing, via package.json
#
# Exits non-zero if anything required is missing/down. Encodes the diagnosis
# steps that used to be re-improvised by hand every session (Docker not
# running, .env missing a key, DB not accepting connections, pending
# migrations) into a single, repeatable check.

set -u
status=0

ok()   { printf '[ OK ] %s\n' "$1"; }
warn() { printf '[WARN] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1"; status=1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "== nestjs-project environment check =="

# 1. Docker available and daemon reachable.
if ! command -v docker >/dev/null 2>&1; then
  fail "docker CLI not found on PATH — install Docker Desktop and re-run."
  echo "== $( [ "$status" -eq 0 ] && echo PASS || echo FAIL ) =="
  exit "$status"
fi
if ! docker info >/dev/null 2>&1; then
  fail "Docker daemon not reachable — start Docker Desktop before continuing."
  echo "== $( [ "$status" -eq 0 ] && echo PASS || echo FAIL ) =="
  exit "$status"
fi
ok "Docker daemon reachable."

# 2. .env exists and carries every key .env.example declares.
if [ ! -f .env ]; then
  fail ".env is missing — copy .env.example to .env and fill in real values."
else
  ok ".env exists."
  if [ -f .env.example ]; then
    missing_keys=""
    while IFS='=' read -r key _; do
      key="${key%$'\r'}"
      case "$key" in
        ''|\#*) continue ;;
      esac
      if ! grep -q "^${key}=" .env; then
        missing_keys="$missing_keys $key"
      fi
    done < <(tr -d '\r' < .env.example)
    if [ -n "$missing_keys" ]; then
      fail ".env is missing keys present in .env.example:${missing_keys}"
    else
      ok ".env has every key declared in .env.example."
    fi
  fi
fi

# 3. Every Compose service is up.
services="$(docker compose config --services 2>/dev/null)"
if [ -z "$services" ]; then
  fail "docker compose config produced no services — check compose.yaml."
else
  for svc in $services; do
    # -a so one-shot init services that already Exited are still listed.
    state="$(docker compose ps -a --format '{{.State}}' "$svc" 2>/dev/null)"
    if [ "$state" = "running" ]; then
      ok "service '$svc' is running."
    elif [ "$state" = "exited" ]; then
      # One-shot services (e.g. bucket bootstrap) legitimately exit; 0 means done.
      code="$(docker compose ps -a --format '{{.ExitCode}}' "$svc" 2>/dev/null)"
      if [ "${code:-1}" = "0" ]; then
        ok "service '$svc' completed (one-shot, exit 0)."
      else
        fail "service '$svc' exited with code ${code:-?}. Check: docker compose logs $svc"
      fi
    else
      fail "service '$svc' is not running (state: '${state:-absent}'). Run: docker compose up -d"
    fi
  done
fi

# 4. Database ready to accept connections (if a 'db' service is defined).
if echo "$services" | grep -qx "db"; then
  db_user="$(grep -E '^DB_USERNAME=' .env 2>/dev/null | cut -d= -f2-)"
  db_user="${db_user:-streamtube}"
  if docker compose exec -T db pg_isready -U "$db_user" >/dev/null 2>&1; then
    ok "Postgres is accepting connections."
  else
    fail "Postgres is not accepting connections yet — wait for the healthcheck or check 'docker compose logs db'."
  fi
fi

# 5. Pending migrations — informational only, never blocks (a new phase may
#    legitimately introduce a migration that hasn't run yet).
if echo "$services" | grep -qx "nestjs-api"; then
  api_state="$(docker compose ps --format '{{.State}}' nestjs-api 2>/dev/null)"
  if [ "$api_state" = "running" ]; then
    pending="$(docker compose exec -T nestjs-api npm run typeorm -- migration:show -d src/database/data-source.ts 2>/dev/null | grep -c '^\[ \]')"
    if [ "${pending:-0}" -gt 0 ]; then
      warn "$pending migration(s) pending — run: docker compose exec nestjs-api npm run migration:run"
    else
      ok "No pending migrations."
    fi
  fi
fi

echo "== $( [ "$status" -eq 0 ] && echo PASS || echo FAIL ) =="
exit "$status"
