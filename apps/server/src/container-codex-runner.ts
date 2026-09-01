import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  agentCodexHomePath,
  containerEngineKind,
  type AppConfig,
  writeAgentCodexConfig,
} from "./config.js";
import {
  buildCodexArgs,
  parseCodexEventLine,
  redactRuntimeSecrets,
  runCancellableSetup,
  throwIfRunCancelled,
} from "./codex-runner.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

const CONTAINER_REMOVAL_ATTEMPTS = 3;

export function containerName(agentId: string, instanceId = "default"): string {
  const normalizedInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const safeInstance =
    normalizedInstance.length <= 32
      ? normalizedInstance
      : normalizedInstance.slice(0, 21) +
        "-" +
        createHash("sha256").update(instanceId).digest("hex").slice(0, 10);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "principallatch-" + safeInstance + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
  hostPlatform: NodeJS.Platform = process.platform,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  const engineName = containerEngineKind(config.containerEngine);
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.principallatch=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    "--log-driver",
    "none",
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    ...(engineName === "docker" && hostPlatform === "linux"
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--ipc",
    "none",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "MODEL_API_KEY",
    "--env",
    "PRINCIPALLATCH_AGENT_PASSPORT",
    "--env",
    "PRINCIPALLATCH_GATEWAY_URL",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace",
    "--mount",
    "type=bind,src=" + agentCodexHomePath(config, request.agentId) + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private stopping = false;
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.helperEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.helperEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private async removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = this.removeContainerAndVerify(active);
    }
    const termination = active.termination;
    try {
      await termination;
    } finally {
      if (active.termination === termination) active.termination = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled(
      [...this.active.entries()].map(async ([agentId, active]) => {
        active.cancelled = true;
        await this.removeContainer(active);
        await active.settled;
        if (await this.containerExists(active.containerName)) {
          throw new Error(
            `Runtime container ${active.containerName} remains after shutdown`,
          );
        }
        this.active.delete(agentId);
      }),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0 || this.active.size > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "One or more Runtime containers could not be safely removed",
      );
    }
  }

  private async removeContainerAndVerify(active: ActiveContainer): Promise<void> {
    let lastFailure = "container remained present";
    for (let attempt = 1; attempt <= CONTAINER_REMOVAL_ATTEMPTS; attempt += 1) {
      try {
        await execFileAsync(
          this.config.containerEngine,
          ["rm", "--force", active.containerName],
          { timeout: 8_000, env: this.helperEnvironment() },
        );
      } catch (error) {
        lastFailure = helperFailureDetail(error);
      }
      if (!(await this.containerExists(active.containerName))) {
        active.child.kill("SIGTERM");
        return;
      }
      if (attempt < CONTAINER_REMOVAL_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    active.child.kill("SIGTERM");
    const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
    forceKill.unref();
    throw new Error(
      `Failed to remove Runtime container ${active.containerName}; ` +
        `credential-bearing container state may remain (${lastFailure})`,
    );
  }

  private async containerExists(name: string): Promise<boolean> {
    try {
      await execFileAsync(
        this.config.containerEngine,
        ["container", "inspect", name],
        { timeout: 5_000, env: this.helperEnvironment() },
      );
      return true;
    } catch (error) {
      if (isMissingContainerError(error)) return false;
      throw new Error(
        `Could not verify removal of Runtime container ${name}: ` +
          helperFailureDetail(error),
      );
    }
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    throwIfRunCancelled(request.signal);
    if (this.stopping) throw new Error("Runtime is shutting down");
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }

    await runCancellableSetup(request.signal, async () => {
      await writeAgentCodexConfig(this.config, request.agentId);
      await assertIsolatedRuntimeMounts(request, this.config);
    });
    throwIfRunCancelled(request.signal);
    if (this.stopping) throw new Error("Runtime is shutting down");
    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config),
      {
        cwd: request.workspacePath,
        env: this.runChildEnvironment(request),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: containerName(request.agentId, this.config.runtimeInstanceId),
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        void this.removeContainer(active).catch(() => {
          active.child.kill("SIGTERM");
        });
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) parseCodexEventLine(line, parsed);
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active).catch(() => {
        active.child.kill("SIGTERM");
      });
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) parseCodexEventLine(stdout.trim(), parsed);
      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = redactRuntimeSecrets(
          parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail",
          request.principalLatch.passport,
          this.config.modelApiKey,
        );
        throw new Error(
          this.config.containerEngine +
            " Runtime exited with code " +
            exitCode +
            ": " +
            detail,
        );
      }
      const output = redactRuntimeSecrets(
        parsed.messages.at(-1)?.trim() ?? "",
        request.principalLatch.passport,
        this.config.modelApiKey,
      );
      if (!output) throw new Error("Codex completed without an agent message");
      return { output, threadId: parsed.threadId, usage: parsed.usage };
    } finally {
      clearTimeout(timeout);
      if (await this.containerExists(active.containerName)) {
        await this.removeContainer(active);
      }
      if (await this.containerExists(active.containerName)) {
        throw new Error(
          `Runtime container ${active.containerName} still exists after cleanup`,
        );
      }
      this.active.delete(request.agentId);
    }
  }

  private helperEnvironment(): NodeJS.ProcessEnv {
    return containerHelperEnvironment();
  }

  private runChildEnvironment(request: RunnerRequest): NodeJS.ProcessEnv {
    return {
      ...this.helperEnvironment(),
      MODEL_API_KEY: this.config.modelApiKey,
      PRINCIPALLATCH_AGENT_PASSPORT: request.principalLatch.passport,
      PRINCIPALLATCH_GATEWAY_URL: request.principalLatch.gatewayUrl,
    };
  }
}

export function containerHelperEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  const pathValue = source.PATH ?? source.Path;
  if (pathValue !== undefined) environment.PATH = pathValue;
  for (const name of [
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "PATHEXT",
    "ComSpec",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "CONTAINER_HOST",
    "CONTAINER_CONNECTION",
    "CONTAINER_SSHKEY",
    "PODMAN_CONNECTIONS_CONF",
    "CONTAINERS_CONF",
    "CONTAINERS_REGISTRIES_CONF",
    "CONTAINERS_STORAGE_CONF",
  ] as const) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

export function isMissingContainerError(error: unknown): boolean {
  const detail = helperFailureDetail(error).toLowerCase();
  return (
    detail.includes("no such container") ||
    detail.includes("no such object") ||
    detail.includes("does not exist") ||
    detail.includes("container not found")
  );
}

function helperFailureDetail(error: unknown): string {
  const failure = error as { stderr?: string | Buffer; message?: string };
  const stderr = Buffer.isBuffer(failure?.stderr)
    ? failure.stderr.toString("utf8")
    : failure?.stderr;
  return (stderr?.trim() || failure?.message || String(error)).slice(0, 512);
}

export async function assertIsolatedRuntimeMounts(
  request: RunnerRequest,
  config: AppConfig,
): Promise<void> {
  const workspace = await realpath(request.workspacePath);
  const codexHome = await realpath(agentCodexHomePath(config, request.agentId));
  const sensitive = await Promise.all([
    realpath(config.dataDirectory),
    realpath(config.principalLatchKeyDirectory),
    realpath(config.principalLatchProtectedContentFile),
  ]);
  if (pathsOverlap(workspace, codexHome)) {
    throw new Error("Agent workspace and Codex home must be separate mounts");
  }
  for (const mount of [workspace, codexHome]) {
    for (const protectedPath of sensitive) {
      if (pathsOverlap(mount, protectedPath)) {
        throw new Error(
          "Agent Runtime mount overlaps trusted control-plane data: " + mount,
        );
      }
    }
  }
}

export function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return (
    normalizedLeft === normalizedRight ||
    isInside(normalizedLeft, normalizedRight) ||
    isInside(normalizedRight, normalizedLeft)
  );
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}
