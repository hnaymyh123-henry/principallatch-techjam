import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates legacy Runs and Messages onto the Agent's Mandate evidence scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-v2-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        agents: [
          {
            id: "agent-1",
            principalId: "agent:one",
            ownerPrincipalId: "user:alice",
            mandateId: "mandate:one",
          },
        ],
        messages: [
          {
            id: "message-1",
            agentId: "agent-1",
            runId: "run-1",
            role: "user",
            content: "legacy prompt",
            createdAt: new Date(0).toISOString(),
          },
        ],
        runs: [{ id: "run-1", agentId: "agent-1" }],
        authorityRecords: [],
        gatewayAuditEvents: [],
      }),
      "utf8",
    );
    const store = new JsonStore(filePath);

    await store.initialize();

    expect(store.snapshot().version).toBe(5);
    expect(store.snapshot().runs[0]?.mandateId).toBe("mandate:one");
    expect(store.snapshot().messages[0]?.mandateId).toBe("mandate:one");
  });

  it("retains application history but resets pre-v5 security evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-v4-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 4,
        agents: [
          {
            id: "agent-1",
            principalId: "agent:one",
            ownerPrincipalId: "user:alice",
            mandateId: "mandate:one",
          },
        ],
        messages: [],
        runs: [],
        authorityRecords: [{ untrusted: "must-not-be-reinterpreted" }],
        gatewayAuditEvents: [{ eventType: "authorization_decision" }],
      }),
      "utf8",
    );
    const store = new JsonStore(filePath);

    await store.initialize();

    expect(store.snapshot().version).toBe(5);
    expect(store.snapshot().agents).toHaveLength(1);
    expect(store.snapshot().authorityRecords).toEqual([]);
    expect(store.snapshot().gatewayAuditEvents).toEqual([]);
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          mandateId: "mandate:one",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        mandateId: "mandate:one",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
