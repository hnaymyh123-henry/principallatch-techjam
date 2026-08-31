import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { humanSessionCookie } from "./principallatch/demo-session.js";
import { ALICE_PRINCIPAL_ID } from "./principallatch/fixtures.js";
import { createTestContext } from "./test-context.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Human session and Agent ownership boundary", () => {
  it("allows the owner to revoke immediately without a demo-phase precondition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-immediate-revoke-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root);
    const app = await createAuthenticatedApp(test);
    const alice = await login(app, "user:alice");
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/mandate/revoke`,
      headers: { cookie: alice.cookie, "x-csrf-token": alice.csrfToken },
    });

    expect(response.statusCode).toBe(200);
    expect(
      await test.principalLatch.readDocument(
        "AgentPassport " + credential.passport,
        "alice-doc-001",
      ),
    ).toMatchObject({
      ok: false,
      statusCode: 403,
      code: "DENY_MANDATE_LIFECYCLE",
    });
    await app.close();
  });

  it("starts a fresh rehearsal with a new Mandate and preserves the revoked predecessor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-reset-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root);
    const app = await createAuthenticatedApp(test);
    const alice = await login(app, "user:alice");
    const bob = serverFixtureSession(test, "user:bob");
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const historical = await test.service.sendMessage(
      ALICE_PRINCIPAL_ID,
      agent.id,
      "historical rehearsal prompt",
    );
    await expect
      .poll(
        () =>
          test.service.getRun(ALICE_PRINCIPAL_ID, historical.run.id).status,
      )
      .toBe("completed");
    expect(test.service.getMessages(ALICE_PRINCIPAL_ID, agent.id)).toHaveLength(2);
    expect(test.service.getRuns(ALICE_PRINCIPAL_ID, agent.id)).toHaveLength(1);
    const initial = test.principalLatch.authority.getCurrent(agent.mandateId)!;
    const captured = test.principalLatch.credentialForAgent(agent);
    expect(
      await test.principalLatch.readDocument(
        "AgentPassport " + captured.passport,
        "alice-doc-001",
      ),
    ).toMatchObject({ ok: true, statusCode: 200 });
    expect(test.principalLatch.contentProvider.readCount("alice-doc-001")).toBe(1);
    const payload = {
      expectedMandateId: agent.mandateId,
      expectedRevision: initial.revision,
    };

    const bobAttempt = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/demo/fresh-rehearsal`,
      headers: { cookie: bob.cookie, "x-csrf-token": bob.csrfToken },
      payload,
    });
    expect(bobAttempt.statusCode).toBe(404);

    const reset = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/demo/fresh-rehearsal`,
      headers: { cookie: alice.cookie, "x-csrf-token": alice.csrfToken },
      payload,
    });
    expect(reset.statusCode).toBe(200);
    const successorId = reset.json().agent.mandateId as string;
    expect(successorId).not.toBe(agent.mandateId);
    expect(test.principalLatch.authority.getCurrent(agent.mandateId)).toMatchObject({
      revision: initial.revision + 1,
      mandate: {
        lifecycle: { status: "revoked", replacedBy: successorId },
      },
    });
    expect(test.principalLatch.authority.getCurrent(successorId)).toMatchObject({
      revision: 1,
      mandate: {
        lifecycle: { status: "active", replaces: agent.mandateId },
      },
    });
    expect(test.service.getMessages(ALICE_PRINCIPAL_ID, agent.id)).toEqual([]);
    expect(test.service.getRuns(ALICE_PRINCIPAL_ID, agent.id)).toEqual([]);
    expect(test.principalLatch.contentProvider.readCount("alice-doc-001")).toBe(1);
    expect(
      test.store.snapshot().messages.some((message) => message.runId === historical.run.id),
    ).toBe(true);
    expect(
      test.store.snapshot().runs.some((run) => run.id === historical.run.id),
    ).toBe(true);
    expect(
      await test.principalLatch.readDocument(
        "AgentPassport " + captured.passport,
        "alice-doc-001",
      ),
    ).toMatchObject({ code: "DENY_PASSPORT_SESSION" });

    const staleRetry = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/demo/fresh-rehearsal`,
      headers: { cookie: alice.cookie, "x-csrf-token": alice.csrfToken },
      payload,
    });
    expect(staleRetry.statusCode).toBe(409);
    await app.close();
  });

  it("keeps Bob outside Alice's control plane and keeps Agent credentials outside Human routes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-authz-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root);
    const app = await createAuthenticatedApp(test);

    const aliceLogin = await login(app, "user:alice");
    const aliceAgents = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { cookie: aliceLogin.cookie },
    });
    expect(aliceAgents.statusCode).toBe(200);
    const aliceAgent = aliceAgents.json().agents[0] as { id: string };
    expect(aliceAgent).toBeDefined();

    const bobBrowserLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { principalId: "user:bob" },
    });
    expect(bobBrowserLogin.statusCode, bobBrowserLogin.body).toBe(400);
    expect(bobBrowserLogin.headers["set-cookie"]).toBeUndefined();

    // Bob remains a server-side principal for ownership-isolation testing, but
    // the public demo login route deliberately cannot create his session.
    const bobLogin = serverFixtureSession(test, "user:bob");
    const bobAgents = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { cookie: bobLogin.cookie },
    });
    expect(bobAgents.json()).toEqual({ agents: [] });
    const bobReadsAlice = await app.inject({
      method: "GET",
      url: `/api/agents/${aliceAgent.id}`,
      headers: { cookie: bobLogin.cookie },
    });
    expect(bobReadsAlice.statusCode).toBe(404);
    const bobRevokesAlice = await app.inject({
      method: "POST",
      url: `/api/agents/${aliceAgent.id}/mandate/revoke`,
      headers: {
        cookie: bobLogin.cookie,
        "x-csrf-token": bobLogin.csrfToken,
      },
    });
    expect(bobRevokesAlice.statusCode).toBe(404);

    const agent = test.service.getAgent(ALICE_PRINCIPAL_ID, aliceAgent.id);
    const credential = test.principalLatch.credentialForAgent(agent);
    const agentAttemptsHumanRoute = await app.inject({
      method: "POST",
      url: `/api/agents/${aliceAgent.id}/mandate/revoke`,
      headers: { authorization: "AgentPassport " + credential.passport },
    });
    expect(agentAttemptsHumanRoute.statusCode).toBe(401);

    const authorization = "AgentPassport " + credential.passport;
    expect(
      await test.principalLatch.readDocument(authorization, "alice-doc-001"),
    ).toMatchObject({ ok: true, statusCode: 200 });
    expect(
      await test.principalLatch.readDocument(authorization, "bob-payroll-001"),
    ).toMatchObject({
      ok: false,
      statusCode: 403,
      code: "DENY_OWNER_MISMATCH",
    });

    const wrongCsrf = await app.inject({
      method: "POST",
      url: `/api/agents/${aliceAgent.id}/mandate/revoke`,
      headers: { cookie: aliceLogin.cookie, "x-csrf-token": "wrong" },
    });
    expect(wrongCsrf.statusCode).toBe(403);
    const revoked = await app.inject({
      method: "POST",
      url: `/api/agents/${aliceAgent.id}/mandate/revoke`,
      headers: {
        cookie: aliceLogin.cookie,
        "x-csrf-token": aliceLogin.csrfToken,
      },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().security).toMatchObject({
      mandateStatus: "revoked",
      mandateRevision: 2,
    });

    await app.close();
  });

  it("does not expose protected content through catalog, system, security, or audit routes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-routes-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root);
    const app = await createAuthenticatedApp(test);
    const alice = await login(app, "user:alice");
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const protectedContent = JSON.parse(
      await readFile(test.config.principalLatchProtectedContentFile, "utf8"),
    ) as Record<string, string>;
    const routes = [
      "/api/system",
      "/api/demo/resources",
      `/api/agents/${agent.id}/security`,
      `/api/agents/${agent.id}/audit`,
    ];
    for (const url of routes) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: alice.cookie },
      });
      expect(response.statusCode).toBe(200);
      for (const secret of Object.values(protectedContent)) {
        expect(response.body).not.toContain(secret);
      }
    }
    const noPassport = await app.inject({
      method: "GET",
      url: "/v1/documents/alice-doc-001",
      headers: { cookie: alice.cookie },
    });
    expect(noPassport.statusCode).toBe(403);
    for (const secret of Object.values(protectedContent)) {
      expect(noPassport.body).not.toContain(secret);
    }
    await app.close();
  });

  it("rate limits the Agent-facing Gateway before rejection audit can grow without bound", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-rate-limit-test-"));
    temporaryDirectories.push(root);
    const test = await createTestContext(root, {
      environment: { PRINCIPALLATCH_GATEWAY_RATE_LIMIT_MAX: "2" },
    });
    const app = await createAuthenticatedApp(test);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/documents/alice-doc-001",
      });
      expect(response.statusCode).toBe(403);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/v1/documents/alice-doc-001",
    });
    expect(limited.statusCode).toBe(429);
    expect(test.store.snapshot().gatewayAuditEvents).toHaveLength(4);

    await app.close();
  });
});

async function createAuthenticatedApp(
  test: Awaited<ReturnType<typeof createTestContext>>,
): Promise<Awaited<ReturnType<typeof createApp>>> {
  const app = await createApp(test.config, test.service, test.principalLatch);
  const rawInject = app.inject.bind(app);
  app.inject = ((options: Parameters<typeof rawInject>[0]) =>
    rawInject({
      ...options,
      headers: {
        authorization: "Bearer " + test.config.authToken,
        ...(options.headers ?? {}),
      },
    })) as typeof app.inject;
  return app;
}

async function login(
  app: Awaited<ReturnType<typeof createApp>>,
  principalId: "user:alice",
): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/session",
    payload: { principalId },
  });
  expect(response.statusCode, response.body).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return {
    cookie: (raw ?? "").split(";", 1)[0] ?? "",
    csrfToken: response.json().session.csrfToken as string,
  };
}

function serverFixtureSession(
  test: Awaited<ReturnType<typeof createTestContext>>,
  principalId: "user:bob",
): { cookie: string; csrfToken: string } {
  const fixture = test.principalLatch.sessions.create(principalId);
  return {
    cookie: humanSessionCookie(
      fixture.cookieToken,
      test.config.sessionCookieSecure,
    ).split(";", 1)[0]!,
    csrfToken: fixture.session.csrfToken,
  };
}
