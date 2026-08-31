import { timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ensureManagedChildDirectory,
  ensureTrustedRoot,
  replaceManagedFile,
} from "./safe-files.js";

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("container"),
  PRINCIPALLATCH_ALLOW_INSECURE_LOCAL_PROCESS: z
    .enum(["true", "false"])
    .default("false"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("principallatch-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  APP_ALLOWED_ORIGINS: z.string().optional(),
  PRINCIPALLATCH_KEY_DIR: z.string().optional(),
  PRINCIPALLATCH_PROTECTED_CONTENT_FILE: z.string().optional(),
  PRINCIPALLATCH_GATEWAY_URL: z.string().url().optional(),
  PRINCIPALLATCH_PASSPORT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(300),
  PRINCIPALLATCH_GATEWAY_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(120),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function containerEngineKind(command: string): string {
  const executable = command.split(/[\\/]/).at(-1) ?? command;
  return executable.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const arkApiKey = env.ARK_API_KEY?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.RUNTIME_PROVIDER === "container" || !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters whenever the Agent Runtime or a non-loopback client can reach the Human API",
      );
    }
  }
  if (authToken && arkApiKey && secretsEqual(authToken, arkApiKey)) {
    throw new Error(
      "APP_AUTH_TOKEN and ARK_API_KEY must be independent secrets; the Agent receives the Ark key",
    );
  }
  const insecureLocalProcessAllowed =
    env.PRINCIPALLATCH_ALLOW_INSECURE_LOCAL_PROCESS === "true";
  if (
    env.RUNTIME_PROVIDER === "local-process" &&
    (env.NODE_ENV !== "development" || !insecureLocalProcessAllowed)
  ) {
    throw new Error(
      "PrincipalLatch requires RUNTIME_PROVIDER=container so the Agent cannot read control-plane keys or protected content. " +
        "Set PRINCIPALLATCH_ALLOW_INSECURE_LOCAL_PROCESS=true only with NODE_ENV=development for an explicitly insecure UI preview.",
    );
  }
  const configuredOrigins = (env.APP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      const parsed = new URL(origin);
      if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
        throw new Error("APP_ALLOWED_ORIGINS entries must use http or https");
      }
      if (parsed.origin !== origin.replace(/\/$/, "")) {
        throw new Error("APP_ALLOWED_ORIGINS entries must be origins without paths");
      }
      return parsed.origin;
    });
  const allowedOrigins = Array.from(
    new Set([
      `http://localhost:${env.PORT}`,
      `http://127.0.0.1:${env.PORT}`,
      ...(env.NODE_ENV === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : []),
      ...configuredOrigins,
    ]),
  );
  const hostUid = typeof process.getuid === "function" ? process.getuid() : null;
  const hostGid = typeof process.getgid === "function" ? process.getgid() : null;
  const defaultContainerUser =
    hostUid !== null && hostUid > 0 && hostGid !== null
      ? hostUid + ":" + hostGid
      : "1000:1000";
  const containerUser = env.CONTAINER_USER?.trim() || defaultContainerUser;
  if (/^(?:0+|root)(?::|$)/i.test(containerUser)) {
    throw new Error(
      "PrincipalLatch requires a non-root CONTAINER_USER for the Agent Runtime",
    );
  }
  const engineName = containerEngineKind(env.CONTAINER_ENGINE);
  const runtimeGatewayHost =
    env.RUNTIME_PROVIDER === "container"
      ? engineName === "podman"
        ? "host.containers.internal"
        : "host.docker.internal"
      : "127.0.0.1";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    insecureLocalProcessAllowed,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    allowedOrigins,
    principalLatchKeyDirectory: path.resolve(
      env.PRINCIPALLATCH_KEY_DIR ?? path.join(env.APP_DATA_DIR, "principallatch-keys"),
    ),
    principalLatchProtectedContentFile: path.resolve(
      env.PRINCIPALLATCH_PROTECTED_CONTENT_FILE ??
        path.join(env.APP_DATA_DIR, "principallatch-protected-content.json"),
    ),
    principalLatchGatewayUrl:
      env.PRINCIPALLATCH_GATEWAY_URL?.replace(/\/+$/, "") ??
      `http://${runtimeGatewayHost}:${env.PORT}`,
    principalLatchPassportTtlSeconds: env.PRINCIPALLATCH_PASSPORT_TTL_SECONDS,
    principalLatchGatewayRateLimitMax: env.PRINCIPALLATCH_GATEWAY_RATE_LIMIT_MAX,
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === "true",
    arkApiKey,
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export function agentCodexHomePath(config: AppConfig, agentId: string): string {
  const safeAgentId = agentId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
  if (!safeAgentId) throw new Error("Agent ID cannot produce a Codex home path");
  return path.join(config.codexHome, "agents", safeAgentId);
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export async function writeAgentCodexConfig(
  config: AppConfig,
  agentId: string,
): Promise<string> {
  const root = await ensureTrustedRoot(config.codexHome, "Codex home root");
  const agents = await ensureManagedChildDirectory(
    root,
    path.join(root, "agents"),
    "Codex Agent homes directory",
  );
  const codexHome = await ensureManagedChildDirectory(
    agents,
    path.join(agents, path.basename(agentCodexHomePath(config, agentId))),
    "Agent Codex home",
  );
  await chmod(codexHome, 0o700);
  const toml = [
    "# Generated by PrincipalLatch. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await replaceManagedFile(codexHome, "config.toml", toml);
  return codexHome;
}
