import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "../test-context.js";
import type { AuditWriter } from "./audit.js";
import type { GatewayAuditEvent } from "./contracts.js";
import { ALICE_PRINCIPAL_ID } from "./fixtures.js";
import { PrincipalLatchGateway } from "./gateway.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function context() {
  const root = await mkdtemp(path.join(tmpdir(), "principallatch-gateway-test-"));
  temporaryDirectories.push(root);
  return createTestContext(root);
}

describe("PrincipalLatch protected resource boundary", () => {
  it("allows Alice, denies Bob before content access, then denies revocation with the same Passport", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const authorization = "AgentPassport " + credential.passport;

    const alice = await test.principalLatch.readDocument(
      authorization,
      "alice-doc-001",
    );
    expect(alice).toMatchObject({
      ok: true,
      statusCode: 200,
      decision: "allow",
      resource: { id: "alice-doc-001" },
    });
    expect(test.principalLatch.contentProvider.readCount("alice-doc-001")).toBe(1);

    const bob = await test.principalLatch.readDocument(
      authorization,
      "bob-payroll-001",
    );
    expect(bob).toMatchObject({
      ok: false,
      statusCode: 403,
      code: "DENY_OWNER_MISMATCH",
    });
    expect(test.principalLatch.contentProvider.readCount("bob-payroll-001")).toBe(0);

    await test.principalLatch.revoke(agent);
    expect(test.principalLatch.credentialForAgent(agent).passport).toBe(
      credential.passport,
    );
    const revoked = await test.principalLatch.readDocument(
      authorization,
      "alice-doc-001",
    );
    expect(revoked).toMatchObject({
      ok: false,
      statusCode: 403,
      code: "DENY_MANDATE_LIFECYCLE",
    });
    expect(test.principalLatch.contentProvider.readCount("alice-doc-001")).toBe(1);

    const events = test.principalLatch.auditForAgent(agent.principalId);
    const decisions = events.filter(
      (event) => event.eventType === "authorization_decision",
    );
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanPrincipalId: ALICE_PRINCIPAL_ID,
          agentPrincipalId: agent.principalId,
          resourceId: "alice-doc-001",
          decision: "allow",
        }),
        expect.objectContaining({
          humanPrincipalId: ALICE_PRINCIPAL_ID,
          agentPrincipalId: agent.principalId,
          resourceId: "bob-payroll-001",
          decision: "deny",
          reasonCode: "DENY_OWNER_MISMATCH",
        }),
      ]),
    );
    expect(
      events.some(
        (event) =>
          event.eventType === "security_rejection" &&
          event.code === "DENY_MANDATE_LIFECYCLE",
      ),
    ).toBe(true);
  });

  it("does not enumerate the catalog before Passport verification", async () => {
    const test = await context();
    test.principalLatch.catalog.resetCounters();
    const denied = await test.principalLatch.readDocument(
      "AgentPassport not-a-jws",
      "bob-payroll-001",
    );
    expect(denied).toMatchObject({ ok: false, statusCode: 403 });
    expect(test.principalLatch.catalog.lookupCount).toBe(0);
    expect(test.principalLatch.contentProvider.readCount("bob-payroll-001")).toBe(0);
  });

  it("fails closed before content access when the decision audit sink fails", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const unavailableAudit: AuditWriter = {
      append: async () => {
        throw new Error("audit unavailable");
      },
      appendBatch: async () => {
        throw new Error("audit unavailable");
      },
    };
    test.principalLatch.contentProvider.resetCounters();
    const gateway = new PrincipalLatchGateway(
      test.principalLatch.passportBroker,
      test.principalLatch.authority,
      test.principalLatch.catalog,
      test.principalLatch.contentProvider,
      unavailableAudit,
    );
    const result = await gateway.readDocument(
      "AgentPassport " + credential.passport,
      "alice-doc-001",
    );
    expect(result).toMatchObject({
      ok: false,
      statusCode: 503,
      code: "DENY_AUDIT_UNAVAILABLE",
    });
    expect(test.principalLatch.contentProvider.readCount("alice-doc-001")).toBe(0);
  });

  it("denies a read when revocation completes after its first check but before provider access", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    let releaseDecisionAudit!: () => void;
    let markDecisionAuditReached!: () => void;
    const decisionAuditReached = new Promise<void>((resolve) => {
      markDecisionAuditReached = resolve;
    });
    const decisionAuditRelease = new Promise<void>((resolve) => {
      releaseDecisionAudit = resolve;
    });
    let batches = 0;
    const pausingAudit: AuditWriter = {
      append: async () => undefined,
      appendBatch: async () => {
        batches += 1;
        if (batches !== 1) return;
        markDecisionAuditReached();
        await decisionAuditRelease;
      },
    };
    const gateway = new PrincipalLatchGateway(
      test.principalLatch.passportBroker,
      test.principalLatch.authority,
      test.principalLatch.catalog,
      test.principalLatch.contentProvider,
      pausingAudit,
    );

    const pendingRead = gateway.readDocument(
      "AgentPassport " + credential.passport,
      "alice-doc-001",
    );
    await decisionAuditReached;
    await test.principalLatch.revoke(agent);
    releaseDecisionAudit();
    const result = await pendingRead;

    expect(result).toMatchObject({
      ok: false,
      statusCode: 403,
      code: "DENY_MANDATE_LIFECYCLE",
    });
    expect(test.principalLatch.contentProvider.readCount("alice-doc-001")).toBe(0);
  });

  it("leaves an explicit attempting outcome when the terminal audit write fails", async () => {
    const test = await context();
    const agent = test.service.listAgents(ALICE_PRINCIPAL_ID)[0]!;
    const credential = test.principalLatch.credentialForAgent(agent);
    const recorded: GatewayAuditEvent[] = [];
    let batches = 0;
    const interruptedAudit: AuditWriter = {
      append: async (event) => {
        recorded.push(event);
      },
      appendBatch: async (events) => {
        batches += 1;
        if (batches === 2) throw new Error("terminal audit unavailable");
        recorded.push(...events);
      },
    };
    const gateway = new PrincipalLatchGateway(
      test.principalLatch.passportBroker,
      test.principalLatch.authority,
      test.principalLatch.catalog,
      test.principalLatch.contentProvider,
      interruptedAudit,
    );

    const result = await gateway.readDocument(
      "AgentPassport " + credential.passport,
      "alice-doc-001",
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 503,
      code: "DENY_AUDIT_UNAVAILABLE",
    });
    expect(test.principalLatch.contentProvider.readCount("alice-doc-001")).toBe(1);
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "authorization_decision" }),
        expect.objectContaining({
          eventType: "resource_outcome",
          status: "attempting",
        }),
      ]),
    );
    expect(
      recorded.some(
        (event) =>
          event.eventType === "resource_outcome" &&
          event.status === "succeeded",
      ),
    ).toBe(false);
  });
});
