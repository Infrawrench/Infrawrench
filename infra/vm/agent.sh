#!/usr/bin/env bash
# The deploy agent on Infrawrench's VMs: the AWS session gateway instances
# (infra/terraform/aws-web.tf) and the Oracle Cloud github-watcher
# (infra/terraform/oci.tf). systemd runs it every minute
# (infrawrench-agent.timer, written by cloud-init-*.yaml); the loader fetches
# this file fresh each time, so a change here ships with `terraform apply` and
# never replaces a VM.
#
# Each run converges the VM on what its provider and the registry say:
#   - the configuration: app_env merged with lambda_app_env, the same values
#     the Lambda functions get. On AWS it is the functions' own Secrets Manager
#     secret (a JSON object); on Oracle Cloud a shell-quoted file in the
#     runtime bucket. Either way it ends up as $CONF/runtime.env, shell-quoted
#     because GITHUB_APP_PRIVATE_KEY is multi-line, which docker's --env-file
#     cannot carry. A change restarts the app.
#   - the registry login: ECR through the instance role on AWS, the OCIR
#     auth token from the bucket on Oracle Cloud.
#   - the image tag CI moves after every deploy. A new image id restarts the app.
#   - tunnel.env (web only, TUNNEL_TOKEN=...): the Cloudflare Tunnel both web
#     instances connect to. Cloudflare spreads requests over every connected
#     replica, so an instance that dies, or whose app is unhealthy and has its
#     connector stopped below, simply stops receiving traffic.
#
# Rollouts are staggered by DEPLOY_DELAY (web-2 waits three minutes after it
# first sees a new image), and a web restart takes its connector down first,
# so one instance always serves while the other restarts.
set -euo pipefail

# PROVIDER (aws | oci), ROLE (web | watcher), IMAGE, REGISTRY_HOST,
# DEPLOY_DELAY (seconds), and per provider: AWS_REGION, APP_ENV_SECRET,
# RUNTIME_BUCKET (aws) or PAR_URL (oci). Written by cloud-init.
# shellcheck disable=SC1091
. /etc/infrawrench/node.env
# VMs bootstrapped before PROVIDER existed are the Oracle Cloud ones.
PROVIDER="${PROVIDER:-oci}"

STATE=/var/lib/infrawrench
CONF=/etc/infrawrench
APP=app
TUNNEL=cloudflared
CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.10.0
# ECR login tokens last 12 hours; refresh well inside that.
ECR_LOGIN_EVERY_S=$((6 * 3600))
mkdir -p "$STATE"

log() { echo "[infrawrench-agent] $*"; }

# Install a fetched file over the live one when it changed; prints "changed".
replace_if_changed() {
  local new="$1" live="$2"
  if ! cmp -s "$new" "$live" 2>/dev/null; then
    install -m 600 "$new" "$live"
    echo changed
  fi
}

# --- provider hooks --------------------------------------------------------

par_fetch() {
  curl -fsS --retry 3 --retry-delay 2 --max-time 30 "${PAR_URL}$1" -o "$2"
}

imds_token() {
  curl -fsS --max-time 5 -X PUT http://169.254.169.254/latest/api/token \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300"
}

# $CONF/runtime.env, freshly fetched, at $1.
fetch_runtime_env() {
  if [ "$PROVIDER" = "aws" ]; then
    aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$APP_ENV_SECRET" \
      --query SecretString --output text |
      python3 -c '
import json, shlex, sys
env = json.load(sys.stdin)
keys = sorted(env)
print("IW_ENV_KEYS=" + shlex.quote(" ".join(keys)))
for k in keys:
    print(k + "=" + shlex.quote(str(env[k])))
' >"$1"
  else
    par_fetch runtime.env "$1"
  fi
}

fetch_tunnel_env() {
  if [ "$PROVIDER" = "aws" ]; then
    aws s3 cp --only-show-errors "s3://${RUNTIME_BUCKET}/tunnel.env" "$1"
  else
    par_fetch tunnel.env "$1"
  fi
}

registry_login() {
  if [ "$PROVIDER" = "aws" ]; then
    local last
    last="$(cat "$STATE/ecr-login-at" 2>/dev/null || echo 0)"
    if [ $(($(date +%s) - last)) -lt "$ECR_LOGIN_EVERY_S" ] && [ -f /root/.docker/config.json ]; then
      return 0
    fi
    aws ecr get-login-password --region "$AWS_REGION" |
      docker login -u AWS --password-stdin "$REGISTRY_HOST" >/dev/null
    date +%s >"$STATE/ecr-login-at"
    log "registry login refreshed"
    return 0
  fi
  par_fetch registry.env "$STATE/registry.env.new"
  if [ -n "$(replace_if_changed "$STATE/registry.env.new" "$CONF/registry.env")" ] ||
    [ ! -f /root/.docker/config.json ]; then
    (
      # shellcheck disable=SC1091
      . "$CONF/registry.env"
      printf '%s' "$REGISTRY_PASSWORD" | docker login -u "$REGISTRY_USER" --password-stdin "$REGISTRY_HOST" >/dev/null
    )
    log "registry login refreshed"
  fi
}

private_ip() {
  if [ "$PROVIDER" = "aws" ]; then
    curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: $(imds_token)" \
      http://169.254.169.254/latest/meta-data/local-ipv4
  else
    curl -fsS --max-time 5 -H "Authorization: Bearer Oracle" \
      http://169.254.169.254/opc/v2/vnics/ | sed -n 's/.*"privateIp" *: *"\([^"]*\)".*/\1/p' | head -n1
  fi
}

# --- app and connector -----------------------------------------------------

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
    # the instances reach each other's port 3000 inside the VPC.
    role_args=(-e PORT=3000 -e "POD_IP=${ip}" --memory 3g)
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

fetch_runtime_env "$STATE/runtime.env.new"
env_changed="$(replace_if_changed "$STATE/runtime.env.new" "$CONF/runtime.env")"
IW_ENV_KEYS="$(sed -n 's/^IW_ENV_KEYS=//p' "$CONF/runtime.env" | tr -d "'")"

registry_login

if [ "$ROLE" = "web" ]; then
  fetch_tunnel_env "$STATE/tunnel.env.new"
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
