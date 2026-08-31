import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { loadOrCreateKeyMaterial } from "./principallatch/keys.js";
import { PrincipalLatchService } from "./principallatch/service.js";

const config = loadConfig();

const store = new JsonStore(path.join(config.dataDirectory, "principallatch.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const principalLatchKeys = await loadOrCreateKeyMaterial(
  config.principalLatchKeyDirectory,
);
const principalLatch = new PrincipalLatchService(config, store, principalLatchKeys);
const service = new AgentService(config, store, workspaces, runner, principalLatch);
await service.initialize();

const app = await createApp(config, service, principalLatch);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");
  service.beginShutdown();
  let exitCode = 0;
  try {
    await app.close();
  } catch (error) {
    exitCode = 1;
    app.log.error({ error }, "HTTP server shutdown failed");
  }
  try {
    await service.shutdown();
  } catch (error) {
    exitCode = 1;
    app.log.error(
      { error },
      "Runtime cleanup failed; inspect and remove labelled containers before reuse",
    );
  }
  process.exitCode = exitCode;
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
