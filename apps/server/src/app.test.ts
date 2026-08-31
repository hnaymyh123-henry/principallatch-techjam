import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { ALICE_PRINCIPAL_ID } from "./principallatch/fixtures.js";
import {
  createTestContext,
  TEST_APP_AUTH_TOKEN,
} from "./test-context.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function context(authToken?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "principallatch-app-test-"));
  temporaryDirectories.push(root);
  return createTestContext(root, { ...(authToken ? { authToken } : {}) });
}

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const test = await context(TEST_APP_AUTH_TOKEN);
    const app = await createApp(test.config, test.service, test.principalLatch);
    const denied = await app.inject({ method: "GET", url: "/api/system" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/system",
      headers: { authorization: "Bearer " + TEST_APP_AUTH_TOKEN },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("applies outer authentication to percent-encoded spellings of matched API routes", async () => {
    const test = await context(TEST_APP_AUTH_TOKEN);
    const app = await createApp(test.config, test.service, test.principalLatch);

    const encodedSession = await app.inject({
      method: "POST",
      url: "/%61pi/session",
      headers: { origin: "http://localhost:3000" },
      payload: { principalId: "user:alice" },
    });
    expect(encodedSession.statusCode).toBe(401);
    expect(encodedSession.headers["set-cookie"]).toBeUndefined();

    const encodedAgents = await app.inject({
      method: "GET",
      url: "/%61pi/agents",
    });
    expect(encodedAgents.statusCode).toBe(401);

    const agentGateway = await app.inject({
      method: "GET",
      url: "/v1/documents/alice-doc-001",
    });
    expect(agentGateway.statusCode).toBe(403);
    expect(agentGateway.json()).toMatchObject({
      ok: false,
      statusCode: 403,
      decision: "deny",
      outcome: "not_attempted",
      providerAttempted: false,
      code: "DENY_PASSPORT_MISSING",
    });
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const test = await context();
    const app = await createApp(test.config, test.service, test.principalLatch);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        authorization: "Bearer " + TEST_APP_AUTH_TOKEN,
        "content-type": "application/json",
      },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        authorization: "Bearer " + TEST_APP_AUTH_TOKEN,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("returns an authorized provider failure as 502 allow/failed", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    test.principalLatch.contentProvider.setForcedFailure("alice-doc-001", true);
    const app = await createApp(test.config, test.service, test.principalLatch);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/documents/alice-doc-001",
        headers: {
          authorization: "AgentPassport " + credential.passport,
        },
      });
      const body = response.json();

      expect(response.statusCode).toBe(502);
      expect(body).toMatchObject({
        ok: false,
        statusCode: 502,
        requestId: expect.any(String),
        decision: "allow",
        outcome: "failed",
        providerAttempted: true,
        code: "RESOURCE_PROVIDER_FAILED",
      });
      expect(
        test.principalLatch.contentProvider.readCount("alice-doc-001"),
      ).toBe(1);
      expect(
        test.store.snapshot().gatewayAuditEvents.some(
          (event) =>
            event.requestId === body.requestId &&
            event.eventType === "resource_outcome" &&
            event.status === "failed",
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 503 deny/not-attempted when pre-access audit persistence fails", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const auditSpy = vi
      .spyOn(test.principalLatch.audit, "appendBatch")
      .mockRejectedValue(new Error("audit unavailable"));
    const app = await createApp(test.config, test.service, test.principalLatch);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/documents/alice-doc-001",
        headers: {
          authorization: "AgentPassport " + credential.passport,
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        ok: false,
        statusCode: 503,
        requestId: expect.any(String),
        decision: "deny",
        outcome: "not_attempted",
        providerAttempted: false,
        code: "DENY_AUDIT_UNAVAILABLE",
      });
      expect(
        test.principalLatch.contentProvider.readCount("alice-doc-001"),
      ).toBe(0);
      expect(test.store.snapshot().gatewayAuditEvents).toEqual([]);
    } finally {
      auditSpy.mockRestore();
      await app.close();
    }
  });

  it("returns 503 allow/indeterminate when terminal outcome persistence fails after provider access", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const persistBatch = test.principalLatch.audit.appendBatch.bind(
      test.principalLatch.audit,
    );
    const auditSpy = vi
      .spyOn(test.principalLatch.audit, "appendBatch")
      .mockImplementation(async (events) => {
        if (
          events.some(
            (event) =>
              event.eventType === "resource_outcome" &&
              event.status === "succeeded",
          )
        ) {
          throw new Error("terminal audit unavailable");
        }
        await persistBatch(events);
      });
    const app = await createApp(test.config, test.service, test.principalLatch);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/documents/alice-doc-001",
        headers: {
          authorization: "AgentPassport " + credential.passport,
        },
      });
      const body = response.json();

      expect(response.statusCode).toBe(503);
      expect(body).toMatchObject({
        ok: false,
        statusCode: 503,
        requestId: expect.any(String),
        decision: "allow",
        outcome: "indeterminate",
        providerAttempted: true,
        code: "OUTCOME_AUDIT_UNAVAILABLE",
      });
      expect(
        test.principalLatch.contentProvider.readCount("alice-doc-001"),
      ).toBe(1);

      const persisted = test.store
        .snapshot()
        .gatewayAuditEvents.filter(
          (event) => event.requestId === body.requestId,
        );
      expect(persisted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "authorization_decision",
            decision: "allow",
          }),
          expect.objectContaining({
            eventType: "resource_outcome",
            status: "attempting",
          }),
        ]),
      );
      expect(
        persisted.some(
          (event) =>
            event.eventType === "resource_outcome" &&
            event.status === "succeeded",
        ),
      ).toBe(false);
    } finally {
      auditSpy.mockRestore();
      await app.close();
    }
  });
});
