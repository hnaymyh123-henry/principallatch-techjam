#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

runtime_image="${CONTAINER_RUNTIME_IMAGE:-principallatch-agent-runtime:local}"
runtime_base_image="${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"
runtime_apt_mirror="${CONTAINER_APT_MIRROR:-}"
runtime_apt_security_mirror="${CONTAINER_APT_SECURITY_MIRROR:-}"
runtime_apt_packages="${CONTAINER_RUNTIME_APT_PACKAGES:-ca-certificates git ripgrep}"
codex_sandbox_mode="${CODEX_SANDBOX_MODE:-workspace-write}"
engine=""
cleanup_armed=false

log() {
  printf '[local-poc] %s\n' "$*" >&2
}

engine_works() {
  "$1" info >/dev/null 2>&1
}

detect_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
      log "CONTAINER_ENGINE=$CONTAINER_ENGINE was not found."
      return 1
    }
    engine_works "$CONTAINER_ENGINE" || {
      log "$CONTAINER_ENGINE is installed but its service is not running."
      return 1
    }
    printf '%s' "$CONTAINER_ENGINE"
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    if engine_works docker; then
      printf 'docker'
      return
    fi
    log "Docker is installed but its service is not running."
  fi

  if command -v podman >/dev/null 2>&1; then
    if engine_works podman; then
      printf 'podman'
      return
    fi
    log "Podman is installed but its service or machine is not running."
  fi

  if command -v colima >/dev/null 2>&1; then
    log "Colima is installed but Docker is not reachable; start Colima first."
  fi

  log "No running Docker, Colima, or Podman engine was found."
  log "Install and start one of them, then rerun this command."
  return 1
}

list_runtime_containers() {
  local output
  if ! output="$($engine ps --all --quiet \
    --filter label=io.codejam.principallatch=agent-runtime \
    --filter "label=io.codejam.instance-id=$RUNTIME_INSTANCE_ID" 2>/dev/null)"; then
    log "Could not list Agent Runtime containers for $RUNTIME_INSTANCE_ID."
    return 1
  fi
  printf '%s\n' "$output" | sed '/^[[:space:]]*$/d'
}

remove_runtime_containers() {
  local phase="$1"
  local container_ids
  local failed=false

  if ! container_ids="$(list_runtime_containers)"; then
    return 1
  fi

  if [[ -n "$container_ids" ]]; then
    log "Removing $phase Agent Runtime containers for $RUNTIME_INSTANCE_ID."
    while IFS= read -r container_id; do
      [[ -z "$container_id" ]] && continue
      if ! "$engine" rm --force "$container_id" >/dev/null 2>&1; then
        log "Failed to remove Agent Runtime container $container_id."
        failed=true
      fi
    done <<<"$container_ids"
  fi

  local remaining_ids
  if ! remaining_ids="$(list_runtime_containers)"; then
    return 1
  fi
  if [[ -n "$remaining_ids" ]]; then
    log "Agent Runtime cleanup is incomplete; containers remain for $RUNTIME_INSTANCE_ID."
    failed=true
  fi

  [[ "$failed" == false ]]
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$cleanup_armed" == true ]] && ! remove_runtime_containers "shutdown"; then
    log "SECURITY ERROR: shutdown cleanup failed; inspect the engine before reusing this POC."
    if (( status == 0 )); then
      status=1
    fi
  fi
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "${ARK_API_KEY:-}" || -z "${ARK_MODEL:-}" || -z "${APP_AUTH_TOKEN:-}" ]]; then
  log "ARK_API_KEY, ARK_MODEL, and APP_AUTH_TOKEN are required."
  log "APP_AUTH_TOKEN must contain 24-128 URL-safe characters."
  log "Example: ARK_API_KEY=key ARK_MODEL=ep-id APP_AUTH_TOKEN=24-plus-random-characters npm run poc"
  exit 2
fi

if [[ "$ARK_API_KEY" == replace-* || "$ARK_MODEL" == *replace-* ]]; then
  log "ARK_API_KEY and ARK_MODEL must not be placeholder values."
  exit 2
fi

if [[ "$APP_AUTH_TOKEN" == "$ARK_API_KEY" ]]; then
  log "APP_AUTH_TOKEN and ARK_API_KEY must be independently generated secrets."
  exit 2
fi

if (( ${#APP_AUTH_TOKEN} < 24 || ${#APP_AUTH_TOKEN} > 128 )) \
  || [[ ! "$APP_AUTH_TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]] \
  || [[ "$APP_AUTH_TOKEN" == replace-* ]]; then
  log "APP_AUTH_TOKEN must contain 24-128 URL-safe characters and must not be a placeholder."
  exit 2
fi

requested_container_user="${CONTAINER_USER:-$(id -u):$(id -g)}"
if [[ "$requested_container_user" =~ ^(0+|[Rr][Oo][Oo][Tt])(:|$) ]]; then
  log "PrincipalLatch requires a non-root CONTAINER_USER for the Agent Runtime."
  exit 2
fi
export CONTAINER_USER="$requested_container_user"

command -v node >/dev/null 2>&1 || {
  log "Node.js 22+ is required to run the local control plane."
  exit 2
}
command -v npm >/dev/null 2>&1 || {
  log "npm is required to build and run the local control plane."
  exit 2
}

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  log "Node.js 22+ is required; found $(node --version)."
  exit 2
fi

engine="$(detect_engine)" || exit 2
log "Using $engine as the disposable Agent Runtime engine."

if [[ -n "${RUNTIME_INSTANCE_ID:-}" ]]; then
  if (( ${#RUNTIME_INSTANCE_ID} > 48 )) \
    || [[ ! "$RUNTIME_INSTANCE_ID" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    log "RUNTIME_INSTANCE_ID must contain 1-48 letters, digits, dots, underscores, or hyphens."
    exit 2
  fi
else
  RUNTIME_INSTANCE_ID="local-$(id -u)-$(printf '%s' "$repo_dir" | cksum | awk '{print $1}')"
  export RUNTIME_INSTANCE_ID
fi

# A stale Runtime may still hold a provider credential. Do not start the host
# control plane unless every Runtime from this POC instance is gone.
cleanup_armed=true
if ! remove_runtime_containers "stale"; then
  log "SECURITY ERROR: stale Agent Runtime cleanup failed; startup is blocked."
  exit 2
fi

if [[ ! -d node_modules ]]; then
  log "Installing application dependencies."
  npm ci
fi

resolve_path() {
  node -e 'const path=require("node:path"); console.log(path.resolve(process.argv[1]))' "$1"
}

if [[ -n "${LOCAL_POC_DATA_ROOT:-}" ]]; then
  local_state_root="$(resolve_path "$LOCAL_POC_DATA_ROOT")"
  APP_DATA_DIR="$local_state_root/data"
  AGENT_WORKSPACE_ROOT="$local_state_root/workspaces"
  CODEX_HOME="$local_state_root/codex-home"
else
  local_state_root="$repo_dir/.local"
  APP_DATA_DIR="$(resolve_path "${APP_DATA_DIR:-$local_state_root/data}")"
  AGENT_WORKSPACE_ROOT="$(resolve_path "${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}")"
  CODEX_HOME="$(resolve_path "${CODEX_HOME:-$local_state_root/codex-home}")"
fi
export APP_DATA_DIR AGENT_WORKSPACE_ROOT CODEX_HOME

for mount_path in "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"; do
  if [[ "$mount_path" == *,* ]] || [[ "$mount_path" == *$'\n'* ]]; then
    log "Container mount paths must not contain commas or newlines: $mount_path"
    exit 2
  fi
done

mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"
log "Persistent state: $local_state_root"

log "Building $runtime_image from Dockerfile.runtime (base: $runtime_base_image)."
"$engine" build \
  --file Dockerfile.runtime \
  --build-arg "NODE_IMAGE=$runtime_base_image" \
  --build-arg "DEBIAN_MIRROR=$runtime_apt_mirror" \
  --build-arg "DEBIAN_SECURITY_MIRROR=$runtime_apt_security_mirror" \
  --build-arg "RUNTIME_APT_PACKAGES=$runtime_apt_packages" \
  --tag "$runtime_image" \
  .

runtime_labels=(
  --label io.codejam.principallatch=agent-runtime
  --label "io.codejam.instance-id=$RUNTIME_INSTANCE_ID"
)
preflight_user_args=(--user "$CONTAINER_USER")
if [[ "$(basename "$engine")" == "podman" ]]; then
  preflight_user_args+=(--userns keep-id)
fi

log "Checking that the Runtime can bind-mount the configured state directories."
if ! "$engine" run --rm \
  "${runtime_labels[@]}" \
  "${preflight_user_args[@]}" \
  --mount "type=bind,src=$AGENT_WORKSPACE_ROOT,dst=/workspace" \
  --mount "type=bind,src=$CODEX_HOME,dst=/codex-home" \
  "$runtime_image" sh -lc \
    'touch /workspace/.principallatch-write-test /codex-home/.principallatch-write-test && rm /workspace/.principallatch-write-test /codex-home/.principallatch-write-test'; then
  log "The container engine cannot mount $local_state_root."
  log "Set LOCAL_POC_DATA_ROOT to a directory shared with Docker/Colima/Podman."
  exit 2
fi

if [[ "$codex_sandbox_mode" == "workspace-write" ]] \
  && ! "$engine" run --rm \
    "${runtime_labels[@]}" \
    "$runtime_image" codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  log "Codex Landlock is unavailable in this Linux Runtime."
  log "Falling back to danger-full-access inside the disposable container boundary."
  log "Do not mount unrelated secrets or host directories into the Agent Runtime."
  codex_sandbox_mode=danger-full-access
fi

export NODE_ENV=production
# The disposable bridge Runtime must reach the Passport-only /v1 gateway.
# Human /api routes remain protected by APP_AUTH_TOKEN plus opaque sessions.
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"
export CODEX_SANDBOX_MODE="$codex_sandbox_mode"
export RUNTIME_PROVIDER=container
export CONTAINER_ENGINE="$engine"
export CONTAINER_RUNTIME_IMAGE="$runtime_image"

log "Building the local Web and trusted host API."
npm run build

log "Open http://localhost:$PORT"
npm start
