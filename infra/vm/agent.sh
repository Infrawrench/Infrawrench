#!/usr/bin/env bash
# The deploy agent on the Oracle Cloud VMs (infra/terraform/oci.tf). systemd
# runs it every minute (infrawrench-agent.timer, written by cloud-init.yaml);
# the loader fetches this file fresh from the runtime bucket each time, so a
# change here ships with `terraform apply` and never replaces a VM.
#
# Each run converges the VM on what the bucket and the registry say:
#   - runtime.env: app_env merged with lambda_app_env, shell-quoted (one value,
#     GITHUB_APP_PRIVATE_KEY, is multi-line, which docker's --env-file cannot
#     carry). A change restarts the app.
#   - registry.env: the OCIR login (REGISTRY_USER, REGISTRY_PASSWORD).
#   - the image tag CI moves after every deploy (`web:oci-arm64`,
#     `github-watcher:oci`). A new image id restarts the app.
#   - tunnel.env (web only, TUNNEL_TOKEN=...): the Cloudflare Tunnel both web VMs connect to.
#     Cloudflare spreads requests over every connected replica, so a VM that
#     dies, or whose app is unhealthy and has its connector stopped below,
#     simply stops receiving traffic.
#
# Rollouts are staggered by DEPLOY_DELAY (web-2 waits three minutes after it
# first sees a new image), and a web restart takes its connector down first,
# so one VM always serves while the other restarts.
set -euo pipefail

# ROLE, PAR_URL, IMAGE, REGISTRY_HOST, DEPLOY_DELAY (seconds), from cloud-init.
# shellcheck disable=SC1091
. /etc/infrawrench/node.env

STATE=/var/lib/infrawrench
CONF=/etc/infrawrench
APP=app
TUNNEL=cloudflared
CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.10.0
mkdir -p "$STATE"

log() { echo "[infrawrench-agent] $*"; }

fetch() {
  curl -fsS --retry 3 --retry-delay 2 --max-time 30 "${PAR_URL}$1" -o "$2"
}

# Install a fetched file over the live one when it changed; prints "changed".
replace_if_changed() {
  local new="$1" live="$2"
  if ! cmp -s "$new" "$live" 2>/dev/null; then
    install -m 600 "$new" "$live"
    echo changed
  fi
}

private_ip() {
  curl -fsS --max-time 5 -H "Authorization: Bearer Oracle" \
    http://169.254.169.254/opc/v2/vnics/ | sed -n 's/.*"privateIp" *: *"\([^"]*\)".*/\1/p' | head -n1
}

healthy() {
  curl -fsS --max-time 5 http://127.0.0.1:3000/healthz >/dev/null 2>&1
}

running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

start_tunnel() {
  running "$TUNNEL" && return 0
  docker rm -f "$TUNNEL" >/dev/null 2>&1 || true
  # TUNNEL_TOKEN comes from an env file, so it never appears on a command line.
  docker run -d --name "$TUNNEL" --restart unless-stopped --network host \
    --log-driver local --log-opt max-size=20m --env-file "$CONF/tunnel.env" \
    "$CLOUDFLARED_IMAGE" tunnel --no-autoupdate --metrics 127.0.0.1:20241 run >/dev/null
  log "tunnel connector started"
}

stop_tunnel() {
  if docker inspect "$TUNNEL" >/dev/null 2>&1; then
    # cloudflared drains in-flight requests for its 30s grace period on SIGTERM.
    docker stop -t 35 "$TUNNEL" >/dev/null 2>&1 || true
    docker rm -f "$TUNNEL" >/dev/null 2>&1 || true
    log "tunnel connector stopped"
  fi
}

start_app() {
  local ref="$1" ip
  ip="$(private_ip)"
  # Variable names only: values come from this process's environment, so a
  # multi-line value survives and nothing secret lands on a command line.
  local -a env_args=()
  for key in $IW_ENV_KEYS; do env_args+=(-e "$key"); done

  local -a role_args=()
  if [ "$ROLE" = "web" ]; then
    # POD_IP is the cross-replica relay's address (web/src/services/replica-relay.ts);
    # the VMs reach each other's port 3000 inside the VCN.
    role_args=(-e PORT=3000 -e "POD_IP=${ip}" --memory 4g)
  else
    role_args=(--memory 700m --memory-swap 1500m)
  fi

  docker rm -f "$APP" >/dev/null 2>&1 || true
  (
    set -a
    # shellcheck disable=SC1091
    . "$CONF/runtime.env"
    set +a
    docker run -d --name "$APP" --restart unless-stopped --network host \
      --read-only --tmpfs /tmp:rw,size=512m --security-opt no-new-privileges \
      --cap-drop ALL --log-driver local --log-opt max-size=50m \
      -e NODE_ENV=production "${role_args[@]}" "${env_args[@]}" "$ref" >/dev/null
  )
  log "started $ref"
}

deploy() {
  local ref="$1"
  if [ "$ROLE" = "web" ]; then
    stop_tunnel
    start_app "$ref"
    for _ in $(seq 1 60); do
      healthy && break
      sleep 2
    done
    if healthy; then
      start_tunnel
    else
      log "app not healthy after 120s; connector stays down until it is"
    fi
  else
    start_app "$ref"
  fi
}

# --- converge --------------------------------------------------------------

fetch runtime.env "$STATE/runtime.env.new"
env_changed="$(replace_if_changed "$STATE/runtime.env.new" "$CONF/runtime.env")"
IW_ENV_KEYS="$(sed -n 's/^IW_ENV_KEYS=//p' "$CONF/runtime.env" | tr -d "'")"

fetch registry.env "$STATE/registry.env.new"
if [ -n "$(replace_if_changed "$STATE/registry.env.new" "$CONF/registry.env")" ] ||
  [ ! -f /root/.docker/config.json ]; then
  (
    # shellcheck disable=SC1091
    . "$CONF/registry.env"
    printf '%s' "$REGISTRY_PASSWORD" | docker login -u "$REGISTRY_USER" --password-stdin "$REGISTRY_HOST" >/dev/null
  )
  log "registry login refreshed"
fi

if [ "$ROLE" = "web" ]; then
  fetch tunnel.env "$STATE/tunnel.env.new"
  if [ -n "$(replace_if_changed "$STATE/tunnel.env.new" "$CONF/tunnel.env")" ]; then
    stop_tunnel
  fi
fi

docker pull -q "$IMAGE" >/dev/null
want="$(docker image inspect -f '{{.Id}}' "$IMAGE")"
have="$(docker inspect -f '{{.Image}}' "$APP" 2>/dev/null || echo none)"

if [ "$want" != "$have" ] && running "$APP" && [ "${DEPLOY_DELAY:-0}" -gt 0 ]; then
  # Staggered rollout: wait DEPLOY_DELAY after first sight of this image.
  if [ "$(cat "$STATE/seen-image" 2>/dev/null)" != "$want" ]; then
    echo "$want" >"$STATE/seen-image"
    date +%s >"$STATE/seen-at"
  fi
  if [ $(($(date +%s) - $(cat "$STATE/seen-at"))) -lt "$DEPLOY_DELAY" ]; then
    log "new image seen; waiting out the ${DEPLOY_DELAY}s rollout delay"
    want="$have"
  fi
fi

if [ "$want" != "$have" ] || [ -n "$env_changed" ] || ! running "$APP"; then
  deploy "$IMAGE"
  docker image prune -f >/dev/null 2>&1 || true
elif [ "$ROLE" = "web" ]; then
  # Watchdog: only a healthy app gets traffic.
  if healthy; then
    start_tunnel
  else
    log "health check failed; taking the connector down"
    stop_tunnel
  fi
fi
