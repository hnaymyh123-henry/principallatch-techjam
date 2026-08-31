import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 5,
  agents: [],
  messages: [],
  runs: [],
  authorityRecords: [],
  gatewayAuditEvents: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const migrated = migrateDatabase(parsed);
      if (!migrated) {
        throw new Error("Unsupported database format");
      }
      this.data = migrated.database;
      if (migrated.changed) await this.persist(this.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function migrateDatabase(
  value: unknown,
): { database: Database; changed: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Record<string, unknown>;
  if (
    !Array.isArray(parsed.agents) ||
    !Array.isArray(parsed.messages) ||
    !Array.isArray(parsed.runs)
  ) {
    return null;
  }
  if (parsed.version === 5) {
    if (
      !Array.isArray(parsed.authorityRecords) ||
      !Array.isArray(parsed.gatewayAuditEvents)
    ) {
      return null;
    }
    return { database: parsed as unknown as Database, changed: false };
  }
  if (
    parsed.version !== 1 &&
    parsed.version !== 2 &&
    parsed.version !== 3 &&
    parsed.version !== 4
  ) {
    return null;
  }

  const agents = (parsed.agents as Array<Record<string, unknown>>).map((agent) => ({
    ...agent,
    principalId:
      typeof agent.principalId === "string"
        ? agent.principalId
        : `agent:${String(agent.id)}`,
    ownerPrincipalId:
      typeof agent.ownerPrincipalId === "string"
        ? agent.ownerPrincipalId
        : "user:alice",
    mandateId:
      typeof agent.mandateId === "string"
        ? agent.mandateId
        : `mandate:user:alice:agent:${String(agent.id)}`,
  })) as unknown as Database["agents"];
  const ownerByAgent = new Map(
    agents.map((agent) => [agent.id, agent.ownerPrincipalId]),
  );
  const mandateByAgent = new Map(
    agents.map((agent) => [agent.id, agent.mandateId]),
  );
  const runs = (parsed.runs as Array<Record<string, unknown>>).map((run) => ({
    ...run,
    mandateId:
      typeof run.mandateId === "string"
        ? run.mandateId
        : mandateByAgent.get(String(run.agentId)) ?? "mandate:legacy:unknown",
    initiatedByPrincipalId:
      typeof run.initiatedByPrincipalId === "string"
        ? run.initiatedByPrincipalId
        : ownerByAgent.get(String(run.agentId)) ?? "user:alice",
    agentSessionId:
      typeof run.agentSessionId === "string" ? run.agentSessionId : "legacy",
    passportJti:
      typeof run.passportJti === "string" ? run.passportJti : "legacy",
    passportExpiresAt:
      typeof run.passportExpiresAt === "string"
        ? run.passportExpiresAt
        : new Date(0).toISOString(),
    passportTokenSha256:
      typeof run.passportTokenSha256 === "string"
        ? run.passportTokenSha256
        : "sha256:legacy",
  })) as unknown as Database["runs"];
  const mandateByRun = new Map(runs.map((run) => [run.id, run.mandateId]));
  const messages = (parsed.messages as Array<Record<string, unknown>>).map(
    (message) => ({
      ...message,
      mandateId:
        typeof message.mandateId === "string"
          ? message.mandateId
          : mandateByRun.get(String(message.runId)) ??
            mandateByAgent.get(String(message.agentId)) ??
            "mandate:legacy:unknown",
    }),
  ) as unknown as Database["messages"];
  return {
    database: {
      version: 5,
      agents,
      messages,
      runs,
      // v5 introduces PrincipalLatch's independent signed-mandate format. Older
      // authority objects and their audit chains are intentionally not
      // reinterpreted as current security evidence. AgentService reissues a
      // fresh mandate for every retained Agent during initialization.
      authorityRecords: [],
      gatewayAuditEvents: [],
    },
    changed: true,
  };
}
