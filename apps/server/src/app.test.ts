import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
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
});
