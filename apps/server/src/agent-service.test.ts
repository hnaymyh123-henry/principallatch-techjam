import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service.js";
import { ALICE_PRINCIPAL_ID, BOB_PRINCIPAL_ID } from "./principallatch/fixtures.js";
import { createTestContext, FakeRunner } from "./test-context.js";
import { RunCancelledError } from "./errors.js";
import type { AgentRunner, RunnerResult } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "principallatch-test-"));
  temporaryDirectories.push(root);
  return (await createTestContext(root, { runner })).service;
}

describe("Agent lifecycle", () => {
  it("reports live Agent readiness only when the isolated Runtime is usable", async () => {
    const ready = await makeService();
    await expect(ready.systemInfo()).resolves.toMatchObject({
      arkConfigured: true,
      codexAvailable: true,
      securityDemoEligible: true,
      liveAgentReady: true,
    });

    const unavailable = await makeService({
      run: async () => ({ output: "unused", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => false,
      shutdown: async () => undefined,
    });
    await expect(unavailable.systemInfo()).resolves.toMatchObject({
      arkConfigured: true,
      codexAvailable: false,
      securityDemoEligible: true,
      liveAgentReady: false,
    });
  });

  it("rejects an unconfigured live Run before issuing Runtime credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-unconfigured-run-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root, {
      environment: { ARK_API_KEY: "", ARK_MODEL: "" },
    });
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;

    await expect(
      test.service.sendMessage(ALICE_PRINCIPAL_ID, agent.id, "must not start"),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(test.store.snapshot().runs).toEqual([]);
    expect(test.principalLatch.passportBroker.inspect(agent.principalId)).toBeNull();
  });

  it("rejects an unavailable Runtime before issuing Runtime credentials", async () => {
    const service = await makeService({
      run: async () => ({ output: "unused", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => false,
      shutdown: async () => undefined,
    });
    const agent = service.listAgents(ALICE_PRINCIPAL_ID)[0]!;

    await expect(
      service.sendMessage(ALICE_PRINCIPAL_ID, agent.id, "must not start"),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(service.getRuns(ALICE_PRINCIPAL_ID, agent.id)).toEqual([]);
  });

  it("rebinds a persisted Agent workspace after the deployment root moves", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-relocated-store-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "data"), { recursive: true });
    const timestamp = new Date(0).toISOString();
    await writeFile(
      path.join(root, "data", "db.json"),
      JSON.stringify({
        version: 4,
        agents: [
          {
            id: "relocated-agent",
            principalId: "agent:relocated-agent",
            ownerPrincipalId: ALICE_PRINCIPAL_ID,
            mandateId: "mandate:user:alice:agent:relocated-agent",
            name: "Relocated Agent",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: "/old-machine/private/workspaces/relocated-agent",
            codexThreadId: null,
            lastError: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        messages: [],
        runs: [],
        authorityRecords: [],
        gatewayAuditEvents: [],
      }),
      "utf8",
    );

    const test = await createTestContext(root);
    const relocated = test.service.getAgent(ALICE_PRINCIPAL_ID, "relocated-agent");

    expect(relocated.workspacePath).toBe(
      test.workspaces.workspacePath("relocated-agent"),
    );
    expect(test.store.snapshot().agents.find((agent) => agent.id === relocated.id))
      .toMatchObject({ workspacePath: relocated.workspacePath });
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent(ALICE_PRINCIPAL_ID, { name: "Builder" });
    expect(service.listAgents(ALICE_PRINCIPAL_ID)).toHaveLength(2);
    expect(
      (
        await service.updateAgent(ALICE_PRINCIPAL_ID, agent.id, {
          description: "Builds apps",
        })
      ).description,
    ).toBe("Builds apps");
    expect((await service.stopAgent(ALICE_PRINCIPAL_ID, agent.id)).status).toBe(
      "stopped",
    );
    expect((await service.startAgent(ALICE_PRINCIPAL_ID, agent.id)).status).toBe(
      "ready",
    );
    await service.deleteAgent(ALICE_PRINCIPAL_ID, agent.id);
    expect(service.listAgents(ALICE_PRINCIPAL_ID)).toHaveLength(1);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent(ALICE_PRINCIPAL_ID, { name: "Coder" });
    const { run } = await service.sendMessage(
      ALICE_PRINCIPAL_ID,
      agent.id,
      "write hello world",
    );
    await expect
      .poll(() => service.getRun(ALICE_PRINCIPAL_ID, run.id).status)
      .toBe("completed");
    const messages = service.getMessages(ALICE_PRINCIPAL_ID, agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(ALICE_PRINCIPAL_ID, agent.id).codexThreadId).toBe(
      "fake-thread",
    );
    expect(run.passportTokenSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("redacts Runtime credentials before persisting successful output", async () => {
    const service = await makeService({
      run: async (request) => ({
        output:
          "passport=" + request.principalLatch.passport + " ark=test-key",
        threadId: "secret-test-thread",
        usage: null,
      }),
      cancel: async () => false,
      isAvailable: async () => true,
      shutdown: async () => undefined,
    });
    const agent = service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const { run } = await service.sendMessage(
      ALICE_PRINCIPAL_ID,
      agent.id,
      "try to reveal credentials",
    );

    await expect
      .poll(() => service.getRun(ALICE_PRINCIPAL_ID, run.id).status)
      .toBe("completed");
    const stored = service.getRun(ALICE_PRINCIPAL_ID, run.id);
    expect(stored.output).toBe(
      "passport=[REDACTED_AGENT_PASSPORT] ark=[REDACTED_ARK_API_KEY]",
    );
    expect(JSON.stringify(service.getMessages(ALICE_PRINCIPAL_ID, agent.id))).not.toContain(
      "test-key",
    );
  });

  it("redacts Runtime credentials before persisting an error", async () => {
    const service = await makeService({
      run: async (request) => {
        throw new Error(
          "failed with " + request.principalLatch.passport + " and test-key",
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
      shutdown: async () => undefined,
    });
    const agent = service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const { run } = await service.sendMessage(
      ALICE_PRINCIPAL_ID,
      agent.id,
      "try to reveal credentials",
    );

    await expect
      .poll(() => service.getRun(ALICE_PRINCIPAL_ID, run.id).status)
      .toBe("failed");
    const stored = service.getRun(ALICE_PRINCIPAL_ID, run.id);
    expect(stored.error).toContain("[REDACTED_AGENT_PASSPORT]");
    expect(stored.error).toContain("[REDACTED_ARK_API_KEY]");
    expect(stored.error).not.toContain("test-key");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
      shutdown: async () => undefined,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent(ALICE_PRINCIPAL_ID, {
      name: "Concurrent",
    });
    const attempts = await Promise.allSettled([
      service.sendMessage(ALICE_PRINCIPAL_ID, agent.id, "first"),
      service.sendMessage(ALICE_PRINCIPAL_ID, agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(ALICE_PRINCIPAL_ID, agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect
        .poll(
          () =>
            service.getRun(ALICE_PRINCIPAL_ID, accepted.value.run.id).status,
        )
        .toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
      shutdown: async () => undefined,
    });
    const agent = await service.createAgent(ALICE_PRINCIPAL_ID, { name: "Busy" });
    const { run } = await service.sendMessage(
      ALICE_PRINCIPAL_ID,
      agent.id,
      "first",
    );

    await expect(
      service.startAgent(ALICE_PRINCIPAL_ID, agent.id),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.sendMessage(ALICE_PRINCIPAL_ID, agent.id, "second"),
    ).rejects.toMatchObject({ statusCode: 409 });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect
      .poll(() => service.getRun(ALICE_PRINCIPAL_ID, run.id).status)
      .toBe("completed");
  });

  it("does not issue a Passport when a stopped Agent rejects a Run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-stopped-run-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root);
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    await test.service.stopAgent(ALICE_PRINCIPAL_ID, agent.id);

    await expect(
      test.service.sendMessage(ALICE_PRINCIPAL_ID, agent.id, "should reject"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(test.principalLatch.passportBroker.inspect(agent.principalId)).toBeNull();
  });

  it("does not expose Alice's Agent to Bob", async () => {
    const service = await makeService();
    const aliceAgent = service.listAgents(ALICE_PRINCIPAL_ID)[0];
    expect(aliceAgent).toBeDefined();
    expect(service.listAgents(BOB_PRINCIPAL_ID)).toEqual([]);
    expect(() =>
      service.getAgent(BOB_PRINCIPAL_ID, aliceAgent!.id),
    ).toThrowError("Agent not found");
  });

  it("kills a captured Passport when an Agent is stopped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-stop-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root);
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const authorization = "AgentPassport " + credential.passport;
    expect(
      await test.principalLatch.readDocument(authorization, "alice-doc-001"),
    ).toMatchObject({ ok: true, statusCode: 200 });

    await test.service.stopAgent(ALICE_PRINCIPAL_ID, agent.id);

    expect(
      await test.principalLatch.readDocument(authorization, "alice-doc-001"),
    ).toMatchObject({
      ok: false,
      statusCode: 403,
      code: "DENY_PASSPORT_SESSION",
    });
    await test.service.startAgent(ALICE_PRINCIPAL_ID, agent.id);
    expect(test.principalLatch.credentialForAgent(agent).passport).not.toBe(
      credential.passport,
    );
  });

  it("revokes authority and kills a captured Passport before deleting an Agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-delete-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root);
    const agent = await test.service.createAgent(ALICE_PRINCIPAL_ID, {
      name: "Disposable",
    });
    const credential = test.principalLatch.credentialForAgent(agent);
    const authorization = "AgentPassport " + credential.passport;

    await test.service.deleteAgent(ALICE_PRINCIPAL_ID, agent.id);

    expect(test.principalLatch.authority.getCurrent(agent.mandateId)).toMatchObject({
      mandate: { lifecycle: { status: "revoked" } },
    });
    expect(
      await test.principalLatch.readDocument(authorization, "alice-doc-001"),
    ).toMatchObject({
      ok: false,
      statusCode: 403,
      code: "DENY_PASSPORT_SESSION",
    });
  });

  it("keeps the seeded demo Agent permanent so its evidence flow remains reproducible", async () => {
    const service = await makeService();
    const agent = service.listAgents(ALICE_PRINCIPAL_ID)[0]!;

    await expect(
      service.deleteAgent(ALICE_PRINCIPAL_ID, agent.id),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(service.getAgent(ALICE_PRINCIPAL_ID, agent.id).id).toBe(agent.id);
  });

  it("can retire an ordinary Agent after its signed Mandate has expired", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-expired-delete-test-"));
    temporaryDirectories.push(root);
    let currentTime = new Date("2030-01-01T00:00:00.000Z");
    const test = await createTestContext(root, { now: () => currentTime });
    const agent = await test.service.createAgent(ALICE_PRINCIPAL_ID, {
      name: "Expiring Agent",
    });
    currentTime = new Date("2030-01-09T00:00:00.000Z");
    expect(
      test.principalLatch.authority.effectiveLifecycleStatus(agent.mandateId),
    ).toBe("expired");

    await expect(
      test.service.deleteAgent(ALICE_PRINCIPAL_ID, agent.id),
    ).resolves.toHaveProperty("archivedWorkspace");
    expect(() => test.service.getAgent(ALICE_PRINCIPAL_ID, agent.id)).toThrow(
      "Agent not found",
    );
  });

  it("cancels and awaits active Runtime work during service shutdown", async () => {
    let rejectRun: ((error: Error) => void) | null = null;
    let cancelCalls = 0;
    const service = await makeService({
      run: () =>
        new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
        }),
      cancel: async () => {
        cancelCalls += 1;
        rejectRun?.(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
      shutdown: async () => undefined,
    });
    const agent = await service.createAgent(ALICE_PRINCIPAL_ID, {
      name: "Shutdown boundary",
    });
    const { run } = await service.sendMessage(
      ALICE_PRINCIPAL_ID,
      agent.id,
      "keep running until shutdown",
    );
    await expect.poll(() => rejectRun !== null).toBe(true);

    await service.shutdown();

    expect(cancelCalls).toBe(1);
    expect(service.getRun(ALICE_PRINCIPAL_ID, run.id).status).toBe("cancelled");
  });

  it("stops a Run during delayed Runtime setup without letting it start", async () => {
    let setupEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      setupEntered = resolve;
    });
    let releaseSetup: (() => void) | null = null;
    let runtimeStarted = false;
    const service = await makeService({
      run: (request) =>
        new Promise<RunnerResult>((resolve, reject) => {
          let settled = false;
          setupEntered();
          releaseSetup = () => {
            if (settled) return;
            settled = true;
            runtimeStarted = true;
            resolve({ output: "too late", threadId: null, usage: null });
          };
          const signal = (
            request as typeof request & { signal?: AbortSignal }
          ).signal;
          signal?.addEventListener(
            "abort",
            () => {
              if (settled) return;
              settled = true;
              reject(new RunCancelledError());
            },
            { once: true },
          );
        }),
      cancel: async () => false,
      isAvailable: async () => true,
      shutdown: async () => undefined,
    });
    const agent = await service.createAgent(ALICE_PRINCIPAL_ID, {
      name: "Delayed setup",
    });
    const { run } = await service.sendMessage(
      ALICE_PRINCIPAL_ID,
      agent.id,
      "must be cancellable before Runtime registration",
    );
    await entered;

    let stopSettled = false;
    const stopping = service
      .stopAgent(ALICE_PRINCIPAL_ID, agent.id)
      .then((stopped) => {
        stopSettled = true;
        return stopped;
      });
    try {
      await expect.poll(() => stopSettled, { timeout: 500 }).toBe(true);
      expect((await stopping).status).toBe("stopped");
      expect(runtimeStarted).toBe(false);
      expect(service.getRun(ALICE_PRINCIPAL_ID, run.id).status).toBe("cancelled");
    } finally {
      releaseSetup?.();
      await stopping.catch(() => undefined);
    }
  });

  it("rejects a Run reservation that was queued when the shutdown latch closes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-shutdown-race-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root);
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    let releaseStore: (() => void) | null = null;
    const blocker = test.store.mutate(
      () =>
        new Promise<void>((resolve) => {
          releaseStore = resolve;
        }),
    );
    await expect.poll(() => releaseStore !== null).toBe(true);
    const queuedRun = test.service.sendMessage(
      ALICE_PRINCIPAL_ID,
      agent.id,
      "must not start after shutdown",
    );

    test.service.beginShutdown();
    releaseStore?.();
    await blocker;

    await expect(queuedRun).rejects.toMatchObject({ statusCode: 503 });
    expect(test.store.snapshot().runs).toEqual([]);
    expect(test.principalLatch.passportBroker.inspect(agent.principalId)).toBeNull();
    await test.service.shutdown();
  });
});
