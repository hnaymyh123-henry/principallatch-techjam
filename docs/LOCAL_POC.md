# Local judged POC

`npm run poc` is the only security-supported PrincipalLatch launcher. It keeps the
trusted Fastify process on the host and starts each real Codex turn in a fresh
Docker/Podman container.

## Requirements

- Node.js 22+ and npm;
- a running Docker or Podman engine (Docker Desktop/Colima are valid Docker
  providers);
- a scoped Volcengine Ark API key;
- a Responses-compatible Ark endpoint/model ID; and
- an independently generated 24–128 character URL-safe operator token.

`APP_AUTH_TOKEN` must not equal `ARK_API_KEY`: the Agent necessarily receives the
Ark key, while only the Human operator may know the outer API token.

## Start

PowerShell on Windows:

```powershell
$env:ARK_API_KEY = "your-scoped-competition-key"
$env:ARK_MODEL = "ep-your-endpoint-id"
$env:APP_AUTH_TOKEN = "use-24-plus-random-url-safe-characters"
npm run poc
```

Bash on macOS, Linux, or WSL:

```bash
export ARK_API_KEY=your-scoped-competition-key
export ARK_MODEL=ep-your-endpoint-id
export APP_AUTH_TOKEN=use-24-plus-random-url-safe-characters
npm run poc
```

The Node launcher selects PowerShell on Windows and Bash elsewhere. It does not
start Docker Desktop, Colima, or a Podman machine for you. If no engine is
running, it exits before installing dependencies or creating state.

Open <http://localhost:3000>, enter the operator token, continue as Alice, and click
**Fresh rehearsal** before the timed demo. Press `Ctrl+C` to stop.

## What the launcher verifies

Before serving the UI, it:

1. validates Node, Ark configuration, and the independent operator token;
2. selects Docker/Podman, or validates `CONTAINER_ENGINE` when explicitly set;
3. removes and re-lists stale Runtime containers for this repository instance;
4. blocks startup if credential-bearing stale state cannot be proven absent;
5. installs dependencies with `npm ci` only when needed;
6. builds `Dockerfile.runtime` and checks both bind mounts with the configured
   non-root container user;
7. probes the inner Codex sandbox and, if unavailable, clearly reports the
   fallback inside the outer disposable-container boundary;
8. builds the Web/API and forces `RUNTIME_PROVIDER=container`; and
9. repeats labelled-container cleanup on every normal or signalled exit, returning
   a non-zero status if cleanup cannot be verified.

The server also removes and inspects each per-turn container and performs its own
Runner-level shutdown cleanup. The launcher is a second cleanup layer, not the
only one.

## State and mounts

State defaults to `<repo>/.local/` on all platforms:

```text
.local/data/        trusted JSON, signing keys, generated mock canaries
.local/workspaces/  per-Agent workspace
.local/codex-home/  per-Agent Codex state
```

Set `LOCAL_POC_DATA_ROOT` to another absolute or resolvable path when Docker
Desktop/Colima requires a shared directory. Each Agent turn mounts only its
workspace and its own Codex-home directory. Trusted data, keys, protected
content, the repository, and the engine socket are not mounted.

The container uses a read-only root, a bounded `noexec` temporary filesystem,
no IPC, dropped capabilities, `no-new-privileges`, CPU/memory/PID limits, and
`--log-driver none`. It still has outbound bridge networking for Ark and the
Gateway.

## Options and troubleshooting

Force an engine:

```powershell
$env:CONTAINER_ENGINE = "podman" # or docker
npm run poc
```

Relevant options are documented in [../.env.example](../.env.example): Runtime
image/base, apt mirrors/packages, resource limits, state roots, Passport TTL,
and Gateway rate limit.

Useful read-only checks:

```bash
docker info                         # or: podman info
docker image inspect principallatch-agent-runtime:local
curl http://localhost:3000/api/health
```

If a mount preflight fails, set `LOCAL_POC_DATA_ROOT` to a directory shared with
the engine VM. If startup or shutdown reports `SECURITY ERROR`, inspect/remove
only containers carrying both `io.codejam.principallatch=agent-runtime` and the
reported instance label before rerunning.

Do not substitute an all-in-one deployment or
`RUNTIME_PROVIDER=local-process`; those profiles co-locate trusted state and the
Agent and are not PrincipalLatch security evidence.
