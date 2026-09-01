import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  agentCodexHomePath,
  type AppConfig,
  writeAgentCodexConfig,
} from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    ...(sandboxMode === "workspace-write"
      ? ["-c", "sandbox_workspace_write.network_access=true"]
      : []),
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

export function throwIfRunCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new RunCancelledError();
}

export async function runCancellableSetup<T>(
  signal: AbortSignal,
  setup: () => Promise<T>,
): Promise<T> {
  throwIfRunCancelled(signal);
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    // Filesystem setup itself is not abortable. Wait for it to settle before
    // reporting cancellation so no background writer survives the Run and no
    // Runtime can be spawned from partially-created state.
    const value = await setup();
    if (cancelled || signal.aborted) throw new RunCancelledError();
    return value;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export class CodexRunner implements AgentRunner {
  private stopping = false;
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.helperEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled(
      [...this.active.keys()].map((agentId) => this.cancel(agentId)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0 || this.active.size > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "One or more local Codex processes could not be stopped",
      );
    }
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    throwIfRunCancelled(request.signal);
    if (this.stopping) throw new Error("Runtime is shutting down");
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    await runCancellableSetup(request.signal, () =>
      writeAgentCodexConfig(this.config, request.agentId),
    );
    throwIfRunCancelled(request.signal);
    if (this.stopping) throw new Error("Runtime is shutting down");
    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.runChildEnvironment(request),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
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
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
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
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = redactRuntimeSecrets(
        parsed.messages.at(-1)?.trim() ?? "",
        request.principalLatch.passport,
        this.config.modelApiKey,
      );
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private helperEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }

  private runChildEnvironment(request: RunnerRequest): NodeJS.ProcessEnv {
    return {
      ...this.helperEnvironment(),
      CODEX_HOME: agentCodexHomePath(this.config, request.agentId),
      MODEL_API_KEY: this.config.modelApiKey,
      PRINCIPALLATCH_AGENT_PASSPORT: request.principalLatch.passport,
      PRINCIPALLATCH_GATEWAY_URL: request.principalLatch.gatewayUrl,
    };
  }
}

export function redactRuntimeSecrets(
  value: string,
  passport: string,
  modelApiKey: string,
): string {
  let redacted = value;
  for (const [secret, replacement] of [
    [passport, "[REDACTED_AGENT_PASSPORT]"],
    [modelApiKey, "[REDACTED_MODEL_API_KEY]"],
  ] as const) {
    if (secret) redacted = redacted.split(secret).join(replacement);
  }
  return redacted;
}
