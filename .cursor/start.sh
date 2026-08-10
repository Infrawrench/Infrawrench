#!/usr/bin/env bash
#
# Cloud Agent start phase for the Infrawrench web stack.
#
# Reconciles the backing services (Postgres, ClickHouse, WorkOS emulator),
# applies DB migrations, then runs the web dev server in the FOREGROUND as the
# attached process. Idempotent and safe to run on every boot: each service is
# started only if not already up, and every create/migrate is a no-op when
# already applied.
#
# The web app is then reachable at http://localhost:3000 (log in as
# dev@infrawrench.local / devpassword1!, seeded in the WorkOS emulator).
set -uo pipefail

# Cloud Agent install/start run from the repo root; be explicit so this script
# also works when invoked from a snapshot-resident copy outside the checkout.
cd "${WORKSPACE_DIR:-/workspace}"

WORKOS_HOME="$HOME/.infrawrench-dev"

# Load the dev env into this process so db:migrate and the dev server see
# DATABASE_URL, WORKOS_*, CLICKHOUSE_* etc.
if [ -f app/packages/web/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . app/packages/web/.env
  set +a
fi

# --- PostgreSQL -----------------------------------------------------------
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do
  pg_isready -h localhost -U infrawrench -d infrawrench >/dev/null 2>&1 && break
  sleep 1
done
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='infrawrench'" 2>/dev/null | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE infrawrench LOGIN PASSWORD 'infrawrench' SUPERUSER;" 2>/dev/null || true
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='infrawrench'" 2>/dev/null | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE infrawrench OWNER infrawrench;" 2>/dev/null || true

# --- ClickHouse (metrics time-series store) -------------------------------
sudo clickhouse start 2>/dev/null || true
for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:8123/ping >/dev/null 2>&1 && break
  sleep 1
done
clickhouse-client --host 127.0.0.1 --password infrawrench \
  -q "CREATE DATABASE IF NOT EXISTS infrawrench" 2>/dev/null || true

# --- WorkOS emulator (auth) ----------------------------------------------
if ! curl -sf http://127.0.0.1:4100/health >/dev/null 2>&1; then
  "$WORKOS_HOME/workos/node_modules/.bin/workos-emulate" \
    --host 0.0.0.0 --port 4100 --interactive \
    --seed /workspace/infra/docker/workos-emulate/seed.yaml \
    --signing-key "$WORKOS_HOME/workos-signing-key.pem" \
    --kid dev_key --json >/tmp/workos-emulate.log 2>&1 &
  for _ in $(seq 1 30); do
    curl -sf http://127.0.0.1:4100/health >/dev/null 2>&1 && break
    sleep 1
  done
fi

# --- Database migrations (idempotent) ------------------------------------
pnpm --filter @infrawrench/web db:migrate || true

# --- Web dev server (foreground / attached process) ----------------------
exec pnpm --filter @infrawrench/web dev
