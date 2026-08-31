import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { ALICE_PRINCIPAL_ID } from "./principallatch/fixtures.js";
import { createTestContext } from "./test-context.js";

const root = await mkdtemp(path.join(tmpdir(), "principallatch-verifier-"));
try {
  const test = await createTestContext(root);
  const app = await createApp(test.config, test.service, test.principalLatch);
  try {
    const operatorAuthorization = `Bearer ${test.config.authToken}`;
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { authorization: operatorAuthorization },
      payload: { principalId: ALICE_PRINCIPAL_ID },
    });
    assert.equal(login.statusCode, 200);
    const rawCookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : login.headers["set-cookie"];
    const cookie = (rawCookie ?? "").split(";", 1)[0] ?? "";
    const csrfToken = login.json().session.csrfToken as string;
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0];
    assert(agent, "seeded Alice Agent is missing");
    const credential = test.principalLatch.credentialForAgent(agent);
    const authorization = "AgentPassport " + credential.passport;

    const alice = await app.inject({
      method: "GET",
      url: "/v1/documents/alice-doc-001",
      headers: { authorization },
    });
    const bob = await app.inject({
      method: "GET",
      url: "/v1/documents/bob-payroll-001",
      headers: { authorization },
    });
    assert.equal(alice.statusCode, 200);
    assert.equal(bob.statusCode, 403);
    assert.equal(bob.json().code, "DENY_OWNER_MISMATCH");
    assert.equal(test.principalLatch.contentProvider.readCount("bob-payroll-001"), 0);

    const revoke = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/mandate/revoke`,
      headers: {
        authorization: operatorAuthorization,
        cookie,
        "x-csrf-token": csrfToken,
      },
    });
    assert.equal(revoke.statusCode, 200);
    const revokedAlice = await app.inject({
      method: "GET",
      url: "/v1/documents/alice-doc-001",
      headers: { authorization },
    });
    assert.equal(revokedAlice.statusCode, 403);
    assert.equal(revokedAlice.json().code, "DENY_MANDATE_LIFECYCLE");

    const finalAgent = test.service.getAgent(ALICE_PRINCIPAL_ID, agent.id);
    const security = test.principalLatch.securitySummary(finalAgent) as {
      demo: { phase: string; samePassportActive: boolean };
    };
    assert.equal(security.demo.phase, "complete");
    assert.equal(security.demo.samePassportActive, true);

    const events = test.principalLatch.auditForAgent(
      agent.principalId,
      agent.mandateId,
    );
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          mode: "middleware-verification-no-model",
          liveAgentRun: false,
          agentPrincipalId: agent.principalId,
          mandateId: agent.mandateId,
          passportTokenSha256: credential.summary.passportTokenSha256,
          proof: {
            alice: "ALLOW / succeeded",
            bob: "DENY_OWNER_MISMATCH / not_attempted",
            afterRevoke: "DENY_MANDATE_LIFECYCLE / not_attempted",
            samePassport: true,
          },
          auditEvents: events.length,
          bobProviderReads: test.principalLatch.contentProvider.readCount(
            "bob-payroll-001",
          ),
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await app.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
