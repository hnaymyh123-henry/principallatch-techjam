import path from "node:path";
import { AgentService } from "./agent-service.js";
import { keyMaterialFromSeeds } from "./principallatch/keys.js";
import { PrincipalLatchService } from "./principallatch/service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

export const TEST_APP_AUTH_TOKEN = "test-only-operator-token-1234567890";

export class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {}
}

export async function createTestContext(
  root: string,
  options: {
    runner?: AgentRunner;
    authToken?: string;
    environment?: Record<string, string>;
    now?: () => Date;
  } = {},
) {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    PRINCIPALLATCH_KEY_DIR: path.join(root, "keys"),
    PRINCIPALLATCH_GATEWAY_URL: "http://127.0.0.1:3000",
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    APP_AUTH_TOKEN: options.authToken ?? TEST_APP_AUTH_TOKEN,
    ...options.environment,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const keys = keyMaterialFromSeeds(
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
  );
  const principalLatch = new PrincipalLatchService(
    config,
    store,
    keys,
    options.now ?? (() => new Date()),
  );
  const service = new AgentService(
    config,
    store,
    workspaces,
    options.runner ?? new FakeRunner(),
    principalLatch,
  );
  await service.initialize();
  return { config, store, workspaces, keys, principalLatch, service };
}
